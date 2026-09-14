import { PerpetualController } from './perpetual.controller';
import type { PerpetualService } from './perpetual.service';
import type { StellarService } from './stellar.service';
import type { OracleService } from './oracle.service';
import type { ConfigService } from '@nestjs/config';
import type { AdminActivityRepository } from './admin-activity.repository';

/** `.unref()`'d so a still-pending delay from an unrelated failed assertion doesn't hold the Jest worker process open — real `setTimeout`s (not `jest.useFakeTimers()`) are needed here since what's under test is real promise-chain ordering, not simulated time. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Regression for a real bug found auditing this session's perpetual work:
 * `checkpoint()`'s refresh-then-record sequence is two *separate*
 * on-chain transactions against `polaris-mock-redstone` — a single,
 * unauthenticated-by-design contract shared by every perpetual this
 * backend creates. `record_price_checkpoint` reads the mock's *live*
 * state at its own execution time, not a snapshot from the refresh
 * moments earlier, so a second `checkpoint()` call (this backend racing
 * itself — two admin tabs, a double-click) landing in that window would
 * silently corrupt the first call's result with an unrelated price. This
 * asserts `checkpointQueue` actually serializes concurrent calls —
 * without it, both `doCheckpoint` bodies below would execute their
 * mocked "critical section" concurrently and this test would fail.
 */
describe('PerpetualController.checkpoint — serializes concurrent calls', () => {
  function makeController() {
    let inFlight = false;
    let overlapDetected = false;
    const callOrder: string[] = [];

    const stellar = {
      refreshMockRedstonePrice: jest.fn(async (_contractId: string, _cents: bigint) => {
        if (inFlight) overlapDetected = true;
        inFlight = true;
        await delay(10);
        return 'REFRESH_TX';
      }),
      recordPriceCheckpoint: jest.fn(async (id: string) => {
        if (!inFlight) overlapDetected = true; // refresh must have already run for THIS call
        await delay(10);
        callOrder.push(id);
        inFlight = false;
        return 'CHECKPOINT_TX';
      }),
      getPerpetualState: jest.fn(async () => ({ lastPriceCents: '18', lastPriceAt: '1000' })),
    } as unknown as StellarService;

    const oracle = {
      isAvailable: true,
      waitForUpdate: jest.fn(async () => ({ payload: Buffer.from([1, 2, 3]), priceCents: 18n })),
    } as unknown as OracleService;

    const config = {
      get: (key: string) => {
        if (key === 'mockRedstoneContract') return 'CMOCKREDSTONE';
        if (key === 'xlmUsdFeedId') return 100;
        return undefined;
      },
    } as unknown as ConfigService;

    const perpetuals = {} as PerpetualService;
    const activity = {} as AdminActivityRepository;

    const controller = new PerpetualController(perpetuals, stellar, oracle, config, activity);
    return { controller, stellar, callOrder, overlapDetected: () => overlapDetected };
  }

  it('never runs two checkpoints\' refresh/record transactions concurrently', async () => {
    const { controller, callOrder, overlapDetected } = makeController();

    const [a, b] = await Promise.all([controller.checkpoint('PERP_A'), controller.checkpoint('PERP_B')]);

    expect(a).toMatchObject({ txHash: 'CHECKPOINT_TX' });
    expect(b).toMatchObject({ txHash: 'CHECKPOINT_TX' });
    expect(overlapDetected()).toBe(false);
    // Each call's own refresh must be immediately followed by its own
    // record — never A's refresh, B's refresh, A's record, B's record.
    expect(callOrder).toEqual(['PERP_A', 'PERP_B']);
  });

  it('a failed checkpoint does not jam the queue for the next call', async () => {
    const { controller, stellar } = makeController();
    (stellar.refreshMockRedstonePrice as jest.Mock).mockRejectedValueOnce(new Error('simulated RPC failure'));

    await expect(controller.checkpoint('PERP_A')).rejects.toThrow('simulated RPC failure');
    // The queue must have recovered — a subsequent call still runs.
    const result = await controller.checkpoint('PERP_B');
    expect(result).toMatchObject({ txHash: 'CHECKPOINT_TX' });
  });
});
