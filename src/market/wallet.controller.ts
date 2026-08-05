import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from './stellar.service';
import { AuthRelayService } from './auth-relay.service';
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
  constructor(
    private readonly stellar: StellarService,
    private readonly relay: AuthRelayService,
    private readonly config: ConfigService,
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
  async deploy(@Body() dto: DeployWalletDto) {
    const factoryId = this.config.get<string>('smartWalletFactoryContract');
    const walletWasmHash = this.config.get<string>('smartWalletWasmHash');
    if (!factoryId || !walletWasmHash) {
      throw new BadRequestException(
        'SMART_WALLET_FACTORY_CONTRACT and SMART_WALLET_WASM_HASH must be configured to deploy wallets',
      );
    }
    const address = await this.stellar.deployWallet(
      factoryId,
      Buffer.from(dto.publicKeyHex, 'hex'),
      Buffer.from(walletWasmHash, 'hex'),
    );
    return { address };
  }

  @Post('tx/prepare')
  async prepare(@Body() dto: PrepareAuthDto) {
    return this.relay.prepare(dto.walletAddress, dto.contractId, dto.function, dto.args);
  }

  @Post('tx/submit')
  async submit(@Body() dto: SubmitAuthDto) {
    return this.relay.submit(
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
    );
  }
}
