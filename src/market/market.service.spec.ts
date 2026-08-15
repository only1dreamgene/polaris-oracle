import { ConfigService } from '@nestjs/config';
import { MarketService } from './market.service';
import { MarketRepository } from './market.repository';
import { MarketEvents } from './market-events';
import type { WatchedMarket } from './market.types';

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
    const oracle = { isAvailable: true, waitForUpdate: jest.fn().mockResolvedValue(Buffer.from('payload')) };
    const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents());

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
      const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents());

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
      const oracle = { isAvailable: true, waitForUpdate: jest.fn().mockResolvedValue(Buffer.from('x')) };
      const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents());

      const m = sample({ gracePeriodSecs: 60 });
      svc.watch(m);
      // reconcileWithChain's read retries use a real setTimeout between
      // attempts (see RECONCILE_READ_RETRY_DELAY_MS) — advance fake timers
      // past those before asserting, not just microtasks.
      await jest.advanceTimersByTimeAsync(2000);

      expect(svc.get(m.contractId)?.status).toBe('pending');
      expect(svc.get(m.contractId)?.lastError).toMatch(/rpc exploded/);

      await jest.advanceTimersByTimeAsync(60_000 + 1000);

      expect(stellar.cancel).toHaveBeenCalled();
      expect(svc.get(m.contractId)?.status).toBe('cancelled');
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
    const oracle = { isAvailable: true, waitForUpdate: jest.fn().mockResolvedValue(Buffer.from('x')) };
    const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents());

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
    const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents());

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
      const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents());

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
      const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents());

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
    const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents());

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
    const oracle = { isAvailable: true, waitForUpdate: jest.fn().mockResolvedValue(Buffer.from('x')) };
    const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents());

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

      const svc = new MarketService(repo, stellar as any, oracle as any, {} as ConfigService, new MarketEvents());
      svc.onModuleInit();

      // Re-arming a future-expiry market should not immediately settle/cancel it.
      expect(stellar.settle).not.toHaveBeenCalled();
      expect(stellar.cancel).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
