import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MARKETS_DB_PATH } from './market.repository';

interface EmailCodeRow {
  email: string;
  code_hash: string;
  expires_at: number;
  attempts: number;
  created_at: number;
}

interface EmailWalletRow {
  email: string;
  address: string;
  public_key_hex: string;
  encrypted_private_key: string;
  created_at: number;
}

/**
 * Same SQLite file `MarketRepository` uses (one DB for the whole process,
 * one thing to back up) — `better-sqlite3` supports multiple connections
 * to the same WAL-mode file safely, so a second `Database` handle here is
 * fine rather than needing to thread the market repo's own handle through.
 */
@Injectable()
export class EmailAuthRepository {
  private readonly db: Database.Database;

  constructor(@Inject(MARKETS_DB_PATH) dbPath: string, config: ConfigService) {
    const path = dbPath ?? config.get<string>('marketsDbFile') ?? './data/markets.db';
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_login_codes (
        email TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS email_wallets (
        email TEXT PRIMARY KEY,
        address TEXT NOT NULL UNIQUE,
        public_key_hex TEXT NOT NULL,
        encrypted_private_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  saveCode(email: string, codeHash: string, expiresAt: number): void {
    this.db
      .prepare(
        `INSERT INTO email_login_codes (email, code_hash, expires_at, attempts, created_at)
         VALUES (@email, @codeHash, @expiresAt, 0, @createdAt)
         ON CONFLICT(email) DO UPDATE SET
           code_hash = excluded.code_hash,
           expires_at = excluded.expires_at,
           attempts = 0,
           created_at = excluded.created_at`,
      )
      .run({ email, codeHash, expiresAt, createdAt: Date.now() });
  }

  getCode(email: string): EmailCodeRow | undefined {
    return this.db.prepare('SELECT * FROM email_login_codes WHERE email = ?').get(email) as
      | EmailCodeRow
      | undefined;
  }

  incrementAttempts(email: string): void {
    this.db.prepare('UPDATE email_login_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
  }

  deleteCode(email: string): void {
    this.db.prepare('DELETE FROM email_login_codes WHERE email = ?').run(email);
  }

  getWallet(email: string): EmailWalletRow | undefined {
    return this.db.prepare('SELECT * FROM email_wallets WHERE email = ?').get(email) as
      | EmailWalletRow
      | undefined;
  }

  saveWallet(email: string, address: string, publicKeyHex: string, encryptedPrivateKey: string): void {
    this.db
      .prepare(
        `INSERT INTO email_wallets (email, address, public_key_hex, encrypted_private_key, created_at)
         VALUES (@email, @address, @publicKeyHex, @encryptedPrivateKey, @createdAt)`,
      )
      .run({ email, address, publicKeyHex, encryptedPrivateKey, createdAt: Date.now() });
  }
}
