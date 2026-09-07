import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MARKETS_DB_PATH } from './market.repository';

export type WalletActionFunction = 'buy' | 'sell' | 'split' | 'merge' | 'redeem' | 'transfer';
export type WalletActionSource = 'passkey' | 'email';
export type SettlementCheckOutcome = 'ok' | 'skipped' | 'failed';

export interface WalletActionRow {
  id: number;
  contract_id: string;
  wallet_address: string;
  function: WalletActionFunction;
  collateral_amount: string | null;
  fee_bps: number | null;
  tx_hash: string;
  source: WalletActionSource;
  created_at: number;
}

export interface VaultFlowRow {
  id: number;
  vault_contract_id: string;
  amount_stroops: string;
  market_contract_id: string;
  tx_hash: string;
  created_at: number;
}

export interface SettlementCheckRow {
  id: number;
  market_contract_id: string;
  lazer_price_cents: string | null;
  hermes_price_cents: string | null;
  divergence_bps: number | null;
  outcome: SettlementCheckOutcome;
  reason: string | null;
  created_at: number;
}

/**
 * A read-side cache for the admin dashboard, not a second source of truth
 * — `MarketRepository`, the vault, and the contracts themselves stay
 * authoritative. Forward-looking only: rows are written at the moment an
 * action is confirmed, so nothing before this shipped appears here, and a
 * crash between on-chain confirmation and the write below drops one row
 * with no reconciliation — unlike `reconcileWithChain`'s job elsewhere in
 * this codebase, that's an acceptable loss here since nothing authoritative
 * is at stake, just one dashboard row.
 *
 * Same SQLite file as `MarketRepository`/`EmailAuthRepository` — see
 * `EmailAuthRepository`'s doc comment for why a second `better-sqlite3`
 * connection to the same WAL-mode file is fine.
 */
@Injectable()
export class AdminActivityRepository implements OnModuleDestroy {
  private readonly db: Database.Database;

  constructor(@Inject(MARKETS_DB_PATH) dbPath: string, config: ConfigService) {
    const path = dbPath ?? config.get<string>('marketsDbFile') ?? './data/markets.db';
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallet_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_id TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        function TEXT NOT NULL,
        collateral_amount TEXT,
        fee_bps INTEGER,
        tx_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_actions_created_at ON wallet_actions(created_at);
      CREATE INDEX IF NOT EXISTS idx_wallet_actions_wallet_address ON wallet_actions(wallet_address);

      CREATE TABLE IF NOT EXISTS vault_flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vault_contract_id TEXT NOT NULL,
        amount_stroops TEXT NOT NULL,
        market_contract_id TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vault_flows_created_at ON vault_flows(created_at);

      CREATE TABLE IF NOT EXISTS settlement_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_contract_id TEXT NOT NULL,
        lazer_price_cents TEXT,
        hermes_price_cents TEXT,
        divergence_bps INTEGER,
        outcome TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_settlement_checks_created_at ON settlement_checks(created_at);
    `);
  }

  recordWalletAction(action: {
    contractId: string;
    walletAddress: string;
    functionName: WalletActionFunction;
    collateralAmount: string | undefined;
    feeBps: number | undefined;
    txHash: string;
    source: WalletActionSource;
  }): void {
    this.db
      .prepare(
        `INSERT INTO wallet_actions (contract_id, wallet_address, function, collateral_amount, fee_bps, tx_hash, source, created_at)
         VALUES (@contractId, @walletAddress, @functionName, @collateralAmount, @feeBps, @txHash, @source, @createdAt)`,
      )
      .run({
        ...action,
        collateralAmount: action.collateralAmount ?? null,
        feeBps: action.feeBps ?? null,
        createdAt: Date.now(),
      });
  }

  recordVaultFlow(flow: {
    vaultContractId: string;
    amountStroops: string;
    marketContractId: string;
    txHash: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO vault_flows (vault_contract_id, amount_stroops, market_contract_id, tx_hash, created_at)
         VALUES (@vaultContractId, @amountStroops, @marketContractId, @txHash, @createdAt)`,
      )
      .run({ ...flow, createdAt: Date.now() });
  }

  recordSettlementCheck(check: {
    marketContractId: string;
    lazerPriceCents: bigint | undefined;
    hermesPriceCents: bigint | undefined;
    divergenceBps: number | undefined;
    outcome: SettlementCheckOutcome;
    reason: string | undefined;
  }): void {
    this.db
      .prepare(
        `INSERT INTO settlement_checks (market_contract_id, lazer_price_cents, hermes_price_cents, divergence_bps, outcome, reason, created_at)
         VALUES (@marketContractId, @lazerPriceCents, @hermesPriceCents, @divergenceBps, @outcome, @reason, @createdAt)`,
      )
      .run({
        marketContractId: check.marketContractId,
        lazerPriceCents: check.lazerPriceCents?.toString() ?? null,
        hermesPriceCents: check.hermesPriceCents?.toString() ?? null,
        divergenceBps: check.divergenceBps ?? null,
        outcome: check.outcome,
        reason: check.reason ?? null,
        createdAt: Date.now(),
      });
  }

  /** Only `buy`/`sell` actually pay a fee (see `apply_fee` in the market contract) — callers must filter, this isn't done implicitly by the table. */
  getWalletActionsByFunction(functions: WalletActionFunction[]): WalletActionRow[] {
    const placeholders = functions.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM wallet_actions WHERE function IN (${placeholders}) ORDER BY created_at DESC`)
      .all(...functions) as WalletActionRow[];
  }

  getRecentWalletActions(limit: number): WalletActionRow[] {
    return this.db.prepare(`SELECT * FROM wallet_actions ORDER BY created_at DESC LIMIT ?`).all(limit) as WalletActionRow[];
  }

  countWalletActions(): number {
    return (this.db.prepare(`SELECT COUNT(*) as n FROM wallet_actions`).get() as { n: number }).n;
  }

  /** Distinct wallet addresses this backend has ever relayed/executed an action for — not an exhaustive registry, see the class doc comment. */
  getDistinctWalletAddresses(): string[] {
    return (this.db.prepare(`SELECT DISTINCT wallet_address FROM wallet_actions`).all() as { wallet_address: string }[]).map(
      (r) => r.wallet_address,
    );
  }

  getRecentVaultFlows(limit: number): VaultFlowRow[] {
    return this.db.prepare(`SELECT * FROM vault_flows ORDER BY created_at DESC LIMIT ?`).all(limit) as VaultFlowRow[];
  }

  getRecentSettlementChecks(limit: number): SettlementCheckRow[] {
    return this.db.prepare(`SELECT * FROM settlement_checks ORDER BY created_at DESC LIMIT ?`).all(limit) as SettlementCheckRow[];
  }

  countSettlementChecksByOutcome(): Record<SettlementCheckOutcome, number> {
    const rows = this.db.prepare(`SELECT outcome, COUNT(*) as n FROM settlement_checks GROUP BY outcome`).all() as {
      outcome: SettlementCheckOutcome;
      n: number;
    }[];
    const counts: Record<SettlementCheckOutcome, number> = { ok: 0, skipped: 0, failed: 0 };
    for (const row of rows) counts[row.outcome] = row.n;
    return counts;
  }

  onModuleDestroy(): void {
    this.db.close();
  }
}
