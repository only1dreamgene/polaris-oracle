import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { StellarService } from './stellar.service';

describe('StellarService (smoke)', () => {
  it('constructs from a valid secret key', () => {
    const secret = Keypair.random().secret();
    const config = {
      get: (key: string) =>
        ({
          oracleSecretKey: secret,
          stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
          stellarRpcUrl: 'https://soroban-testnet.stellar.org',
        })[key],
    } as unknown as ConfigService;

    // A syntactically valid but unfunded random test key; this only
    // exercises construction (Keypair parsing + rpc.Server setup), not any
    // network call.
    expect(() => new StellarService(config)).not.toThrow();
  });

  it('throws if ORACLE_SECRET_KEY is missing', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    expect(() => new StellarService(config)).toThrow(/ORACLE_SECRET_KEY/);
  });
});
