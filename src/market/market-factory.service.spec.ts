import { ConfigService } from '@nestjs/config';
import { MarketFactoryService, type FeedCatalogEntry } from './market-factory.service';
import { MarketRepository } from './market.repository';
import { MarketService } from './market.service';
import { MarketEvents } from './market-events';
import type { WatchedMarket } from './market.types';

// Same "hand-rolled fakes, no real StellarService/network SDK" pattern as
// market.service.spec.ts — this suite is pure orchestration logic.

const XLM_ENTRY: FeedCatalogEntry = { feedId: 100, hermesFeedId: '0xaaaa', symbol: 'XLM/USD' };
const BTC_ENTRY: FeedCatalogEntry = { feedId: 200, hermesFeedId: '0xbbbb', symbol: 'BTC/USD' };

/** Flushes fire-and-forget async chains (`void this.run()`, the 'finalized' listener's `void this.rollFeed(...)`) the same way market.service.spec.ts does. */
async function flushMicrotasks(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

function makeRepo(existing: WatchedMarket[] = []): MarketRepository {
  return {
    getByFeedId: jest.fn((feedId: number) => existing.filter((m) => m.feedId === feedId)),
  } as unknown as MarketRepository;
}

function makeMarkets(): MarketService {
  return { watch: jest.fn() } as unknown as MarketService;
}

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    feedCatalog: [XLM_ENTRY],
    vaultContract: 'CVAULT',
    lazerContract: 'CLAZER',
    nativeXlmSac: 'CNATIVE',
    reflectorContract: 'CREFLECTOR',
    reflectorAsset: 'XLM',
    reflectorMaxStalenessSecs: '600',
    reflectorToleranceBps: 150,
    pythHermesUrl: 'https://hermes.example',
    marketFactoryIntervalSecs: 21600,
    marketFactoryExpirySecs: 86400,
    marketFactoryGracePeriodSecs: 3600,
    marketFactoryBaseFeeBps: 100,
    marketFactoryMinFeeBps: 20,
    marketFactoryInitialLiquidityStroops: '1000000000',
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function watchedMarket(overrides: Partial<WatchedMarket> = {}): WatchedMarket {
  const now = Date.now();
  return {
    contractId: 'CEXISTING',
    strikePriceCents: '1000',
    expiry: Math.floor(now / 1000) + 3600,
    gracePeriodSecs: 3600,
    feedId: 100,
    status: 'watching',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mockHermesFetch(priceCents: { price: string; expo: number } | 'error' | 'empty') {
  global.fetch = jest.fn(async () => {
    if (priceCents === 'error') {
      return { ok: false, status: 503 } as Response;
    }
    if (priceCents === 'empty') {
      return { ok: true, json: async () => ({ parsed: [] }) } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({ parsed: [{ price: { price: priceCents.price, expo: priceCents.expo } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('MarketFactoryService — run()', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('skips a feed that already has an open market', async () => {
    const repo = makeRepo([watchedMarket({ feedId: 100, status: 'watching' })]);
    const markets = makeMarkets();
    const stellar = { vaultWithdraw: jest.fn(), deployMarket: jest.fn() };
    const config = makeConfig();
    mockHermesFetch({ price: '10000000', expo: -8 });

    const svc = new MarketFactoryService(repo, markets, stellar as any, config, new MarketEvents());
    const result = await svc.run();

    expect(result.skipped).toEqual(['XLM/USD']);
    expect(result.created).toEqual([]);
    expect(stellar.vaultWithdraw).not.toHaveBeenCalled();
    expect(stellar.deployMarket).not.toHaveBeenCalled();
  });

  it('creates a market for a feed with no open market, funded from the vault, treasury set to the vault', async () => {
    const repo = makeRepo([]);
    const markets = makeMarkets();
    const stellar = {
      vaultWithdraw: jest.fn().mockResolvedValue('WITHDRAWTX'),
      deployMarket: jest.fn().mockResolvedValue({ contractId: 'CNEWMARKET', initTxHash: 'INITTX' }),
    };
    const config = makeConfig();
    mockHermesFetch({ price: '10000000', expo: -8 }); // 0.10 USD -> 10 cents

    const svc = new MarketFactoryService(repo, markets, stellar as any, config, new MarketEvents());
    const result = await svc.run();

    expect(stellar.vaultWithdraw).toHaveBeenCalledWith('CVAULT', 1_000_000_000n);
    expect(stellar.deployMarket).toHaveBeenCalledWith(
      expect.objectContaining({
        strikePriceCents: 10n,
        feedId: 100,
        treasury: 'CVAULT',
        collateralAsset: 'CNATIVE',
        lazerContract: 'CLAZER',
        initialLiquidityStroops: 1_000_000_000n,
      }),
    );
    expect(markets.watch).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: 'CNEWMARKET', feedId: 100, strikePriceCents: '10' }),
    );
    expect(result.created).toEqual([{ symbol: 'XLM/USD', contractId: 'CNEWMARKET', strikePriceCents: '10' }]);
    expect(result.failed).toEqual([]);
  });

  it('a vault-withdrawal failure fails that feed loudly and does not deploy an underfunded market', async () => {
    const repo = makeRepo([]);
    const markets = makeMarkets();
    const stellar = {
      vaultWithdraw: jest.fn().mockRejectedValue(new Error('vault balance too low')),
      deployMarket: jest.fn(),
    };
    const config = makeConfig();
    mockHermesFetch({ price: '10000000', expo: -8 });

    const svc = new MarketFactoryService(repo, markets, stellar as any, config, new MarketEvents());
    const result = await svc.run();

    expect(stellar.deployMarket).not.toHaveBeenCalled();
    expect(markets.watch).not.toHaveBeenCalled();
    expect(result.failed).toEqual([{ symbol: 'XLM/USD', error: 'vault balance too low' }]);
    expect(result.created).toEqual([]);
  });

  it('a bad Hermes lookup fails that feed independently and does not block the rest of the catalog', async () => {
    const repo = makeRepo([]);
    const markets = makeMarkets();
    const stellar = {
      vaultWithdraw: jest.fn().mockResolvedValue('WITHDRAWTX'),
      deployMarket: jest.fn().mockResolvedValue({ contractId: 'CBTC', initTxHash: 'INITTX' }),
    };
    const config = makeConfig({ feedCatalog: [XLM_ENTRY, BTC_ENTRY] });

    let call = 0;
    global.fetch = jest.fn(async () => {
      call++;
      if (call === 1) return { ok: false, status: 503 } as Response;
      return {
        ok: true,
        json: async () => ({ parsed: [{ price: { price: '5000000000000', expo: -8 } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const svc = new MarketFactoryService(repo, markets, stellar as any, config, new MarketEvents());
    const result = await svc.run();

    expect(result.failed).toEqual([{ symbol: 'XLM/USD', error: 'Hermes price lookup failed: 503' }]);
    expect(result.created).toEqual([{ symbol: 'BTC/USD', contractId: 'CBTC', strikePriceCents: '5000000' }]);
  });

  it('surfaces missing config as a per-feed failure rather than throwing out of run()', async () => {
    const repo = makeRepo([]);
    const markets = makeMarkets();
    const stellar = { vaultWithdraw: jest.fn(), deployMarket: jest.fn() };
    const config = makeConfig({ vaultContract: undefined });
    mockHermesFetch({ price: '10000000', expo: -8 });

    const svc = new MarketFactoryService(repo, markets, stellar as any, config, new MarketEvents());
    const result = await svc.run();

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].symbol).toBe('XLM/USD');
    expect(stellar.vaultWithdraw).not.toHaveBeenCalled();
  });
});

describe('MarketFactoryService — auto-rolling successors', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a successor immediately when a finalized event fires for a catalog feed, not just on the next sweep', async () => {
    // Starts with an open market for the feed (boot state) so onModuleInit's
    // own immediate reconciliation pass correctly no-ops — isolates the
    // assertion to the event path, not the boot pass.
    const existing: WatchedMarket[] = [watchedMarket({ feedId: 100, status: 'watching', contractId: 'COLD' })];
    const repo = makeRepo(existing);
    const markets = makeMarkets();
    const stellar = {
      vaultWithdraw: jest.fn().mockResolvedValue('WITHDRAWTX'),
      deployMarket: jest.fn().mockResolvedValue({ contractId: 'CNEW', initTxHash: 'INITTX' }),
    };
    const config = makeConfig();
    const events = new MarketEvents();
    mockHermesFetch({ price: '10000000', expo: -8 });

    const svc = new MarketFactoryService(repo, markets, stellar as any, config, events);
    svc.onModuleInit();
    await flushMicrotasks(); // let the boot-time run() settle — COLD is still watching, so it should skip
    expect(stellar.deployMarket).not.toHaveBeenCalled();

    // Simulate MarketService.persist() having just transitioned COLD to a
    // terminal status and emitted 'finalized' — same shape trySettle/
    // tryCancel produce.
    existing[0] = { ...existing[0], status: 'settled' };
    events.emit('finalized', existing[0]);
    await flushMicrotasks();

    expect(stellar.deployMarket).toHaveBeenCalledWith(expect.objectContaining({ feedId: 100 }));
    expect(markets.watch).toHaveBeenCalledWith(expect.objectContaining({ contractId: 'CNEW' }));
    svc.onModuleDestroy();
  });

  it('ignores a finalized event for a feed that is not in the catalog', async () => {
    // Repo starts with an open market for the catalog's own feed so the
    // boot-time reconciliation pass (which always runs once) has nothing to
    // create — isolates the assertion to the finalized-event path itself,
    // same reasoning as the test above.
    const repo = makeRepo([watchedMarket({ feedId: 100, status: 'watching' })]);
    const markets = makeMarkets();
    const stellar = { vaultWithdraw: jest.fn(), deployMarket: jest.fn() };
    const config = makeConfig();
    const events = new MarketEvents();
    mockHermesFetch({ price: '10000000', expo: -8 });

    const svc = new MarketFactoryService(repo, markets, stellar as any, config, events);
    svc.onModuleInit();
    await flushMicrotasks();
    stellar.deployMarket.mockClear();

    events.emit('finalized', watchedMarket({ feedId: 999, status: 'settled' }));
    await flushMicrotasks();

    expect(stellar.deployMarket).not.toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('does not start a second concurrent roll for a feed already being rolled', async () => {
    const repo = makeRepo([]);
    const markets = makeMarkets();
    const stellar = {
      vaultWithdraw: jest.fn().mockResolvedValue('WITHDRAWTX'),
      deployMarket: jest.fn().mockResolvedValue({ contractId: 'CNEW', initTxHash: 'INITTX' }),
    };
    const config = makeConfig();
    mockHermesFetch({ price: '10000000', expo: -8 });

    const svc = new MarketFactoryService(repo, markets, stellar as any, config, new MarketEvents());
    // Both calls' synchronous prefix (hasOpenMarket + rolling.add) runs to
    // completion before either hits its first await (inside the Hermes
    // fetch) — JS run-to-completion semantics guarantee the second call
    // sees the first's reservation already in place.
    const p1 = (svc as any).rollFeed(XLM_ENTRY);
    const p2 = (svc as any).rollFeed(XLM_ENTRY);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(stellar.vaultWithdraw).toHaveBeenCalledTimes(1);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(['created', 'skipped']);
  });
});
