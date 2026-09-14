import { buildReflectorConfigArg, buildPriceOracleArg } from './stellar.service';

/**
 * Regression for a real bug caught live: the Stellar CLI's struct-arg JSON
 * parser rejects a quoted `max_staleness_secs` ("600") with "unknown
 * variant `600`" — it needs a bare JSON number for this u64 field, unlike
 * the bigints passed as CLI *scalar* flags elsewhere in `deployMarket`,
 * which correctly stay strings (u64/i128 there are fine as decimal
 * strings on the command line; a `contracttype` struct's own JSON encoding
 * is stricter).
 */
describe('buildReflectorConfigArg', () => {
  it('encodes asset as the Asset enum shape, not a bare string', () => {
    // Regression for another real bug: OracleFeedConfig.asset used to be a
    // plain Symbol (bare "XLM" was correct then); it became the Asset enum
    // (Stellar(Address) | Other(Symbol)) once RedStone needed to key XLM
    // under Asset::Stellar(<SAC>) instead of Reflector's Asset::Other("XLM")
    // — see polaris-contracts/README.md's "On-chain second-oracle" section.
    // A bare string here is silently wrong shape, not just stale style: the
    // contract's `initialize` call rejects it outright ("Missing Entry
    // Asset" until a since-fixed soroban-sdk spec-export bug was corrected
    // in polaris-contracts, then "expected type Asset" against a bare
    // string after).
    const arg = buildReflectorConfigArg({
      reflectorContract: 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63',
      reflectorAsset: 'XLM',
      reflectorMaxStalenessSecs: 600n,
      reflectorToleranceBps: 150,
    });
    expect(JSON.parse(arg).asset).toEqual({ Other: 'XLM' });
  });

  it('encodes max_staleness_secs as a bare number, not a string', () => {
    const arg = buildReflectorConfigArg({
      reflectorContract: 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63',
      reflectorAsset: 'XLM',
      reflectorMaxStalenessSecs: 600n,
      reflectorToleranceBps: 150,
    });

    const parsed = JSON.parse(arg);
    expect(parsed).toEqual({
      contract: 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63',
      asset: { Other: 'XLM' },
      max_staleness_secs: 600,
      tolerance_bps: 150,
    });
    expect(typeof parsed.max_staleness_secs).toBe('number');
    // The exact failure mode confirmed live: a quoted value in the raw JSON text.
    expect(arg).not.toMatch(/"max_staleness_secs":"600"/);
  });
});

/**
 * `PriceOracleConfig` requires both legs together (see
 * `configuration.ts`'s `mockRedstoneContract` doc comment) and, unlike
 * `OracleFeedConfig`, keys the two legs under different `Asset` variants
 * — Reflector's real testnet oracle is `Asset::Other("XLM")`, RedStone's
 * real wrapper (and this mock standing in for it on testnet) is
 * `Asset::Stellar(<native XLM SAC>)`, confirmed live against each
 * provider's real contract (see `polaris-contracts/README.md`'s "A third
 * oracle: RedStone"). Getting either backwards silently builds the wrong
 * shape, the same class of bug `buildReflectorConfigArg`'s own asset test
 * above guards against.
 */
describe('buildPriceOracleArg', () => {
  const base = {
    lazerContract: 'CB6BSWAUVLKDN7PM6USOBHOQI6M5YWQCOJFRVT6FQSXCAPQESLROPKQ2',
    feedId: 100,
    reflectorContract: 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63',
    reflectorAsset: 'XLM',
    reflectorMaxStalenessSecs: 600n,
    reflectorToleranceBps: 150,
    redstoneContract: 'CAFAVGX6VUIRPK2KDCK7QGJEOOBM2EWCIA5UJBLOR2T7HZINKVKYRYTI',
    nativeXlmSac: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    redstoneMaxStalenessSecs: 600n,
    redstoneToleranceBps: 150,
  };

  it('keys reflector under Asset::Other and redstone under Asset::Stellar', () => {
    const parsed = JSON.parse(buildPriceOracleArg(base));
    expect(parsed.reflector.asset).toEqual({ Other: 'XLM' });
    expect(parsed.redstone.asset).toEqual({ Stellar: base.nativeXlmSac });
  });

  it('includes placeholder decimals_at_init fields (initialize overwrites them live)', () => {
    const parsed = JSON.parse(buildPriceOracleArg(base));
    expect(parsed.reflector_decimals_at_init).toBe(0);
    expect(parsed.redstone_decimals_at_init).toBe(0);
  });

  it('encodes both max_staleness_secs as bare numbers, not strings', () => {
    const arg = buildPriceOracleArg(base);
    expect(arg).not.toMatch(/"max_staleness_secs":"600"/);
    const parsed = JSON.parse(arg);
    expect(typeof parsed.reflector.max_staleness_secs).toBe('number');
    expect(typeof parsed.redstone.max_staleness_secs).toBe('number');
  });
});
