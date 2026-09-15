import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Environment + filesystem layout. Everything the process needs to boot is
 * resolved exactly once, here, so that no other module has to guess at paths.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root — `packages/server/src` → up three levels. */
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

/**
 * Minimal `.env` loader. We deliberately avoid a dependency: the format we care
 * about (`KEY=value` per line, `#` comments) is trivial to parse correctly.
 */
function loadDotEnv(): void {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment variables always win over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

export const env = {
  // 3200 rather than 3080: 3080 is commonly taken by other local dev tooling,
  // and a port clash would otherwise fail only at listen() time.
  port: int('PORT', 3200),
  host: str('HOST', '127.0.0.1'),
  logLevel: str('LOG_LEVEL', 'info') as 'debug' | 'info' | 'warn' | 'error',

  dataDir: path.isAbsolute(str('DATA_DIR', './data'))
    ? str('DATA_DIR', './data')
    : path.join(REPO_ROOT, str('DATA_DIR', './data')),
  dbFile: str('DB_FILE', 'autoquant.sqlite'),

  /** Hex-encoded 32-byte key material. Empty means "derive one on first boot". */
  masterKey: str('MASTER_KEY', ''),
  jwtSecret: str('JWT_SECRET', ''),
  adminPassword: str('ADMIN_PASSWORD', ''),

  binanceUseTestnet: bool('BINANCE_USE_TESTNET', true),

  globalTradingDisabled: bool('GLOBAL_TRADING_DISABLED', false),
  dryRun: bool('DRY_RUN', false),

  isProduction: process.env.NODE_ENV === 'production',
} as const;

export const dbPath = path.join(env.dataDir, env.dbFile);

/** Directory holding the built web console, served in production. */
export const webDistDir = path.join(REPO_ROOT, 'packages', 'web', 'dist');

export async function ensureDataDir(): Promise<void> {
  await mkdir(env.dataDir, { recursive: true });
}

/**
 * Resolve the 32-byte AES master key.
 *
 * Order of preference: `MASTER_KEY` env var → `data/.master.key` file →
 * generate and persist a new one. The file route exists so that a self-hosted
 * instance works with zero configuration while still never storing the key
 * anywhere it could be committed to git.
 */
export async function resolveMasterKey(): Promise<Buffer> {
  if (env.masterKey) {
    const buf = Buffer.from(env.masterKey.trim(), 'hex');
    if (buf.length !== 32) {
      throw new Error(
        `MASTER_KEY must be 32 bytes of hex (64 characters); got ${buf.length} bytes. ` +
          'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    return buf;
  }

  const keyPath = path.join(env.dataDir, '.master.key');
  if (existsSync(keyPath)) {
    const buf = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex');
    if (buf.length !== 32) throw new Error(`Corrupt master key at ${keyPath}`);
    return buf;
  }

  await ensureDataDir();
  const generated = randomBytes(32);
  await writeFile(keyPath, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  return generated;
}

/** Resolve the JWT signing secret, persisting a generated one when unset. */
export async function resolveJwtSecret(): Promise<string> {
  if (env.jwtSecret) return env.jwtSecret;
  const secretPath = path.join(env.dataDir, '.jwt.secret');
  if (existsSync(secretPath)) return readFileSync(secretPath, 'utf8').trim();
  await ensureDataDir();
  const generated = randomBytes(48).toString('hex');
  await writeFile(secretPath, generated, { encoding: 'utf8', mode: 0o600 });
  return generated;
}
