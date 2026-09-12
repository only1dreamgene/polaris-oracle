import { BadRequestException, Body, Controller, Get, HttpCode, Logger, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PerpetualService } from './perpetual.service';
import { StellarService } from './stellar.service';
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

  constructor(
    private readonly perpetuals: PerpetualService,
    private readonly stellar: StellarService,
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
    });

    const watched = this.perpetuals.watch(contractId);
    return { ...watched, initTxHash };
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
