import { buildReflectorConfigArg } from './stellar.service';

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
