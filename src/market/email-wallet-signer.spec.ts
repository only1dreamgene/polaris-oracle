import { createHash } from 'node:crypto';
import { p256 } from '@noble/curves/nist.js';
import { generateP256Keypair, signChallengeWithEmailWallet } from './email-wallet-signer';

/**
 * Regression test for a real bug found while building this: `@noble/curves`'
 * `p256.sign()` defaults to `prehash: true`, silently SHA-256'ing its input
 * before signing. Since the digest handed to it here is *already* the
 * `sha256(authenticator_data ‖ sha256(client_data_json))` the contract
 * independently recomputes, that default double-hashes it — the resulting
 * signature verifies fine against noble's own `verify()` (both sides applied
 * the same extra hash) but fails on-chain, where `secp256r1_verify` does no
 * such re-hashing. This only surfaced against a live deployed contract
 * (`Error(Crypto, InvalidInput)` / "failed secp256r1 verification"); a
 * pure-JS round-trip test doesn't catch it on its own; the point of this
 * test is to fail loudly if the `prehash: false` option is ever dropped.
 */
describe('signChallengeWithEmailWallet', () => {
  it('produces a signature that verifies against the raw digest with no re-hashing', () => {
    const { privateKey, publicKey } = generateP256Keypair();
    const signaturePayload = Buffer.from('a'.repeat(64), 'hex'); // 32 bytes

    const assertion = signChallengeWithEmailWallet(privateKey, signaturePayload, 'localhost', 'http://localhost:3000');

    const authenticatorData = Buffer.from(assertion.authenticatorDataHex, 'hex');
    const clientDataJson = Buffer.from(assertion.clientDataJsonBase64, 'base64');
    const clientDataHash = createHash('sha256').update(clientDataJson).digest();
    const digest = createHash('sha256').update(Buffer.concat([authenticatorData, clientDataHash])).digest();

    const ok = p256.verify(Buffer.from(assertion.signatureHex, 'hex'), digest, publicKey, { prehash: false });
    expect(ok).toBe(true);

    // The failure mode this guards against: verifying against sha256(digest)
    // instead of digest itself would also need to fail, or this test
    // wouldn't actually distinguish correct behavior from the bug.
    const doubleHashed = createHash('sha256').update(digest).digest();
    const wronglyOk = p256.verify(Buffer.from(assertion.signatureHex, 'hex'), doubleHashed, publicKey, {
      prehash: false,
    });
    expect(wronglyOk).toBe(false);
  });

  it("binds the challenge field to base64url(signaturePayload) — what the contract's ChallengeMismatch check compares against", () => {
    const { privateKey } = generateP256Keypair();
    const signaturePayload = Buffer.from('b'.repeat(64), 'hex');

    const assertion = signChallengeWithEmailWallet(privateKey, signaturePayload, 'localhost', 'http://localhost:3000');
    const clientData = JSON.parse(Buffer.from(assertion.clientDataJsonBase64, 'base64').toString('utf8'));

    expect(clientData.challenge).toBe(signaturePayload.toString('base64url'));
    expect(clientData.type).toBe('webauthn.get');
  });

  it('signature is always low-S (the contract traps on high-S)', () => {
    const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    for (let i = 0; i < 25; i++) {
      const { privateKey } = generateP256Keypair();
      const assertion = signChallengeWithEmailWallet(
        privateKey,
        Buffer.from(i.toString(16).padStart(64, '0'), 'hex'),
        'localhost',
        'http://localhost:3000',
      );
      const s = BigInt('0x' + assertion.signatureHex.slice(64, 128));
      expect(s <= N / 2n).toBe(true);
    }
  });
});
