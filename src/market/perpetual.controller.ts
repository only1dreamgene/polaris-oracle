import { BadRequestException, Body, Controller, Get, HttpCode, Logger, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PerpetualService } from './perpetual.service';
import { StellarService } from './stellar.service';
import { OracleService } from './oracle.service';
import { AdminGuard } from './admin.guard';
import { AdminActivityRepository } from './admin-activity.repository';
import { CreatePerpetualDto } from './dto/create-perpetual.dto';

/**
 * Deliberately its own controller/route family (`/perpetuals`, not folded
 * into `/markets`) — see the top-level README/plan for why: a perpetual
 * has no strike/expiry/settle, so a shared schema or shared list endpoint
 * would mean a pile of fields meaningless for one contract kind or the
 * other. No `factory/run`/`watch`-from-chain endpoints yet either — unlike
 * classic markets, there's no recurring "the old one expired, deploy a
 * replacement" cycle to automate (a perpetual never expires), so creation
 * here is a one-shot admin action.
 */
@Controller('perpetuals')
export class PerpetualController {
  private readonly logger = new Logger(PerpetualController.name);

  /**
   * Serializes `checkpoint()` calls within this process — see that
   * method's doc comment for the race it closes. A resolved promise this
   * process chains onto rather than a real mutex library: the lock only
   * ever needs to order *this backend's own* async calls one after
   * another, never block across processes, so a bare promise chain is
   * enough.
   */
  private checkpointQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly perpetuals: PerpetualService,
    private readonly stellar: StellarService,
    private readonly oracle: OracleService,
    private readonly config: ConfigService,
    private readonly activity: AdminActivityRepository,
  ) {}

  @Get()
  list() {
    return this.perpetuals.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const p = this.perpetuals.get(id);
    if (!p) throw new NotFoundException(`no tracked perpetual ${id}`);
    return p;
  }

  @Get(':id/state')
  async state(@Param('id') id: string) {
    return this.stellar.getPerpetualState(id);
  }

  @Get(':id/position')
  async position(@Param('id') id: string, @Query('address') address: string) {
    if (!address) throw new BadRequestException('address query param is required');
    const [yes, no] = await this.stellar.getPerpetualPosition(id, address);
    return { yes: yes.toString(), no: no.toString() };
  }

  @Get(':id/price')
  async price(@Param('id') id: string) {
    return this.stellar.getPerpetualPrice(id);
  }

  @Get(':id/fee')
  async fee(@Param('id') id: string) {
    return { feeBps: await this.stellar.getPerpetualFee(id) };
  }

  @Post('create')
  @UseGuards(AdminGuard)
  async create(@Body() dto: CreatePerpetualDto) {
    const nativeXlmSac = this.config.get<string>('nativeXlmSac');
    const treasury = this.config.get<string>('treasuryAddress') ?? this.stellar.oraclePublicKey;
    if (!nativeXlmSac) {
      throw new BadRequestException('NATIVE_XLM_SAC must be configured to create a perpetual');
    }

    const { contractId, initTxHash } = await this.stellar.deployPerpetual({
      baseFeeBps: dto.baseFeeBps,
      minFeeBps: dto.minFeeBps,
      treasury,
      initialLiquidityStroops: BigInt(dto.initialLiquidityStroops),
      collateralAsset: nativeXlmSac,
      priceOracle: this.buildPriceOracleParams(nativeXlmSac),
    });

    const watched = this.perpetuals.watch(contractId);
    return { ...watched, initTxHash };
  }

  /**
   * `undefined` unless *every* piece needed for the full
   * Lazer+Reflector+RedStone(mock) bundle is configured — see
   * `configuration.ts`'s `mockRedstoneContract` doc comment for why this
   * is all-or-nothing rather than a partial bundle.
   */
  private buildPriceOracleParams(nativeXlmSac: string) {
    const lazerContract = this.config.get<string>('lazerContract');
    const reflectorContract = this.config.get<string>('reflectorContract');
    const mockRedstoneContract = this.config.get<string>('mockRedstoneContract');
    if (!lazerContract || !reflectorContract || !mockRedstoneContract) return undefined;

    return {
      lazerContract,
      feedId: this.config.get<number>('xlmUsdFeedId')!,
      reflectorContract,
      reflectorAsset: this.config.get<string>('reflectorAsset')!,
      reflectorMaxStalenessSecs: BigInt(this.config.get<string>('reflectorMaxStalenessSecs')!),
      reflectorToleranceBps: this.config.get<number>('reflectorToleranceBps')!,
      redstoneContract: mockRedstoneContract,
      nativeXlmSac,
      redstoneMaxStalenessSecs: BigInt(this.config.get<string>('redstoneMaxStalenessSecs')!),
      redstoneToleranceBps: this.config.get<number>('redstoneToleranceBps')!,
    };
  }

  /**
   * Admin-triggered, not scheduled — matches this contract's other
   * lifecycle actions (`create`/`terminate`), both one-shot admin calls
   * rather than an automated interval like `MarketFactoryService`'s.
   * Refreshes `polaris-mock-redstone`'s price first (see
   * `StellarService.refreshMockRedstonePrice`'s doc comment for why that's
   * this caller's job, not the mock's), then calls
   * `record_price_checkpoint` with a real signed Lazer payload — the
   * *exact* same `OracleService.waitForUpdate` path `MarketService.trySettle`
   * already uses. Unlike `trySettle`, there's no fallback action to take
   * when the oracle is unavailable (checkpointing is purely
   * informational — there's nothing to cancel toward), so this fails the
   * request cleanly with a clear message instead of silently no-oping or
   * (the bug this fixes, caught live) letting the rejection propagate
   * uncaught into a bare 500.
   *
   * The refresh-then-record sequence is two *separate* on-chain
   * transactions, not one atomic call — `record_price_checkpoint` reads
   * the mock's *live* state at its own execution time, not a snapshot
   * from the refresh. `mockRedstoneContract` is one shared config value
   * used by every perpetual this backend creates, and its `set_price` is
   * deliberately unauthenticated (any testnet account can call it — see
   * that contract's own doc comment), so a second `checkpoint()` call
   * (this backend racing itself — two admin tabs, a double-click) landing
   * between this call's two transactions would silently corrupt this
   * call's result with an unrelated price, surfacing as a confusing
   * `OracleDivergence` caused by a caller that was never even checkpointing
   * this perpetual. `checkpointQueue` closes the "this backend races
   * itself" case by serializing every `checkpoint()` call process-wide.
   * It can NOT close the remaining "a third party pokes the shared mock
   * directly, off this backend entirely" window — the mock's own
   * unauthenticated-by-design nature makes that structurally impossible
   * to prevent from here; stated plainly rather than pretended away (see
   * `polaris-oracle/README.md`'s "Perpetual markets" section).
   */
  @Post(':id/checkpoint')
  @UseGuards(AdminGuard)
  @HttpCode(200)
  checkpoint(@Param('id') id: string) {
    const next = this.checkpointQueue.then(() => this.doCheckpoint(id), () => this.doCheckpoint(id));
    // Swallow this attempt's own rejection from the queue chain itself —
    // otherwise an unhandled rejection warning fires even though the
    // caller (below) does see and handle the real error via `next`.
    this.checkpointQueue = next.catch(() => undefined);
    return next;
  }

  private async doCheckpoint(id: string) {
    const mockRedstoneContract = this.config.get<string>('mockRedstoneContract');
    if (!mockRedstoneContract) {
      throw new BadRequestException('MOCK_REDSTONE_CONTRACT must be configured to checkpoint a perpetual');
    }
    if (!this.oracle.isAvailable) {
      throw new BadRequestException('Pyth Lazer is not available (PYTH_LAZER_TOKEN not configured?) — cannot checkpoint');
    }
    const feedId = this.config.get<number>('xlmUsdFeedId')!;
    let payload: Buffer;
    let priceCents: bigint | undefined;
    try {
      ({ payload, priceCents } = await this.oracle.waitForUpdate(feedId));
    } catch (err) {
      throw new BadRequestException(`Pyth Lazer update failed: ${(err as Error).message}`);
    }
    if (priceCents === undefined) {
      throw new BadRequestException('Lazer update had no parsed price to refresh the mock RedStone leg with');
    }
    await this.stellar.refreshMockRedstonePrice(mockRedstoneContract, priceCents);
    const txHash = await this.stellar.recordPriceCheckpoint(id, payload);
    return { txHash, ...(await this.stellar.getPerpetualState(id)) };
  }

  @Post(':id/terminate')
  @UseGuards(AdminGuard)
  @HttpCode(200)
  async terminate(@Param('id') id: string) {
    await this.perpetuals.triggerTerminate(id);
    const p = this.perpetuals.get(id);
    // Best-effort admin-dashboard logging — same pattern (and same
    // reasoning for never failing the request over it) as
    // wallet.controller.ts's `submit` handler. `terminate`'s payout
    // (0.5 collateral per complementary YES+NO pair, credited to
    // `treasury`) isn't a swap fee like buy/sell, so it's logged as its
    // own function kind rather than folded into fee-revenue accounting —
    // see AdminController.feeRevenue()'s doc comment on why only
    // buy/sell ever pay a fee.
    if (p?.terminateTxHash) {
      try {
        this.activity.recordWalletAction({
          contractId: id,
          walletAddress: this.stellar.deployerPublicKey,
          functionName: 'terminate',
          collateralAmount: undefined,
          feeBps: undefined,
          txHash: p.terminateTxHash,
          source: 'admin',
        });
      } catch (err) {
        this.logger.warn(`failed to record admin-activity row for tx ${p.terminateTxHash}: ${(err as Error).message}`);
      }
    }
    return p;
  }
}
