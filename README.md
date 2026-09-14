# polaris-oracle

[![CI](https://github.com/samuel2926i39-art/polaris-oracle/actions/workflows/ci.yml/badge.svg)](https://github.com/samuel2926i39-art/polaris-oracle/actions/workflows/ci.yml)

NestJS settlement automation for **Polaris**. Watches deployed markets,
relays Pyth Lazer prices at expiry, calls `settle`/`cancel`, and exposes a
public read API, an admin API, a testnet faucet, and the passkey
smart-wallet deploy + sponsored-transaction relay.

See [`polaris-contracts`](https://github.com/samuel2926i39-art/polaris-contracts) for the on-chain half of this system, and [`polaris-frontend`](https://github.com/samuel2926i39-art/polaris-frontend) for the web app.

## Layout

| File | Responsibility |
|---|---|
| `stellar.service.ts` | All Stellar/Soroban I/O: reads via RPC simulation, oracle-authorized writes (`settle`/`cancel`/wallet deploy) via `contract.Client`, market deployment via the Stellar CLI (see the class doc for why that one path isn't reimplemented in-process). |
| `auth-relay.service.ts` | Sponsors passkey-authorized calls: this process pays the fee, a WebAuthn passkey signs the Soroban authorization entry, in two HTTP round-trips (`prepare` / `submit`). |
| `oracle.service.ts` | Pyth Lazer WebSocket client (`@pythnetwork/pyth-lazer-sdk`). Exposes `isAvailable` and `waitForUpdate`. |
| `market.service.ts` | Settlement orchestration: arms a timer per watched market, falls back to permissionless `cancel` on any failure or oracle outage, re-arms on process restart. |
| `market-factory.service.ts` | "No human clicks a button" market creation: sweeps a configured feed catalog on an interval *and* reacts immediately when a tracked market resolves, funding each new market's seed liquidity from the capital-efficiency vault instead of a manual admin transfer. See "Market factory automation" and "Auto-rolling successor markets" below. |
| `market-events.ts` | A trivial injectable `MarketEvents extends EventEmitter` — decouples `MarketService` (emits `'finalized'`) from `MarketFactoryService` (listens) without a circular Nest DI dependency. See "Auto-rolling successor markets". |
| `pyth-price.ts` | Shared Hermes-price fetch/conversion, used by both the factory (a fresh market's strike price) and `MarketService`'s settlement cross-check (see "Multi-oracle settlement cross-check"). |
| `market.repository.ts` | WAL-journaled SQLite persistence via `better-sqlite3`. |
| `perpetual.service.ts` / `perpetual.controller.ts` / `perpetual.repository.ts` | The `polaris-perpetual` contract's much smaller counterpart to the three files above — no expiry, no settle, so none of `MarketService`'s timer/scheduling logic applies. See "Perpetual markets" below. |
| `admin.guard.ts` | `x-admin-key` check, constant-time compare, fails closed if unset — throws `UnauthorizedException` (401), not a bare `false` (which Nest turns into a 403), so the admin dashboard's key-entry gate can tell "wrong key" apart from "forbidden regardless." |
| `admin.controller.ts` / `admin-activity.repository.ts` | The admin dashboard's read API and its backing activity log. See "Admin dashboard" below. |
| `faucet.service.ts` | Rate-limited (3/hour/address) Friendbot funding. |
| `wallet-deploy-rate-limiter.service.ts` | Same rate-limiting shape as `FaucetService`, keyed by IP instead of address — mitigates (doesn't close) `POST /wallets/deploy`'s unauthenticated-by-design abuse surface. |
| `contracts.ts` | Loads `wasm/*.wasm` and parses each contract's real spec via `contract.Spec.fromWasm` — argument/return encoding for custom types (the `Prediction` enum, the `Market`/`Signature` structs) comes from the compiled contract, not from guessing the wire format. |
| `wire-args.ts` | Converts JSON-transportable request args into `xdr.ScVal[]`, and — the part that actually matters — injects the wallet's own address into whichever parameter authorizes each sponsored call. See "Bugs found by pressure-testing" below. |

## Bugs found by pressure-testing this system

Thirteen real bugs surfaced by deliberately trying to break this system after
it was "done," not just written once and left. Recorded here because each
one is the kind of thing that looks fine in a code read and only shows up
under adversarial pressure or a real failure:

1. **Every sponsored trade call was missing its own address.** `wireArgs`
   only ever carried what the frontend explicitly passed (`prediction`,
   `collateral_amount`, ...) — the wallet's address was never included, and
   `coerceWireArgs` silently *skips* any parameter absent from its input
   rather than erroring. This didn't crash loudly; it would have made
   `AuthRelayService.prepare` fail to find any authorization entry to sign,
   breaking `buy`/`sell`/`split`/`merge`/`redeem`/`transfer` end to end.
   Fixed by extracting the argument-building into `wire-args.ts`'s
   `buildSponsoredCallArgs`, which injects the address explicitly (derived
   from the *signed entry itself* in `submit()`, not a client-supplied
   field, so it can't drift or be spoofed) — and is directly unit-tested
   (`wire-args.spec.ts`) without any RPC mocking, specifically so this
   class of bug fails a test instead of silently shipping.
2. **`contract.Spec` decodes structs/enums as raw Rust shapes**, not
   camelCase strings — `getMarketState` was casting the raw decode result
   straight to the REST-facing type, which would have served wrong field
   names and an unusable status shape. Fixed with an explicit
   `normalizeMarket` translation in `stellar.service.ts`.
3. **A crash between an on-chain `settle`/`cancel` succeeding and this
   service persisting that fact would strand the tracked status as
   `'pending'` forever** — the retry's call fails on-chain
   (`AlreadyFinalized`), and nothing reconciled that against the
   possibility that it failed *because it had already worked*. Not a
   funds-safety bug (the contract was never at risk either way), but a real
   observability one: the admin console and dashboard would show a
   perfectly fine market as stuck. Fixed with `reconcileWithChain` in
   `market.service.ts`, which checks live on-chain state before recording
   a settle/cancel failure as real.
4. **`contract.Client` doesn't auto-unwrap a `Result<T, Error>`-returning
   contract fn.** `getMarketState`, `getPrice`, and `getFee` all call
   contract methods declared as `Result<T, Error>` in Rust
   (`get_market`, `get_price`, `get_fee`), and each one cast `tx.result`
   straight to its expected shape. In reality `tx.result` is a
   `contract.Ok`/`contract.Err` wrapper (`Ok { value: T }` on success) — the
   SDK leaves the `Result` for the caller to unwrap. This wasn't caught by
   any earlier test because every prior test either mocked the RPC layer
   below `contract.Client` or never exercised a real deployed contract; it
   only surfaced once `POST /markets/watch` was pointed at a real testnet
   market and crashed with `Cannot read properties of undefined (reading
   'toString')` inside `normalizeMarket`. Fixed by calling `.unwrap()` on
   `tx.result` before use in all three methods — confirmed with a live
   `get_market()` call against the deployed contract first, then locked in
   by `stellar.service.result-unwrap.spec.ts`, which mocks `marketClient()`
   to return real `contract.Ok`-wrapped shapes. `get_position`
   (`(i128, i128)`) and the factory's `deploy`/`resolve` (`Address`) are
   *not* affected — none of those three are declared `Result` in Rust.
5. **`origin: true` + `credentials: true` on the same `enableCors()` call
   would let any website on the internet ride a signed-in user's session
   cookie.** The `origin: origins.length > 0 ? origins : true` fallback
   predates email login and was harmless then — nothing was
   cookie-authenticated, so reflecting any origin only exposed
   non-credentialed reads. Adding email login (this changeset) added
   `credentials: true` to that *same* call, needed so the browser sends the
   new `polaris_session` httpOnly cookie cross-origin
   (`polaris-frontend`'s `api.ts`), and a fully cookie-authenticated,
   fund-moving endpoint (`POST /auth/email/trade`, which allows
   `function: 'transfer'`). `origin: true` makes the `cors` package reflect
   whatever `Origin` header the request sent; combined with
   `credentials: true`, any deployment where an operator forgets to set
   `CORS_ORIGINS` (not enforced anywhere — `fly.toml` doesn't set it, it's
   only a `fly secrets` value) lets a page on *any* domain do
   `fetch(..., { credentials: 'include' })` against `/auth/email/trade`,
   have the browser attach the victim's session cookie, and read the JSON
   response back — full cross-origin account takeover, no XSS required,
   worse than plain CSRF because the response is readable too. The passkey
   trade path doesn't have this exposure the same way: it requires an
   out-of-band biometric prompt CSRF can't fake, so a valid cookie alone
   was never sufficient there. For email/custodial wallets a valid cookie
   *is* the entire authorization, which is exactly what made this exploit
   the CORS gap completely. Admin routes are unaffected — `AdminGuard`
   checks an `x-admin-key` header, not ambient cookie credentials. Fixed in
   `main.ts` by failing closed (empty origin allowlist, matching
   `AdminGuard`'s fail-closed behavior on a missing `ADMIN_API_KEY`) instead
   of falling back to `true` whenever `CORS_ORIGINS` is unset, with a loud
   boot-time warning explaining why the fallback can never be "allow
   everything" once credentials are involved.
6. **`reconcileWithChain`'s own on-chain read could itself fail transiently
   — and did, live, on testnet.** Bug 3 added `reconcileWithChain` so a
   `settle`/`cancel` call that fails locally *after* already succeeding
   on-chain doesn't get recorded as a stranded `pending` forever. Caught
   deploying a real short-lived testnet market, buying a real position,
   settling it directly against the deployed `mock-lazer` contract
   (bypassing `OracleService` — no `PYTH_LAZER_TOKEN` in this environment),
   and watching `MarketService`'s own automatic cancel-fallback timer fire
   ~70s later, fail (the market was already `ResolvedYes`, exactly as
   expected), call `reconcileWithChain` — and have *that* read fail too,
   more than ten seconds after the settle had already confirmed, nowhere
   near a plausible propagation race. `reconcileWithChain`'s read had
   exactly one attempt and swallowed its own failure with a bare
   `catch { return false; }` — no log, no distinguishing "definitely not
   finalized" from "couldn't check right now." Since `tryCancel`/`trySettle`
   never auto-retry (by design — each is a one-shot timer fire), a single
   transient RPC hiccup on that one read was enough to leave a *perfectly
   finalized* market stuck reporting `pending` with a stale, misleading
   error until an admin happened to hit `/markets/:id/cancel` or `/settle`
   manually. Confirmed the diagnosis by doing exactly that — one manual
   retry reconciled it instantly, proving the market was fine the whole
   time and the read was the only thing that had failed. Fixed by giving
   the reconcile read a few retries with a short delay
   (`RECONCILE_READ_ATTEMPTS` / `RECONCILE_READ_RETRY_DELAY_MS` in
   `market.service.ts`) and logging the real error when they're all
   exhausted instead of swallowing it silently.
7. **`deployMarket()`'s two back-to-back `stellar` CLI calls (`deploy` then
   `initialize`, same source account for both) had zero resilience to
   testnet RPC hiccups** — any transient failure surfaced as a bare 500 to
   the admin caller, no retry, nothing. Went looking for this after bug 6
   turned up the same root cause (an unretried single RPC call) in a
   different spot; confirmed it live by firing real `/markets/create`
   calls and hitting it immediately. The failure text turned out to come in
   more shapes than expected — `Contract not found` and `HostError:
   Error(Storage, MissingValue)` are the *same* "RPC hasn't caught up to
   the deploy yet" race worded differently; `TxBadSeq` is two CLI processes
   racing on the account's sequence number; `client error (SendRequest)`
   and a plain `transaction submission timeout` are the RPC connection
   itself hiccuping. An early fix allowlisted three exact error strings and
   missed the other two on the very next live run — replaced with the
   inverse: retry everything *except* a confirmed contract-level rejection
   (`HostError: Error(Contract, #N)` — bad strike price, insufficient
   balance, etc., which fails identically every time, so retrying it is
   pure wasted delay). See `isTransientStellarCliError` /
   `execStellarCli` in `stellar.service.ts`, plus a fixed short wait after
   `deploy` before `initialize`'s first attempt, to cut down on how often
   the retry is even needed. **Honest limit, not swept under the rug:**
   this raises the odds a transient hiccup self-resolves, it does not make
   admin market creation immune to testnet being *severely* degraded — one
   live run during this fix hit a gap of several minutes on a single CLI
   call before it failed, which no small, bounded client-side retry policy
   can paper over without making a normal call hang just as long. That
   remains a "try again" case for the admin, same as before.
8. **The bug-7 retry logic could itself paper over a success and report it
   as a failure.** Confirmed live the first time `MarketFactoryService` ever
   ran against real testnet: `deployMarket`'s `initialize` call reported
   `HostError: Error(Contract, #2)` (`AlreadyInitialized`) on a contract that
   had just been freshly deployed seconds earlier — impossible on a genuine
   first `initialize`, unless the CLI's own submission had actually already
   succeeded on-chain and only its *result reporting* failed (a network
   hiccup between submit and confirmation, most likely), so the error
   surfacing was really a second, redundant simulation running against
   already-initialized storage. This is bug 3's exact shape
   (`reconcileWithChain`) in a spot that never got the same treatment:
   `deployMarket` had gained retry *resilience* (bug 7) but not
   *reconciliation* — a permanent-looking error was still trusted at face
   value instead of being checked against live chain state first. Confirmed
   by reading the "failed" contract's `get_market()` directly: fully
   initialized, `status: "Open"`, every field matching the request
   (`treasury` = the vault, `strike_price` = the live Hermes-derived price).
   Worse than an ordinary observability gap here specifically: `deployMarket`
   throwing meant `MarketFactoryService` never called `MarketService.watch()`,
   so a real, vault-funded, on-chain-open market would have sat completely
   untracked — no settlement timer, no cancel fallback, silently orphaned
   despite holding real withdrawn capital. Fixed by catching exactly
   `Error(Contract, #2)` around the `initialize` call, reading
   `getMarketState` before giving up, and treating a confirmed `Open` status
   as success (no `initTxHash` available for that reconciled path, since the
   original submission's hash was never seen). The orphaned market this
   produced live (`CDEBN4JLIKNRZOL4WQQZ6ZAAP2P5PQPJCK6HIITKRN2V46T3IR6JH4W7`)
   was registered manually via `POST /markets/watch` rather than discarded.
9. **A settle/cancel timer scheduled to fire exactly at its deadline could
   beat the chain to it.** `arm()`/`scheduleCancelFallback` compute a
   `setTimeout` delay from this process's own wall clock against
   `expiry`/`grace_period_secs`, but the contract checks `now >= ...`
   against the *last-closed ledger's* timestamp, which can lag real time by
   roughly one ledger-close interval. Confirmed live, twice: a cancel fired
   right at the computed boundary got a spurious `GracePeriodNotElapsed`
   even though the deadline had "already" passed locally — harmless (it
   self-heals on the next real-world second, or the next retry), but it left
   a market stuck reporting `pending` with a confusing error until something
   retried it, the exact same *shape* of problem as bugs 3/6/8, just a
   fourth spot it turned up in. Fixed with a fixed buffer
   (`LEDGER_LAG_BUFFER_MS`, 8s) added to both scheduled-ahead timers in
   `market.service.ts` — deliberately not applied to `arm()`'s
   already-clearly-overdue immediate-fire branches, which don't race this
   way.
10. **`contract.Client` calls had zero retry resilience against the exact
    RPC flakiness the CLI path (bug 7) already retries past.** Every
    `contract.Client` method does an account-fetch + simulate step before
    signing or sending anything; confirmed live that this step alone can
    fail with `Account not found: G...` for an account that demonstrably
    exists and was used successfully seconds before and after — a genuine
    testnet RPC hiccup, not a real missing account. `execStellarCli` already
    retries this class of failure for `deployMarket`'s CLI calls; nothing
    covered the `contract.Client`-based calls (`getMarketState`,
    `getPosition`, `settle`, `cancel`, `deployWallet`, `vaultWithdraw`, ...)
    at all — a single transient blip on any of them surfaced straight to
    the caller (or, for `settle`/`cancel`, straight into the existing
    pending/cancel-fallback path, adding an unnecessary delay for what was
    really just a network hiccup). Fixed with `withRpcRetry`, wrapping only
    the pre-submission build/simulate step (safe to retry unconditionally —
    nothing has been sent yet, and a genuine contract-level rejection can't
    surface there; that only appears via a separate `.unwrap()` call on an
    already-successfully-returned result, left untouched). Deliberately does
    **not** wrap `tx.signAndSend()` itself — retrying a send that may have
    actually landed despite reporting failure is the harder problem
    `reconcileWithChain` already owns for settle/cancel specifically;
    blindly retrying the send too could double-submit.

Bugs 9 and 10 together re-verified live after both fixes landed: a fresh
short-grace test market ran its full expiry → grace → cancel cycle in one
clean pass — no `GracePeriodNotElapsed`, no `Account not found`, no retry
warnings logged at all — where the same cycle had needed either a manual
retry or produced a stuck `pending` status before.

11. **Every `sell` has been silently missing from fee-revenue accounting
    since the admin dashboard shipped.** `wallet.controller.ts`/
    `email-auth.controller.ts` recorded each trade's fee-bearing amount by
    reading `args.collateral_amount` unconditionally — the correct wire-arg
    name for `buy`, but `sell`'s is `shares_in`. Every `sell`'s
    `collateral_amount` was therefore recorded as `undefined`, which
    `AdminController.feeRevenue()` treats as "skip this row" (it can't
    compute a fee off a missing amount) — so `sell` fees were counted as
    zero, for every market, silently, the whole time. Found live while
    verifying the new perpetual-market wiring (below) end-to-end through
    the real API: a `buy` then a `sell` against a fresh perpetual, and
    `GET /admin/fee-revenue`'s total didn't move after the `sell` at all.
    Fixed with a small `feeBearingAmount(functionName, args)` helper
    (`wire-args.ts`) that knows each fee-charging function's actual
    argument name (`buy` → `collateral_amount`, `sell` → `shares_in` —
    matching each side's own `apply_fee(effective_in, ...)` call in the
    contract); re-verified live afterward that a `sell` against the same
    fresh perpetual now correctly moved the total.

Worth knowing if you add a new sponsorable function that charges a fee:
`feeBearingAmount`'s lookup table needs a new entry — it isn't derived
from anything structural, so a function silently gets skipped rather than
erroring if you forget (the same "quiet, not loud" failure shape as bug 1).

12. **`POST /perpetuals/:id/checkpoint` let `OracleService.waitForUpdate`'s
    rejection propagate uncaught into a bare 500**, instead of the clean
    4xx every other admin action returns. Found live, immediately, the
    first real call in this dev environment (no `PYTH_LAZER_TOKEN`
    configured — same known limitation `MarketService.trySettle` already
    has, see below): `curl`'d the endpoint, got `{"statusCode":500,
    "message":"Internal server error"}` with the real cause only visible
    in the server log. Unlike `trySettle`, there's no fallback action to
    take when the oracle is unavailable (checkpointing is purely
    informational — nothing to cancel toward), so the fix is a plain
    `isAvailable` check plus a try/catch around `waitForUpdate`, both
    mapped to `BadRequestException` with the real reason in the message.
    Re-verified live afterward: the same call now returns a clean 400
    explaining exactly why (`PYTH_LAZER_TOKEN not configured?`).

13. **`checkpoint()`'s refresh-then-record sequence was racy against
    itself.** It's two *separate* on-chain transactions — `refreshMockRedstonePrice`
    then `recordPriceCheckpoint` — not one atomic call, and
    `record_price_checkpoint` reads `polaris-mock-redstone`'s *live* state
    at its own execution time, not a snapshot from the refresh moments
    earlier. `mockRedstoneContract` is one shared config value used by
    *every* perpetual this backend creates, and the mock's `set_price` is
    deliberately unauthenticated (any testnet account can call it — that's
    the whole point of a mock, see its own doc comment in
    `polaris-contracts`). Two admin tabs (or a double-click) calling
    `checkpoint()` for two *different* perpetuals close together could
    land B's refresh in the gap between A's refresh and A's record — A's
    `record_price_checkpoint` would then compare its own Lazer payload
    against B's price instead of its own, surfacing as a confusing
    `OracleDivergence` for a request that never actually diverged from
    anything. Found during a dedicated audit pass (not live — this dev
    environment has no `PYTH_LAZER_TOKEN`/network access to reproduce it
    against real testnet), by tracing the two-transaction sequence against
    the mock's own "unauthenticated by design" doc comment. Fixed with
    `checkpointQueue`, a per-process promise
    chain that serializes every `checkpoint()` call — closes the "this
    backend races itself" case, which is the realistic trigger. Regression
    test: `perpetual.controller.checkpoint-race.spec.ts` (confirmed it
    actually fails without the fix, not just that it passes with it — the
    same "prove it reproduces" bar every other entry here holds to).
    **What this does NOT close, stated plainly rather than glossed over**:
    a third party calling `set_price` on the shared mock directly, from
    outside this backend entirely, during the same window — the mock's
    unauthenticated-by-design nature makes that structurally impossible to
    prevent from this backend's side. Acceptable for what this mock
    exists for (exercising the verification logic on testnet, see
    "Perpetual markets" below) but worth knowing if `checkpoint()`
    ever needs to be trusted against a genuinely adversarial testnet.

Worth knowing if you add a new on-chain read: `contract.Spec` preserves the
Rust struct's exact field names (snake_case) and represents enums as
`{ tag: 'Open' }` rather than a bare string — it does **not** camelCase
anything, so casting a raw decode result straight to a REST-facing type
(the mistake bug 2 was) is an easy trap to fall back into. Separately, if
the Rust fn signature is `Result<T, Error>`, `tx.result` is `Ok`/`Err`, not
`T` — call `.unwrap()` (bug 4).

## Why native XLM, no custom test token

The market contract's collateral is generic (any Stellar Asset Contract).
This build uses the **native XLM SAC** rather than minting a custom test
token: Friendbot already funds new testnet accounts with XLM for free, so
there's no faucet-mint logic or token-admin key to manage — one less moving
part, and thematically it's "stake XLM, predict XLM."

## Passkey smart wallets

`wallet.controller.ts` exposes:
- `GET /wallets/resolve?publicKeyHex=` — the address a passkey would deploy
  to, computed by the factory contract's own `resolve` view (a free
  simulated read, on-chain formula, not a reimplementation of it) without
  deploying anything. This is the portable-identity lookup: a caller can
  check whether a wallet already exists for a given passkey before deciding
  whether to prompt registration.
- `POST /wallets/deploy` — gasless: this process pays to deploy+init a new
  `polaris-smart-wallet` for a given secp256r1 public key via the
  `polaris-smart-wallet-factory` contract.
- `POST /wallets/tx/prepare` / `POST /wallets/tx/submit` — the two-step
  sponsored-transaction relay. See `auth-relay.service.ts`'s doc comment for
  the full protocol and why it's necessarily two round-trips (a passkey
  signature means an actual Face ID/Touch ID prompt in the browser, not a
  synchronous in-process callback).

Note: the embeddable market widget (`<iframe>`-able on any third-party
site) lives in `polaris-frontend`'s `/embed/[id]`, **not** here — WebAuthn's
relying-party id is tied to the document's origin, so the widget has to be
served from the same origin as the flagship app for a passkey to be usable
in both places. This backend only supplies the data/relay APIs both consume.

**Status**: structurally complete and grounded in the SDK's documented
`authorizeEntry`/custom-account pattern (see the contracts repo for the
low-S signature normalization gotcha this uncovered), but this build
environment has no live Soroban RPC access to exercise it end-to-end
against. Treat the relay as unverified until run against testnet.

## Market factory automation

`MarketFactoryService` closes the last manual step in market creation: until
now, `POST /markets/create` needed a human to pick a strike price, fund
`initial_liquidity` from their own balance, and click a button. The factory
sweeps a configured feed catalog (`FEED_CATALOG` — see `.env.example`) on an
interval (`MARKET_FACTORY_INTERVAL_SECS`, default 6h) and, for each feed with
no open/pending tracked market:

1. Reads the current price from Pyth's **Hermes** HTTP API (`pythHermesUrl`)
   — not the Lazer feed used for settlement. These are two genuinely
   different id schemes for the same underlying asset (see
   `PriceController`'s own doc comment); `configuration.ts`'s
   `FeedCatalogEntry` carries both (`feedId` for settlement, `hermesFeedId`
   for pricing). `hermesPriceToCents` converts Hermes' `{price, expo}` pair
   into whole cents, rounding to the nearest cent rather than truncating (a
   floor bias would skew every fresh coin-flip market toward one side).
2. Withdraws `MARKET_FACTORY_INITIAL_LIQUIDITY_STROOPS` from the
   capital-efficiency vault (`StellarService.vaultWithdraw` — see
   [`polaris-contracts`](https://github.com/samuel2926i39-art/polaris-contracts)'s vault section) *before* attempting to
   deploy, so a withdrawal failure (vault underfunded, misconfigured) fails
   that feed loudly and skips it — never a market deployed without the
   capital to back it.
3. Calls the existing `StellarService.deployMarket()` unchanged, with
   `treasury` set to the **vault's** contract address rather than this
   process's own — so the vault can later collect its own payout via
   `redeem_from_market` once the market resolves.
4. Registers the new market with `MarketService.watch()`, arming the same
   settlement/cancel timers a manually-created market gets.

Each catalog entry is independent — one feed's failure (a bad Hermes lookup,
an underfunded vault) is logged and skipped, not a reason to abort the rest
of the sweep. `POST /markets/factory/run` (behind `AdminGuard`) triggers a
sweep on demand, for ops visibility rather than only a silent background
timer.

**Verified live on testnet**, not just unit-tested: deposited 500 XLM into
the deployed vault (`CDDZCX5PT7FURKHTHNKXGNJJNURS4M7BLLNS6BHRV4RJM6CJT25SNCF5`,
balance confirmed `5,020,000,000` stroops via `get_balance`), fetched
XLM/USD's real Hermes id live (`https://hermes.pyth.network/v2/price_feeds?query=XLM`,
not copied from memory — see the comment above `DEFAULT_FEED_CATALOG` in
`configuration.ts`), then triggered `POST /markets/factory/run` against the
real backend. It withdrew 100 XLM from the vault, deployed and initialized a
real market (`CDEBN4JLIKNRZOL4WQQZ6ZAAP2P5PQPJCK6HIITKRN2V46T3IR6JH4W7`) with
`treasury` = the vault and `strike_price` = the live Hermes price (16 cents,
i.e. $0.16 XLM/USD at the time) — confirmed directly via `get_market()` — and
the vault's on-chain balance dropped by exactly 100 XLM
(`5,020,000,000` → `4,020,000,000`), matching the withdrawal precisely. That
same live run also turned up bug 8 below; after the fix, re-running
`POST /markets/factory/run` correctly reported `"skipped": ["XLM/USD"]` since
a tracked open market for that feed now existed — the idempotency check
works, confirmed live, not just in `market-factory.service.spec.ts`'s fakes.

## Auto-rolling successor markets

"Perpetual markets" here means **auto-rolling**, not a new contract: no
funding-rate mechanic, no persistent cross-round position — each round is
still a fully independent, fully-collateralized market like every other one
in this system. What's automated is *creating the next one*, so a feed never
sits dark waiting on a human or a slow timer.

`MarketService.persist()` emits a `'finalized'` event (via `MarketEvents`,
a plain injectable wrapper around Node's `EventEmitter` — not a direct
dependency on `MarketFactoryService`, which already depends on
`MarketService` the other way; a real circular dependency would force a 5th
constructor arg into every one of `market.service.spec.ts`'s 10 direct
`new MarketService(...)` calls, which don't go through Nest's DI container
at all) the moment a tracked market *newly* transitions into `settled` or
`cancelled` — not on every `persist()` call, only the actual transition.
`MarketFactoryService` listens for it and immediately rolls that feed if
it's in the catalog, instead of waiting for the periodic sweep.

The periodic sweep still runs (default every 5 minutes, down from the
factory's original 6-hour cadence — its role changed from "the trigger" to
"a safety net for a missed event," so the interval needed to shrink to
match: it should stay well under `MARKET_FACTORY_GRACE_PERIOD_SECS`, or a
crash right after expiry leaves a feed dark for most of an hour before the
net even looks). `onModuleInit` also runs one immediate reconciliation pass
on boot, on top of the timer, for the one gap neither the event nor the
timer's *first* tick covers: a crash strictly between a market's terminal
`persist()` and its successor being created, where the event that would
have triggered it already fired and was lost.

Both paths — the event and the sweep — funnel through one `rollFeed(entry)`,
which checks `hasOpenMarket` and an in-memory `rolling` set *synchronously*
(no `await` between the check and reserving the feed) before ever awaiting
anything, so the event firing at the same moment the sweep is mid-pass can't
double-create a market for the same feed.

`GET /markets?feedId=` (new `MarketRepository.getByFeedId`) lets a caller —
the frontend, in particular — find a resolved market's successor once one
exists, to link "next round" rather than dead-ending.

**Verified live on testnet**: cancelled a short-grace test market and
confirmed the successor was created within ~1 second via the `'finalized'`
event path (not the 5-minute sweep), with correct on-chain wiring
(`treasury` = the vault, funded from it, matching the factory's existing
verified behavior). Also verified the failure path is handled the way it's
designed to be, not just in theory: a vault-withdrawal failure during a live
event-triggered roll (the shared vault was genuinely low on funds from
repeated testing) was caught, logged with the real on-chain reason
(`"balance is not sufficient to spend"`), and correctly produced **no**
underfunded market — confirmed by topping the vault back up and re-running,
which then succeeded cleanly.

## Perpetual markets

`polaris-perpetual` (see `polaris-contracts/README.md`'s "The perpetual
contract") is a second, parallel contract kind — continuous trading, no
strike price, no expiry, no `settle`. Deliberately wired as its **own**
route family (`/perpetuals`, `PerpetualController`/`PerpetualService`/
`PerpetualRepository`) rather than folded into the existing
`/markets`/`MarketRepository` — a shared schema would mean a pile of
columns meaningless for one contract kind or the other (`strike_price_cents`/
`expiry`/`grace_period_secs`/`feed_id` don't exist on a perpetual; a
perpetual's `last_price_cents`/`last_price_at` checkpoint fields don't
exist on a classic market). The two share every trading mechanic
(`buy`/`sell`/`split`/`merge`/`redeem`/`transfer`), so `PerpetualService`
is a small fraction of `MarketService`'s size — no settle-timers, no
cancel-fallback scheduling, no `onModuleInit` re-arming, since a perpetual
has no expiry to arm any of that against. `terminate` is a pure
admin-initiated action with no natural liveness deadline (see the
contract's own doc comment — a stated v1 scope choice, not an oversight),
so creating and terminating a perpetual are both one-shot admin actions,
not automated the way `market-factory.service.ts` automates classic-market
rollover.

**Trading reuses the existing sponsored-relay path unchanged.**
`buy`/`sell`/`split`/`merge`/`redeem`/`transfer` have identical names and
argument shapes on both contracts, so `AuthRelayService.prepare`/`submit`
and `EmailAuthService.signAndSubmitTrade` all gained one new optional
parameter — `contractKind: 'market' | 'perpetual'` (default `'market'`,
so every existing caller keeps working unchanged) — that picks which
compiled `contract.Spec` to encode arguments against
(`marketSpec`/`perpetualSpec` in `contracts.ts`). No new signing/relay
logic at all; `wire-args.ts`'s `buildSponsoredCallArgs` was already
spec-agnostic.

**`price_oracle` is a real Lazer + Reflector + RedStone bundle when all
three are configured, `None` otherwise.** Follow-up round: RedStone has no
testnet deployment (mainnet-only — see `polaris-contracts/README.md`'s
"A third oracle: RedStone"), and `contracts/perpetual`'s `PriceOracleConfig`
requires *both* the Reflector and RedStone legs together whenever
`price_oracle` is configured at all — no Reflector-only option. That made
`record_price_checkpoint` genuinely unexercisable on testnet, not just
unwired. `polaris-contracts/contracts/mock-redstone` (a bare SEP-40-shaped
stand-in, same "mock the third-party interface" shape as
`contracts/mock-lazer`) closes this: `MOCK_REDSTONE_CONTRACT` configured
alongside the existing `LAZER_CONTRACT`/`REFLECTOR_CONTRACT` makes
`PerpetualController.buildPriceOracleParams` wire a full bundle into every
newly-created perpetual (`stellar.service.ts`'s `buildPriceOracleArg`,
mirroring `buildReflectorConfigArg`'s shape); leaving any of the three
unset keeps `price_oracle: None`, exactly as before this existed.

`POST /perpetuals/:id/checkpoint` (admin-gated, though `record_price_checkpoint`
itself is permissionless at the contract level — *some* account still has
to sign and pay for the call) refreshes the mock RedStone leg with a real
price (`StellarService.refreshMockRedstonePrice`) — unlike Reflector's
real testnet oracle, which updates itself on its own ~300s cadence, this
mock only ever returns whatever was last set — then calls
`record_price_checkpoint` with a real signed Lazer payload via the same
`OracleService.waitForUpdate` path `MarketService.trySettle` already uses,
so it degrades the same way (a clean 400 without a real
`PYTH_LAZER_TOKEN` — see bug 12 below for the version of this that
*didn't* degrade cleanly at first).

**Admin dashboard**: `GET /admin/overview` reports `totalPerpetuals`/
`perpetualsByStatus` as separate top-level fields, not merged into
`marketsByStatus` — a perpetual's status space (`'watching' | 'terminated'`)
isn't the same as a classic market's, so combining them would either
collide `'watching'`'s two different meanings or need namespacing either
way. `GET /admin/network`'s `wasmHashes` gained a `perpetual` entry
alongside `market`. `terminate` is logged to the same `wallet_actions`
table `buy`/`sell`/etc. use (a new `'terminate'` function kind, `'admin'`
source — it's not wallet-sponsored, so `'passkey'`/`'email'` don't fit) —
its 0.5-collateral-per-pair payout isn't a swap fee, so it's deliberately
excluded from `feeRevenue()`'s `buy`/`sell`-only accounting rather than
force-fit into it.

**Live-verified end-to-end through the real API** (not direct CLI calls):
`POST /perpetuals/create` deployed and initialized a real testnet
contract, this time with a genuine `price_oracle` bundle attached
(`GET .../state`'s `get_price_oracle` read back both legs' pinned
`decimals_at_init` correctly — 14 for the real Reflector, 8 for the mock);
a `buy` then a `sell` through `POST /auth/email/trade` (with
`contractKind: 'perpetual'`) round-tripped correctly (pool/position
math confirmed via `GET /perpetuals/:id/state`/`position`); `POST
/perpetuals/:id/terminate` wound it down; a final `redeem` paid out and
drained the position to zero. `GET /admin/overview` and `/admin/fee-revenue`
confirmed the dashboard picked up all of it correctly (`totalPerpetuals`,
`perpetualsByStatus`, and a nonzero fee-revenue row for the trade) — which
is also what caught bug 11 above.

The checkpoint path itself was verified in two halves, since this dev
environment has no `PYTH_LAZER_TOKEN` (see bug 12): `POST
/perpetuals/:id/checkpoint` correctly returns a clean 400 explaining why
under that constraint — proving the endpoint's own error handling, not the
oracle logic. The oracle logic itself (unanimous corroboration, not just
"wired up") was verified directly against the real contracts on testnet,
bypassing the token-gated `OracleService`: a hand-built Lazer payload
agreeing with both the real Reflector and the freshly-set mock RedStone
succeeded and recorded the checkpoint (confirmed via this backend's own
`GET /perpetuals/:id/state` afterward — `lastPriceCents`/`lastPriceAt`
updated, pools/`totalSupply` untouched); a second attempt with the mock
deliberately set to a wildly different price than Lazer's — while
Reflector still agreed with Lazer — correctly rejected with
`OracleDivergence`, and the perpetual's checkpoint fields were confirmed
unchanged afterward. That's the specific property this whole design
exists for (unanimous, not 2-of-3 majority — see
`polaris-contracts/README.md`'s "A third oracle: RedStone"), proven live,
not just asserted in a unit test.

## Off-chain multi-oracle settlement cross-check (Pyth-internal)

"Redundant multi-oracle" here means a **Pyth-internal cross-check**
(Lazer vs. Hermes — two different aggregation/latency paths, not two
independent providers), not a second on-chain oracle integration. Honest
about what it does and doesn't catch: both paths ultimately source from
Pyth's publisher network, so this catches a stale, malformed, or
individually-wrong read on one path — not a scenario where Pyth itself is
compromised end to end.

`OracleService.waitForUpdate` now subscribes with `parsed: true`, which
returns a *decoded* price (`ParsedPayload.priceFeeds[].price`/`exponent`)
in the exact same WebSocket message that already carries the signed
`leEcdsa` payload used for settlement — confirmed by reading
`@pythnetwork/pyth-lazer-sdk`'s own type definitions directly, not assumed.
No hand-rolled wire-format decoder needed for a second, independently-
comparable price value.

In `MarketService.trySettle`, if the feed has a `hermesFeedId` in the
configured catalog, `pyth-price.ts`'s `fetchHermesPriceCents` (shared with
the factory's strike-price lookup, `AbortSignal`-bounded at 8s — see its own
doc comment for why an unbounded fetch here used to be a genuine silent-stop
bug) fetches Hermes' current price. If it diverges from the Lazer-decoded
price by more than `SETTLE_ORACLE_TOLERANCE_BPS` (default 150 bps = 1.5%,
deliberately loose — this is a gross-divergence check, not an arbiter of
normal cross-path noise, and a tight tolerance would turn a defense-in-depth
check into a new way to needlessly stall a healthy settlement), an error is
thrown *before* `stellar.settle()` is ever called. That error is handled by
the exact same machinery bug 6 above added for an unrelated reason —
`reconcileWithChain` reads live on-chain state (finds the market still
genuinely `Open`, since nothing was submitted), falls through cleanly, and
the market gets `persist(pending)` + a scheduled cancel fallback, with zero
new fallback logic written for this. Any Hermes-fetch failure, timeout, or a
feed missing from the catalog skips the cross-check entirely and settles on
Lazer's signature alone, exactly as before this existed — the check must
never be able to turn a healthy settlement into a stuck one just because
*it* is unavailable.

**Verification limit, stated plainly rather than implied**: this has **no
live end-to-end path in this build environment** — same root cause as
`OracleService.isAvailable` always being `false` here (no real
`PYTH_LAZER_TOKEN` configured), which means `trySettle` always takes the
"oracle unavailable" branch straight to `cancel()` and never reaches the
cross-check at all. Its correctness is covered by 15 unit tests against
hand-rolled fakes (agreement, tolerance-trip with real bps math, missing
catalog entry, Hermes failure, Hermes timeout, undefined parsed price) —
not a live run. Same category of honest limit as the sponsored-relay path
below.

## On-chain second-oracle enforcement (Reflector Network)

Distinct from the off-chain check above, and stronger: `contracts/market`'s
`settle()` itself now requires a genuinely independent oracle (Reflector
Network — different node operators, different data pipeline, not just a
different Pyth product line) to agree with the Lazer-signed price before
finalizing, enforced by the contract, not this backend. See
`polaris-contracts/README.md`'s "On-chain second-oracle: Reflector Network"
for the full design, the live verification of Reflector's testnet
deployment, and why it fails closed rather than gracefully degrading (the
opposite of the off-chain check above, deliberately).

This backend's role is just threading `Market.reflector`'s four settings
through to every newly-deployed market — `CreateMarketParams` gained
`reflectorContract`/`reflectorAsset`/`reflectorMaxStalenessSecs`/
`reflectorToleranceBps`, `StellarService.deployMarket`'s CLI `initialize`
call passes them as a JSON-encoded `--reflector` struct arg (Stellar CLI's
way of taking a `contracttype` param), and both `MarketController.create()`
and `MarketFactoryService.createMarketFor` read them from config
(`REFLECTOR_CONTRACT` has no safe default — both refuse to deploy without
it configured, same fail-closed shape as `LAZER_CONTRACT`/`NATIVE_XLM_SAC`).

**A real gap this surfaced, fixed alongside it**: `MarketService.trySettle`
used to have zero retry — one failure went straight to
`scheduleCancelFallback`. Fine when every failure mode was essentially
permanent, but the on-chain Reflector check adds one that plausibly isn't
— a single missed 5-minute Reflector update cycle landing badly is likely
self-healing within a couple of minutes, and treating it identically to a
genuine permanent divergence means refunding a market that would have
resolved fine shortly after. `trySettle` now retries a failed attempt up
to `SETTLE_RETRY_ATTEMPTS` (3) times, `SETTLE_RETRY_DELAY_MS` (75s) apart,
before falling through to the cancel fallback — a real market's grace
period is comfortably longer than this whole retry budget, and
`reconcileWithChain` still runs after every attempt (not just the last),
so a hidden on-chain success is still caught immediately rather than
wasting a retry on it.

Both new behaviors have dedicated unit tests: `trySettle` recovering from
a transient failure on the second attempt without ever scheduling a
cancel fallback, and a persistent failure correctly exhausting all three
attempts (`stellar.settle`/`oracle.waitForUpdate` call counts asserted
directly, not just the end state — the intermediate `'pending'` status is
now too transient to assert cleanly with fake timers once retries are
involved, since the cancel fallback's own delay clamps to ~0 by the time
retries exhaust for a short-grace test market).

## Admin dashboard

`polaris-frontend`'s `/admin/*` dashboard (grouped sidebar: Overview,
Markets, Fee Revenue, Treasury, Wallets, Blockchain, Fraud & Trust) is
backed entirely by `admin.controller.ts`, all `AdminGuard`-gated and
read-only — the market-lifecycle admin actions (create, settle, cancel, run
the factory) stay on `MarketController`, which already owned them.

The load-bearing design decision: **no indexer needed for
trade/wallet/fee visibility**. Every trade already flows through this
backend at submission time (`AuthRelayService.submit()` for passkey,
`EmailAuthService.signAndSubmitTrade()` for custodial) and both already
poll to on-chain confirmation before returning — so `AdminActivityRepository`
just records a row at that point, plus at `MarketFactoryService`'s vault
withdrawal and at all 5 branches of the settlement cross-check. Every write
is best-effort (wrapped in try/catch, logged on failure) — a dropped
dashboard row is never allowed to affect the real trade/settle/factory path,
since `MarketRepository`, the vault, and the contracts stay the actual
source of truth; this table is a read-side cache, not a second one.

Two honest limits, not discovered later: **forward-looking only** (nothing
before this shipped appears — no retroactive indexing was built), and
**fee revenue is captured live via `getFee()` at write time, not derived
after the fact** — the contract's fee curve depends on the market's
`total_supply` at the moment of the trade, which isn't recoverable once
that trade has passed, so reconstructing it later from `collateral_amount`
alone would be structurally wrong, not just approximate.

## Running

```sh
cp .env.example .env   # fill in ORACLE_SECRET_KEY, ADMIN_API_KEY at minimum
npm install
npm run start:dev      # http://localhost:3001
npm test                # 120 unit tests
```

`ORACLE_SECRET_KEY` is the only hard requirement to boot — everything else
degrades gracefully (no `PYTH_LAZER_TOKEN` → markets fall back to
permissionless `cancel` at grace expiry instead of settling; no admin key
→ every admin route rejects, per `AdminGuard`'s fail-closed design).

## Known gaps

- `POST /wallets/deploy` is still unauthenticated by design (self-service
  onboarding for a fresh passkey, which by definition has no address yet
  to key a limiter on) — but is now rate-limited per IP
  (`WalletDeployRateLimiter`, `WALLET_DEPLOY_MAX_PER_HOUR`, default 5),
  mitigating rather than closing the abuse surface: an attacker rotating
  IPs still works around it. A production deployment would still want a
  stronger anti-abuse layer (CAPTCHA, requiring proof of an existing funded
  account).
- No test framework verification of the auth-relay's live submission path
  (see above) — the parts that don't need a network (ScVal construction,
  request validation) are covered; the RPC round-trip isn't.
- The RedStone leg every perpetual's `price_oracle` bundle now includes is
  `polaris-mock-redstone` (see "Perpetual markets" above) — a deliberate
  testnet stand-in, not real RedStone data. Fine for exercising the
  verification logic (which doesn't care where a leg's data comes from,
  only that it's a genuine, independently-queried contract), but the
  *checkpoint's actual price* isn't corroborated by real RedStone
  infrastructure until a mainnet deployment happens. RedStone visibility
  in the admin dashboard (a "2 vs 3 oracles configured" indicator,
  extending `/admin/settlement-checks`' existing two-oracle display to a
  third leg) is still a deferred follow-up, not implemented here.
- `POST /perpetuals/:id/checkpoint` is admin-triggered, not scheduled —
  nothing calls it automatically. A perpetual's `lastPriceCents`/
  `lastPriceAt` stays `0`/never-updated until an admin calls it by hand.
