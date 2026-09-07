import { ConfigService } from '@nestjs/config';
import { MarketService } from './market.service';
import { MarketRepository } from './market.repository';
import { MarketEvents } from './market-events';
import type { AdminActivityRepository } from './admin-activity.repository';
import type { WatchedMarket } from './market.types';

function makeActivity(): AdminActivityRepository {
  return { recordSettlementCheck: jest.fn() } as unknown as AdminActivityRepository;
}

// This suite is pure orchestration logic — it doesn't need the real
// StellarService (which pulls in @stellar/stellar-sdk) or OracleService, so
// both are hand-rolled fakes rather than the real classes. Mirrors the
// pattern used elsewhere in this repo for keeping unit tests fast and
// independent of network SDKs.

function makeRepo(): MarketRepository {
  const store = new Map<string, WatchedMarket>();
  return {
    upsert: jest.fn((m: WatchedMarket) => store.set(m.contractId, { ...m })),
    getAll: jest.fn(() => [...store.values()]),
    getById: jest.fn((id: string) => store.get(id)),
    onModuleDestroy: jest.fn(),
  } as unknown as MarketRepository;
}

/**
 * Flushes pending microtasks — needed because `trySettle`/`tryCancel`'s
 * fire-and-forget async chains (`void this.trySettle(m)`) run detached from
 * the test's own await chain. A fixed number of `await Promise.resolve()`
 * calls is fragile: it silently under-flushes (and the test starts failing
 * on an unrelated assertion, as happened here) whenever a code path grows
 * one more `await` hop, e.g. when `reconcileWithChain` was added. Looping
 * until nothing is scheduled anymore doesn't have that failure mode.
 */
async function flushMicrotasks(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

function sample(overrides: Partial<WatchedMarket> = {}): WatchedMarket {
  const now = Date.now();
  return {
    contractId: 'CCONTRACT1',
    strikePriceCents: '1500000',
    expiry: Math.floor(now / 1000) - 10, // already expired
    gracePeriodSecs: 3600,
    feedId: 100,
    status: 'watching',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('MarketService — settlement orchestration', () => {
  it('settles when the oracle is available and returns a valid payload', async () => {
    const repo = makeRepo();
    const stellar = { settle: jest.fn().mockResolvedValue('TXHASH1'), cancel: jest.fn() };
    const oracle = {
      isAvailable: true,
      waitForUpdate: jest.fn().mockResolvedValue({ payload: Buffer.from('payload'), priceCents: undefined }),
    };
    const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents(), makeActivity());

    const m = svc.watch(sample());
    // watch() arms synchronously via a microtask chain (now >= expiry, < grace end) — flush it.
    await flushMicrotasks();

    expect(stellar.settle).toHaveBeenCalledWith('CCONTRACT1', Buffer.from('payload'));
    expect(svc.get(m.contractId)?.status).toBe('settled');
    expect(svc.get(m.contractId)?.settleTxHash).toBe('TXHASH1');
    expect(stellar.cancel).not.toHaveBeenCalled();
  });

  it('never strands funds: falls straight to cancel when the oracle is unavailable', async () => {
    jest.useFakeTimers();
    try {
      const repo = makeRepo();
      const stellar = { settle: jest.fn(), cancel: jest.fn().mockResolvedValue('CANCELTX') };
      const oracle = { isAvailable: false, waitForUpdate: jest.fn() };
      const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents(), makeActivity());

      const m = sample({ gracePeriodSecs: 60 });
      svc.watch(m);
      await flushMicrotasks();

      expect(stellar.settle).not.toHaveBeenCalled();
      expect(svc.get(m.contractId)?.status).toBe('watching'); // fallback scheduled, not yet fired

      jest.advanceTimersByTime(60_000 + 1000);
      await flushMicrotasks();

      expect(stellar.cancel).toHaveBeenCalledWith('CCONTRACT1');
      expect(svc.get(m.contractId)?.status).toBe('cancelled');
    } finally {
      jest.useRealTimers();
    }
  });

  it('never strands funds: a thrown settle error still schedules a cancel fallback', async () => {
    jest.useFakeTimers();
    try {
      const repo = makeRepo();
      const stellar = {
        settle: jest.fn().mockRejectedValue(new Error('rpc exploded')),
        cancel: jest.fn().mockResolvedValue('CANCELTX'),
        getMarketState: jest.fn().mockRejectedValue(new Error('rpc down too')),
      };
      const oracle = { isAvailable: true, waitForUpdate: jest.fn().mockResolvedValue({ payload: Buffer.from('x'), priceCents: undefined }) };
      const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents(), makeActivity());

      const m = sample({ gracePeriodSecs: 60 });
      svc.watch(m);
      // trySettle now retries a failed attempt SETTLE_RETRY_ATTEMPTS times
      // (75s apart) before giving up — by the time the last attempt fails,
      // the grace period (60s) has long since elapsed, so
      // scheduleCancelFallback's own delay clamps to ~0 and cancellation
      // follows immediately within the same advance. Assert the retries
      // actually happened (not just the end state) and that nothing got
      // stranded along the way.
      await jest.advanceTimersByTimeAsync(300_000);

      expect(stellar.settle).toHaveBeenCalledTimes(3); // SETTLE_RETRY_ATTEMPTS
      expect(stellar.cancel).toHaveBeenCalled();
      expect(svc.get(m.contractId)?.status).toBe('cancelled');
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers from a transient settle failure on retry instead of falling straight to cancel', async () => {
    // The whole reason trySettle retries at all now: a blip that clears up
    // on its own (e.g. a Reflector staleness window that rolls forward)
    // shouldn't be treated identically to a permanent divergence. First
    // attempt fails, second succeeds — must end up settled, and must not
    // have scheduled a cancel fallback along the way.
    jest.useFakeTimers();
    try {
      const repo = makeRepo();
      const stellar = {
        settle: jest.fn().mockRejectedValueOnce(new Error('transient blip')).mockResolvedValueOnce('TXHASH1'),
        cancel: jest.fn(),
        getMarketState: jest.fn().mockRejectedValue(new Error('rpc down too')), // nothing to reconcile against yet
      };
      const oracle = {
        isAvailable: true,
        waitForUpdate: jest.fn().mockResolvedValue({ payload: Buffer.from('x'), priceCents: undefined }),
      };
      const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents(), makeActivity());

      const m = sample({ gracePeriodSecs: 3600 }); // long grace — retries must land well inside it
      svc.watch(m);
      await jest.advanceTimersByTimeAsync(80_000); // past the single 75s inter-attempt delay + reconcileWithChain's own read-retry overhead

      expect(stellar.settle).toHaveBeenCalledTimes(2);
      expect(svc.get(m.contractId)?.status).toBe('settled');
      expect(svc.get(m.contractId)?.settleTxHash).toBe('TXHASH1');
      expect(stellar.cancel).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reconciles instead of stranding status as "pending" when settle failed locally but had already succeeded on-chain', async () => {
    // Models a crash between the on-chain settle tx confirming and this
    // service persisting that fact: the retry's settle() call fails
    // (AlreadyFinalized on-chain), but the market is actually fine — status
    // must sync to 'settled', not get stuck reporting a failure forever.
    const repo = makeRepo();
    const stellar = {
      settle: jest.fn().mockRejectedValue(new Error('AlreadyFinalized')),
      cancel: jest.fn(),
      getMarketState: jest.fn().mockResolvedValue({ status: 'ResolvedYes' }),
    };
    const oracle = { isAvailable: true, waitForUpdate: jest.fn().mockResolvedValue({ payload: Buffer.from('x'), priceCents: undefined }) };
    const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents(), makeActivity());

    const m = sample({ gracePeriodSecs: 60 });
    svc.watch(m);
    await flushMicrotasks();

    expect(svc.get(m.contractId)?.status).toBe('settled');
    expect(svc.get(m.contractId)?.lastError).toBeUndefined();
    expect(stellar.cancel).not.toHaveBeenCalled(); // no bogus fallback scheduled once reconciled
  });

  it('reconciles instead of stranding status as "pending" when cancel failed locally but had already succeeded on-chain', async () => {
    const repo = makeRepo();
    const stellar = {
      settle: jest.fn(),
      cancel: jest.fn().mockRejectedValue(new Error('AlreadyFinalized')),
      getMarketState: jest.fn().mockResolvedValue({ status: 'Cancelled' }),
    };
    const oracle = { isAvailable: true, waitForUpdate: jest.fn() };
    const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents(), makeActivity());

    const m = sample({ status: 'pending' });
    repo.upsert(m);

    await svc.triggerCancel(m.contractId);

    expect(svc.get(m.contractId)?.status).toBe('cancelled');
    expect(svc.get(m.contractId)?.lastError).toBeUndefined();
  });

  it('retries the reconcile read past a transient RPC hiccup instead of stranding status as "pending"', async () => {
    // Regression for: confirmed live against testnet that a single failed
    // getMarketState() read inside reconcileWithChain — even moments after
    // the market had genuinely finalized on-chain — left it reporting
    // 'pending' with a stale error forever, since tryCancel/trySettle never
    // auto-retry. The read now gets a few attempts before giving up.
    jest.useFakeTimers();
    try {
      const repo = makeRepo();
      const stellar = {
        settle: jest.fn(),
        cancel: jest.fn().mockRejectedValue(new Error('AlreadyFinalized')),
        getMarketState: jest
          .fn()
          .mockRejectedValueOnce(new Error('rpc hiccup'))
          .mockResolvedValueOnce({ status: 'Cancelled' }),
      };
      const oracle = { isAvailable: true, waitForUpdate: jest.fn() };
      const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents(), makeActivity());

      const m = sample({ status: 'pending' });
      repo.upsert(m);

      const triggerPromise = svc.triggerCancel(m.contractId);
      // The retry delay uses a real setTimeout — advance fake timers until
      // the pending reconcile read (queued as a microtask) resolves.
      await jest.advanceTimersByTimeAsync(1000);
      await triggerPromise;

      expect(stellar.getMarketState).toHaveBeenCalledTimes(2);
      expect(svc.get(m.contractId)?.status).toBe('cancelled');
      expect(svc.get(m.contractId)?.lastError).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('gives up after exhausting reconcile read retries and logs why, instead of throwing', async () => {
    jest.useFakeTimers();
    try {
      const repo = makeRepo();
      const stellar = {
        settle: jest.fn(),
        cancel: jest.fn().mockRejectedValue(new Error('AlreadyFinalized')),
        getMarketState: jest.fn().mockRejectedValue(new Error('rpc down')),
      };
      const oracle = { isAvailable: true, waitForUpdate: jest.fn() };
      const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents(), makeActivity());

      const m = sample({ status: 'pending' });
      repo.upsert(m);

      const triggerPromise = svc.triggerCancel(m.contractId);
      await jest.advanceTimersByTimeAsync(3000);
      await triggerPromise;

      expect(stellar.getMarketState).toHaveBeenCalledTimes(3);
      expect(svc.get(m.contractId)?.status).toBe('pending');
      expect(svc.get(m.contractId)?.lastError).toMatch(/AlreadyFinalized/);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not re-settle or re-cancel an already-finalized market', async () => {
    const repo = makeRepo();
    const stellar = { settle: jest.fn(), cancel: jest.fn() };
    const oracle = { isAvailable: true, waitForUpdate: jest.fn() };
    const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents(), makeActivity());

    const m = sample({ status: 'settled' });
    repo.upsert(m);

    await svc.triggerSettle(m.contractId);
    await svc.triggerCancel(m.contractId);

    expect(stellar.settle).not.toHaveBeenCalled();
    expect(stellar.cancel).not.toHaveBeenCalled();
  });

  it('an admin can manually retry settle after a pending failure', async () => {
    const repo = makeRepo();
    const stellar = { settle: jest.fn().mockResolvedValue('RETRYTX'), cancel: jest.fn() };
    const oracle = { isAvailable: true, waitForUpdate: jest.fn().mockResolvedValue({ payload: Buffer.from('x'), priceCents: undefined }) };
    const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents(), makeActivity());

    const m = sample({ status: 'pending', lastError: 'previous failure' });
    repo.upsert(m);

    await svc.triggerSettle(m.contractId);

    expect(svc.get(m.contractId)?.status).toBe('settled');
    expect(svc.get(m.contractId)?.settleTxHash).toBe('RETRYTX');
  });

  it('re-arms timers for markets still open on module init (process restart recovery)', () => {
    jest.useFakeTimers(); // a real ~1hr setTimeout here would otherwise leak past this test
    try {
      const repo = makeRepo();
      const stellar = { settle: jest.fn(), cancel: jest.fn() };
      const oracle = { isAvailable: true, waitForUpdate: jest.fn() };

      const future = sample({
        contractId: 'CFUTURE',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        status: 'watching',
      });
      repo.upsert(future);

      const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents(), makeActivity());
      svc.onModuleInit();

      // Re-arming a future-expiry market should not immediately settle/cancel it.
      expect(stellar.settle).not.toHaveBeenCalled();
      expect(stellar.cancel).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('MarketService — oracle cross-check', () => {
  const XLM_FEED = { feedId: 100, hermesFeedId: '0xfeed', symbol: 'XLM/USD' };

  function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
    const values: Record<string, unknown> = {
      feedCatalog: [XLM_FEED],
      pythHermesUrl: 'https://hermes.example',
      settleOracleToleranceBps: 150,
      ...overrides,
    };
    return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
  }

  function mockHermesFetch(priceCents: { price: string; expo: number } | 'error') {
    global.fetch = jest.fn(async () => {
      if (priceCents === 'error') return { ok: false, status: 503 } as Response;
      return {
        ok: true,
        json: async () => ({ parsed: [{ price: { price: priceCents.price, expo: priceCents.expo } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('settles normally when the Lazer and Hermes prices agree within tolerance', async () => {
    const repo = makeRepo();
    const stellar = { settle: jest.fn().mockResolvedValue('TXHASH1'), cancel: jest.fn() };
    // 10000000/-8 -> 10 cents, same as Hermes below — should pass comfortably.
    const oracle = {
      isAvailable: true,
      waitForUpdate: jest.fn().mockResolvedValue({ payload: Buffer.from('x'), priceCents: 10n }),
    };
    mockHermesFetch({ price: '10000000', expo: -8 });
    const svc = new MarketService(repo, stellar as any, oracle as any, makeConfig(), new MarketEvents(), makeActivity());

    const m = svc.watch(sample());
    await flushMicrotasks();

    expect(stellar.settle).toHaveBeenCalled();
    expect(svc.get(m.contractId)?.status).toBe('settled');
  });

  it('falls back to cancel instead of settling on a gross Lazer/Hermes divergence', async () => {
    jest.useFakeTimers();
    try {
      const repo = makeRepo();
      const stellar = {
        settle: jest.fn(),
        cancel: jest.fn().mockResolvedValue('CANCELTX'),
        getMarketState: jest.fn().mockResolvedValue({ status: 'Open' }), // nothing was ever submitted
      };
      // Lazer says 10 cents, Hermes says 20 cents — 100% apart, way past a 150bps tolerance.
      const oracle = {
        isAvailable: true,
        waitForUpdate: jest.fn().mockResolvedValue({ payload: Buffer.from('x'), priceCents: 10n }),
      };
      mockHermesFetch({ price: '20000000', expo: -8 });
      const svc = new MarketService(repo, stellar as any, oracle as any, makeConfig(), new MarketEvents(), makeActivity());

      const m = sample({ gracePeriodSecs: 60 });
      svc.watch(m);
      // trySettle retries a failed attempt SETTLE_RETRY_ATTEMPTS times (75s
      // apart) before giving up — a persistent divergence fails identically
      // on every attempt (proven by waitForUpdate being called 3 times, not
      // just once), and by the time the retries are exhausted the grace
      // period has long since elapsed, so cancellation follows immediately.
      await jest.advanceTimersByTimeAsync(300_000);

      expect(stellar.settle).not.toHaveBeenCalled();
      expect(oracle.waitForUpdate).toHaveBeenCalledTimes(3); // SETTLE_RETRY_ATTEMPTS
      expect(stellar.cancel).toHaveBeenCalled();
      expect(svc.get(m.contractId)?.status).toBe('cancelled');
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips the cross-check and settles anyway when the feed is not in the catalog', async () => {
    const repo = makeRepo();
    const stellar = { settle: jest.fn().mockResolvedValue('TXHASH1'), cancel: jest.fn() };
    const oracle = {
      isAvailable: true,
      waitForUpdate: jest.fn().mockResolvedValue({ payload: Buffer.from('x'), priceCents: 10n }),
    };
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const svc = new MarketService(
      repo,
      stellar as any,
      oracle as any,
      makeConfig({ feedCatalog: [] }),
      new MarketEvents(),
      makeActivity(),
    );

    const m = svc.watch(sample());
    await flushMicrotasks();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stellar.settle).toHaveBeenCalled();
    expect(svc.get(m.contractId)?.status).toBe('settled');
  });

  it('skips the cross-check and settles anyway when the Hermes lookup itself fails', async () => {
    const repo = makeRepo();
    const stellar = { settle: jest.fn().mockResolvedValue('TXHASH1'), cancel: jest.fn() };
    const oracle = {
      isAvailable: true,
      waitForUpdate: jest.fn().mockResolvedValue({ payload: Buffer.from('x'), priceCents: 10n }),
    };
    mockHermesFetch('error');
    const svc = new MarketService(repo, stellar as any, oracle as any, makeConfig(), new MarketEvents(), makeActivity());

    const m = svc.watch(sample());
    await flushMicrotasks();

    // A cross-check that can't run must never be the reason a healthy settlement stalls.
    expect(stellar.settle).toHaveBeenCalled();
    expect(svc.get(m.contractId)?.status).toBe('settled');
  });

  it('skips the cross-check when Lazer sent no parsed price for this feed', async () => {
    const repo = makeRepo();
    const stellar = { settle: jest.fn().mockResolvedValue('TXHASH1'), cancel: jest.fn() };
    const oracle = {
      isAvailable: true,
      waitForUpdate: jest.fn().mockResolvedValue({ payload: Buffer.from('x'), priceCents: undefined }),
    };
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const svc = new MarketService(repo, stellar as any, oracle as any, makeConfig(), new MarketEvents(), makeActivity());

    const m = svc.watch(sample());
    await flushMicrotasks();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stellar.settle).toHaveBeenCalled();
    expect(svc.get(m.contractId)?.status).toBe('settled');
  });
});
