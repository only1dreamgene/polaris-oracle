/**
 * Parses `CORS_ORIGINS` into an explicit allowlist for `enableCors({ origin,
 * credentials: true })`. Deliberately returns `[]` — never `true`/`*` — when
 * unset: this API sets a session cookie (`polaris_session`), so
 * `credentials: true` is on, and `cors` reflects the request's `Origin`
 * verbatim whenever `origin` is `true`. Reflecting any origin with
 * credentials on lets any website ride a signed-in user's session cookie
 * (read responses, trigger sponsored trades). An empty allowlist fails
 * closed instead, the way `AdminGuard` fails closed on a missing
 * `ADMIN_API_KEY`.
 */
export function resolveCorsOrigins(envValue: string | undefined): string[] {
  return (envValue ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
