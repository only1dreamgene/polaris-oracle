# polaris-oracle

NestJS settlement automation for **Polaris**. Watches deployed markets,
relays Pyth Lazer prices at expiry, calls `settle`/`cancel`, and exposes a
public read API, an admin API, a testnet faucet, and the passkey
smart-wallet deploy + sponsored-transaction relay.

See `../polaris-contracts/README.md` for the on-chain half of this system.

## Layout

| File | Responsibility |
|---|---|
| `stellar.service.ts` | All Stellar/Soroban I/O: reads via RPC simulation, oracle-authorized writes (`settle`/`cancel`/wallet deploy) via `contract.Client`, market deployment via the Stellar CLI (see the class doc for why that one path isn't reimplemented in-process). |
| `auth-relay.service.ts` | Sponsors passkey-authorized calls: this process pays the fee, a WebAuthn passkey signs the Soroban authorization entry, in two HTTP round-trips (`prepare` / `submit`). |
| `oracle.service.ts` | Pyth Lazer WebSocket client (`@pythnetwork/pyth-lazer-sdk`). Exposes `isAvailable` and `waitForUpdate`. |
| `market.service.ts` | Settlement orchestration: arms a timer per watched market, falls back to permissionless `cancel` on any failure or oracle outage, re-arms on process restart. |
| `market-factory.service.ts` | "No human clicks a button" market creation: sweeps a configured feed catalog on an interval, funds each new market's seed liquidity from the capital-efficiency vault instead of a manual admin transfer. See "Market factory automation" below. |
| `market.repository.ts` | WAL-journaled SQLite persistence via `better-sqlite3`. |
| `admin.guard.ts` | `x-admin-key` check, constant-time compare, fails closed if unset. |
| `faucet.service.ts` | Rate-limited (3/hour/address) Friendbot funding. |
| `contracts.ts` | Loads `wasm/*.wasm` and parses each contract's real spec via `contract.Spec.fromWasm` — argument/return encoding for custom types (the `Prediction` enum, the `Market`/`Signature` structs) comes from the compiled contract, not from guessing the wire format. |
| `wire-args.ts` | Converts JSON-transportable request args into `xdr.ScVal[]`, and — the part that actually matters — injects the wallet's own address into whichever parameter authorizes each sponsored call. See "Bugs found by pressure-testing" below. |

## Bugs found by pressure-testing this system

Eight real bugs surfaced by deliberately trying to break this system after
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
   `../polaris-contracts/README.md`'s vault section) *before* attempting to
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

## Running

```sh
cp .env.example .env   # fill in ORACLE_SECRET_KEY, ADMIN_API_KEY at minimum
npm install
npm run start:dev      # http://localhost:3001
npm test                # 70 unit tests
```

`ORACLE_SECRET_KEY` is the only hard requirement to boot — everything else
degrades gracefully (no `PYTH_LAZER_TOKEN` → markets fall back to
permissionless `cancel` at grace expiry instead of settling; no admin key
→ every admin route rejects, per `AdminGuard`'s fail-closed design).

## Known gaps

- `POST /wallets/deploy` is unauthenticated and unrated-limited by design
  (self-service onboarding for a fresh passkey, which by definition has no
  address yet to key a limiter on) — an attacker could still spam-deploy
  wallets to drain this process's fee-paying balance. A production
  deployment needs a real anti-abuse layer here (CAPTCHA, IP throttling, or
  requiring proof of an existing funded account); deliberately out of scope
  for this build, same spirit as the contracts repo's own "deliberately out
  of scope" list.
- No test framework verification of the auth-relay's live submission path
  (see above) — the parts that don't need a network (ScVal construction,
  request validation) are covered; the RPC round-trip isn't.
