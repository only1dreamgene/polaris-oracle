import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { StellarService } from './stellar.service';
import { AuthRelayService } from './auth-relay.service';
import { WalletDeployRateLimiter } from './wallet-deploy-rate-limiter.service';
import { AdminActivityRepository, type WalletActionFunction } from './admin-activity.repository';
import { feeBearingAmount } from './wire-args';
import { DeployWalletDto } from './dto/deploy-wallet.dto';
import { PrepareAuthDto } from './dto/prepare-auth.dto';
import { SubmitAuthDto } from './dto/submit-auth.dto';

/**
 * Passkey smart-wallet endpoints: gasless deploy (this process pays), and
 * the two-step sponsored-transaction relay (`prepare` / `submit`) described
 * in `AuthRelayService`.
 */
@Controller('wallets')
export class WalletController {
  private readonly logger = new Logger(WalletController.name);

  constructor(
    private readonly stellar: StellarService,
    private readonly relay: AuthRelayService,
    private readonly config: ConfigService,
    private readonly deployRateLimiter: WalletDeployRateLimiter,
    private readonly activity: AdminActivityRepository,
  ) {}

  /**
   * The address a passkey with this public key resolves to, whether or not
   * it's been deployed yet — the "portable identity" lookup: a caller can
   * check this before deciding whether to prompt registration or just sign
   * a bettor in. Free (a simulated read), not a transaction.
   */
  @Get('resolve')
  async resolve(@Query('publicKeyHex') publicKeyHex: string) {
    const factoryId = this.config.get<string>('smartWalletFactoryContract');
    if (!publicKeyHex) {
      throw new BadRequestException('publicKeyHex query param is required');
    }
    if (!factoryId) {
      throw new BadRequestException('SMART_WALLET_FACTORY_CONTRACT must be configured to resolve wallets');
    }
    const address = await this.stellar.resolveWallet(factoryId, Buffer.from(publicKeyHex, 'hex'));
    return { address };
  }

  @Post('deploy')
  async deploy(@Req() req: Request, @Body() dto: DeployWalletDto) {
    if (!this.deployRateLimiter.tryConsume(req.ip ?? 'unknown')) {
      throw new HttpException('wallet deploy rate limit exceeded — try again in an hour', HttpStatus.TOO_MANY_REQUESTS);
    }
    const factoryId = this.config.get<string>('smartWalletFactoryContract');
    if (!factoryId) {
      throw new BadRequestException('SMART_WALLET_FACTORY_CONTRACT must be configured to deploy wallets');
    }
    const address = await this.stellar.deployWallet(factoryId, Buffer.from(dto.publicKeyHex, 'hex'));
    return { address };
  }

  @Post('tx/prepare')
  async prepare(@Body() dto: PrepareAuthDto) {
    return this.relay.prepare(dto.walletAddress, dto.contractId, dto.function, dto.args, dto.contractKind);
  }

  @Post('tx/submit')
  async submit(@Body() dto: SubmitAuthDto) {
    const result = await this.relay.submit(
      dto.contractId,
      dto.function,
      dto.args,
      dto.entryXdr,
      dto.validUntilLedgerSeq,
      {
        authenticatorDataHex: dto.assertion.authenticatorDataHex,
        clientDataJsonBase64: dto.assertion.clientDataJsonBase64,
        signatureHex: dto.assertion.signatureHex,
      },
      dto.contractKind,
    );
    // Best-effort admin-dashboard logging, after the on-chain result is
    // already confirmed — never let this affect the real response. See
    // AdminActivityRepository's doc comment: a read-side cache, not a
    // second source of truth, so a failure here is just a dropped
    // dashboard row, not something worth failing the request over.
    try {
      const feeBps = ['buy', 'sell'].includes(dto.function)
        ? await (dto.contractKind === 'perpetual'
            ? this.stellar.getPerpetualFee(dto.contractId)
            : this.stellar.getFee(dto.contractId))
        : undefined;
      this.activity.recordWalletAction({
        contractId: dto.contractId,
        walletAddress: result.walletAddress,
        functionName: dto.function as WalletActionFunction,
        collateralAmount: feeBearingAmount(dto.function, dto.args),
        feeBps,
        txHash: result.txHash,
        source: 'passkey',
      });
    } catch (err) {
      this.logger.warn(`failed to record admin-activity row for tx ${result.txHash}: ${(err as Error).message}`);
    }
    return { txHash: result.txHash };
  }
}
