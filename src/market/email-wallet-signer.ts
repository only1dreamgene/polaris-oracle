import { createHash } from 'node:crypto';
import { p256 } from '@noble/curves/nist.js';

export interface GeneratedKeypair {
  /** 32 bytes. */
  privateKey: Buffer;
  /** 65-byte uncompressed secp256r1 SEC1 point (0x04 ‖ X ‖ Y) — same shape a passkey's public key takes. */
  publicKey: Buffer;
}

export function generateP256Keypair(): GeneratedKeypair {
  const kp = p256.keygen();
  return {
    privateKey: Buffer.from(kp.secretKey),
    publicKey: Buffer.from(p256.getPublicKey(kp.secretKey, false)),
  };
}

export interface EmailWalletAssertion {
  authenticatorDataHex: string;
  clientDataJsonBase64: string;
  signatureHex: string;
}

/**
 * Server-side equivalent of `polaris-frontend`'s `signWithPasskey`, for
 * wallets whose signer is a custodial keypair (the email-login path)
 * rather than a real browser passkey. Produces byte-for-byte the same
 * `Signature` shape `polaris-smart-wallet`'s `__check_auth` verifies — see
 * that contract's doc comment in `polaris-contracts`:
 *
 *   digest = sha256(authenticator_data ‖ sha256(client_data_json))
 *   secp256r1_verify(public_key, digest, signature)
 *   client_data_json.challenge must equal base64url(signature_payload)
 *
 * The contract only checks the `challenge` field inside the JSON — not
 * `type`/`origin`/`crossOrigin` — so those are set for realism and to keep
 * this a legitimate WebAuthn-shaped assertion, not because verification
 * depends on them. `@noble/curves`'s `p256.sign()` defaults to `prehash:
 * true` — i.e. it SHA-256's its input before signing, which would double-
 * hash a digest that's already hashed. `prehash: false` below is required
 * to sign the digest as-is, matching `secp256r1_verify`'s raw-digest
 * semantics (confirmed empirically against a live contract call — omitting
 * this flag deploys and prepares fine but fails on-chain at
 * `verify_sig_ecdsa_secp256r1` with `Error(Crypto, InvalidInput)`). The
 * signature itself is always raw, low-S-normalized 64 bytes — confirmed
 * separately (0/200 high-S over random inputs) — so no DER-decode-and-
 * normalize step is needed here the way `webauthn.ts` needs client-side.
 */
export function signChallengeWithEmailWallet(
  privateKey: Buffer,
  signaturePayload: Buffer,
  rpId: string,
  rpOrigin: string,
): EmailWalletAssertion {
  const rpIdHash = createHash('sha256').update(rpId).digest();
  const flags = Buffer.from([0x05]); // UP (0x01) | UV (0x04)
  const signCount = Buffer.alloc(4); // not tracked — single custodial signer, no clone detection
  const authenticatorData = Buffer.concat([rpIdHash, flags, signCount]);

  const clientDataJson = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: signaturePayload.toString('base64url'),
      origin: rpOrigin,
      crossOrigin: false,
    }),
  );

  const clientDataHash = createHash('sha256').update(clientDataJson).digest();
  const digest = createHash('sha256').update(Buffer.concat([authenticatorData, clientDataHash])).digest();
  const signature = Buffer.from(p256.sign(digest, privateKey, { prehash: false }));

  return {
    authenticatorDataHex: authenticatorData.toString('hex'),
    clientDataJsonBase64: clientDataJson.toString('base64'),
    signatureHex: signature.toString('hex'),
  };
}
