import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketController } from './market.controller';
import { PerpetualController } from './perpetual.controller';
import { PriceController } from './price.controller';
import { WalletController } from './wallet.controller';
import { EmailAuthController } from './email-auth.controller';
import { AdminController } from './admin.controller';
import { MarketService } from './market.service';
import { PerpetualService } from './perpetual.service';
import { MarketFactoryService } from './market-factory.service';
import { MarketEvents } from './market-events';
import { StellarService } from './stellar.service';
import { OracleService } from './oracle.service';
import { AuthRelayService } from './auth-relay.service';
import { FaucetService } from './faucet.service';
import { WalletDeployRateLimiter } from './wallet-deploy-rate-limiter.service';
import { EmailAuthService } from './email-auth.service';
import { AdminGuard } from './admin.guard';
import { MarketRepository, MARKETS_DB_PATH } from './market.repository';
import { PerpetualRepository, PERPETUALS_DB_PATH } from './perpetual.repository';
import { EmailAuthRepository } from './email-auth.repository';
import { AdminActivityRepository } from './admin-activity.repository';
import { EMAIL_SENDER, ConsoleEmailSender, ResendEmailSender } from './email-sender';

@Module({
  controllers: [MarketController, PerpetualController, PriceController, WalletController, EmailAuthController, AdminController],
  providers: [
    MarketService,
    PerpetualService,
    MarketFactoryService,
    MarketEvents,
    StellarService,
    OracleService,
    AuthRelayService,
    FaucetService,
    WalletDeployRateLimiter,
    EmailAuthService,
    AdminGuard,
    MarketRepository,
    PerpetualRepository,
    EmailAuthRepository,
    AdminActivityRepository,
    ConsoleEmailSender,
    ResendEmailSender,
    {
      provide: MARKETS_DB_PATH,
      useFactory: (config: ConfigService) => config.get<string>('marketsDbFile'),
      inject: [ConfigService],
    },
    {
      provide: PERPETUALS_DB_PATH,
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
