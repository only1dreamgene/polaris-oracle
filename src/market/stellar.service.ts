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
  feeBps: number;
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
  readonly networkPassphrase: string;
  readonly rpcUrl: string;

  constructor(private readonly config: ConfigService) {
    const secret = this.config.get<string>('oracleSecretKey');
    if (!secret) {
      throw new Error('ORACLE_SECRET_KEY is required to start polaris-oracle');
    }
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
    return tx.result as OnChainMarket;
  }

  async getPosition(contractId: string, address: string): Promise<[bigint, bigint]> {
    const client = this.marketClient(contractId);
    const tx = await (client as any).get_position({ addr: address });
    return tx.result as [bigint, bigint];
  }

  async getPrice(contractId: string): Promise<{ yesBps: number; noBps: number }> {
    const client = this.marketClient(contractId);
    const tx = await (client as any).get_price();
    const [yesBps, noBps] = tx.result as [number, number];
    return { yesBps, noBps };
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
  // gotchas: `libdbus-1-3`, CLI identity provisioning) for correctness
  // confidence on the piece most likely to silently misbehave if hand-rolled
  // blind.
  async deployMarket(params: CreateMarketParams): Promise<{ contractId: string; initTxHash: string }> {
    const network = this.config.get<string>('stellarNetwork')!;
    const deploy = await execFileAsync('stellar', [
      'contract',
      'deploy',
      '--wasm',
      'wasm/polaris_market.wasm',
      '--source',
      'deployer',
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
      'deployer',
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
      '--fee_bps',
      params.feeBps.toString(),
      '--treasury',
      params.treasury,
      '--initial_liquidity',
      params.initialLiquidityStroops.toString(),
    ]);
    const initTxHash = invoke.stdout.trim();
    return { contractId, initTxHash };
  }
}
