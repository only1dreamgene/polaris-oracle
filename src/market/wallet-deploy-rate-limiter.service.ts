import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Same in-memory sliding-window shape as `FaucetService`, keyed by
 * requester IP instead of address — `POST /wallets/deploy` is
 * unauthenticated by design (self-service onboarding for a fresh passkey,
 * which by definition has no address yet to key a limiter on), so IP is
 * the only thing available to rate-limit by. Mitigates, doesn't close, the
 * known gap this endpoint has always had (see `polaris-oracle/README.md`'s
 * "Known gaps" — an attacker rotating IPs still works around this) — a
 * generous default so it doesn't get in a legitimate new user's way, not a
 * claim of real abuse resistance.
 */
@Injectable()
export class WalletDeployRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly config: ConfigService) {}

  tryConsume(ip: string): boolean {
    const max = this.config.get<number>('walletDeployMaxPerHour')!;
    const now = Date.now();
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= max) {
      this.hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(ip, recent);
    return true;
  }
}
