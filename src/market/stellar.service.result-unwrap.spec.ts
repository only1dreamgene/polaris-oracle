import { ConfigService } from '@nestjs/config';
import { Keypair, contract } from '@stellar/stellar-sdk';
import { StellarService } from './stellar.service';

/**
 * Regression test for a real bug: `contract.Client` methods generated from
 * a `Result<T, Error>`-returning contract fn (get_market/get_price/get_fee)
 * resolve `tx.result` to an `Ok`/`Err` wrapper, not `T` directly. Found by
 * inspecting a live `get_market()` call against the deployed testnet
 * contract, which returned `Ok { value: {...} }` and crashed
 * `normalizeMarket` with `Cannot read properties of undefined`.
 */
describe('StellarService result unwrapping', () => {
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

  it('unwraps get_market()\'s Ok-wrapped Result before normalizing', async () => {
    const service = makeService();
    const rawMarket = {
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
    (service as any).marketClient = () => ({
      get_market: async () => ({ result: new contract.Ok(rawMarket) }),
    });

    const market = await service.getMarketState('CAV7CR62HKZ7RY5UEDZ2UOUHT3PSWIE3OPKZ5RFSIQHNDCU4KBXHIEYT');

    expect(market.strikePrice).toBe('15');
    expect(market.poolYes).toBe('1000000000');
    expect(market.status).toBe('Open');
  });

  it('unwraps get_price()\'s Ok-wrapped Result', async () => {
    const service = makeService();
    (service as any).marketClient = () => ({
      get_price: async () => ({ result: new contract.Ok([5000, 5000]) }),
    });

    const price = await service.getPrice('CAV7CR62HKZ7RY5UEDZ2UOUHT3PSWIE3OPKZ5RFSIQHNDCU4KBXHIEYT');

    expect(price).toEqual({ yesBps: 5000, noBps: 5000 });
  });

  it('unwraps get_fee()\'s Ok-wrapped Result', async () => {
    const service = makeService();
    (service as any).marketClient = () => ({
      get_fee: async () => ({ result: new contract.Ok(100) }),
    });

    const fee = await service.getFee('CAV7CR62HKZ7RY5UEDZ2UOUHT3PSWIE3OPKZ5RFSIQHNDCU4KBXHIEYT');

    expect(fee).toBe(100);
  });
});
