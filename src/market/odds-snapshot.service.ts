import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketService } from './market.service';
import { StellarService } from './stellar.service';
import { OddsSnapshotRepository } from './odds-snapshot.repository';

/** Snapshots older than this are never read by anything (see `oddsChangeWindowSecs`) and no market runs this long — comfortably above any real expiry + grace period, so it never prunes a snapshot a caller could still plausibly want. */
const PRUNE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Periodically records each open classic market's current odds, purely so
 * `GET /markets/:id/price` has real history to compute a "Chg" figure
 * from — see `polaris-frontend`'s markets ticker list. Scoped to classic
 * markets only for now, same as the ticker redesign it backs; perpetuals
 * don't get this in this round (a small follow-up would mirror this
 * exact pattern against `PerpetualService`/`PerpetualRepository` if
 * that's ever wanted).
 *
 * Deliberately its own service rather than folded into
 * `MarketFactoryService`'s existing timer — a factory failure and a
 * snapshot failure are unrelated concerns, and coupling them would mean a
 * factory bug could also silently stop odds history from being recorded.
 */
@Injectable()
export class OddsSnapshotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OddsSnapshotService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly markets: MarketService,
    private readonly stellar: StellarService,
    private readonly snapshots: OddsSnapshotRepository,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const intervalSecs = this.config.get<number>('oddsSnapshotIntervalSecs')!;
    this.timer = setInterval(() => void this.run(), intervalSecs * 1000);
    this.timer.unref?.();
    void this.run();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every open market — each is independent, same "isolate the blast radius per unit of work" shape as `MarketFactoryService.run()`: one market's RPC hiccup never stops the rest from being recorded. */
  async run(): Promise<void> {
    const open = this.markets.list().filter((m) => m.status === 'watching');
    for (const m of open) {
      try {
        const { yesBps, noBps } = await this.stellar.getPrice(m.contractId);
        this.snapshots.record(m.contractId, yesBps, noBps);
      } catch (err) {
        this.logger.warn(`odds snapshot failed for ${m.contractId}: ${(err as Error).message}`);
      }
    }
    this.snapshots.pruneOlderThan(Date.now() - PRUNE_WINDOW_MS);
  }
}
