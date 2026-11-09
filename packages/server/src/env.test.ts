/**
 * **JWT 签名密钥的强度校验** —— 防的是「认证被完全绕过」。
 *
 * ## 为什么这个测试存在（审计 2026-11-10）
 *
 * `resolveJwtSecret()` 原来对 `data/.jwt.secret` 的内容**不做任何检查**：
 *
 * ```ts
 * if (existsSync(secretPath)) return readFileSync(secretPath, 'utf8').trim();
 * ```
 *
 * 于是被截断成空文件的密钥（写到一半崩溃、磁盘满、误操作）会让
 * `signToken()` / `verifyToken()` 用**空字符串**做 HMAC 密钥。
 * 那不是弱口令 —— 是**认证被完全绕过**：任何人用同一个空串签一张
 * `role: 'owner'` 的令牌就能当管理员，30 天有效，而症状完全不可见。
 *
 * 对照 `resolveMasterKey()`：它一直有长度校验并在损坏时抛错。JWT 这一侧漏了。
 *
 * 同一测试还覆盖了 `JWT_SECRET="   "` 这种"空白但非空"的环境变量 ——
 * `str()` 不 trim，所以它会绕过"未设置"判断，变成零熵密钥。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  JWT_SECRET_MIN_LENGTH,
  jwtSecretVerdict,
  resolveOrCreateJwtSecret,
} from './env.js';

/* -------------------------------------------------------------------------- */
/*  纯函数：判定                                                            */
/* -------------------------------------------------------------------------- */

test('未设置 / 空串 / 纯空白 —— 一律拒绝（零熵密钥等于没有认证）', () => {
  for (const raw of [undefined, null, '', '   ', '\t\n']) {
    const verdict = jwtSecretVerdict(raw);
    assert.equal(verdict.ok, false, `"${String(raw)}" 不应被接受`);
    assert.ok(verdict.reason && verdict.reason.length > 0, '拒绝时必须给出原因');
  }
});

test('过短的密钥被拒绝，并说明生成方法', () => {
  const verdict = jwtSecretVerdict('secret');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? '', new RegExp(String(JWT_SECRET_MIN_LENGTH)));
});

test('长度达标的密钥被接受（含边界值）', () => {
  assert.equal(jwtSecretVerdict('x'.repeat(JWT_SECRET_MIN_LENGTH)).ok, true);
  /* 系统自己生成的是 96 个十六进制字符 —— 必须通过。 */
  assert.equal(jwtSecretVerdict('a'.repeat(96)).ok, true);
});

test('两侧空白不算长度 —— trim 后判断', () => {
  assert.equal(jwtSecretVerdict(`   ${'x'.repeat(JWT_SECRET_MIN_LENGTH)}   `).ok, true);
  /* 30 个 x + 首尾空白：trim 后仍不足。 */
  assert.equal(jwtSecretVerdict(`  ${'x'.repeat(30)}  `).ok, false);
});

/* -------------------------------------------------------------------------- */
/*  文件 / 生成路径                                                          */
/* -------------------------------------------------------------------------- */

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'aq-jwt-secret-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('★ 密钥文件为空时必须拒绝启动（复现那个"认证被绕过"的漏洞）', async () => {
  const { dir, cleanup } = tempDir();
  try {
    writeFileSync(join(dir, '.jwt.secret'), '');
    await assert.rejects(
      () => resolveOrCreateJwtSecret(dir),
      /为空/,
      '空密钥文件必须 fail closed —— 空 HMAC 密钥等于任何人都能伪造令牌',
    );
  } finally {
    cleanup();
  }
});

test('密钥文件是纯空白时同样拒绝', async () => {
  const { dir, cleanup } = tempDir();
  try {
    writeFileSync(join(dir, '.jwt.secret'), '   \n  \n');
    await assert.rejects(() => resolveOrCreateJwtSecret(dir), /为空/);
  } finally {
    cleanup();
  }
});

test('密钥文件过短时拒绝，而不是静默接受一个可穷举的密钥', async () => {
  const { dir, cleanup } = tempDir();
  try {
    writeFileSync(join(dir, '.jwt.secret'), 'short');
    await assert.rejects(() => resolveOrCreateJwtSecret(dir), /至少需要/);
  } finally {
    cleanup();
  }
});

test('合法密钥文件原样返回', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const secret = 'a'.repeat(96);
    writeFileSync(join(dir, '.jwt.secret'), secret);
    assert.equal(await resolveOrCreateJwtSecret(dir), secret);
  } finally {
    cleanup();
  }
});

test('没有密钥文件时生成一个合法密钥、落盘，并在下次启动时复用', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const generated = await resolveOrCreateJwtSecret(join(dir, 'data'));
    assert.match(generated, /^[0-9a-f]{96}$/);
    /* 落盘的就是同一把：重启后已登录的会话不能因为重新生成而全部失效。 */
    const onDisk = readFileSync(join(dir, 'data', '.jwt.secret'), 'utf8').trim();
    assert.equal(onDisk, generated);
    assert.equal(await resolveOrCreateJwtSecret(join(dir, 'data')), generated);
  } finally {
    cleanup();
  }
});
