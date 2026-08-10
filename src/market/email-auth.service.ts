import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { StellarService } from './stellar.service';
import { AuthRelayService } from './auth-relay.service';
import { FaucetService } from './faucet.service';
import { EmailAuthRepository } from './email-auth.repository';
import { EMAIL_SENDER, type EmailSender } from './email-sender';
import { encryptAtRest, decryptAtRest } from './email-crypto';
import { generateP256Keypair, signChallengeWithEmailWallet } from './email-wallet-signer';
import type { WireArgs } from './wire-args';

export class EmailAuthError extends Error {}

interface SessionClaims {
  email: string;
  address: string;
}

/**
 * Email fallback for the passkey-only login flow — see `polaris-frontend`'s
 * `wallet-provider.tsx` doc comment for why this exists: passkeys need a
 * real platform authenticator, which some browsers/embedded webviews don't
 * have. This path trades that hardware requirement for a custodial
 * keypair: `verifyCode` generates a real secp256r1 keypair server-side,
 * deploys it through the exact same `smart-wallet-factory` a passkey
 * wallet uses, and stores the private key encrypted at rest — the wallet
 * itself can't tell the difference from an on-chain point of view. Trading
 * afterward re-derives a WebAuthn-shaped assertion server-side
 * (`email-wallet-signer.ts`) instead of prompting a browser ceremony, so
 * every other piece of this system (the market contract, `AuthRelayService`,
 * the frontend's trade flow once it has an address) needs zero changes.
 */
@Injectable()
export class EmailAuthService {
  private readonly logger = new Logger(EmailAuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly repo: EmailAuthRepository,
    private readonly stellar: StellarService,
    private readonly relay: AuthRelayService,
    private readonly faucet: FaucetService,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
  ) {}

  async requestCode(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const existing = this.repo.getCode(normalized);
    const cooldownMs = this.config.get<number>('emailCodeResendCooldownSecs')! * 1000;
    if (existing && Date.now() - existing.created_at < cooldownMs) {
      const waitSecs = Math.ceil((cooldownMs - (Date.now() - existing.created_at)) / 1000);
      throw new EmailAuthError(`Please wait ${waitSecs}s before requesting another code.`);
    }

    const code = randomInt(100_000, 1_000_000).toString();
    const codeHash = hashCode(code);
    const ttlMs = this.config.get<number>('emailCodeTtlSecs')! * 1000;
    this.repo.saveCode(normalized, codeHash, Date.now() + ttlMs);

    await this.sender.send(
      normalized,
      'Your Polaris sign-in code',
      `Your sign-in code is ${code}. It expires in ${Math.round(ttlMs / 60_000)} minutes. If you didn't request this, ignore this email.`,
    );
  }

  /** Verifies the code, creating (once) and returning the email's custodial wallet, plus a signed session token to hand back as a cookie. */
  async verifyCode(email: string, code: string): Promise<{ address: string; sessionToken: string }> {
    const normalized = email.trim().toLowerCase();
    const row = this.repo.getCode(normalized);
    if (!row) {
      throw new EmailAuthError('No code was requested for this email, or it already expired. Request a new one.');
    }
    const maxAttempts = this.config.get<number>('emailCodeMaxAttempts')!;
    if (row.attempts >= maxAttempts) {
      this.repo.deleteCode(normalized);
      throw new EmailAuthError('Too many incorrect attempts. Request a new code.');
    }
    if (Date.now() > row.expires_at) {
      this.repo.deleteCode(normalized);
      throw new EmailAuthError('This code expired. Request a new one.');
    }
    if (!timingSafeEqual(Buffer.from(hashCode(code)), Buffer.from(row.code_hash))) {
      this.repo.incrementAttempts(normalized);
      throw new EmailAuthError('Incorrect code.');
    }
    this.repo.deleteCode(normalized);

    const address = await this.getOrCreateWallet(normalized);
    const sessionToken = this.issueSessionToken(normalized, address);
    return { address, sessionToken };
  }

  /** Returns the session's `{ email, address }` if `token` is a valid, unexpired session — `null` otherwise (expired, tampered, or absent). */
  verifySession(token: string | undefined): SessionClaims | null {
    if (!token) return null;
    try {
      const claims = jwt.verify(token, this.config.get<string>('sessionJwtSecret')!) as SessionClaims;
      return { email: claims.email, address: claims.address };
    } catch {
      return null;
    }
  }

  /** Signs and submits a sponsored contract call on behalf of `email`'s custodial wallet — the email-login equivalent of the frontend's `callAsWallet` + a browser passkey prompt, minus the browser. */
  async signAndSubmitTrade(
    email: string,
    contractId: string,
    functionName: string,
    args: WireArgs,
  ): Promise<{ txHash: string }> {
    const walletRow = this.repo.getWallet(email);
    if (!walletRow) {
      throw new EmailAuthError('No wallet found for this session — sign in again.');
    }
    const privateKey = decryptAtRest(walletRow.encrypted_private_key, this.config.get<string>('emailWalletEncKeyHex')!);

    const prepared = await this.relay.prepare(walletRow.address, contractId, functionName, args);
    const assertion = signChallengeWithEmailWallet(
      privateKey,
      Buffer.from(prepared.signaturePayloadHex, 'hex'),
      this.config.get<string>('emailWalletRpId')!,
      this.config.get<string>('emailWalletOrigin')!,
    );
    return this.relay.submit(contractId, functionName, args, prepared.entryXdr, prepared.validUntilLedgerSeq, assertion);
  }

  private async getOrCreateWallet(email: string): Promise<string> {
    const existing = this.repo.getWallet(email);
    if (existing) return existing.address;

    const { privateKey, publicKey } = generateP256Keypair();
    const factoryId = this.config.get<string>('smartWalletFactoryContract');
    const walletWasmHash = this.config.get<string>('smartWalletWasmHash');
    if (!factoryId || !walletWasmHash) {
      throw new EmailAuthError('Email wallets are not configured on this server yet.');
    }

    const address = await this.stellar.deployWallet(factoryId, publicKey, Buffer.from(walletWasmHash, 'hex'));
    const encrypted = encryptAtRest(privateKey, this.config.get<string>('emailWalletEncKeyHex')!);
    this.repo.saveWallet(email, address, publicKey.toString('hex'), encrypted);
    this.logger.log(`deployed custodial wallet ${address} for a new email login`);

    // Best-effort: a fresh wallet holds 0 XLM and the market's `buy` pulls
    // collateral straight from it, so without this every first-time email
    // login could deploy fine and then fail its very first trade on an
    // opaque "insufficient balance" simulation error. Never block login on
    // Friendbot being slow/down — an unfunded wallet is recoverable (retry,
    // or the manual `/markets/faucet` endpoint); a login that 500s because
    // a testnet faucet hiccuped is a worse failure mode.
    if (this.faucet.tryConsume(address)) {
      try {
        await this.faucet.fund(address);
      } catch (err) {
        this.logger.warn(`faucet funding failed for new email wallet ${address}: ${(err as Error).message}`);
      }
    }
    return address;
  }

  private issueSessionToken(email: string, address: string): string {
    const ttlSecs = this.config.get<number>('sessionTtlSecs')!;
    return jwt.sign({ email, address } satisfies SessionClaims, this.config.get<string>('sessionJwtSecret')!, {
      expiresIn: ttlSecs,
    });
  }
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
