import { ConfigService } from '@nestjs/config';
import { Keypair, contract } from '@stellar/stellar-sdk';
import { StellarService } from './stellar.service';

/**
 * Regression for: `contract.Client` methods (the account-fetch + simulate
 * step every one of them does before signing/sending anything) failed
 * transiently, live, on testnet — `Account not found: G...` for an account
 * that demonstrably existed and had been used seconds before and after.
 * The CLI path (`execStellarCli`, see `stellar.service.cli-retry.spec.ts`)
 * already retried past exactly this class of flakiness; this path never
 * did, until now (`withRpcRetry`).
 */
describe('StellarService RPC retry', () => {
  function makeService() {
    const secret = Keypair.random().secret();
    const config = {
      get: (key: string) =>
        ({
          oracleSecretKey: secret,
          stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
          stellarRpcUrl: 'https://soroban-testnet.stellar.org',
        })[key],
    } as unknown as ConfigService;
    return new StellarService(config);
  }

  it('retries past a transient failure and succeeds', async () => {
    const service = makeService();
    let calls = 0;
    (service as any).marketClient = () => ({
      get_market: async () => {
        calls++;
        if (calls < 3) throw new Error('Account not found: GTEST');
        return { result: new contract.Ok(sampleMarket) };
      },
    });

    const market = await service.getMarketState('CAV7CR62HKZ7RY5UEDZ2UOUHT3PSWIE3OPKZ5RFSIQHNDCU4KBXHIEYT');

    expect(calls).toBe(3);
    expect(market.status).toBe('Open');
  });

  it('gives up after exhausting attempts and throws the last error', async () => {
    const service = makeService();
    let calls = 0;
    (service as any).marketClient = () => ({
      get_market: async () => {
        calls++;
        throw new Error('Account not found: GTEST');
      },
    });

    await expect(service.getMarketState('CAV7CR62HKZ7RY5UEDZ2UOUHT3PSWIE3OPKZ5RFSIQHNDCU4KBXHIEYT')).rejects.toThrow(
      'Account not found: GTEST',
    );
    expect(calls).toBe(3);
  });

  it('does not retry a genuine contract-level rejection surfaced via .unwrap()', async () => {
    // .unwrap() is called separately, after withRpcRetry's call already
    // resolved successfully — a real Err result must not trigger a retry,
    // since nothing about it is transient (retrying would just waste time
    // before failing identically).
    const service = makeService();
    let calls = 0;
    (service as any).marketClient = () => ({
      get_price: async () => {
        calls++;
        return { result: new contract.Err({ message: 'MarketNotOpen' }) };
      },
    });

    await expect(service.getPrice('CAV7CR62HKZ7RY5UEDZ2UOUHT3PSWIE3OPKZ5RFSIQHNDCU4KBXHIEYT')).rejects.toThrow(
      'MarketNotOpen',
    );
    expect(calls).toBe(1);
  });
});

const sampleMarket = {
  admin: 'GAEMG5TVLEIQYCY3XB4EJT742DIE3FQO53RSESSYJQUZIWZOJQIZATJS',
  collateral: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  strike_price: 15n,
  expiry: 1786046823n,
  grace_period: 3600n,
  lazer_contract: 'CB6BSWAUVLKDN7PM6USOBHOQI6M5YWQCOJFRVT6FQSXCAPQESLROPKQ2',
  feed_id: 100,
  base_fee_bps: 100,
  min_fee_bps: 20,
  treasury: 'GAEMG5TVLEIQYCY3XB4EJT742DIE3FQO53RSESSYJQUZIWZOJQIZATJS',
  status: { tag: 'Open' as const },
  final_price: 0n,
  pool_yes: 1000000000n,
  pool_no: 1000000000n,
  total_supply: 1000000000n,
  initial_liquidity: 1000000000n,
};
