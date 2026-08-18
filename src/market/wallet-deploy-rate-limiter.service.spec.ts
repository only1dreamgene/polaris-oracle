import { ConfigService } from '@nestjs/config';
import { WalletDeployRateLimiter } from './wallet-deploy-rate-limiter.service';

function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    walletDeployMaxPerHour: 3,
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

describe('WalletDeployRateLimiter', () => {
  it('allows up to the configured max deploys per IP per hour', () => {
    const svc = new WalletDeployRateLimiter(makeConfig());
    const ip = '203.0.113.5';
    expect(svc.tryConsume(ip)).toBe(true);
    expect(svc.tryConsume(ip)).toBe(true);
    expect(svc.tryConsume(ip)).toBe(true);
    expect(svc.tryConsume(ip)).toBe(false);
  });

  it('tracks each IP independently', () => {
    const svc = new WalletDeployRateLimiter(makeConfig({ walletDeployMaxPerHour: 1 }));
    expect(svc.tryConsume('203.0.113.1')).toBe(true);
    expect(svc.tryConsume('203.0.113.2')).toBe(true);
    expect(svc.tryConsume('203.0.113.1')).toBe(false);
    expect(svc.tryConsume('203.0.113.2')).toBe(false);
  });

  it('lets hits back in once the window rolls forward', () => {
    const svc = new WalletDeployRateLimiter(makeConfig({ walletDeployMaxPerHour: 1 }));
    const ip = '203.0.113.5';
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      expect(svc.tryConsume(ip)).toBe(true);
      expect(svc.tryConsume(ip)).toBe(false);
      now += 61 * 60 * 1000; // > 1 hour later
      expect(svc.tryConsume(ip)).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});
