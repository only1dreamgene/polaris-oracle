import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WatchedMarket } from './market.types';

/**
 * Nest can't inject a bare `string` (or number/boolean) as a provider token
 * — DI tokens need identity, and primitives don't have any of their own, so
 * two `string`-typed bindings would collide. A dedicated Symbol gives the
 * DB path its own identity; tests bind it to `':memory:'`.
 */
export const MARKETS_DB_PATH = Symbol('MARKETS_DB_PATH');

@Injectable()
export class MarketRepository implements OnModuleDestroy {
  private readonly db: Database.Database;

  constructor(
    @Inject(MARKETS_DB_PATH) private readonly dbPath: string,
    config: ConfigService,
  ) {
    const path = this.dbPath ?? config.get<string>('marketsDbFile') ?? './data/markets.db';
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS markets (
        contract_id TEXT PRIMARY KEY,
        strike_price_cents TEXT NOT NULL,
        expiry INTEGER NOT NULL,
        grace_period_secs INTEGER NOT NULL,
        feed_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT,
        settle_tx_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  upsert(m: WatchedMarket): void {
    this.db
      .prepare(
        `INSERT INTO markets (contract_id, strike_price_cents, expiry, grace_period_secs, feed_id, status, last_error, settle_tx_hash, created_at, updated_at)
         VALUES (@contractId, @strikePriceCents, @expiry, @gracePeriodSecs, @feedId, @status, @lastError, @settleTxHash, @createdAt, @updatedAt)
         ON CONFLICT(contract_id) DO UPDATE SET
           status = excluded.status,
           last_error = excluded.last_error,
           settle_tx_hash = excluded.settle_tx_hash,
           updated_at = excluded.updated_at`,
      )
      .run({
        ...m,
        lastError: m.lastError ?? null,
        settleTxHash: m.settleTxHash ?? null,
      });
  }

  getAll(): WatchedMarket[] {
    const rows = this.db.prepare(`SELECT * FROM markets ORDER BY created_at DESC`).all() as any[];
    return rows.map(rowToMarket);
  }

  getById(contractId: string): WatchedMarket | undefined {
    const row = this.db
      .prepare(`SELECT * FROM markets WHERE contract_id = ?`)
      .get(contractId) as any;
    return row ? rowToMarket(row) : undefined;
  }

  onModuleDestroy(): void {
    this.db.close();
  }
}

function rowToMarket(row: any): WatchedMarket {
  return {
    contractId: row.contract_id,
    strikePriceCents: row.strike_price_cents,
    expiry: row.expiry,
    gracePeriodSecs: row.grace_period_secs,
    feedId: row.feed_id,
    status: row.status,
    lastError: row.last_error ?? undefined,
    settleTxHash: row.settle_tx_hash ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
