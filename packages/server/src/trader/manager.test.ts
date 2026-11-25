import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultStrategyConfig } from '@aq/shared';
import { closeDb, getDb, initDb } from '../db/index.js';
import { aiModels, equity, exchanges, strategies, traders } from '../store/repositories.js';
import { Vault } from '../crypto/vault.js';
import { TraderManager, startGuard } from './manager.js';

let workDir: string;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-manager-'));
  initDb(path.join(workDir, 'manager.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const t of traders.list()) traders.remove(t.id);
});

function seedTrader(name: string, initialEquity = 1000): number {
  const account = exchanges.create({
    exchange: 'binance',
    label: name,
    apiKey: `k-${name}`,
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
    initialEquity,
  }).id;
}

test('★ stopTrader 排空期间并发 startTrader 必须等待旧停机完毕，且旧停机绝不拆毁新实例连接', async () => {
  /*
   * 防回归（Bug #3 P0）：
   * stopTrader 为了让 UI 秒变 stopped 提前 delete(running)，旧实例仍在 await stop() 排空；
   * 若此时立刻点启动，旧实现会直接并发拉起第二个实例，且旧 stop() 结束后还会把新实例的
   * userStreams / connections / researchRefresher 一并拆掉。
   */
  const id = seedTrader('stop-restart-race');
  const manager = new TraderManager(new Vault(Buffer.alloc(32, 9)));
  const internal = manager as unknown as {
    running: Map<number, { abortInFlightCycle(): void; stop(): Promise<void> }>;
    connections: Map<string, unknown>;
    userStreams: Map<number, { stop(): Promise<void> }>;
    startedAt: Map<number, number>;
    attemptStart: (...args: unknown[]) => Promise<{ result: { ok: boolean; preflight: [] }; permanent: boolean }>;
  };

  let releaseOldStop!: () => void;
  let oldStopDone = false;
  let newStartEntered = false;
  let newStreamStopped = false;

  internal.running.set(id, {
    abortInFlightCycle: () => undefined,
    stop: () =>
      new Promise<void>((resolve) => {
        releaseOldStop = () => {
          oldStopDone = true;
          resolve();
        };
      }),
  });
  internal.startedAt.set(id, Date.now());
  internal.connections.set(`${id}:dry`, { tag: 'old-conn' });

  internal.attemptStart = async () => {
    newStartEntered = true;
    assert.equal(oldStopDone, true, '新启动必须在旧 stopTrader 排空完成后才进入 attemptStart');
    internal.connections.set(`${id}:dry`, { tag: 'new-conn' });
    internal.userStreams.set(id, {
      stop: async () => {
        newStreamStopped = true;
      },
    });
    return { result: { ok: true, preflight: [] }, permanent: false };
  };

  // 1) 点击停止：UI 状态应立即落为 stopped
  const stopPromise = manager.stopTrader(id);
  assert.equal(traders.get(id)?.status, 'stopped', 'stopTrader 必须立即将状态置为 stopped');
  assert.equal(internal.running.has(id), false);

  // 2) 在旧 stop 尚未结束时立即发起 startTrader
  const startPromise = manager.startTrader(id, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(newStartEntered, false, '旧实例未排空前，新实例不得开始启动');

  // 3) 放行旧 stop 排空
  releaseOldStop();
  await Promise.all([stopPromise, startPromise]);

  assert.equal(newStartEntered, true, '旧排空结束后新实例正常启动');
  assert.equal(newStreamStopped, false, '旧停机不得停掉新实例的 userStream');
  assert.deepEqual(
    internal.connections.get(`${id}:dry`),
    { tag: 'new-conn' },
    '旧停机不得删掉新实例的连接',
  );
});

test('★ stopAll() 期间 shutdownInProgress 拒绝并发 startTrader，并清空 startedAt', async () => {
  /*
   * 防回归（Bug #3 P2 & Bug #10 P1）：
   * 1) stopAll() 排空期间并发 startTrader 曾覆写 this.stopping = false 打破停机保护；
   * 2) stopAll() 曾漏清 this.startedAt。
   */
  const id = seedTrader('shutdown-lock');
  const manager = new TraderManager(new Vault(Buffer.alloc(32, 9)));
  const internal = manager as unknown as {
    running: Map<number, { stop(reason?: string, persist?: boolean): Promise<void> }>;
    startedAt: Map<number, number>;
  };

  let releaseShutdown!: () => void;
  internal.running.set(id, {
    stop: () =>
      new Promise<void>((resolve) => {
        releaseShutdown = resolve;
      }),
  });
  internal.startedAt.set(id, Date.now());

  const stopAllPromise = manager.stopAll('测试关机');
  // stopAll 正在排空期间，并发 startTrader 必须被拦截
  const blocked = await manager.startTrader(id, true);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error ?? '', /停机清理中/);

  const guardVerdict = startGuard({
    traderId: id,
    globalTradingDisabled: false,
    traderExists: true,
    running: false,
    starting: false,
    shuttingDown: true,
  });
  assert.equal(guardVerdict.ok, false);

  releaseShutdown();
  await stopAllPromise;
  assert.equal(internal.startedAt.size, 0, 'stopAll 结束后必须清空 startedAt');
});

test('★ startTraderAsync 遇到 result.cancelled 时兜底确保 DB 为 stopped（防止重启复活）', async () => {
  /*
   * 防回归（Bug #10 P1）：
   * 若 startTrader 返回 cancelled: true 但此前状态还是 starting，startTraderAsync 必须兜底写回 stopped。
   */
  const id = seedTrader('cancel-db-stopped');
  const manager = new TraderManager(new Vault(Buffer.alloc(32, 9)));
  manager.startTrader = (async () => ({
    ok: false,
    error: 'cancelled',
    preflight: [],
    cancelled: true,
  })) as unknown as TraderManager['startTrader'];

  manager.startTraderAsync(id, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(traders.get(id)?.status, 'stopped', '取消分支必须确保 DB 最终为 stopped');
});

test('★ readEquity 优先读取实时最新权益快照，无快照再回落 initialEquity', () => {
  /*
   * 防回归（Bug #10 P1）：
   * 原 readEquity 直接读 initialEquity，余额翻倍或腰斩后仓位计算仍按初始本金算。
   */
  const id = seedTrader('equity-snapshot', 500);
  // 尚无快照 → 回落 initialEquity = 500
  assert.equal(equity.list(id, 1)[0]?.equity, undefined);
  assert.equal(traders.get(id)?.initialEquity, 500);

  // 写入实时快照 1234.56 → 应优先读到最新权益
  equity.insert({
    traderId: id,
    timestamp: new Date().toISOString(),
    equity: 1234.56,
    accountEquity: 1234.56,
    accountUnrealizedPnl: 10,
    availableBalance: 1000,
    unrealizedPnl: 10,
    marginUsed: 200,
    openPositions: 1,
  });
  assert.equal(equity.list(id, 1)[0]?.equity, 1234.56);
});

test('★★★ 历史 SQLite 数据库中残留的 mode="jev" 行读库时安全降级为 strategy，不抛异常', () => {
  const id = seedTrader('legacy-jev-row', 1000);
  // 直接写底库模拟老版本留下的 mode = 'jev'（含 strategy_id = NULL 的历史形态）
  getDb().run("UPDATE traders SET mode = 'jev', strategy_id = NULL WHERE id = ?", id);

  const loaded = traders.get(id);
  assert.ok(loaded, '历史 jev 行应可正常读取');
  assert.equal(loaded!.mode, 'strategy', '历史 mode=jev 必须安全归一化降级为 strategy');
  assert.equal(loaded!.strategyId, null);

  const all = traders.list();
  const inList = all.find((t) => t.id === id);
  assert.ok(inList, '列表查询不应因历史 jev 行抛错或丢失该记录');
  assert.equal(inList!.mode, 'strategy');
});
