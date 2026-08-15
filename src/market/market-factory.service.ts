import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketRepository } from './market.repository';
import { MarketService } from './market.service';
import { MarketEvents } from './market-events';
import { StellarService } from './stellar.service';
import type { WatchedMarket } from './market.types';

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
  // Guards against the periodic sweep and the 'finalized' event both seeing
  // "no open market" for the same feed around the same moment and both
  // starting a create — checked+added synchronously with hasOpenMarket in
  // rollFeed, so there's no await between the check and the reservation.
  private readonly rolling = new Set<number>();

  constructor(
    private readonly repo: MarketRepository,
    private readonly markets: MarketService,
    private readonly stellar: StellarService,
    private readonly config: ConfigService,
    private readonly events: MarketEvents,
  ) {}

  onModuleInit(): void {
    // Relies on MarketService.onModuleInit() never emitting 'finalized'
    // *synchronously* during Nest's provider-init tick — true today, since
    // its fire-and-forget trySettle/tryCancel calls are gated on real I/O
    // (oracle wait, RPC), so they can't resolve before this listener is
    // registered a few lines below in the same synchronous tick.
    this.events.on('finalized', (m: WatchedMarket) => {
      try {
        const entry = this.catalogEntry(m.feedId);
        if (entry) void this.rollFeed(entry);
      } catch (err) {
        // EventEmitter doesn't catch listener exceptions itself — an
        // unhandled one here would become an unhandled rejection, not a
        // logged, contained failure like everywhere else in this class.
        this.logger.error(`'finalized' handler failed for ${m.contractId}: ${(err as Error).message}`);
      }
    });

    const intervalSecs = this.config.get<number>('marketFactoryIntervalSecs')!;
    this.timer = setInterval(() => void this.run(), intervalSecs * 1000);
    this.timer.unref?.();

    // Boot-time reconciliation pass, distinct from the interval above and
    // from the 'finalized' event: covers the narrow gap neither handles —
    // a crash strictly between a market's terminal persist() completing and
    // its successor being created, where the event that would have
    // triggered it already fired and was lost. (A market that was still
    // open pre-crash and resolves *during* this boot is covered once
    // MarketService re-arms it and the event fires, not by this.)
    void this.run();
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
      const outcome = await this.rollFeed(entry);
      if (outcome.status === 'skipped') result.skipped.push(entry.symbol);
      else if (outcome.status === 'failed') result.failed.push({ symbol: entry.symbol, error: outcome.error });
      else result.created.push({ symbol: entry.symbol, contractId: outcome.contractId, strikePriceCents: outcome.strikePriceCents });
    }
    return result;
  }

  /**
   * Creates a successor for one catalog entry if (and only if) it doesn't
   * already have an open/pending market and nothing else is already rolling
   * it — the single entry point both the periodic sweep and the
   * 'finalized' event call, so there's exactly one place that can start a
   * creation, not two independently-maintained ones.
   */
  private async rollFeed(
    entry: FeedCatalogEntry,
  ): Promise<
    | { status: 'skipped' }
    | { status: 'failed'; error: string }
    | { status: 'created'; contractId: string; strikePriceCents: string }
  > {
    if (this.hasOpenMarket(entry.feedId) || this.rolling.has(entry.feedId)) {
      return { status: 'skipped' };
    }
    this.rolling.add(entry.feedId);
    try {
      const { contractId, strikePriceCents } = await this.createMarketFor(entry);
      return { status: 'created', contractId, strikePriceCents: strikePriceCents.toString() };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`market factory failed for ${entry.symbol}: ${message}`);
      return { status: 'failed', error: message };
    } finally {
      this.rolling.delete(entry.feedId);
    }
  }

  private catalogEntry(feedId: number): FeedCatalogEntry | undefined {
    const catalog = this.config.get<FeedCatalogEntry[]>('feedCatalog') ?? [];
    return catalog.find((e) => e.feedId === feedId);
  }

  private hasOpenMarket(feedId: number): boolean {
    return this.repo.getByFeedId(feedId).some((m) => m.status === 'watching' || m.status === 'pending');
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
