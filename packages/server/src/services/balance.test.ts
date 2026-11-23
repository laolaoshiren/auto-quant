/**
 * `BalanceService` 交易所分派回归测试（2026-11-23 P0 凭据外泄修复）。
 *
 * ## 为什么这个测试存在
 *
 * 原先 `BalanceService.clientFor()` 不检查 `row.exchange`，始终拿凭据构造 `BinanceRest`
 * 并发往 Binance：每次列表轮询或新建 Gate 机器人都会把 Gate 的明文 API Key 与签名发给
 * 第三方交易所 Binance，同时让新建 Gate 机器人的初始权益恒为 0。
 *
 * 本测试通过拦截全局 `fetch` 断言：读取 Gate 账户余额时**只会**请求 Gate 域名，
 * 绝不会发出任何指向 Binance 的 HTTP 请求。
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Vault } from '../crypto/vault.js';
import { closeDb, initDb } from '../db/index.js';
import { exchanges } from '../store/repositories.js';
import { BalanceService } from './balance.js';

let workDir: string;
let vault: Vault;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-balance-dispatch-'));
  initDb(path.join(workDir, 'test.sqlite'));
  vault = new Vault(randomBytes(32));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

test('★★★ 读取 Gate 账户余额走 GateRest，绝不把 Gate 凭据发往 Binance', async () => {
  const gateAcc = exchanges.create({
    exchange: 'gate',
    label: 'Gate 测试网',
    apiKey: 'gate-key-should-never-hit-binance',
    apiSecretEnc: vault.encrypt('gate-secret-123'),
    testnet: true,
    canTrade: true,
  });

  const requestedUrls: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requestedUrls.push(url);
    return new Response(
      JSON.stringify({ total: '776.25', unrealised_pnl: '6.25', available: '700.00', margin: '76.25' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const svc = new BalanceService(vault);
    const result = await svc.get(gateAcc.id);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.balance.equity, 776.25);
      assert.equal(result.balance.walletBalance, 770);
      assert.equal(result.balance.asset, 'USDT');
    }
    assert.ok(requestedUrls.length > 0, '应当实际发起了 Gate 请求');
    assert.ok(
      requestedUrls.every((u) => !/binance/i.test(u) && /gate/i.test(u)),
      `Gate 凭据绝不可发往 Binance，实际请求：${requestedUrls.join(', ')}`,
    );

    const wallet = await svc.walletBalanceOf(gateAcc.id);
    assert.equal(wallet, 770, '新建 Gate 机器人应能正确读到初始钱包余额');
  } finally {
    globalThis.fetch = origFetch;
  }
});
