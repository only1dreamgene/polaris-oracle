/**
 * Price conversion/lookup shared by two callers: `MarketFactoryService`
 * (picks a fresh strike price for a newly-created market) and
 * `MarketService`'s settlement cross-check (compares Hermes' current price
 * against the Lazer-signed payload before trusting it — see `trySettle`).
 * Hoisted here rather than left in `market-factory.service.ts` once a
 * second caller needed the exact same conversion.
 */

// Confirmed live: a cold first fetch in a freshly-booted process (DNS +
// TLS + Node's undici lazy-init, before any connection pooling exists yet)
// took long enough to trip a 3s bound even though a warm `curl` to the same
// endpoint consistently lands under 1s. 8s stays well inside
// SETTLE_TIMEOUT_MS's 30s budget while tolerating that one-time cost.
const HERMES_FETCH_TIMEOUT_MS = 8_000;

/** `price * 10^expo` is the USD value; `* 100` more for cents means `price * 10^(expo+2)`. Rounds to the nearest cent rather than truncating — a floor-biased result would skew every fresh coin-flip market's strike toward one side by a systematic, silent amount, and would bias a settlement cross-check the same way. Same shape for both Hermes' and Pyth Lazer's parsed `{price, exponent}` pairs. */
export function hermesPriceToCents(price: string, expo: number): bigint {
  const priceStroops = BigInt(price);
  const scaledExpo = expo + 2;
  if (scaledExpo >= 0) {
    return priceStroops * 10n ** BigInt(scaledExpo);
  }
  const divisor = 10n ** BigInt(-scaledExpo);
  return (priceStroops + divisor / 2n) / divisor;
}

/**
 * Reads Hermes' current published price for `hermesFeedId`, in cents.
 *
 * Bounded with a manually-managed `AbortController`, not
 * `AbortSignal.timeout()` — that convenience API has no public way to
 * cancel or unref its internal timer, so even a fetch that resolves
 * instantly leaves a live handle sitting around for the full timeout
 * window regardless (harmless in this long-running server process, but it
 * tripled this repo's test-suite time once enough tests exercised this
 * path). `clearTimeout` in `finally` cancels it the moment the fetch
 * actually settles either way, and `.unref()` covers the case where it
 * doesn't.
 *
 * The bound itself matters for a real reason, not just tidiness: a hung
 * (not just failed) fetch here used to be a latent bug — called
 * synchronously inside `MarketService.trySettle`'s try block, a hung
 * response would mean `trySettle` never reaches `stellar.settle()` *or*
 * the `catch` block, so `scheduleCancelFallback` never fires either — a
 * genuine silent stop, exactly what that class's own doc comment says
 * never happens. This turns that into an ordinary caught failure instead,
 * well inside `SETTLE_TIMEOUT_MS`'s 30s budget.
 */
export async function fetchHermesPriceCents(hermesUrl: string, hermesFeedId: string): Promise<bigint> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HERMES_FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(`${hermesUrl}/v2/updates/price/latest?ids[]=${encodeURIComponent(hermesFeedId)}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Hermes price lookup failed: ${res.status}`);
    }
    const body = (await res.json()) as { parsed?: { price?: { price?: string; expo?: number } }[] };
    const parsed = body.parsed?.[0]?.price;
    if (!parsed || parsed.price === undefined || parsed.expo === undefined) {
      throw new Error(`Hermes returned no parsed price for feed ${hermesFeedId}`);
    }
    return hermesPriceToCents(parsed.price, parsed.expo);
  } finally {
    clearTimeout(timer);
  }
}
