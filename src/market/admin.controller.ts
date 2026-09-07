import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminGuard } from './admin.guard';
import { MarketRepository } from './market.repository';
import { EmailAuthRepository } from './email-auth.repository';
import { AdminActivityRepository } from './admin-activity.repository';
import { StellarService } from './stellar.service';

const DEFAULT_LIST_LIMIT = 50;

/**
 * The admin dashboard's read API — everything here is `AdminGuard`-gated
 * and read-only (the existing market-lifecycle admin actions — create,
 * settle, cancel, run the factory — stay on `MarketController`, which
 * already owns them).
 *
 * A dedicated controller rather than folding this into `MarketController`
 * (already the largest, most mixed one): this is a distinct concern
 * (dashboard aggregation) from market lifecycle management.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly config: ConfigService,
    private readonly markets: MarketRepository,
    private readonly emailWallets: EmailAuthRepository,
    private readonly activity: AdminActivityRepository,
    private readonly stellar: StellarService,
  ) {}

  @Get('overview')
  async overview() {
    const allMarkets = this.markets.getAll();
    const marketsByStatus: Record<string, number> = {};
    for (const m of allMarkets) {
      marketsByStatus[m.status] = (marketsByStatus[m.status] ?? 0) + 1;
    }

    const vaultContract = this.config.get<string>('vaultContract');
    const vaultBalanceStroops = vaultContract ? (await this.stellar.vaultBalance(vaultContract)).toString() : null;

    return {
      totalMarkets: allMarkets.length,
      marketsByStatus,
      vaultBalanceStroops,
      totalWalletActions: this.activity.countWalletActions(),
      settlementChecksByOutcome: this.activity.countSettlementChecksByOutcome(),
    };
  }

  /**
   * "Estimated," not a ledger truth — see `wallet.controller.ts`/
   * `email-auth.controller.ts`'s recording sites for why `fee_bps` is
   * captured live at trade time rather than reconstructed here: the fee
   * curve depends on the market's `total_supply` at the moment of the
   * trade, which isn't recoverable after the fact, and a live read still
   * has a small race window against the trade actually landing.
   *
   * Only `buy`/`sell` ever pay a fee — `split`/`merge`/`redeem`/`transfer`
   * never touch the contract's `apply_fee`, so including them here would
   * silently overcount.
   */
  @Get('fee-revenue')
  feeRevenue() {
    const rows = this.activity.getWalletActionsByFunction(['buy', 'sell']);
    let totalStroops = 0n;
    const byMarket = new Map<string, bigint>();
    for (const row of rows) {
      if (row.collateral_amount === null || row.fee_bps === null) continue;
      const fee = (BigInt(row.collateral_amount) * BigInt(row.fee_bps)) / 10_000n;
      totalStroops += fee;
      byMarket.set(row.contract_id, (byMarket.get(row.contract_id) ?? 0n) + fee);
    }
    return {
      totalStroops: totalStroops.toString(),
      byMarket: [...byMarket.entries()].map(([contractId, stroops]) => ({
        contractId,
        stroops: stroops.toString(),
      })),
      sampleSize: rows.length,
    };
  }

  /** No deposit history — deposits are operator-initiated directly via the Stellar CLI, never touching this backend. Withdrawals below are only the ones this backend itself made (market-factory seed funding). */
  @Get('treasury')
  async treasury(@Query('limit') limit?: string) {
    const vaultContract = this.config.get<string>('vaultContract');
    if (!vaultContract) {
      return { configured: false as const };
    }
    const [balance, totalDeposited] = await Promise.all([
      this.stellar.vaultBalance(vaultContract),
      this.stellar.vaultTotalDeposited(vaultContract),
    ]);
    return {
      configured: true as const,
      vaultContract,
      balanceStroops: balance.toString(),
      totalDepositedStroops: totalDeposited.toString(),
      recentWithdrawals: this.activity.getRecentVaultFlows(parseLimit(limit)),
    };
  }

  /**
   * Passkey-wallet coverage here means "seen since this dashboard shipped,"
   * not exhaustive — there's no registry, on-chain or off, of every passkey
   * wallet ever deployed (see `wallet.controller.ts`'s `deploy` handler,
   * which never persists anything). Email wallets ARE exhaustive, since
   * every one is created through and recorded by this backend.
   */
  @Get('wallets')
  wallets() {
    const passkeyAddresses = this.activity.getDistinctWalletAddresses();
    const emailWallets = this.emailWallets.getAllWallets().map((w) => ({
      email: w.email,
      address: w.address,
      createdAt: w.created_at,
      // Deliberately not returning encrypted_private_key/public_key_hex —
      // this endpoint is for the dashboard's own display, not a credential
      // export, even though it's already AdminGuard-gated.
    }));
    return { passkeyAddressesSeen: passkeyAddresses, emailWallets };
  }

  @Get('network')
  async network() {
    const health = await this.stellar.getNetworkHealth();
    return {
      ...health,
      oraclePublicKey: this.stellar.oraclePublicKey,
      deployerPublicKey: this.stellar.deployerPublicKey,
      contracts: {
        vaultContract: this.config.get<string>('vaultContract'),
        lazerContract: this.config.get<string>('lazerContract'),
        reflectorContract: this.config.get<string>('reflectorContract'),
        nativeXlmSac: this.config.get<string>('nativeXlmSac'),
        smartWalletFactoryContract: this.config.get<string>('smartWalletFactoryContract'),
      },
      wasmHashes: {
        market: this.config.get<string>('marketWasmHash'),
        smartWallet: this.config.get<string>('smartWalletWasmHash'),
      },
    };
  }

  /**
   * This will render empty in any environment without a real
   * `PYTH_LAZER_TOKEN` configured — `OracleService.isAvailable` is `false`,
   * so `trySettle` always takes the cancel-fallback branch and never
   * reaches the cross-check that populates this table at all. That's
   * expected, not a bug in this endpoint; the frontend's empty state should
   * say so rather than imply something's broken.
   */
  @Get('settlement-checks')
  settlementChecks(@Query('limit') limit?: string) {
    return { checks: this.activity.getRecentSettlementChecks(parseLimit(limit)) };
  }
}

function parseLimit(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 500 ? n : DEFAULT_LIST_LIMIT;
}
