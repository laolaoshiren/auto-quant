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
  // 非字符串（例如 JSON 里传了个数字）会让 scryptSync 抛 TypeError 并变成 HTTP 500。
  // 校验失败一律返回 false：这里**没有**绕过风险，但 500 会把内部实现细节
  // 和一条栈信息暴露给未认证的调用方。
  if (typeof password !== 'string') return false;
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

/**
 * 一个永远不会匹配成功的口令哈希，用来给「用户不存在」这条分支**跑一遍同样的 scrypt**。
 *
 * 防的是用户名枚举：登录原本写成 `if (!record || !verifyPassword(...))`，
 * `||` 短路意味着用户名不存在时根本不会做密钥派生，401 会早几十毫秒返回。
 * 这个时间差足以把「哪些用户名存在」一个个试出来 —— 而随机用户名
 * （`generateUsername()`）的全部价值就在于让攻击者必须先猜对用户名。
 *
 * 参数与 `hashPassword()` 完全一致，所以两条分支的 CPU 成本相同；
 * 全零摘要不可能等于任何真实 scrypt 输出（概率 2^-512）。
 */
export const DUMMY_PASSWORD_HASH = [
  'scrypt',
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  '00000000000000000000000000000000',
  '0'.repeat(KEY_LENGTH * 2),
].join('$');

/* -------------------------------------------------------------------------- */
/*  API key masking                                                            */
/* -------------------------------------------------------------------------- */

/** `sk-abcdef…1234` — enough for a human to recognise which key is stored. */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 10) return `${secret.slice(0, 2)}…${secret.slice(-2)}`;
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}
