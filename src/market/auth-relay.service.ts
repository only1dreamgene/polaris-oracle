import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  hash,
  inspectAuthEntry,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import type { contract } from '@stellar/stellar-sdk';
import { marketSpec, perpetualSpec } from './contracts';
import { buildSponsoredCallArgs, type WireArgs } from './wire-args';
import type { ContractKind } from './dto/prepare-auth.dto';

/** `polaris-market`/`polaris-perpetual` share every sponsorable function's
 * name and shape (see `polaris-contracts/README.md`'s "The perpetual
 * contract") — the only thing that differs per contract kind is which
 * compiled spec `buildSponsoredCallArgs` encodes `wireArgs` against. */
function specFor(kind: ContractKind | undefined): contract.Spec {
  return kind === 'perpetual' ? perpetualSpec : marketSpec;
}

export interface PrepareAuthResult {
  entryXdr: string;
  signaturePayloadHex: string;
  validUntilLedgerSeq: number;
}

export interface WebAuthnAssertion {
  authenticatorDataHex: string;
  clientDataJsonBase64: string;
  /** Raw 64-byte r‖s ECDSA signature, DER-decoded and low-S normalized client-side. */
  signatureHex: string;
}

/**
 * Sponsors transactions authorized by a passkey smart-wallet address instead
 * of a classic keypair: this process pays the fee (its own keypair signs the
 * transaction *envelope*, a normal Stellar source-account signature), while
 * the wallet's own Soroban authorization entry is signed by the user's
 * passkey in the browser.
 *
 * Necessarily two HTTP round-trips, because "signing" here means a Face
 * ID/Touch ID prompt in the user's browser — there's no synchronous
 * in-process callback to hand a signer, unlike a normal `Keypair`:
 *
 * 1. `prepare()` — builds the call, simulates it (letting the host
 *    auto-record which addresses need to authorize what), and returns the
 *    32-byte hash the passkey needs to sign plus the exact (unsigned)
 *    authorization entry XDR that hash was derived from.
 * 2. `submit()` — takes that same entry XDR back (unchanged — its nonce and
 *    invocation tree must match exactly what was hashed in step 1) plus the
 *    resulting WebAuthn assertion, attaches it as the entry's signature via
 *    `authorizeEntry`, rebuilds the operation with that entry attached from
 *    the start (rather than mutating a parsed transaction's internals,
 *    which the SDK does not document as safe), and submits.
 *
 * Caveat: this is structurally complete and follows the SDK's documented
 * `authorizeEntry`/custom-account pattern, but has not been exercised
 * against a live Soroban RPC endpoint in this build environment — there is
 * no network access here to do so. Treat it as unverified until run against
 * testnet.
 */
@Injectable()
export class AuthRelayService {
  private readonly logger = new Logger(AuthRelayService.name);
  private readonly server: rpc.Server;
  private readonly keypair: Keypair;
  private readonly networkPassphrase: string;

  constructor(private readonly config: ConfigService) {
    const secret = this.config.get<string>('oracleSecretKey');
    if (!secret) {
      throw new Error('ORACLE_SECRET_KEY is required to start polaris-oracle');
    }
    this.keypair = Keypair.fromSecret(secret);
    this.networkPassphrase = this.config.get<string>('stellarNetworkPassphrase') ?? Networks.TESTNET;
    const rpcUrl = this.config.get<string>('stellarRpcUrl')!;
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  }

  async prepare(
    walletAddress: string,
    contractId: string,
    functionName: string,
    wireArgs: WireArgs,
    contractKind?: ContractKind,
  ): Promise<PrepareAuthResult> {
    const scArgs = buildSponsoredCallArgs(specFor(contractKind), functionName, walletAddress, wireArgs);
    const op = new Contract(contractId).call(functionName, ...scArgs);

    const sourceAccount = await this.server.getAccount(this.keypair.publicKey());
    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(120)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new BadRequestException(`simulation failed: ${sim.error}`);
    }
    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new BadRequestException('simulation did not succeed');
    }

    const entries = sim.result?.auth ?? [];
    const match = entries.find((e) => {
      const info = inspectAuthEntry(e);
      return info.address === walletAddress;
    });
    if (!match) {
      throw new BadRequestException(
        `no authorization entry for ${walletAddress} was recorded for ${functionName} — check the arg that should carry this address`,
      );
    }

    const latestLedger = await this.server.getLatestLedger();
    const validUntilLedgerSeq = latestLedger.sequence + 120; // ~10 minutes at 5s/ledger

    const preimage = buildAuthorizationEntryPreimage(match, validUntilLedgerSeq, this.networkPassphrase);
    const signaturePayload = hash(preimage.toXDR());

    return {
      entryXdr: match.toXDR('base64'),
      signaturePayloadHex: signaturePayload.toString('hex'),
      validUntilLedgerSeq,
    };
  }

  async submit(
    contractId: string,
    functionName: string,
    wireArgs: WireArgs,
    entryXdr: string,
    validUntilLedgerSeq: number,
    assertion: WebAuthnAssertion,
    contractKind?: ContractKind,
  ): Promise<{ txHash: string; walletAddress: string }> {
    const unsignedEntry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');

    // Read the authorizing address back out of the entry itself rather than
    // trust a client-supplied field for it: the entry is what's actually
    // being signed and submitted, so it's the one value here that can't be
    // spoofed or drift out of sync with what the passkey approved.
    const walletAddress = inspectAuthEntry(unsignedEntry).address;
    if (!walletAddress) {
      throw new BadRequestException('entryXdr has no address credentials to authorize against');
    }

    const signatureScVal = buildWebAuthnSignatureScVal(assertion);
    const signedEntry = await authorizeEntry(
      unsignedEntry,
      async () => ({ signatureScVal }),
      validUntilLedgerSeq,
      this.networkPassphrase,
    );

    const scArgs = buildSponsoredCallArgs(specFor(contractKind), functionName, walletAddress, wireArgs);
    const op = new Contract(contractId).call(functionName, ...scArgs);
    op.body().invokeHostFunctionOp().auth([signedEntry]);

    const sourceAccount = await this.server.getAccount(this.keypair.publicKey());
    let tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(60)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new BadRequestException(`simulation failed: ${sim.error}`);
    }
    tx = rpc.assembleTransaction(tx, sim).build();
    tx.sign(this.keypair);

    const sendRes = await this.server.sendTransaction(tx);
    if (sendRes.status === 'ERROR') {
      throw new BadRequestException(`submit failed: ${JSON.stringify(sendRes.errorResult)}`);
    }

    const finalRes = await this.pollTransaction(sendRes.hash);
    if (finalRes.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new BadRequestException(`transaction ${sendRes.hash} did not succeed: ${finalRes.status}`);
    }

    return { txHash: sendRes.hash, walletAddress };
  }

  private async pollTransaction(txHash: string, attempts = 30, delayMs = 2000): Promise<rpc.Api.GetTransactionResponse> {
    for (let i = 0; i < attempts; i++) {
      const res = await this.server.getTransaction(txHash);
      if (res.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
        return res;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`transaction ${txHash} not confirmed after ${attempts} attempts`);
  }
}

/**
 * Builds the `Signature` struct ScVal (`{authenticator_data, client_data_json,
 * signature}`, field order/shape confirmed against the compiled smart-wallet
 * contract's own spec — see `contracts.ts` — rather than assumed) that
 * `authorizeEntry`'s `signatureScVal` callback result is written verbatim
 * into the credentials' signature field.
 */
function buildWebAuthnSignatureScVal(assertion: WebAuthnAssertion): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('authenticator_data'),
      val: xdr.ScVal.scvBytes(Buffer.from(assertion.authenticatorDataHex, 'hex')),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('client_data_json'),
      val: xdr.ScVal.scvBytes(Buffer.from(assertion.clientDataJsonBase64, 'base64')),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('signature'),
      val: xdr.ScVal.scvBytes(Buffer.from(assertion.signatureHex, 'hex')),
    }),
  ]);
}
