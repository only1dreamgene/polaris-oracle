import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { EmailAuthService } from './email-auth.service';

// Hand-rolled fakes rather than a Nest TestingModule — mirrors the pattern
// used elsewhere in this repo (see market.service.spec.ts) for keeping unit
// tests fast and independent of the real Stellar SDK / relay.

function config(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    emailCodeResendCooldownSecs: 60,
    emailCodeTtlSecs: 600,
    emailCodeMaxAttempts: 5,
    sessionJwtSecret: 'test-session-secret',
    sessionTtlSecs: 3600,
    smartWalletFactoryContract: 'FACTORY',
    smartWalletWasmHash: '00'.repeat(32),
    emailWalletEncKeyHex: '11'.repeat(32),
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function pendingCodeRepo(email: string, code: string) {
  const codeHash = createHash('sha256').update(code).digest('hex');
  return {
    getCode: jest.fn().mockReturnValue({
      email,
      code_hash: codeHash,
      expires_at: Date.now() + 10_000,
      attempts: 0,
      created_at: Date.now(),
    }),
    deleteCode: jest.fn(),
    incrementAttempts: jest.fn(),
    getWallet: jest.fn().mockReturnValue(undefined),
    saveWallet: jest.fn(),
  };
}

describe('EmailAuthService — auto-funding a freshly created wallet', () => {
  // Regression for: a brand-new custodial wallet deploys on-chain with 0
  // XLM, and `buy` pulls its collateral straight from the wallet's own
  // balance — without this, every first-time email login's very first
  // trade failed on an opaque "insufficient balance" simulation error.
  it('funds a newly deployed wallet via the faucet', async () => {
    const email = 'bettor@example.com';
    const code = '654321';
    const repo = pendingCodeRepo(email, code);
    const stellar = { deployWallet: jest.fn().mockResolvedValue('CNEWWALLETADDRESS') };
    const relay = {};
    const faucet = {
      tryConsume: jest.fn().mockReturnValue(true),
      fund: jest.fn().mockResolvedValue({ funded: true, alreadyExists: false }),
    };
    const sender = { send: jest.fn() };

    const svc = new EmailAuthService(
      config(),
      repo as any,
      stellar as any,
      relay as any,
      faucet as any,
      sender as any,
    );

    const result = await svc.verifyCode(email, code);

    expect(result.address).toBe('CNEWWALLETADDRESS');
    expect(faucet.tryConsume).toHaveBeenCalledWith('CNEWWALLETADDRESS');
    expect(faucet.fund).toHaveBeenCalledWith('CNEWWALLETADDRESS');
  });

  it('does not fail login if the faucet is down', async () => {
    const email = 'bettor2@example.com';
    const code = '111222';
    const repo = pendingCodeRepo(email, code);
    const stellar = { deployWallet: jest.fn().mockResolvedValue('CNEWWALLETADDRESS2') };
    const relay = {};
    const faucet = {
      tryConsume: jest.fn().mockReturnValue(true),
      fund: jest.fn().mockRejectedValue(new Error('friendbot funding failed: 503')),
    };
    const sender = { send: jest.fn() };

    const svc = new EmailAuthService(
      config(),
      repo as any,
      stellar as any,
      relay as any,
      faucet as any,
      sender as any,
    );

    await expect(svc.verifyCode(email, code)).resolves.toMatchObject({ address: 'CNEWWALLETADDRESS2' });
  });

  it('does not re-fund or re-deploy for a returning email login', async () => {
    const email = 'returning@example.com';
    const code = '999888';
    const repo = pendingCodeRepo(email, code);
    repo.getWallet.mockReturnValue({
      email,
      address: 'CEXISTINGWALLET',
      public_key_hex: 'ab',
      encrypted_private_key: 'ciphertext',
      created_at: Date.now(),
    });
    const stellar = { deployWallet: jest.fn() };
    const relay = {};
    const faucet = { tryConsume: jest.fn(), fund: jest.fn() };
    const sender = { send: jest.fn() };

    const svc = new EmailAuthService(
      config(),
      repo as any,
      stellar as any,
      relay as any,
      faucet as any,
      sender as any,
    );

    const result = await svc.verifyCode(email, code);

    expect(result.address).toBe('CEXISTINGWALLET');
    expect(stellar.deployWallet).not.toHaveBeenCalled();
    expect(faucet.tryConsume).not.toHaveBeenCalled();
  });
});
