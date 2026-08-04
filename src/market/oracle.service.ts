import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PythLazerClient, type JsonOrBinaryResponse } from '@pythnetwork/pyth-lazer-sdk';

/**
 * Pyth Lazer WebSocket client. Wraps `@pythnetwork/pyth-lazer-sdk`'s
 * `PythLazerClient`, which already owns connection pooling and reconnection
 * — this class's job is just: track whether the feed is usable right now
 * (`isAvailable`), and resolve the first signed price update for a feed
 * once subscribed.
 *
 * `isAvailable` starts `false` until the pool actually connects. Every
 * caller in `MarketService` treats "oracle unavailable" as a first-class,
 * expected state (fall back to `cancel`), not an error — a market must
 * still resolve to a full refund if `PYTH_LAZER_TOKEN` is missing or Pyth
 * is down, which is the whole point of the contract's permissionless
 * `cancel` path.
 */
@Injectable()
export class OracleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OracleService.name);
  private client: PythLazerClient | undefined;
  private nextSubscriptionId = 1;
  private available = false;

  constructor(private readonly config: ConfigService) {}

  get isAvailable(): boolean {
    return this.available;
  }

  async onModuleInit(): Promise<void> {
    const token = this.config.get<string>('pythLazerToken');
    if (!token) {
      this.logger.warn('PYTH_LAZER_TOKEN not set — settlement will fall back to cancel() at grace expiry');
      return;
    }

    try {
      this.client = await PythLazerClient.create({
        token,
        webSocketPoolConfig: {
          urls: [this.config.get<string>('pythLazerWsUrl')!],
        },
      });
      this.client.addAllConnectionsDownListener(() => {
        this.logger.warn('all Pyth Lazer connections down');
        this.available = false;
      });
      this.client.addConnectionRestoredListener(() => {
        this.logger.log('Pyth Lazer connection restored');
        this.available = true;
      });
      this.available = true;
    } catch (err) {
      this.logger.error(`failed to connect to Pyth Lazer: ${(err as Error).message}`);
      this.available = false;
    }
  }

  onModuleDestroy(): void {
    this.client?.shutdown();
  }

  /**
   * Resolves the first signed update payload (raw `leEcdsa` bytes, ready to
   * pass straight to the market contract's `settle`) received for `feedId`
   * after subscribing. Rejects if no update arrives within `timeoutMs`.
   */
  waitForUpdate(feedId: number, timeoutMs = 30_000): Promise<Buffer> {
    if (!this.client || !this.available) {
      return Promise.reject(new Error('Pyth Lazer client is not available'));
    }
    const client = this.client;
    const subscriptionId = this.nextSubscriptionId++;

    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for a price update for feed ${feedId}`));
      }, timeoutMs);

      const listener = (event: JsonOrBinaryResponse) => {
        if (event.type !== 'binary') return;
        if (event.value.subscriptionId !== subscriptionId) return;
        if (!event.value.leEcdsa) return;
        cleanup();
        resolve(event.value.leEcdsa);
      };

      const cleanup = () => {
        clearTimeout(timer);
        client.unsubscribe(subscriptionId);
      };

      client.addMessageListener(listener);
      client.subscribe({
        type: 'subscribe',
        subscriptionId,
        priceFeedIds: [feedId],
        properties: ['price', 'exponent', 'feedUpdateTimestamp'],
        formats: ['leEcdsa'],
        deliveryFormat: 'binary',
        channel: 'fixed_rate@200ms',
      });
    });
  }
}
