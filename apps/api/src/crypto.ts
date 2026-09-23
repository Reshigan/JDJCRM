// Stdlib only: scrypt passwords, RFC 6238 TOTP, AES-256-GCM envelope encryption for files.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from './env';

export function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${scryptSync(pw, salt, 64, { N: 16384 }).toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string | null) {
  const [, salt, hash] = stored?.split('$') ?? [];
  if (!salt || !hash) return false;
  return timingSafeEqual(scryptSync(pw, Buffer.from(salt, 'base64'), 64, { N: 16384 }), Buffer.from(hash, 'base64'));
}

export const token = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// --- TOTP ---
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const totpSecret = () => [...randomBytes(20)].map((b) => B32[b & 31]).join('');
const b32decode = (s: string) => {
  let bits = '';
  for (const c of s.replace(/=+$/, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
};
export function totp(secret: string, step = Math.floor(Date.now() / 30_000)) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export const verifyTotp = (secret: string, code: string) => {
  const now = Math.floor(Date.now() / 30_000);
  return [-1, 0, 1].some((d) => totp(secret, now + d) === code.replace(/\s/g, ''));
};

// --- file encryption: random data key per file, wrapped with the master key ---
const master = () => {
  const k = env.masterKey ? Buffer.from(env.masterKey, 'base64') : null;
  if (!k || k.length !== 32) throw new Error('MASTER_KEY must be 32 bytes, base64');
  return k;
};
const seal = (key: Buffer, data: Buffer) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]); // iv(12) | tag(16) | ciphertext
};
const open = (key: Buffer, blob: Buffer) => {
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
};

export function encryptFile(data: Buffer) {
  const dek = randomBytes(32);
  return { blob: seal(dek, data), keyWrapped: seal(master(), dek).toString('base64') };
}
export const decryptFile = (blob: Buffer, keyWrapped: string) => open(open(master(), Buffer.from(keyWrapped, 'base64')), blob);

/** Master-key rotation: re-wrap a file's data key; the encrypted file itself is untouched. */
export const rewrap = (keyWrapped: string, oldKey: Buffer, newKey: Buffer) => seal(newKey, open(oldKey, Buffer.from(keyWrapped, 'base64'))).toString('base64');
