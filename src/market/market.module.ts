import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketController } from './market.controller';
import { PriceController } from './price.controller';
import { WalletController } from './wallet.controller';
import { MarketService } from './market.service';
import { StellarService } from './stellar.service';
import { OracleService } from './oracle.service';
import { AuthRelayService } from './auth-relay.service';
import { FaucetService } from './faucet.service';
import { AdminGuard } from './admin.guard';
import { MarketRepository, MARKETS_DB_PATH } from './market.repository';

@Module({
  controllers: [MarketController, PriceController, WalletController],
  providers: [
    MarketService,
    StellarService,
    OracleService,
    AuthRelayService,
    FaucetService,
    AdminGuard,
    MarketRepository,
    {
      provide: MARKETS_DB_PATH,
      useFactory: (config: ConfigService) => config.get<string>('marketsDbFile'),
      inject: [ConfigService],
    },
  ],
})
export class MarketModule {}
