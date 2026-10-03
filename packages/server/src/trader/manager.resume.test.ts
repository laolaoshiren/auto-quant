import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultStrategyConfig } from '@aq/shared';
import { closeDb, initDb } from '../db/index.js';
import { aiModels, exchanges, strategies, traders } from '../store/repositories.js';
import { TraderManager } from './manager.js';
import { Vault } from '../crypto/vault.js';

/* -------------------------------------------------------------------------- */
/*  开机恢复：一台失败不能拖垮其余                                                */
/* -------------------------------------------------------------------------- */

/**
 * ## 用户 2026-10-03 的实盘事故
 *
 * `resumePersisted()` 的循环原来是：
 *
 * ```ts
 * if (this.cancelledStarts.has(trader.id) || this.stopping) break;
 * const result = await this.startTrader(trader.id, dryRun, { retryTransient: true });
 * ```
 *
 * 两个问题叠加：
 *
 *   · `cancelledStarts` 含**任意一台**就 `break` 整个循环 —— 而它的语义只是"这一台别启动"；
 *   · `startTrader` 调用**没有 try/catch** —— 一抛异常，循环带堆栈退出。
 *
 * 后果：`#9`（id 小、排在前）在启动途中出问题，循环中断，
 * **排在后面的 `#10`（主账户实盘、3 个仓位 6 张保护单）连一条日志都没有** ——
 * 它静默停摆 **8 小时**（09:07 最后一轮 → 17:11 人工发现）。
 *
 * 而这段代码上方的注释自己就写着：**「一个持有杠杆仓位的机器人静默停摆是钱的问题」**。
 *
 * 这两条用例把"一台失败不影响其余"钉死。
 */
let workDir: string;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-resume-'));
  initDb(path.join(workDir, 'resume.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // 每例都从空表开始，避免上一例的 trader 干扰。
  for (const t of traders.list()) traders.remove(t.id);
});

function seedTrader(name: string): number {
  const account = exchanges.create({
    exchange: 'binance',
    label: name,
    apiKey: 'k',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  });
  const model = aiModels.create({
    provider: 'deepseek',
    label: name,
    model: 'm',
    baseUrl: 'https://example.invalid',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 1,
  });
  const strategy = strategies.create({
    name,
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  });
  return traders.create({
    name,
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 100,
  }).id;
}

test('★ 一台机器人启动抛异常，后面那台【仍然要被尝试】—— 实盘曾因此静默停摆 8 小时', async () => {
  const first = seedTrader('first');
  const second = seedTrader('second');
  traders.setStatus(first, 'running', null);
  traders.setStatus(second, 'running', null);

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  const attempted: number[] = [];
  manager.startTrader = (async (id: number) => {
    attempted.push(id);
    if (id === first) throw new Error('模拟：这一台启动时抛异常');
    return { ok: true, preflight: [] };
  }) as unknown as TraderManager['startTrader'];

  await manager.resumePersisted(false);

  assert.deepEqual(
    attempted,
    [first, second],
    '★ 第一台抛异常之后，第二台必须照样被尝试 —— 否则一台的问题会让所有机器人一起不恢复',
  );
});

test('★ 一台启动【失败】（返回 ok:false）同样不能挡住后面的', async () => {
  const first = seedTrader('fail-first');
  const second = seedTrader('after-fail');
  traders.setStatus(first, 'running', null);
  traders.setStatus(second, 'running', null);

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  const attempted: number[] = [];
  manager.startTrader = (async (id: number) => {
    attempted.push(id);
    return id === first ? { ok: false, error: '预检没过' } : { ok: true, preflight: [] };
  }) as unknown as TraderManager['startTrader'];

  await manager.resumePersisted(false);

  assert.deepEqual(attempted, [first, second], '★ 失败（返回 ok:false）也要继续下一台');
  /* 失败那台必须被标成 error，让人看得见 —— 那是 F2 的另一半。 */
  assert.equal(traders.get(first)?.status, 'error');
});

test('操作员主动停掉的机器人【不】被恢复 —— 那次停手是人做的决定', async () => {
  const stopped = seedTrader('operator-stopped');
  traders.setStatus(stopped, 'stopped', null);

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  const attempted: number[] = [];
  manager.startTrader = (async (id: number) => {
    attempted.push(id);
    return { ok: true, preflight: [] };
  }) as unknown as TraderManager['startTrader'];

  await manager.resumePersisted(false);

  assert.deepEqual(attempted, [], '★ `stopped` 是人做的决定，开机不该把它翻过来');
});
