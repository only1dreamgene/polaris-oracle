import { ConfigService } from '@nestjs/config';
import { MarketFactoryService, hermesPriceToCents, type FeedCatalogEntry } from './market-factory.service';
import { MarketRepository } from './market.repository';
import { MarketService } from './market.service';
import type { WatchedMarket } from './market.types';

// Same "hand-rolled fakes, no real StellarService/network SDK" pattern as
// market.service.spec.ts — this suite is pure orchestration logic.

const XLM_ENTRY: FeedCatalogEntry = { feedId: 100, hermesFeedId: '0xaaaa', symbol: 'XLM/USD' };
const BTC_ENTRY: FeedCatalogEntry = { feedId: 200, hermesFeedId: '0xbbbb', symbol: 'BTC/USD' };

function makeRepo(existing: WatchedMarket[] = []): MarketRepository {
  return {
    getAll: jest.fn(() => existing),
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

describe('hermesPriceToCents', () => {
  it('scales a typical negative-exponent price into whole cents', () => {
    // 0.10234567 USD (price=10234567, expo=-8) -> 10.234567 cents -> rounds to 10
    expect(hermesPriceToCents('10234567', -8)).toBe(10n);
  });

  it('rounds to the nearest cent instead of truncating', () => {
    // 0.105 USD -> 10.5 cents -> rounds up to 11, not down to 10
    expect(hermesPriceToCents('105', -3)).toBe(11n);
  });

  it('handles a non-negative scaled exponent', () => {
    expect(hermesPriceToCents('5', 0)).toBe(500n);
  });
});

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

    const svc = new MarketFactoryService(repo, markets, stellar as any, config);
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

    const svc = new MarketFactoryService(repo, markets, stellar as any, config);
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

    const svc = new MarketFactoryService(repo, markets, stellar as any, config);
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

    const svc = new MarketFactoryService(repo, markets, stellar as any, config);
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

    const svc = new MarketFactoryService(repo, markets, stellar as any, config);
    const result = await svc.run();

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].symbol).toBe('XLM/USD');
    expect(stellar.vaultWithdraw).not.toHaveBeenCalled();
  });
});
