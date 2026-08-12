import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketRepository } from './market.repository';
import { MarketService } from './market.service';
import { StellarService } from './stellar.service';

export interface FeedCatalogEntry {
  feedId: number;
  hermesFeedId: string;
  symbol: string;
}

export interface MarketFactoryRunResult {
  created: { symbol: string; contractId: string; strikePriceCents: string }[];
  skipped: string[];
  failed: { symbol: string; error: string }[];
}

/** `price * 10^expo` is Hermes' USD value; `* 100` more for cents means `price * 10^(expo+2)`. Rounds to the nearest cent rather than truncating — a floor-biased strike would skew every fresh coin-flip market toward one side by a systematic, silent amount. */
export function hermesPriceToCents(price: string, expo: number): bigint {
  const priceStroops = BigInt(price);
  const scaledExpo = expo + 2;
  if (scaledExpo >= 0) {
    return priceStroops * 10n ** BigInt(scaledExpo);
  }
  const divisor = 10n ** BigInt(-scaledExpo);
  return (priceStroops + divisor / 2n) / divisor;
}

/**
 * "No human clicks a button" market creation, wired to the capital-
 * efficiency vault (see `polaris-contracts/README.md`) so a fresh market's
 * seed liquidity comes from shared custody rather than a manual admin
 * transfer per market. Same structural pattern as `MarketService`
 * (`Injectable`, `Logger`, a timer armed in `onModuleInit`) rather than a
 * new scheduling dependency.
 *
 * Trust model is unchanged from the existing `POST /markets/create`: this
 * service acts as the oracle's own admin-authorized identity, the same key
 * that already deploys and settles markets today — not a new permission
 * surface.
 */
@Injectable()
export class MarketFactoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketFactoryService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repo: MarketRepository,
    private readonly markets: MarketService,
    private readonly stellar: StellarService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const intervalSecs = this.config.get<number>('marketFactoryIntervalSecs')!;
    this.timer = setInterval(() => void this.run(), intervalSecs * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass over the catalog. Every entry is independent — a failure on
   * one (bad Hermes lookup, an underfunded vault, a deploy hiccup) is
   * logged and skipped rather than aborting the rest, same "isolate the
   * blast radius per unit of work" shape as `MarketService`'s per-market
   * timers.
   */
  async run(): Promise<MarketFactoryRunResult> {
    const catalog = this.config.get<FeedCatalogEntry[]>('feedCatalog') ?? [];
    const result: MarketFactoryRunResult = { created: [], skipped: [], failed: [] };

    for (const entry of catalog) {
      if (this.hasOpenMarket(entry.feedId)) {
        result.skipped.push(entry.symbol);
        continue;
      }
      try {
        const { contractId, strikePriceCents } = await this.createMarketFor(entry);
        result.created.push({ symbol: entry.symbol, contractId, strikePriceCents: strikePriceCents.toString() });
      } catch (err) {
        const message = (err as Error).message;
        this.logger.error(`market factory failed for ${entry.symbol}: ${message}`);
        result.failed.push({ symbol: entry.symbol, error: message });
      }
    }
    return result;
  }

  private hasOpenMarket(feedId: number): boolean {
    return this.repo
      .getAll()
      .some((m) => m.feedId === feedId && (m.status === 'watching' || m.status === 'pending'));
  }

  private async createMarketFor(entry: FeedCatalogEntry): Promise<{ contractId: string; strikePriceCents: bigint }> {
    const vaultContract = this.config.get<string>('vaultContract');
    const lazerContract = this.config.get<string>('lazerContract');
    const nativeXlmSac = this.config.get<string>('nativeXlmSac');
    if (!vaultContract || !lazerContract || !nativeXlmSac) {
      throw new Error('VAULT_CONTRACT, LAZER_CONTRACT and NATIVE_XLM_SAC must be configured for the market factory');
    }

    const strikePriceCents = await this.readCurrentPriceCents(entry.hermesFeedId);
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + this.config.get<number>('marketFactoryExpirySecs')!;
    const gracePeriodSecs = this.config.get<number>('marketFactoryGracePeriodSecs')!;
    const initialLiquidityStroops = BigInt(this.config.get<string>('marketFactoryInitialLiquidityStroops')!);

    // Withdraw before deploy: a failed withdrawal (vault underfunded, admin
    // mismatch, ...) throws here and this feed is skipped for this run —
    // deployMarket never runs, so there's no partially-funded market left
    // behind. See the module doc: every entry fails independently.
    await this.stellar.vaultWithdraw(vaultContract, initialLiquidityStroops);

    const { contractId } = await this.stellar.deployMarket({
      strikePriceCents,
      expiry: BigInt(expiry),
      gracePeriodSecs: BigInt(gracePeriodSecs),
      lazerContract,
      feedId: entry.feedId,
      baseFeeBps: this.config.get<number>('marketFactoryBaseFeeBps')!,
      minFeeBps: this.config.get<number>('marketFactoryMinFeeBps')!,
      // The vault, not this process's own address — its own redeem_from_market
      // is how it later collects the payout back into shared custody. See
      // polaris-contracts/README.md's "The capital-efficiency vault".
      treasury: vaultContract,
      initialLiquidityStroops,
      collateralAsset: nativeXlmSac,
    });

    this.markets.watch({
      contractId,
      strikePriceCents: strikePriceCents.toString(),
      expiry,
      gracePeriodSecs,
      feedId: entry.feedId,
    });

    this.logger.log(`factory created market ${contractId} for ${entry.symbol} (strike ${strikePriceCents}c)`);
    return { contractId, strikePriceCents };
  }

  private async readCurrentPriceCents(hermesFeedId: string): Promise<bigint> {
    const hermesUrl = this.config.get<string>('pythHermesUrl');
    const res = await fetch(`${hermesUrl}/v2/updates/price/latest?ids[]=${encodeURIComponent(hermesFeedId)}`);
    if (!res.ok) {
      throw new Error(`Hermes price lookup failed: ${res.status}`);
    }
    const body = (await res.json()) as { parsed?: { price?: { price?: string; expo?: number } }[] };
    const parsed = body.parsed?.[0]?.price;
    if (!parsed || parsed.price === undefined || parsed.expo === undefined) {
      throw new Error(`Hermes returned no parsed price for feed ${hermesFeedId}`);
    }
    return hermesPriceToCents(parsed.price, parsed.expo);
  }
}
