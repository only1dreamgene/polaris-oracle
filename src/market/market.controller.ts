import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketService } from './market.service';
import { StellarService } from './stellar.service';
import { FaucetService } from './faucet.service';
import { AdminGuard } from './admin.guard';
import { CreateMarketDto } from './dto/create-market.dto';
import { WatchMarketDto } from './dto/watch-market.dto';
import { FaucetDto } from './dto/faucet.dto';

function serializeBigInts<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

@Controller('markets')
export class MarketController {
  constructor(
    private readonly markets: MarketService,
    private readonly stellar: StellarService,
    private readonly faucet: FaucetService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  list() {
    return this.markets.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const m = this.markets.get(id);
    if (!m) throw new NotFoundException(`no tracked market ${id}`);
    return m;
  }

  @Get(':id/state')
  async state(@Param('id') id: string) {
    const state = await this.stellar.getMarketState(id);
    return serializeBigInts(state);
  }

  @Get(':id/position')
  async position(@Param('id') id: string, @Query('address') address: string) {
    if (!address) throw new BadRequestException('address query param is required');
    const [yes, no] = await this.stellar.getPosition(id, address);
    return { yes: yes.toString(), no: no.toString() };
  }

  @Get(':id/price')
  async price(@Param('id') id: string) {
    return this.stellar.getPrice(id);
  }

  @Post('faucet')
  @HttpCode(200)
  async fundFaucet(@Body() dto: FaucetDto) {
    if (!this.faucet.tryConsume(dto.address)) {
      throw new HttpException('faucet rate limit exceeded — try again in an hour', HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.faucet.fund(dto.address);
  }

  @Post('create')
  @UseGuards(AdminGuard)
  async create(@Body() dto: CreateMarketDto) {
    const lazerContract = this.config.get<string>('lazerContract');
    const nativeXlmSac = this.config.get<string>('nativeXlmSac');
    const treasury = this.config.get<string>('treasuryAddress') ?? this.stellar.oraclePublicKey;
    const feedId = this.config.get<number>('xlmUsdFeedId')!;
    if (!lazerContract || !nativeXlmSac) {
      throw new BadRequestException('LAZER_CONTRACT and NATIVE_XLM_SAC must be configured to create a market');
    }

    const { contractId, initTxHash } = await this.stellar.deployMarket({
      strikePriceCents: BigInt(dto.strikePriceCents),
      expiry: BigInt(dto.expiry),
      gracePeriodSecs: BigInt(dto.gracePeriodSecs),
      lazerContract,
      feedId,
      feeBps: dto.feeBps,
      treasury,
      initialLiquidityStroops: BigInt(dto.initialLiquidityStroops),
      collateralAsset: nativeXlmSac,
    });

    const watched = this.markets.watch({
      contractId,
      strikePriceCents: dto.strikePriceCents,
      expiry: dto.expiry,
      gracePeriodSecs: dto.gracePeriodSecs,
      feedId,
    });

    return { ...watched, initTxHash };
  }

  @Post('watch')
  @UseGuards(AdminGuard)
  async watch(@Body() dto: WatchMarketDto) {
    const state = await this.stellar.getMarketState(dto.contractId);
    return this.markets.watch({
      contractId: dto.contractId,
      strikePriceCents: state.strikePrice,
      expiry: Number(state.expiry),
      gracePeriodSecs: Number(state.gracePeriod),
      feedId: state.feedId,
    });
  }

  @Post(':id/settle')
  @UseGuards(AdminGuard)
  @HttpCode(200)
  async settle(@Param('id') id: string) {
    await this.markets.triggerSettle(id);
    return this.markets.get(id);
  }

  @Post(':id/cancel')
  @UseGuards(AdminGuard)
  @HttpCode(200)
  async cancel(@Param('id') id: string) {
    await this.markets.triggerCancel(id);
    return this.markets.get(id);
  }
}
