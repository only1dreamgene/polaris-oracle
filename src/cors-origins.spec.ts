import { resolveCorsOrigins } from './cors-origins';

describe('resolveCorsOrigins', () => {
  it('fails closed (empty allowlist, not `true`/`*`) when CORS_ORIGINS is unset', () => {
    // Regression for: enableCors({ origin: true, credentials: true }) reflects
    // any request Origin and allows the polaris_session cookie along with it —
    // any website could then ride a signed-in user's session. An unset env
    // var must produce an allowlist that matches nothing, not "match anything".
    expect(resolveCorsOrigins(undefined)).toEqual([]);
    expect(resolveCorsOrigins('')).toEqual([]);
  });

  it('parses a comma-separated allowlist, trimming whitespace', () => {
    expect(resolveCorsOrigins('https://polaris.app, https://embed.polaris.app')).toEqual([
      'https://polaris.app',
      'https://embed.polaris.app',
    ]);
  });
});
