import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MARKETS_DB_PATH } from './market.repository';

export interface OddsSnapshotRow {
  yesBps: number;
  noBps: number;
  capturedAt: number;
}

/**
 * Backs the frontend's "Chg" column (see `polaris-frontend`'s markets
 * ticker list) — a real historical odds snapshot, not a fabricated number.
 * Same SQLite file as `MarketRepository`/`AdminActivityRepository` (see
 * `AdminActivityRepository`'s doc comment for why a second `better-sqlite3`
 * connection to the same WAL-mode file is fine). Read-side only: nothing
 * else in this system depends on this table being complete or accurate —
 * a gap in coverage just means `closestBefore` returns nothing and the
 * caller shows no change, never a wrong one.
 */
@Injectable()
export class OddsSnapshotRepository implements OnModuleDestroy {
  private readonly db: Database.Database;

  constructor(@Inject(MARKETS_DB_PATH) dbPath: string, config: ConfigService) {
    const path = dbPath ?? config.get<string>('marketsDbFile') ?? './data/markets.db';
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS odds_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_id TEXT NOT NULL,
        yes_bps INTEGER NOT NULL,
        no_bps INTEGER NOT NULL,
        captured_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_odds_snapshots_contract_captured ON odds_snapshots(contract_id, captured_at);
    `);
  }

  record(contractId: string, yesBps: number, noBps: number, capturedAt: number = Date.now()): void {
    this.db
      .prepare(`INSERT INTO odds_snapshots (contract_id, yes_bps, no_bps, captured_at) VALUES (?, ?, ?, ?)`)
      .run(contractId, yesBps, noBps, capturedAt);
  }

  /** The most recent snapshot at or before `atOrBeforeMs` — the natural query for "what were the odds ~N ago", tolerant of the snapshot interval not landing on the exact requested moment. `undefined` if this market has no snapshot that old yet (too new, or the snapshot service hadn't run yet). */
  closestBefore(contractId: string, atOrBeforeMs: number): OddsSnapshotRow | undefined {
    const row = this.db
      .prepare(
        `SELECT yes_bps as yesBps, no_bps as noBps, captured_at as capturedAt
         FROM odds_snapshots WHERE contract_id = ? AND captured_at <= ?
         ORDER BY captured_at DESC LIMIT 1`,
      )
      .get(contractId, atOrBeforeMs) as OddsSnapshotRow | undefined;
    return row;
  }

  /** Bounds table growth for a long-running deployment — no market or perpetual in this system runs longer than a few days (expiry + grace period), so anything older than that is dead weight, never a value any caller still reads. */
  pruneOlderThan(cutoffMs: number): void {
    this.db.prepare(`DELETE FROM odds_snapshots WHERE captured_at < ?`).run(cutoffMs);
  }

  onModuleDestroy(): void {
    this.db.close();
  }
}
