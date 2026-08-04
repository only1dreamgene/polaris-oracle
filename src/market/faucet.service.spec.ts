import { ConfigService } from '@nestjs/config';
import { FaucetService } from './faucet.service';

function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    faucetMaxPerHour: 3,
    friendbotUrl: 'https://friendbot.stellar.org',
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

describe('FaucetService', () => {
  it('allows up to the configured max hits per address', () => {
    const svc = new FaucetService(makeConfig());
    const addr = 'GADDRESS';
    expect(svc.tryConsume(addr)).toBe(true);
    expect(svc.tryConsume(addr)).toBe(true);
    expect(svc.tryConsume(addr)).toBe(true);
    expect(svc.tryConsume(addr)).toBe(false);
  });

  it('tracks each address independently', () => {
    const svc = new FaucetService(makeConfig({ faucetMaxPerHour: 1 }));
    expect(svc.tryConsume('GADDR_A')).toBe(true);
    expect(svc.tryConsume('GADDR_B')).toBe(true);
    expect(svc.tryConsume('GADDR_A')).toBe(false);
    expect(svc.tryConsume('GADDR_B')).toBe(false);
  });

  it('lets hits back in once the window rolls forward', () => {
    const svc = new FaucetService(makeConfig({ faucetMaxPerHour: 1 }));
    const addr = 'GADDRESS';
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      expect(svc.tryConsume(addr)).toBe(true);
      expect(svc.tryConsume(addr)).toBe(false);
      now += 61 * 60 * 1000; // > 1 hour later
      expect(svc.tryConsume(addr)).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it('fund() treats an already-funded testnet account as a non-error', async () => {
    const svc = new FaucetService(makeConfig());
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"detail":"createAccountAlreadyExist"}',
    }) as unknown as typeof fetch;
    try {
      const result = await svc.fund('GADDRESS');
      expect(result).toEqual({ funded: false, alreadyExists: true });
    } finally {
      global.fetch = realFetch;
    }
  });

  it('fund() throws on unexpected failures', async () => {
    const svc = new FaucetService(makeConfig());
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    }) as unknown as typeof fetch;
    try {
      await expect(svc.fund('GADDRESS')).rejects.toThrow(/friendbot funding failed/);
    } finally {
      global.fetch = realFetch;
    }
  });
});
