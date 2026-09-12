import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WatchedPerpetual } from './perpetual.types';

/** See `MARKETS_DB_PATH`'s doc comment — same reason this needs its own DI token. */
export const PERPETUALS_DB_PATH = Symbol('PERPETUALS_DB_PATH');

@Injectable()
export class PerpetualRepository implements OnModuleDestroy {
  private readonly db: Database.Database;

  constructor(
    @Inject(PERPETUALS_DB_PATH) private readonly dbPath: string,
    config: ConfigService,
  ) {
    // Same sqlite file as classic markets by default — one `data/` dir to
    // operate, not two — just a separate table, since the two shapes don't
    // overlap (see `perpetual.types.ts`'s doc comment).
    const path = this.dbPath ?? config.get<string>('marketsDbFile') ?? './data/markets.db';
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS perpetuals (
        contract_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        last_error TEXT,
        terminate_tx_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  upsert(p: WatchedPerpetual): void {
    this.db
      .prepare(
        `INSERT INTO perpetuals (contract_id, status, last_error, terminate_tx_hash, created_at, updated_at)
         VALUES (@contractId, @status, @lastError, @terminateTxHash, @createdAt, @updatedAt)
         ON CONFLICT(contract_id) DO UPDATE SET
           status = excluded.status,
           last_error = excluded.last_error,
           terminate_tx_hash = excluded.terminate_tx_hash,
           updated_at = excluded.updated_at`,
      )
      .run({
        ...p,
        lastError: p.lastError ?? null,
        terminateTxHash: p.terminateTxHash ?? null,
      });
  }

  getAll(): WatchedPerpetual[] {
    const rows = this.db.prepare(`SELECT * FROM perpetuals ORDER BY created_at DESC`).all() as any[];
    return rows.map(rowToPerpetual);
  }

  getById(contractId: string): WatchedPerpetual | undefined {
    const row = this.db.prepare(`SELECT * FROM perpetuals WHERE contract_id = ?`).get(contractId) as any;
    return row ? rowToPerpetual(row) : undefined;
  }

  onModuleDestroy(): void {
    this.db.close();
  }
}

function rowToPerpetual(row: any): WatchedPerpetual {
  return {
    contractId: row.contract_id,
    status: row.status,
    lastError: row.last_error ?? undefined,
    terminateTxHash: row.terminate_tx_hash ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
