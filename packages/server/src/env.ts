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
  /**
   * 默认端口 27137。
   *
   * 这个数字不是随手挑的 —— 它是**对着 IANA 的官方端口注册表筛出来的**：
   *
   *   · 未在 IANA 登记（全球已登记的单端口有 6262 个）
   *   · 前后各 100 个端口内没有任何登记（最近的邻居是 27017 MongoDB，
   *     隔了 120 个号）
   *   · 不在常见开发工具的默认端口里（3000 / 5000 / 8000 / 8080 / 8888…）
   *   · 低于 32768，**避开 Linux 的临时端口区**（通常 32768–60999）。
   *     把服务绑在临时端口段里，会和出站连接抢端口，表现为随机、难复现的
   *     "address already in use"。
   *
   * 选一个冷门端口是为了让冲突在默认情况下就不会发生：端口冲突只在
   * listen() 那一刻才报错，且错误信息完全不提"是端口被占了"，
   * 对刚上手的人来说是个很难定位的失败。
   */
  port: int('PORT', 27137),
  host: str('HOST', '127.0.0.1'),
  logLevel: str('LOG_LEVEL', 'info') as 'debug' | 'info' | 'warn' | 'error',

  dataDir: path.isAbsolute(str('DATA_DIR', './data'))
    ? str('DATA_DIR', './data')
    : path.join(REPO_ROOT, str('DATA_DIR', './data')),
  dbFile: str('DB_FILE', 'autoquant.sqlite'),

  /** Hex-encoded 32-byte key material. Empty means "derive one on first boot". */
  masterKey: str('MASTER_KEY', ''),
  jwtSecret: str('JWT_SECRET', ''),
  /**
   * **允许访问的内网 LLM 端点**（逗号/空白分隔）。
   *
   * ## 为什么是显式清单，而不是"放开私网"
   *
   * 自建网关与私有部署是这个项目**有意支持**的场景，但出站 URL 白名单
   * 默认挡掉所有私网地址 —— 因为控制台在反向代理后面时，
   * `http://169.254.169.254/latest/meta-data/...` 会把云主机的临时凭据回显出来
   *（见 `llm/urlGuard.ts` 的文件头）。
   *
   * 所以放行必须**由操作员逐个声明**：默认全挡，写进来的才通。
   * 一个"我允许 172.19.0.1"的声明不会顺带允许元数据地址。
   *
   * 写法：`172.19.0.1` · `172.19.0.0/16` · `.corp.lan` · `my-gateway`
   */
  allowPrivateLlmHosts: str('ALLOW_PRIVATE_LLM_HOSTS', ''),
  /**
   * 首次启动创建的管理员账号。
   *
   * 留空时**用户名与密码都由系统随机生成**并打印到日志一次。
   * 这是刻意的：默认的 `admin` + 弱密码是最常见的被攻破路径，
   * 而单人部署场景下用户拿到凭据后第一件事就是改成自己记得住的。
   */
  adminUsername: str('ADMIN_USERNAME', ''),
  adminPassword: str('ADMIN_PASSWORD', ''),

  binanceUseTestnet: bool('BINANCE_USE_TESTNET', true),

  globalTradingDisabled: bool('GLOBAL_TRADING_DISABLED', false),
  dryRun: bool('DRY_RUN', false),

  /**
   * 关掉"与 GitHub 比对版本"这个出站请求。
   *
   * 默认开着，因为控制台用它回答"线上跑的是不是最新版"。但**在一个不出网的部署里
   * 它只会在每次查看时白等一次超时**，所以必须能关。关掉之后控制台显示"未启用"，
   * 而不是把它伪装成"一致"。
   */
  updateCheckDisabled: bool('UPDATE_CHECK_DISABLED', false),
  /**
   * 可选的 GitHub token，只为提高 API 速率限制（未认证 60 次/小时/IP）。
   *
   * public 仓库不需要它；私有仓库需要。**它只出现在请求头里**，不进日志、
   * 不进响应体、不进错误消息 —— 与 `llm/client.ts` 里 API Key 的处理同一条约定。
   */
  githubToken: str('GITHUB_TOKEN', ''),

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
export async function resolveJwtSecret(dataDir: string = env.dataDir): Promise<string> {
  /*
   * ⚠️ **环境变量给的密钥也要校验，不能原样接受**。
   *
   * `str()` 只把「未设置」和「空字符串」当成缺省，所以 `JWT_SECRET="   "`
   * 会被当成"已设置"。而用空白串做 HS256 的密钥等于**零熵** —— 任何人都能
   * 用同一个空白串伪造一张管理员令牌。空密钥是认证被完全绕过，不是弱口令。
   */
  if (env.jwtSecret) {
    const fromEnv = env.jwtSecret.trim();
    const verdict = jwtSecretVerdict(fromEnv);
    if (!verdict.ok) throw new Error(`JWT_SECRET 不可用：${verdict.reason}`);
    return fromEnv;
  }
  return await resolveOrCreateJwtSecret(dataDir);
}

/**
 * JWT 签名密钥的最小长度（字符）。
 *
 * HS256 的安全性完全由密钥熵决定。`randomBytes(48).toString('hex')` 生成的是
 * 96 个字符，这里取 32 作为**下界**（128 bit 以上），既拦得住"随手写个
 * `secret`"这种配置，又不会把合法的十六进制密钥误判。
 */
export const JWT_SECRET_MIN_LENGTH = 32;

export interface JwtSecretVerdict {
  ok: boolean;
  /** 面向操作员的中文原因（`ok === false` 时有值）。 */
  reason?: string;
}

/**
 * 这把密钥能不能用来签会话令牌。
 *
 * ## 为什么必须有这道校验（安全，不是打磨）
 *
 * `resolveJwtSecret()` 原来对**文件内容不做任何检查**：
 *
 * ```ts
 * if (existsSync(secretPath)) return readFileSync(secretPath, 'utf8').trim();
 * ```
 *
 * 于是一个被截断成空文件的 `data/.jwt.secret`（写到一半崩溃、磁盘满、误操作）
 * 会让 `verifyToken()` / `signToken()` 用一个**空字符串**做 HMAC 密钥 ——
 * 这不是"弱口令"，而是**认证被完全绕过**：任何知道这个实现细节的人都能自己
 * 签一张 `role: owner` 的令牌，30 天有效。而症状上它**完全不可见**。
 *
 * 对照 `resolveMasterKey()`：它一直有长度校验并在损坏时抛错。JWT 这一侧漏了。
 *
 * ## 为什么"短"也拒绝
 *
 * 32 个字符是 128 bit 以上。短于它时暴力空间小到可以离线穷举 —— 而重签令牌
 * 只需要离线尝试，不需要打服务端（签名可自验）。所以这里 fail closed。
 */
export function jwtSecretVerdict(raw: string | null | undefined): JwtSecretVerdict {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') {
    return {
      ok: false,
      reason:
        '签名密钥为空 —— 用空密钥做 HMAC 等于任何人都能伪造管理员令牌。' +
        '删除 data/.jwt.secret 让系统重新生成，或设置一个足够长的 JWT_SECRET。',
    };
  }
  if (value.length < JWT_SECRET_MIN_LENGTH) {
    return {
      ok: false,
      reason:
        `签名密钥只有 ${value.length} 个字符，至少需要 ${JWT_SECRET_MIN_LENGTH} 个（HS256 的密钥就是签名空间）。` +
        '生成一个：node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    };
  }
  return { ok: true };
}

/**
 * 从 `data/.jwt.secret` 读密钥；不存在则生成并落盘（权限 0600）。
 *
 * 独立成函数是为了可测：`resolveJwtSecret()` 里对 `env.jwtSecret` 的判断
 * 在模块加载时就固定了，测试无法改它；这一个只依赖传入的目录。
 *
 * ⚠️ **文件存在但内容不合法时抛错，绝不"顺手重新生成"**：那会让所有已登录会话
 * 失效，而操作员看到的只是"登录莫名其妙失效"，根本不知道密钥文件坏了。
 * fail closed + 明确原因才是可恢复的（删掉文件重启即可）。
 */
export async function resolveOrCreateJwtSecret(dataDir: string): Promise<string> {
  const secretPath = path.join(dataDir, '.jwt.secret');
  if (existsSync(secretPath)) {
    const stored = readFileSync(secretPath, 'utf8').trim();
    const verdict = jwtSecretVerdict(stored);
    if (!verdict.ok) throw new Error(`data/.jwt.secret 不可用：${verdict.reason}`);
    return stored;
  }
  await mkdir(dataDir, { recursive: true });
  const generated = randomBytes(48).toString('hex');
  await writeFile(secretPath, generated, { encoding: 'utf8', mode: 0o600 });
  return generated;
}