import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
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
