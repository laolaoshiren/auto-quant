import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Credential vault.
 *
 * Exchange API secrets and LLM API keys are encrypted at rest with
 * AES-256-GCM under a key that never leaves the host. Ciphertext is stored as a
 * self-describing string so that key rotation and format changes stay readable:
 *
 *   v1:<iv-hex>:<authTag-hex>:<ciphertext-base64>
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, the GCM standard
const AUTH_TAG_LENGTH = 16;

export class Vault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error(`Vault key must be exactly 32 bytes, received ${key.length}`);
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('hex'),
      authTag.toString('hex'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 4) {
      throw new Error('Malformed ciphertext: expected 4 colon-separated segments');
    }
    const [version, ivHex, tagHex, dataB64] = parts as [string, string, string, string];
    if (version !== VERSION) throw new Error(`Unsupported vault version: ${version}`);

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivHex, 'hex'), {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Encrypt only when there is something to encrypt; preserve empty values. */
  encryptOptional(plaintext: string | null | undefined): string {
    if (plaintext === null || plaintext === undefined || plaintext === '') return '';
    return this.encrypt(plaintext);
  }

  decryptOptional(payload: string | null | undefined): string {
    if (!payload) return '';
    return this.decrypt(payload);
  }
}

/* -------------------------------------------------------------------------- */
/*  Password hashing                                                           */
/* -------------------------------------------------------------------------- */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

/** `scrypt$N$r$p$salt-hex$hash-hex` */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('hex'), hash.toString('hex')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const N = Number.parseInt(nStr, 10);
  const r = Number.parseInt(rStr, 10);
  const p = Number.parseInt(pStr, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/* -------------------------------------------------------------------------- */
/*  API key masking                                                            */
/* -------------------------------------------------------------------------- */

/** `sk-abcdef…1234` — enough for a human to recognise which key is stored. */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 10) return `${secret.slice(0, 2)}…${secret.slice(-2)}`;
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}
