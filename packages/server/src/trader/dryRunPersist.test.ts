/**
 * **测试机器人不能因为服务重启而静默变成实盘**
 * （2026-10-13 实测安全事件 —— 用户硬约束②的直接保护）。
 *
 * ## 事故
 *
 * 用户明确要求"测试只能用模拟盘、必须 `dryRun: true`"。`#11` 也确实以
 * 模拟盘启动 —— **直到下一次部署重启服务**：
 * ```
 *   resumePersisted(env.dryRun)   ← 一个【进程级】开关，恢复【所有】机器人
 *   → env.dryRun 来自服务器 .env（DRY_RUN=false）
 *   → #11 被用 false 恢复 → 实盘 🚨
 * ```
 * 线上 `runtime_logs` 的决定性证据：
 * ```
 *   #11 [团队测试] 多智能体 → 「机器人已启动（**实盘**）」
 *   #10 赚大钱             → 「机器人已启动（实盘）」   ← 这个是对的
 * ```
 * 而 `#11` 当时 `orders=0`（全 skip）才没造成损失 —— **那是运气，不是保护**。
 *
 * ## 为什么会发生
 *
 * "一个进程级开关恢复所有机器人"在**所有机器人共用一个开关**时自洽。
 * 但 `#11` 这类**测试机器人必须与实盘 `#10` 用不同的值** —— 前提被打破了。
 *
 * `api/server.ts` 原来还写着：
 * > 「`dryRun` 是**运行时**的事实（它是启动参数、不落库），仓储层算不出来。」
 *
 * ## 修法
 *
 * ```
 *   traders.dry_run 列（迁移 18）
 *     NULL  → 回落到 env.dryRun（既有机器人行为完全不变）
 *     0/1   → 操作员当时的显式选择 → 重启后【按它恢复】
 * ```
 * ⚠️ **`undefined` 与 `false` 必须分得开** —— 把 NULL 当 `false` 会把
 * "从未指定"误判成"指定了实盘"，env 的回落路径被悄悄删掉。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MIGRATIONS } from '../db/schema.js';
import { codeOnly } from '../testUtils/sourceText.js';

const SCHEMA = readFileSync(new URL('../db/schema.ts', import.meta.url), 'utf8');
const REPO = readFileSync(new URL('../store/configRepos.ts', import.meta.url), 'utf8');
const MGR = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');

test('★★★ 必须有 `dry_run` 迁移（否则重启后无法区分测试机与实盘机）', () => {
  const mig = MIGRATIONS.find((m) => m.name === 'trader-dry-run');
  assert.ok(mig !== undefined, '★ 缺 `trader-dry-run` 迁移');
  assert.ok(
    /ALTER TABLE traders ADD COLUMN dry_run/.test(mig!.sql),
    '★ 迁移必须加 `dry_run` 列',
  );
  /*
   * ⚠️ 必须是**可空**的：默认 0 会让所有既有机器人在迁移后被当成
   * "显式指定了实盘"，那就等于把 env 的回落路径悄悄删掉了。
   */
  assert.ok(
    !/dry_run\s+INTEGER\s+NOT NULL/i.test(mig!.sql) && !/DEFAULT\s+0/i.test(mig!.sql),
    '★ `dry_run` 必须可空且无默认值（NULL = 从未指定过，要回落到 env）',
  );
});

test('★★★ 仓储层必须能读能写 `dryRun`，且 `NULL` 不能变成 `false`', () => {
  const code = codeOnly(REPO);
  assert.ok(/setDryRun\(/.test(code), '★ 必须有 `setDryRun` 写入方法');
  /*
   * ⚠️ 这条是本文件最重要的一条：`row.dry_run === null ? undefined : ...`
   * 若写成 `row.dry_run === 1` 或 `!== 0`，NULL 会被当成 false。
   */
  assert.ok(
    /row\.dry_run === null \? undefined/.test(code),
    '★ NULL 必须映射成 `undefined`（不能映射成 false）—— 那会把"从未指定"误判成实盘',
  );
});

test('★★★ `resumePersisted` 必须用【每台机器人自己的】dryRun', () => {
  const code = codeOnly(MGR);
  assert.ok(
    /trader\.dryRun \?\? dryRun/.test(code),
    '★ 恢复时必须 `trader.dryRun ?? dryRun` —— 否则测试机会被进程开关覆盖成实盘',
  );
});

test('★★★ `startTrader` 成功后必须把 dryRun 落库', () => {
  const code = codeOnly(MGR);
  assert.ok(
    /traders\.setDryRun\(traderId, dryRun\)/.test(code),
    '★ 启动成功时必须落库（否则重启后没有依据可恢复）',
  );
  /*
   * ⚠️ 落库失败不能让启动失败：机器人**已经在跑了**，
   * 此时抛异常会让调用方以为"没启动"，而实际在跑。
   */
  const at = code.indexOf('traders.setDryRun(traderId, dryRun)');
  const around = code.slice(Math.max(0, at - 300), at + 300);
  assert.ok(/try\s*\{/.test(around) && /catch/.test(around), '★ 落库必须包 try/catch');
});

test('★★★ 仓储层的 `dryRun` 字段必须存在（三态语义的载体）', () => {
  /*
   * 这条防的是"迁移加了列、但没接到 Trader 类型上" ——
   * 那样 `trader.dryRun` 永远是 undefined，恢复路径静默退回旧行为。
   */
  assert.ok(
    /dryRun:\s*row\.dry_run === null \? undefined : row\.dry_run !== 0/.test(codeOnly(REPO)),
    '★ `toTrader` 必须把 `dry_run` 映射到 `dryRun` 三态',
  );
  const DOMAIN = readFileSync(new URL('../../../shared/src/domain.ts', import.meta.url), 'utf8');
  assert.ok(/dryRun\?: boolean/.test(DOMAIN), '★ `Trader` 类型上必须有可选的 `dryRun`');
});
