import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketController } from './market.controller';
import { PriceController } from './price.controller';
import { WalletController } from './wallet.controller';
import { EmailAuthController } from './email-auth.controller';
import { MarketService } from './market.service';
import { StellarService } from './stellar.service';
import { OracleService } from './oracle.service';
import { AuthRelayService } from './auth-relay.service';
import { FaucetService } from './faucet.service';
import { EmailAuthService } from './email-auth.service';
import { AdminGuard } from './admin.guard';
import { MarketRepository, MARKETS_DB_PATH } from './market.repository';
import { EmailAuthRepository } from './email-auth.repository';
import { EMAIL_SENDER, ConsoleEmailSender, ResendEmailSender } from './email-sender';

@Module({
  controllers: [MarketController, PriceController, WalletController, EmailAuthController],
  providers: [
    MarketService,
    StellarService,
    OracleService,
    AuthRelayService,
    FaucetService,
    EmailAuthService,
    AdminGuard,
    MarketRepository,
    EmailAuthRepository,
    ConsoleEmailSender,
    ResendEmailSender,
    {
      provide: MARKETS_DB_PATH,
      useFactory: (config: ConfigService) => config.get<string>('marketsDbFile'),
      inject: [ConfigService],
    },
    {
      provide: EMAIL_SENDER,
      useFactory: (config: ConfigService, consoleSender: ConsoleEmailSender, resendSender: ResendEmailSender) =>
        config.get<string>('emailProvider') === 'resend' ? resendSender : consoleSender,
      inject: [ConfigService, ConsoleEmailSender, ResendEmailSender],
    },
  ],
})
export class MarketModule {}
