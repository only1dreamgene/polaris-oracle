import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM at rest for custodial private keys — the one thing in this
 * subsystem that must never be stored plaintext, since unlike a passkey
 * (which never leaves the user's device) this key is the actual bearer
 * secret for an email-login wallet. Output layout: iv(12) ‖ authTag(16) ‖
 * ciphertext, base64 — self-contained, no separate column needed per part.
 */
export function encryptAtRest(plaintext: Buffer, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptAtRest(blob: string, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  const raw = Buffer.from(blob, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
