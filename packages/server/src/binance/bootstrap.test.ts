/**
 * **启动预检不能因为"模拟盘不需要凭据"就跳过其余检查**（2026-11-09 修 PR #185 的早退）。
 *
 * ## 事故形状
 *
 * PR #185 让模拟盘无需真实交易所账户：`preflight()` 在「没有凭据 + dryRun」时
 * 给出「API 凭据 ok」并**提前 `return checks`**。问题是那个返回值落在函数中段 ——
 * 后面的三项检查（合约元数据 / 时钟同步 / 测试环境提示）被一起跳过了：
 *
 * ```
 *   合约元数据   registry.size === 0 ⇒ error + blocking   ← fail-closed 的那一道
 *   时钟同步     clockOffsetMs 已知，白丢一次告知
 *   测试环境提示 模拟盘连的正是 demo/testnet 端点 —— 对它比对实盘更要紧
 * ```
 *
 * 最坏情况：元数据没加载到的模拟盘带着**空 registry** 启动，预检全绿，而之后
 * 每一笔下单都抛 `Unknown or non-tradable futures symbol` —— 这正是
 * `bootstrap.ts` 顶部强调"三件事是承重的、不只是装饰"要防的形态。
 *
 * ⚠️ 这条修法把三项抽成 `environmentChecks()`，两条返回路径都必须带上。
 * 本文件钉的就是"带上了"，以及实盘无凭据时的 fail-closed 行为没有被放宽。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { preflight, type ExchangeConnection } from './bootstrap.js';

/**
 * 只喂 `preflight()` 真正读到的字段。
 *
 * 起一个真的 `connectExchange()` 需要网络（校时 + exchangeInfo），而本测试要验的
 * 是**检查项有没有被列出来**，不是交易所连通性 —— 那属于 `npm run verify` 那一档。
 */
function fakeConnection(input: {
  hasCredentials: boolean;
  isDryRun: boolean;
  registrySize?: number;
  isTestnet?: boolean;
  equity?: number;
}): ExchangeConnection {
  return {
    environment: 'demo',
    endpoints: {
      label: 'demo',
      isTestnet: input.isTestnet ?? true,
    },
    rest: { hasCredentials: input.hasCredentials },
    broker: {
      isDryRun: input.isDryRun,
      getAccountState: async () => ({
        equity: input.equity ?? 1000,
        walletBalance: input.equity ?? 1000,
        availableBalance: input.equity ?? 1000,
        unrealizedPnl: 0,
        marginUsed: 0,
        openOrderMargin: 0,
      }),
    },
    registry: { size: input.registrySize ?? 528 },
    clockOffsetMs: 12,
  } as unknown as ExchangeConnection;
}

test('★★ 模拟盘的预检不能漏掉公共三项（元数据 / 时钟 / 测试环境）', async () => {
  const checks = await preflight(
    fakeConnection({ hasCredentials: false, isDryRun: true }),
  );
  const names = checks.map((c) => c.name);

  assert.ok(names.includes('API 凭据'), `模拟盘应当说明"不需要凭据"，实际项：${names.join(' / ')}`);
  assert.ok(names.includes('模拟资金'), '模拟盘应当检查本地钱包余额');
  assert.ok(
    names.includes('合约元数据'),
    `模拟盘也必须检查合约元数据 —— 空 registry 启动后每一笔下单都会失败，实际项：${names.join(' / ')}`,
  );
  assert.ok(names.includes('时钟同步'), '时钟偏移已经量好了，模拟盘也该告知');
  assert.ok(
    names.includes('测试环境提示'),
    '模拟盘连的就是 demo/testnet，那条"行情与实盘不同"的提醒对它更要紧',
  );
});

test('★★ 元数据为空时预检必须 fail-closed（模拟盘也不例外）', async () => {
  const checks = await preflight(
    fakeConnection({ hasCredentials: false, isDryRun: true, registrySize: 0 }),
  );
  const metadata = checks.find((c) => c.name === '合约元数据');
  assert.ok(metadata, '应当有「合约元数据」这一项');
  assert.equal(metadata.severity, 'error', '空 registry 必须是 error，而不是被跳过');
  assert.equal(metadata.blocking, true, '空 registry 必须阻止启动');
});

test('★★ 实盘没有凭据时仍然 fail-closed，且不能谎报模拟资金', async () => {
  const checks = await preflight(
    fakeConnection({ hasCredentials: false, isDryRun: false }),
  );
  const names = checks.map((c) => c.name);
  assert.ok(!names.includes('模拟资金'), '实盘不能出现模拟钱包的检查项');
  const credentials = checks.find((c) => c.name === 'API 凭据');
  assert.ok(credentials, '应当有「API 凭据」这一项');
  assert.equal(credentials.severity, 'error', '实盘没有凭据必须报错');
});
