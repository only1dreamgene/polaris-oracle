import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import { contract as StellarContract } from '@stellar/stellar-sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { marketSpec, perpetualSpec, factorySpec, vaultSpec, mockRedstoneSpec } from './contracts';
import type { OnChainMarket } from './market.types';
import type { OnChainPerpetual } from './perpetual.types';

const execFileAsync = promisify(execFile);

const CLI_RETRY_ATTEMPTS = 3;
const CLI_RETRY_DELAY_MS = 2000;
const RPC_RETRY_ATTEMPTS = 3;
const RPC_RETRY_DELAY_MS = 1000;
/** Gives the deployed contract a moment to propagate before `initialize` looks for it — see `deployMarket`. */
const DEPLOY_TO_INIT_DELAY_MS = 1500;

/**
 * `stellar` CLI failures seen live on testnet, from back-to-back calls
 * sharing one source account, turned out to come in more shapes than any
 * fixed allowlist of error strings could keep up with: `Contract not found`
 * and `HostError: Error(Storage, MissingValue)` are the *same* RPC-hasn't-
 * caught-up-to-the-deploy-yet race, worded differently; `TxBadSeq` is two
 * CLI processes racing on the account's sequence number; `client error
 * (SendRequest)` and a plain `transaction submission timeout` are the RPC
 * connection itself hiccuping. All of these resolved on retry.
 *
 * The one thing that must NOT be retried is a genuine rejection from the
 * *contract's own logic* (`HostError: Error(Contract, #N)` — bad strike
 * price, insufficient balance, an already-finalized market, ...): that
 * fails identically every time, so retrying it only wastes the attempt
 * budget before failing anyway with extra delay. Given how varied the
 * transient shapes have proven to be, retrying everything except a
 * confirmed contract-level rejection is the more defensible default than
 * chasing each new transient wording as it turns up.
 */
const PERMANENT_CONTRACT_ERROR = /Error\(Contract,/;

export function isTransientStellarCliError(message: string): boolean {
  return !PERMANENT_CONTRACT_ERROR.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The CLI's own `❌ error: ...` line if there is one — its stderr is otherwise multiple `ℹ️` progress lines followed by that summary, not necessarily last (a trailing diagnostic event dump can follow it). Falls back to the first line for a message with no such marker. */
function summaryLine(message: string): string {
  const lines = message.trim().split('\n');
  return lines.find((line) => line.includes('❌')) ?? lines[0];
}

export interface CreateMarketParams {
  strikePriceCents: bigint;
  expiry: bigint;
  gracePeriodSecs: bigint;
  lazerContract: string;
  feedId: number;
  baseFeeBps: number;
  minFeeBps: number;
  treasury: string;
  initialLiquidityStroops: bigint;
  collateralAsset: string;
  /** On-chain second-oracle settings — `initialize`'s 12th param, see `polaris-contracts/README.md`'s "On-chain second-oracle: Reflector Network". */
  reflectorContract: string;
  reflectorAsset: string;
  reflectorMaxStalenessSecs: bigint;
  reflectorToleranceBps: number;
}

/** See `configuration.ts`'s `mockRedstoneContract` doc comment for why both legs are required together. */
export interface PerpetualPriceOracleParams {
  lazerContract: string;
  feedId: number;
  reflectorContract: string;
  reflectorAsset: string;
  reflectorMaxStalenessSecs: bigint;
  reflectorToleranceBps: number;
  redstoneContract: string;
  /** RedStone's real wrapper keys XLM under `Asset::Stellar(<native XLM SAC>)`, not `Asset::Other` like Reflector — see `polaris-contracts/README.md`'s "A third oracle: RedStone". The mock reuses this same encoding for fidelity, even though it doesn't actually gate on the asset value. */
  nativeXlmSac: string;
  redstoneMaxStalenessSecs: bigint;
  redstoneToleranceBps: number;
}

export interface CreatePerpetualParams {
  baseFeeBps: number;
  minFeeBps: number;
  treasury: string;
  initialLiquidityStroops: bigint;
  collateralAsset: string;
  /** `undefined` → `price_oracle: None`, same as every perpetual this backend deployed before this existed. */
  priceOracle?: PerpetualPriceOracleParams;
}

/** The `--price_oracle` CLI arg for `deployPerpetual`'s `initialize` call — a JSON-encoded `Some(PriceOracleConfig)`. `reflector_decimals_at_init`/`redstone_decimals_at_init` are placeholders (`initialize` overwrites them with a live `decimals()` reading from each oracle regardless — see `PriceOracleConfig`'s doc comment in `polaris-contracts`). */
export function buildPriceOracleArg(params: PerpetualPriceOracleParams): string {
  return JSON.stringify({
    lazer_contract: params.lazerContract,
    feed_id: params.feedId,
    reflector: {
      contract: params.reflectorContract,
      asset: { Other: params.reflectorAsset },
      max_staleness_secs: Number(params.reflectorMaxStalenessSecs),
      tolerance_bps: params.reflectorToleranceBps,
    },
    reflector_decimals_at_init: 0,
    redstone: {
      contract: params.redstoneContract,
      asset: { Stellar: params.nativeXlmSac },
      max_staleness_secs: Number(params.redstoneMaxStalenessSecs),
      tolerance_bps: params.redstoneToleranceBps,
    },
    redstone_decimals_at_init: 0,
  });
}

/**
 * The `--reflector` CLI arg for `deployMarket`'s `initialize` call — a
 * JSON-encoded `OracleFeedConfig` struct (renamed from `ReflectorConfig`
 * once RedStone joined as a second corroborating leg using the same
 * shape — see `polaris-contracts/README.md`'s "A third oracle: RedStone").
 * `max_staleness_secs` must be a bare JSON number, not a quoted string,
 * confirmed live: the CLI's struct-arg parser rejected `"600"` with
 * "unknown variant `600`". Safe to convert the bigint directly here — this
 * field is always a small staleness window in seconds, nowhere near JS's
 * safe-integer ceiling, unlike the bigints passed as CLI *scalar* flags
 * elsewhere in `deployMarket`, which correctly stay strings.
 *
 * `asset` is `{ Other: "XLM" }`, not the bare string `"XLM"` this used to
 * be — `OracleFeedConfig.asset` became the `Asset` enum
 * (`Stellar(Address) | Other(Symbol)`) once RedStone needed to key XLM
 * under `Asset::Stellar(<SAC address>)` instead of Reflector's
 * `Asset::Other("XLM")`. This build stays `Other`-only (Reflector is the
 * only leg actually configured today), same "XLM-only" limitation as
 * before, just expressed through the richer type.
 */
export function buildReflectorConfigArg(
  params: Pick<CreateMarketParams, 'reflectorContract' | 'reflectorAsset' | 'reflectorMaxStalenessSecs' | 'reflectorToleranceBps'>,
): string {
  return JSON.stringify({
    contract: params.reflectorContract,
    asset: { Other: params.reflectorAsset },
    max_staleness_secs: Number(params.reflectorMaxStalenessSecs),
    tolerance_bps: params.reflectorToleranceBps,
  });
}

/**
 * All Stellar/Soroban I/O lives here: reads (via RPC simulation, no fee, no
 * signature), oracle-authorized writes (settle/cancel/wallet deploy, signed
 * by this process's own keypair via `contract.Client`), market deployment
 * (shells out to the Stellar CLI — see the class doc below for why that one
 * path is deliberately not reimplemented in-process), and Friendbot-backed
 * test account funding.
 *
 * This service's keypair only ever pays transaction fees and, for
 * `deployWallet`, funds a new smart wallet's initial liquidity-free
 * deployment — it has no privileged role over any user's funds. `settle`
 * and `cancel` are permissionless on-chain (see the contracts repo); this
 * service calling them is an automation convenience, not a trust
 * requirement.
 */
@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);
  readonly server: rpc.Server;
  private readonly keypair: Keypair;
  private readonly secretKey: string;
  /**
   * Deploy-time identity, separate from `keypair` (settle/cancel/vault
   * calls/wallet deploys — everything that stays online and signs
   * continuously). `DEPLOYER_SECRET_KEY` is optional and falls back to the
   * same key as everything else if unset, same graceful-degrade shape as
   * every other optional config here. Splitting these out is uniquely
   * low-risk for this contract specifically: `Market.admin` (set once at
   * `initialize()`) is never checked again by any other entrypoint —
   * `split`/`merge`/`buy`/`sell`/`transfer`/`redeem` all require the
   * *caller's* own auth, `settle`/`cancel` are fully permissionless — so a
   * deploy-only key plays no ongoing role after the one `initialize()` call
   * it signs. Real (if modest) benefit: if the always-hot settlement key is
   * ever compromised, it can't be used to deploy new markets claiming this
   * system's trusted admin identity.
   */
  private readonly deployerKeypair: Keypair;
  private readonly deployerSecretKey: string;
  readonly networkPassphrase: string;
  readonly rpcUrl: string;

  constructor(private readonly config: ConfigService) {
    const secret = this.config.get<string>('oracleSecretKey');
    if (!secret) {
      throw new Error('ORACLE_SECRET_KEY is required to start polaris-oracle');
    }
    this.secretKey = secret;
    this.keypair = Keypair.fromSecret(secret);
    const deployerSecret = this.config.get<string>('deployerSecretKey') ?? secret;
    this.deployerSecretKey = deployerSecret;
    this.deployerKeypair = Keypair.fromSecret(deployerSecret);
    this.networkPassphrase = this.config.get<string>('stellarNetworkPassphrase')!;
    this.rpcUrl = this.config.get<string>('stellarRpcUrl')!;
    this.server = new rpc.Server(this.rpcUrl, { allowHttp: this.rpcUrl.startsWith('http://') });
  }

  get oraclePublicKey(): string {
    return this.keypair.publicKey();
  }

  get deployerPublicKey(): string {
    return this.deployerKeypair.publicKey();
  }

  /** New — `rpc.Server.getHealth()` is never called anywhere else in this codebase. Powers the admin dashboard's Blockchain/network-health view. `GetHealthResponse` already carries `latestLedger`, so one RPC round trip is enough — no separate `getLatestLedger()` call needed. */
  async getNetworkHealth(): Promise<{
    status: string;
    latestLedger: number;
    oldestLedger: number;
    ledgerRetentionWindow: number;
  }> {
    const health = await this.server.getHealth();
    return {
      status: health.status,
      latestLedger: health.latestLedger,
      oldestLedger: health.oldestLedger,
      ledgerRetentionWindow: health.ledgerRetentionWindow,
    };
  }

  private marketClient(contractId: string) {
    return new StellarContract.Client(marketSpec, {
      contractId,
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
      allowHttp: this.rpcUrl.startsWith('http://'),
      publicKey: this.keypair.publicKey(),
      signTransaction: this.keypair as unknown as StellarContract.ClientOptions['signTransaction'],
      server: this.server,
    });
  }

  private perpetualClient(contractId: string) {
    return new StellarContract.Client(perpetualSpec, {
      contractId,
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
      allowHttp: this.rpcUrl.startsWith('http://'),
      publicKey: this.keypair.publicKey(),
      signTransaction: this.keypair as unknown as StellarContract.ClientOptions['signTransaction'],
      server: this.server,
    });
  }

  private mockRedstoneClient(contractId: string) {
    return new StellarContract.Client(mockRedstoneSpec, {
      contractId,
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
      allowHttp: this.rpcUrl.startsWith('http://'),
      publicKey: this.keypair.publicKey(),
      signTransaction: this.keypair as unknown as StellarContract.ClientOptions['signTransaction'],
      server: this.server,
    });
  }

  private factoryClient(contractId: string) {
    return new StellarContract.Client(factorySpec, {
      contractId,
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
      allowHttp: this.rpcUrl.startsWith('http://'),
      publicKey: this.keypair.publicKey(),
      signTransaction: this.keypair as unknown as StellarContract.ClientOptions['signTransaction'],
      server: this.server,
    });
  }

  private vaultClient(contractId: string) {
    return new StellarContract.Client(vaultSpec, {
      contractId,
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
      allowHttp: this.rpcUrl.startsWith('http://'),
      publicKey: this.keypair.publicKey(),
      signTransaction: this.keypair as unknown as StellarContract.ClientOptions['signTransaction'],
      server: this.server,
    });
  }

  /**
   * Every `contract.Client` method does an account-fetch + simulate step
   * before anything is signed or sent — confirmed live on testnet that this
   * step alone can fail transiently (`Account not found: G...` for an
   * account that demonstrably exists and was used seconds before and
   * after), the same class of RPC flakiness `execStellarCli` already
   * retries past for the CLI path, just never covered here. Safe to retry
   * unconditionally, unlike the CLI path's permanent/transient
   * classification: nothing has been submitted yet at this point, so a
   * retry can't double-submit anything, and a genuine contract-level
   * rejection can't surface here at all — that only appears via `.unwrap()`
   * on an already-successfully-returned `tx.result`, called separately
   * *after* this resolves, never wrapped by it. Deliberately does NOT wrap
   * `tx.signAndSend()` — retrying a send that may have actually landed
   * despite reporting failure is a different, harder problem
   * (`reconcileWithChain` is how `MarketService` already handles that for
   * settle/cancel specifically; blindly retrying here could double-submit).
   */
  private async withRpcRetry(fn: () => Promise<any>): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= RPC_RETRY_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt === RPC_RETRY_ATTEMPTS) throw err;
        this.logger.warn(
          `RPC call failed transiently (attempt ${attempt}/${RPC_RETRY_ATTEMPTS}), retrying: ${(err as Error).message}`,
        );
        await sleep(RPC_RETRY_DELAY_MS);
      }
    }
    throw lastErr;
  }

  // ---------- reads (simulated, no fee, no signature) ----------

  async getMarketState(contractId: string): Promise<OnChainMarket> {
    const client = this.marketClient(contractId);
    const tx = await this.withRpcRetry(() => (client as any).get_market());
    return normalizeMarket(tx.result.unwrap() as RawOnChainMarket);
  }

  async getPosition(contractId: string, address: string): Promise<[bigint, bigint]> {
    const client = this.marketClient(contractId);
    const tx = await this.withRpcRetry(() => (client as any).get_position({ addr: address }));
    return tx.result as [bigint, bigint];
  }

  async getPrice(contractId: string): Promise<{ yesBps: number; noBps: number }> {
    const client = this.marketClient(contractId);
    const tx = await this.withRpcRetry(() => (client as any).get_price());
    const [yesBps, noBps] = tx.result.unwrap() as [number, number];
    return { yesBps, noBps };
  }

  /** Current effective swap fee (bps) per the market's volume-scaled fee curve — see `get_fee` in the contract. */
  async getFee(contractId: string): Promise<number> {
    const client = this.marketClient(contractId);
    const tx = await this.withRpcRetry(() => (client as any).get_fee());
    return tx.result.unwrap() as number;
  }

  // ---------- perpetual reads (simulated, no fee, no signature) ----------

  async getPerpetualState(contractId: string): Promise<OnChainPerpetual> {
    const client = this.perpetualClient(contractId);
    const tx = await this.withRpcRetry(() => (client as any).get_market());
    return normalizePerpetual(tx.result.unwrap() as RawOnChainPerpetual);
  }

  async getPerpetualPosition(contractId: string, address: string): Promise<[bigint, bigint]> {
    const client = this.perpetualClient(contractId);
    const tx = await this.withRpcRetry(() => (client as any).get_position({ addr: address }));
    return tx.result as [bigint, bigint];
  }

  async getPerpetualPrice(contractId: string): Promise<{ yesBps: number; noBps: number }> {
    const client = this.perpetualClient(contractId);
    const tx = await this.withRpcRetry(() => (client as any).get_price());
    const [yesBps, noBps] = tx.result.unwrap() as [number, number];
    return { yesBps, noBps };
  }

  async getPerpetualFee(contractId: string): Promise<number> {
    const client = this.perpetualClient(contractId);
    const tx = await this.withRpcRetry(() => (client as any).get_fee());
    return tx.result.unwrap() as number;
  }

  /**
   * Admin-gated wind-down — see `polaris-contracts/README.md`'s "The
   * perpetual contract" for why this needs no price/oracle at all, unlike
   * `settle`. `initialize`'s `admin` is always `deployerPublicKey` (see
   * `deployPerpetual`), so this signs with `deployerKeypair`, mirroring
   * `deployMarket`'s own admin-identity split — matches on-chain
   * `require_auth()` against whichever key actually holds that role.
   */
  async terminatePerpetual(contractId: string): Promise<string> {
    const client = new StellarContract.Client(perpetualSpec, {
      contractId,
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
      allowHttp: this.rpcUrl.startsWith('http://'),
      publicKey: this.deployerKeypair.publicKey(),
      signTransaction: this.deployerKeypair as unknown as StellarContract.ClientOptions['signTransaction'],
      server: this.server,
    });
    const tx = await this.withRpcRetry(() => (client as any).terminate({ admin: this.deployerKeypair.publicKey() }));
    const sent = await tx.signAndSend();
    return sent.sendTransactionResponse?.hash ?? sent.getTransactionResponse?.txHash ?? '';
  }

  /**
   * Pokes `polaris-mock-redstone` (see `polaris-contracts/README.md`) with
   * a fresh price before a checkpoint attempt — unlike Reflector's real
   * testnet oracle (which updates itself on its own ~300s cadence), this
   * mock only ever returns whatever was last set, so whoever exercises
   * `record_price_checkpoint` owns keeping it fresh. `decimals` must match
   * whatever the mock's own `decimals()` currently reports (defaults to 8,
   * matching the real RedStone wrapper's live-confirmed value — see that
   * README section) — a mismatch here doesn't corrupt anything on-chain
   * (the contract always re-reads `decimals()` itself), it would just make
   * the *price value* wrong by a power of 10, which the divergence check
   * against Lazer would then correctly reject.
   */
  async refreshMockRedstonePrice(contractId: string, priceCents: bigint, decimals = 8): Promise<string> {
    const client = this.mockRedstoneClient(contractId);
    const price = priceCents * 10n ** BigInt(decimals - 2);
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const tx = await this.withRpcRetry(() => (client as any).set_price({ price, timestamp }));
    const sent = await tx.signAndSend();
    return sent.sendTransactionResponse?.hash ?? sent.getTransactionResponse?.txHash ?? '';
  }

  /** Permissionless at the contract level (see `record_price_checkpoint`'s own doc comment in `polaris-contracts`) — signed here by this process's own keypair purely because *some* account has to pay the fee, same as `settle`/`cancel`. */
  async recordPriceCheckpoint(contractId: string, payload: Buffer): Promise<string> {
    const client = this.perpetualClient(contractId);
    const tx = await this.withRpcRetry(() => (client as any).record_price_checkpoint({ payload }));
    const sent = await tx.signAndSend();
    return sent.sendTransactionResponse?.hash ?? sent.getTransactionResponse?.txHash ?? '';
  }

  // ---------- oracle-authorized writes ----------

  async settle(contractId: string, payload: Buffer): Promise<string> {
    const client = this.marketClient(contractId);
    const tx = await this.withRpcRetry(() => (client as any).settle({ payload }));
    const sent = await tx.signAndSend();
    return sent.sendTransactionResponse?.hash ?? sent.getTransactionResponse?.txHash ?? '';
  }

  async cancel(contractId: string): Promise<string> {
    const client = this.marketClient(contractId);
    const tx = await this.withRpcRetry(() => (client as any).cancel());
    const sent = await tx.signAndSend();
    return sent.sendTransactionResponse?.hash ?? sent.getTransactionResponse?.txHash ?? '';
  }

  /**
   * Deploys a new smart-wallet instance for `publicKey` via the (already
   * deployed and configured) factory contract, with this process paying the
   * fee — so a brand-new user can get a working Soroban address before they
   * hold a single stroop. Returns the wallet's contract address, decoded
   * straight from the factory call's result.
   *
   * No wasm hash passed here — `deploy` takes only `public_key` now. It
   * used to accept a caller-chosen wasm hash too, which was a real,
   * confirmed-exploitable address-hijack vector (see
   * `polaris-contracts/README.md`'s "Factory wasm pinning" section): the
   * factory now always deploys its own pinned wallet code, set once via
   * `initializeFactory` below.
   */
  async deployWallet(factoryContractId: string, publicKey: Buffer): Promise<string> {
    const client = this.factoryClient(factoryContractId);
    const tx = await this.withRpcRetry(() => (client as any).deploy({ public_key: publicKey }));
    const sent = await tx.signAndSend();
    return (sent.result as { unwrap: () => string }).unwrap();
  }

  /**
   * One-time factory setup pinning which wallet wasm `deploy` will ever
   * run — must be called once after deploying a fresh
   * `smart-wallet-factory` instance, before `deployWallet` will do
   * anything. `admin` here is only the authority to set this once; it has
   * no ongoing role over deployed wallets.
   */
  async initializeFactory(factoryContractId: string, walletWasmHash: Buffer): Promise<string> {
    const client = this.factoryClient(factoryContractId);
    const tx = await this.withRpcRetry(() =>
      (client as any).initialize({ admin: this.oraclePublicKey, wasm_hash: walletWasmHash }),
    );
    const sent = await tx.signAndSend();
    (sent.result as { unwrap: () => void }).unwrap();
    return sent.sendTransactionResponse?.hash ?? sent.getTransactionResponse?.txHash ?? '';
  }

  /**
   * The address `deployWallet` would produce for `publicKey`, computed by
   * the factory contract's own `resolve` view — a free simulated read, no
   * transaction, no fee — without deploying anything. This is what makes a
   * passkey a portable identity: any caller can check whether a wallet
   * already exists for a given public key before prompting a "create
   * wallet" flow, using the exact on-chain address-derivation formula
   * rather than a reimplementation of it.
   */
  async resolveWallet(factoryContractId: string, publicKey: Buffer): Promise<string> {
    const client = this.factoryClient(factoryContractId);
    const tx = await this.withRpcRetry(() => (client as any).resolve({ public_key: publicKey }));
    return tx.result as string;
  }

  // ---------- capital-efficiency vault ----------
  //
  // See `polaris-contracts/README.md`'s "The capital-efficiency vault" for
  // the full design. This backend only ever withdraws from it (to seed a
  // new market's initial_liquidity) and reads its balance — deposits and
  // admin setup (`initialize`) are operator actions taken directly via the
  // Stellar CLI, not something the app itself does on anyone's behalf.

  /** Available capital, in stroops — checked before `MarketFactoryService` withdraws to seed a new market, so an underfunded vault fails loudly instead of a partial/confusing on-chain error. */
  async vaultBalance(vaultContractId: string): Promise<bigint> {
    const client = this.vaultClient(vaultContractId);
    const tx = await this.withRpcRetry(() => (client as any).get_balance());
    return (tx.result as { unwrap: () => bigint }).unwrap();
  }

  /** Lifetime deposits, in stroops — always `>= vaultBalance` (this v1 vault has no LP-share accounting yet, see the contract's own doc comment). Powers the admin dashboard's Treasury view. */
  async vaultTotalDeposited(vaultContractId: string): Promise<bigint> {
    const client = this.vaultClient(vaultContractId);
    const tx = await this.withRpcRetry(() => (client as any).get_total_deposited());
    return (tx.result as { unwrap: () => bigint }).unwrap();
  }

  /** Moves `amount` stroops from the vault to this process's own account, to fund a new market's `initial_liquidity` — the same account `deployMarket` already transfers that liquidity from. */
  async vaultWithdraw(vaultContractId: string, amount: bigint): Promise<string> {
    const client = this.vaultClient(vaultContractId);
    const tx = await this.withRpcRetry(() =>
      (client as any).withdraw({
        admin: this.oraclePublicKey,
        to: this.oraclePublicKey,
        amount,
      }),
    );
    const sent = await tx.signAndSend();
    (sent.result as { unwrap: () => void }).unwrap();
    return sent.sendTransactionResponse?.hash ?? sent.getTransactionResponse?.txHash ?? '';
  }

  // ---------- market deployment (Stellar CLI) ----------
  //
  // Every other write in this service goes through `contract.Client`,
  // in-process, over RPC. Market *deployment* is the one exception, kept as
  // a CLI shell-out (`stellar contract deploy` + `invoke initialize`)
  // deliberately: computing a freshly-created contract's address correctly
  // from raw `createCustomContract`/upload operations, with no live network
  // in this build environment to verify the derivation against, is a
  // meaningfully riskier reimplementation than calling the CLI tool that
  // the whole ecosystem already relies on to get this right. Everything
  // downstream of a market existing (buy/sell/settle/cancel/redeem) is
  // exercised in-process and unit-tested; this one path trades a small
  // amount of deploy-time robustness (see the contracts repo's Fly.io
  // gotchas: `libdbus-1-3`) for correctness confidence on the piece most
  // likely to silently misbehave if hand-rolled blind.
  //
  // `--source` is passed the raw secret directly (the CLI accepts a secret
  // key or seed phrase as an alternative to a named identity). Uses
  // `deployerSecretKey`/`deployerPublicKey`, not the main oracle key —
  // `initialize`'s `admin` parameter is set to the *deployer's* public
  // address below, and `admin.require_auth()` needs whichever key signs
  // this transaction to match it. See the field doc comment on
  // `deployerKeypair` for why this split is safe and worth having.
  async deployMarket(params: CreateMarketParams): Promise<{ contractId: string; initTxHash: string }> {
    const network = this.config.get<string>('stellarNetwork')!;
    const deploy = await this.execStellarCli([
      'contract',
      'deploy',
      '--wasm',
      'wasm/polaris_market.wasm',
      '--source',
      this.deployerSecretKey,
      '--network',
      network,
      '--rpc-url',
      this.rpcUrl,
      '--network-passphrase',
      this.networkPassphrase,
    ]);
    const contractId = deploy.stdout.trim().split('\n').pop()!.trim();
    this.logger.log(`deployed market contract ${contractId}`);

    // The freshly deployed contract isn't always visible to the RPC node
    // `initialize` immediately queries next — a bare wait here cuts down how
    // often the retry below is actually needed, rather than relying on it
    // to paper over an avoidable race every time.
    await sleep(DEPLOY_TO_INIT_DELAY_MS);

    const initArgs = [
      'contract',
      'invoke',
      '--id',
      contractId,
      '--source',
      this.deployerSecretKey,
      '--network',
      network,
      '--rpc-url',
      this.rpcUrl,
      '--network-passphrase',
      this.networkPassphrase,
      '--',
      'initialize',
      '--admin',
      this.deployerPublicKey,
      '--collateral',
      params.collateralAsset,
      '--strike_price',
      params.strikePriceCents.toString(),
      '--expiry',
      params.expiry.toString(),
      '--grace_period',
      params.gracePeriodSecs.toString(),
      '--lazer_contract',
      params.lazerContract,
      '--feed_id',
      params.feedId.toString(),
      '--base_fee_bps',
      params.baseFeeBps.toString(),
      '--min_fee_bps',
      params.minFeeBps.toString(),
      '--treasury',
      params.treasury,
      '--initial_liquidity',
      params.initialLiquidityStroops.toString(),
      '--reflector',
      buildReflectorConfigArg(params),
      // `initialize`'s 13th param, `Option<OracleFeedConfig>` — RedStone
      // has no testnet deployment (see polaris-contracts/README.md's "A
      // third oracle: RedStone"), so this stays unconditionally `None`.
      // `null` confirmed live as the CLI's encoding for an omitted
      // optional struct arg (its own error message for a missing field
      // elsewhere literally suggests this: "For optional values, use null
      // for none or the expected value type").
      '--redstone',
      'null',
    ];

    try {
      const invoke = await this.execStellarCli(initArgs);
      return { contractId, initTxHash: invoke.stdout.trim() };
    } catch (err) {
      // Confirmed live: the CLI's own submission can succeed on-chain while
      // still reporting a client-side failure (its result-polling hit a
      // hiccup and, per the doc comment on PERMANENT_CONTRACT_ERROR, a
      // second internal attempt then simulates against the now-initialized
      // contract and reports the *simulation's* rejection instead) — the
      // exact same "crash between on-chain success and this backend
      // recording it" shape as MarketService.reconcileWithChain, just for
      // deploy instead of settle/cancel. Without this check, a genuinely
      // successful deploy would be reported as a failure and — for
      // MarketFactoryService specifically — the vault capital that already
      // funded this real, open market would never get an entry in
      // MarketRepository, so it would never get settlement timers armed.
      const message = (err as { stderr?: string; message: string }).stderr ?? (err as Error).message;
      if (!/Error\(Contract, #2\)/.test(message)) throw err; // #2 = AlreadyInitialized, see contracts/market's Error enum
      const state = await this.getMarketState(contractId);
      if (state.status !== 'Open') throw err; // genuinely uninitialized/broken — the AlreadyInitialized report was accurate, not a false negative
      this.logger.warn(
        `initialize on ${contractId} reported AlreadyInitialized but the contract is Open on-chain — treating as already succeeded, not a failure (no initTxHash available for this reconciled path)`,
      );
      return { contractId, initTxHash: '' };
    }
  }

  /**
   * Same deploy-then-initialize CLI shell-out as `deployMarket`, for
   * `polaris-perpetual` — no strike/expiry/grace_period/feed_id (none
   * exist on this contract), and `price_oracle` is unconditionally `None`:
   * this backend doesn't wire a real Lazer+Reflector[+RedStone] bundle
   * into perpetual deployment yet (that's a separate follow-up — see
   * `polaris-contracts/README.md`'s "A third oracle: RedStone", which is
   * mainnet-only regardless). `record_price_checkpoint` is consequently
   * not exposed anywhere in this backend either — see `PerpetualController`.
   */
  async deployPerpetual(params: CreatePerpetualParams): Promise<{ contractId: string; initTxHash: string }> {
    const network = this.config.get<string>('stellarNetwork')!;
    const deploy = await this.execStellarCli([
      'contract',
      'deploy',
      '--wasm',
      'wasm/polaris_perpetual.wasm',
      '--source',
      this.deployerSecretKey,
      '--network',
      network,
      '--rpc-url',
      this.rpcUrl,
      '--network-passphrase',
      this.networkPassphrase,
    ]);
    const contractId = deploy.stdout.trim().split('\n').pop()!.trim();
    this.logger.log(`deployed perpetual contract ${contractId}`);

    await sleep(DEPLOY_TO_INIT_DELAY_MS);

    const initArgs = [
      'contract',
      'invoke',
      '--id',
      contractId,
      '--source',
      this.deployerSecretKey,
      '--network',
      network,
      '--rpc-url',
      this.rpcUrl,
      '--network-passphrase',
      this.networkPassphrase,
      '--',
      'initialize',
      '--admin',
      this.deployerPublicKey,
      '--collateral',
      params.collateralAsset,
      '--base_fee_bps',
      params.baseFeeBps.toString(),
      '--min_fee_bps',
      params.minFeeBps.toString(),
      '--treasury',
      params.treasury,
      '--initial_liquidity',
      params.initialLiquidityStroops.toString(),
      '--price_oracle',
      params.priceOracle ? buildPriceOracleArg(params.priceOracle) : 'null',
    ];

    try {
      const invoke = await this.execStellarCli(initArgs);
      return { contractId, initTxHash: invoke.stdout.trim() };
    } catch (err) {
      // Same AlreadyInitialized reconciliation as `deployMarket` — see its
      // own comment for the full "CLI can report failure on a call that
      // actually succeeded on-chain" reasoning.
      const message = (err as { stderr?: string; message: string }).stderr ?? (err as Error).message;
      if (!/Error\(Contract, #2\)/.test(message)) throw err; // #2 = AlreadyInitialized, see contracts/perpetual's Error enum
      const state = await this.getPerpetualState(contractId);
      if (state.status !== 'Open') throw err;
      this.logger.warn(
        `initialize on ${contractId} reported AlreadyInitialized but the contract is Open on-chain — treating as already succeeded, not a failure (no initTxHash available for this reconciled path)`,
      );
      return { contractId, initTxHash: '' };
    }
  }

  /** Runs a `stellar` CLI call, retrying past the transient failures in `TRANSIENT_CLI_ERROR`. Anything else fails immediately — retrying a genuine error (bad params, insufficient balance) would just waste time before failing anyway. */
  private async execStellarCli(
    args: string[],
    attempts = CLI_RETRY_ATTEMPTS,
  ): Promise<{ stdout: string; stderr: string }> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await execFileAsync('stellar', args);
      } catch (err) {
        lastErr = err;
        const message = (err as { stderr?: string; message: string }).stderr ?? (err as Error).message;
        if (attempt === attempts || !isTransientStellarCliError(message)) throw err;
        this.logger.warn(
          `stellar CLI call failed transiently (attempt ${attempt}/${attempts}), retrying: ${summaryLine(message)}`,
        );
        await sleep(CLI_RETRY_DELAY_MS);
      }
    }
    throw lastErr;
  }
}

/**
 * The exact shape `contract.Spec` decodes the Rust `Market` struct into:
 * verified against `spec.js`'s `structToNative`/`unionToNative` (exact
 * Rust field names, no case conversion; the `MarketStatus` union as
 * `{ tag: 'Open' }` rather than a bare string) rather than assumed —
 * see `normalizeMarket` below for the translation to the REST-facing shape.
 */
interface RawOnChainMarket {
  admin: string;
  collateral: string;
  strike_price: bigint;
  expiry: bigint;
  grace_period: bigint;
  lazer_contract: string;
  feed_id: number;
  base_fee_bps: number;
  min_fee_bps: number;
  treasury: string;
  status: { tag: 'Open' | 'ResolvedYes' | 'ResolvedNo' | 'Cancelled' };
  final_price: bigint;
  pool_yes: bigint;
  pool_no: bigint;
  total_supply: bigint;
  initial_liquidity: bigint;
}

/** Raw `contract.Spec`-decoded `Perpetual` — see `RawOnChainMarket`'s doc comment for why this isn't assumed to line up with `OnChainPerpetual`'s field names/casing without an explicit translation. */
interface RawOnChainPerpetual {
  admin: string;
  collateral: string;
  base_fee_bps: number;
  min_fee_bps: number;
  treasury: string;
  status: { tag: 'Open' | 'Terminated' };
  pool_yes: bigint;
  pool_no: bigint;
  total_supply: bigint;
  initial_liquidity: bigint;
  last_price_cents: bigint;
  last_price_at: bigint;
}

function normalizePerpetual(raw: RawOnChainPerpetual): OnChainPerpetual {
  return {
    admin: raw.admin,
    collateral: raw.collateral,
    baseFeeBps: raw.base_fee_bps,
    minFeeBps: raw.min_fee_bps,
    treasury: raw.treasury,
    status: raw.status.tag,
    poolYes: raw.pool_yes.toString(),
    poolNo: raw.pool_no.toString(),
    totalSupply: raw.total_supply.toString(),
    initialLiquidity: raw.initial_liquidity.toString(),
    lastPriceCents: raw.last_price_cents.toString(),
    lastPriceAt: raw.last_price_at.toString(),
  };
}

function normalizeMarket(raw: RawOnChainMarket): OnChainMarket {
  return {
    admin: raw.admin,
    collateral: raw.collateral,
    strikePrice: raw.strike_price.toString(),
    expiry: raw.expiry.toString(),
    gracePeriod: raw.grace_period.toString(),
    lazerContract: raw.lazer_contract,
    feedId: raw.feed_id,
    baseFeeBps: raw.base_fee_bps,
    minFeeBps: raw.min_fee_bps,
    treasury: raw.treasury,
    status: raw.status.tag,
    finalPrice: raw.final_price.toString(),
    poolYes: raw.pool_yes.toString(),
    poolNo: raw.pool_no.toString(),
    totalSupply: raw.total_supply.toString(),
    initialLiquidity: raw.initial_liquidity.toString(),
  };
}
