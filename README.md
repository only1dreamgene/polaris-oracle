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
| `market.repository.ts` | WAL-journaled SQLite persistence via `better-sqlite3`. |
| `admin.guard.ts` | `x-admin-key` check, constant-time compare, fails closed if unset. |
| `faucet.service.ts` | Rate-limited (3/hour/address) Friendbot funding. |
| `contracts.ts` | Loads `wasm/*.wasm` and parses each contract's real spec via `contract.Spec.fromWasm` — argument/return encoding for custom types (the `Prediction` enum, the `Market`/`Signature` structs) comes from the compiled contract, not from guessing the wire format. |
| `wire-args.ts` | Converts JSON-transportable request args into `xdr.ScVal[]`, and — the part that actually matters — injects the wallet's own address into whichever parameter authorizes each sponsored call. See "Bugs found by pressure-testing" below. |

## Bugs found by pressure-testing this system

Three real bugs surfaced by deliberately trying to break this system after
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

Worth knowing if you add a new on-chain read: `contract.Spec` preserves the
Rust struct's exact field names (snake_case) and represents enums as
`{ tag: 'Open' }` rather than a bare string — it does **not** camelCase
anything, so casting a raw decode result straight to a REST-facing type
(the mistake bug 2 was) is an easy trap to fall back into.

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

## Running

```sh
cp .env.example .env   # fill in ORACLE_SECRET_KEY, ADMIN_API_KEY at minimum
npm install
npm run start:dev      # http://localhost:3001
npm test                # 42 unit tests
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
