import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from './stellar.service';
import { OracleService } from './oracle.service';
import { MarketRepository } from './market.repository';
import type { WatchedMarket } from './market.types';

const SETTLE_TIMEOUT_MS = 30_000;

/**
 * Owns the in-memory timer state that drives settlement automation. The
 * contract itself is the source of truth for whether a market is actually
 * resolved — this is best-effort automation on top of it, not a second
 * source of truth. See the module doc below for the invariant that matters.
 *
 * Every failure path in `trySettle` falls through to a scheduled `cancel`
 * (never a silent stop) — the contract's permissionless `cancel` is the
 * backstop; this service just triggers it automatically so a bettor never
 * has to notice the oracle was down and call it themselves.
 */
@Injectable()
export class MarketService implements OnModuleInit {
  private readonly logger = new Logger(MarketService.name);
  private readonly settleTimers = new Map<string, NodeJS.Timeout>();
  private readonly cancelTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly repo: MarketRepository,
    private readonly stellar: StellarService,
    private readonly oracle: OracleService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    for (const m of this.repo.getAll()) {
      if (m.status === 'watching' || m.status === 'pending') {
        this.arm(m);
      }
    }
  }

  list(): WatchedMarket[] {
    return this.repo.getAll();
  }

  get(contractId: string): WatchedMarket | undefined {
    return this.repo.getById(contractId);
  }

  watch(m: Omit<WatchedMarket, 'status' | 'createdAt' | 'updatedAt'>): WatchedMarket {
    const now = Date.now();
    const watched: WatchedMarket = { ...m, status: 'watching', createdAt: now, updatedAt: now };
    this.repo.upsert(watched);
    this.arm(watched);
    return watched;
  }

  /** Admin manual retry — used when auto-settlement failed and an operator wants to force another attempt. */
  async triggerSettle(contractId: string): Promise<void> {
    const m = this.repo.getById(contractId);
    if (!m) throw new Error(`unknown market ${contractId}`);
    await this.trySettle(m);
  }

  async triggerCancel(contractId: string): Promise<void> {
    const m = this.repo.getById(contractId);
    if (!m) throw new Error(`unknown market ${contractId}`);
    await this.tryCancel(m);
  }

  private arm(m: WatchedMarket): void {
    const now = Date.now();
    const expiryMs = m.expiry * 1000;
    const graceEndMs = expiryMs + m.gracePeriodSecs * 1000;

    this.clearTimers(m.contractId);

    if (now < expiryMs) {
      const timer = setTimeout(() => void this.trySettle(m), expiryMs - now);
      this.settleTimers.set(m.contractId, timer);
    } else if (now < graceEndMs) {
      void this.trySettle(m);
    } else {
      void this.tryCancel(m);
    }
  }

  private scheduleCancelFallback(m: WatchedMarket): void {
    const graceEndMs = m.expiry * 1000 + m.gracePeriodSecs * 1000;
    const delay = Math.max(0, graceEndMs - Date.now());
    const existing = this.cancelTimers.get(m.contractId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => void this.tryCancel(m), delay);
    this.cancelTimers.set(m.contractId, timer);
    this.logger.log(`scheduled cancel fallback for ${m.contractId} in ${Math.round(delay / 1000)}s`);
  }

  private async trySettle(m: WatchedMarket): Promise<void> {
    if (m.status === 'settled' || m.status === 'cancelled') return;

    if (!this.oracle.isAvailable) {
      this.logger.warn(`oracle unavailable — scheduling cancel fallback for ${m.contractId}`);
      this.scheduleCancelFallback(m);
      return;
    }

    try {
      const payload = await this.oracle.waitForUpdate(m.feedId, SETTLE_TIMEOUT_MS);
      const txHash = await this.stellar.settle(m.contractId, payload);
      this.persist(m, { status: 'settled', settleTxHash: txHash, lastError: undefined });
      this.logger.log(`settled ${m.contractId} in tx ${txHash}`);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`settle failed for ${m.contractId}: ${message}`);
      this.persist(m, { status: 'pending', lastError: message });
      this.scheduleCancelFallback(m);
    }
  }

  private async tryCancel(m: WatchedMarket): Promise<void> {
    const current = this.repo.getById(m.contractId) ?? m;
    if (current.status === 'settled' || current.status === 'cancelled') return;

    try {
      const txHash = await this.stellar.cancel(m.contractId);
      this.persist(m, { status: 'cancelled', settleTxHash: txHash, lastError: undefined });
      this.logger.log(`cancelled ${m.contractId} in tx ${txHash}`);
    } catch (err) {
      const message = (err as Error).message;
      // Cancel is permissionless and idempotent-safe on-chain (a second
      // call after it's already Cancelled/Resolved just errors) — if this
      // was "already resolved by someone else", that's success, not a
      // failure to retry. Anything else, log and leave status as-is; an
      // admin can retry via /markets/:id/cancel.
      this.logger.error(`cancel failed for ${m.contractId}: ${message}`);
      this.persist(m, { status: 'pending', lastError: message });
    }
  }

  private persist(m: WatchedMarket, patch: Partial<WatchedMarket>): void {
    const updated: WatchedMarket = { ...m, ...patch, updatedAt: Date.now() };
    this.repo.upsert(updated);
    Object.assign(m, updated);
  }

  private clearTimers(contractId: string): void {
    const s = this.settleTimers.get(contractId);
    if (s) clearTimeout(s);
    const c = this.cancelTimers.get(contractId);
    if (c) clearTimeout(c);
  }
}
