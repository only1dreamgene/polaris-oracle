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
      asset: 'XLM',
      max_staleness_secs: 600,
      tolerance_bps: 150,
    });
    expect(typeof parsed.max_staleness_secs).toBe('number');
    // The exact failure mode confirmed live: a quoted value in the raw JSON text.
    expect(arg).not.toMatch(/"max_staleness_secs":"600"/);
  });
});
