import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import { contract as StellarContract } from '@stellar/stellar-sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { marketSpec, factorySpec } from './contracts';
import type { OnChainMarket } from './market.types';

const execFileAsync = promisify(execFile);

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
  readonly networkPassphrase: string;
  readonly rpcUrl: string;

  constructor(private readonly config: ConfigService) {
    const secret = this.config.get<string>('oracleSecretKey');
    if (!secret) {
      throw new Error('ORACLE_SECRET_KEY is required to start polaris-oracle');
    }
    this.secretKey = secret;
    this.keypair = Keypair.fromSecret(secret);
    this.networkPassphrase = this.config.get<string>('stellarNetworkPassphrase')!;
    this.rpcUrl = this.config.get<string>('stellarRpcUrl')!;
    this.server = new rpc.Server(this.rpcUrl, { allowHttp: this.rpcUrl.startsWith('http://') });
  }

  get oraclePublicKey(): string {
    return this.keypair.publicKey();
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

  // ---------- reads (simulated, no fee, no signature) ----------

  async getMarketState(contractId: string): Promise<OnChainMarket> {
    const client = this.marketClient(contractId);
    const tx = await (client as any).get_market();
    return normalizeMarket(tx.result.unwrap() as RawOnChainMarket);
  }

  async getPosition(contractId: string, address: string): Promise<[bigint, bigint]> {
    const client = this.marketClient(contractId);
    const tx = await (client as any).get_position({ addr: address });
    return tx.result as [bigint, bigint];
  }

  async getPrice(contractId: string): Promise<{ yesBps: number; noBps: number }> {
    const client = this.marketClient(contractId);
    const tx = await (client as any).get_price();
    const [yesBps, noBps] = tx.result.unwrap() as [number, number];
    return { yesBps, noBps };
  }

  /** Current effective swap fee (bps) per the market's volume-scaled fee curve — see `get_fee` in the contract. */
  async getFee(contractId: string): Promise<number> {
    const client = this.marketClient(contractId);
    const tx = await (client as any).get_fee();
    return tx.result.unwrap() as number;
  }

  // ---------- oracle-authorized writes ----------

  async settle(contractId: string, payload: Buffer): Promise<string> {
    const client = this.marketClient(contractId);
    const tx = await (client as any).settle({ payload });
    const sent = await tx.signAndSend();
    return sent.sendTransactionResponse?.hash ?? sent.getTransactionResponse?.txHash ?? '';
  }

  async cancel(contractId: string): Promise<string> {
    const client = this.marketClient(contractId);
    const tx = await (client as any).cancel();
    const sent = await tx.signAndSend();
    return sent.sendTransactionResponse?.hash ?? sent.getTransactionResponse?.txHash ?? '';
  }

  /**
   * Deploys a new smart-wallet instance for `publicKey` via the (already
   * deployed and configured) factory contract, with this process paying the
   * fee — so a brand-new user can get a working Soroban address before they
   * hold a single stroop. Returns the wallet's contract address, decoded
   * straight from the factory call's result.
   */
  async deployWallet(factoryContractId: string, publicKey: Buffer, walletWasmHash: Buffer): Promise<string> {
    const client = this.factoryClient(factoryContractId);
    const tx = await (client as any).deploy({ public_key: publicKey, wasm_hash: walletWasmHash });
    const sent = await tx.signAndSend();
    return sent.result as string;
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
    const tx = await (client as any).resolve({ public_key: publicKey });
    return tx.result as string;
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
  // key or seed phrase as an alternative to a named identity) rather than a
  // separately-provisioned "deployer" identity: `initialize`'s `admin`
  // parameter is set to this same key's public address below, and
  // `admin.require_auth()` needs whichever key signs this transaction to
  // match it. Using one keypair for both online settlement and deployment
  // also means there's no `DEPLOYER_SEED_PHRASE` to provision at container
  // startup — one less moving part than a separate cold deploy key would
  // need, appropriate for a testnet build (a production deployment with
  // real value at stake would reasonably want these separated again).
  async deployMarket(params: CreateMarketParams): Promise<{ contractId: string; initTxHash: string }> {
    const network = this.config.get<string>('stellarNetwork')!;
    const deploy = await execFileAsync('stellar', [
      'contract',
      'deploy',
      '--wasm',
      'wasm/polaris_market.wasm',
      '--source',
      this.secretKey,
      '--network',
      network,
      '--rpc-url',
      this.rpcUrl,
      '--network-passphrase',
      this.networkPassphrase,
    ]);
    const contractId = deploy.stdout.trim().split('\n').pop()!.trim();
    this.logger.log(`deployed market contract ${contractId}`);

    const invoke = await execFileAsync('stellar', [
      'contract',
      'invoke',
      '--id',
      contractId,
      '--source',
      this.secretKey,
      '--network',
      network,
      '--rpc-url',
      this.rpcUrl,
      '--network-passphrase',
      this.networkPassphrase,
      '--',
      'initialize',
      '--admin',
      this.oraclePublicKey,
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
    ]);
    const initTxHash = invoke.stdout.trim();
    return { contractId, initTxHash };
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
