/**
 * **Gate 账户的机器人可以启动**（阶段 2 收尾）—— 用"源码结构守卫"钉住那条被删掉的拒绝。
 *
 * ## 为什么是结构断言而不是完整的启动行为测试
 *
 * `attemptStart()` 要真实构建连接（`connectGate` 启动期会拉 Gate 合约列表）、探测
 * LLM、起交易循环；把它整条跑通需要**Gate 测试网 + 真实模型 key**，属于
 * Lead 的联调范畴（本任务明确"不读测试网 key"）。所以这里钉的是**接线事实**：
 *
 * ```
 *   ① attemptStart 里不再有"Gate 行情未接线"的 blocking 拒绝；
 *   ② 它改为调用 gateStartupChecks()（行为见 gate/connection.test.ts：三项 ok/blocking 判据）；
 *   ③ 币安独有的用户数据流对 Gate 被跳过（而不是拿 Gate 的 rest 去请求币安端点）；
 *   ④ 跨交易所通用的 requireTradingConnection() 不再对 Gate 抛错；
 *   ⑤ "Gate 正式网 + dryRun" 的安全守卫**仍然存在**（这条不能因为放开启动而丢）。
 * ```
 *
 * 这是本仓库既有的同类做法（`dryRunSettle.test.ts` / `startCancellation.test.ts`
 * 都把"接线缺陷"用源码结构钉住，并写明它不能证明运行时行为）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { defaultStrategyConfig } from '@aq/shared';
import { closeDb, initDb } from '../db/index.js';
import { aiModels, exchanges, strategies, traders } from '../store/repositories.js';
import { Vault } from '../crypto/vault.js';
import { SymbolRegistry } from '../binance/symbols.js';
import type { GateConnection } from '../gate/connection.js';
import { AutoTrader } from './autoTrader.js';
import { TraderManager } from './manager.js';

const MANAGER = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');

/** `attemptStart` 起止之间那一段（用下一个 `private` 方法做锚点，不猜大括号）。 */
function attemptStartSpan(): string {
  const start = MANAGER.indexOf('private async attemptStart(');
  assert.ok(start > 0, '找不到 attemptStart —— 方法被改名了？');
  const end = MANAGER.indexOf('\n  private ', start + 10);
  assert.ok(end > start, '找不到 attemptStart 之后的下一个方法 —— 结构变了？');
  return MANAGER.slice(start, end);
}

test('★★★ attemptStart 不再对 Gate 返回 blocking 拒绝，改为走 Gate 启动预检', () => {
  const span = attemptStartSpan();

  /* 旧的拒绝文案必须消失 —— 它是"交易循环待放开"的临时状态标记。 */
  assert.ok(
    !span.includes('尚未接线') && !span.includes('交易所适配'),
    '★ Gate 的"行情适配层尚未接线"拒绝必须已删除，否则 Gate 账户仍然启动不了',
  );
  assert.ok(
    span.includes('gateStartupChecks(connection)'),
    '★ 必须调用 gateStartupChecks() —— 放开启动的前提是 Gate 有自己的预检，而不是复用币安那套',
  );
  /* 预检失败仍要按 blocking 处理（不能悄悄忽略）。 */
  assert.ok(
    /blockingGate/.test(span) && span.includes('!c.ok && c.blocking'),
    '★ Gate 预检里的 blocking 项必须仍然阻止启动',
  );
  /* 币安路径不能被顺手改坏：币安仍然走 `preflight(...)`。 */
  assert.ok(
    span.includes('preflight(connection, { requireCredentials: !dryRun })'),
    '★ 币安账户仍必须走原来的 preflight()（本改动不得动币安路径）',
  );
});

test('★★★ Gate 跳过币安独有的用户数据流（不能让 Gate 的 rest 去请求币安端点）', () => {
  const call = MANAGER.indexOf('await this.startUserStream(traderId, connection);');
  assert.ok(call > 0, '找不到 startUserStream 调用');
  const before = MANAGER.slice(Math.max(0, call - 400), call);
  assert.ok(
    /if \(!isGateConnection\(connection\)\)/.test(before),
    '★ startUserStream 必须被 isGateConnection 判据包住 —— Gate 的 WS 属于阶段 3',
  );
});

test('★★★ requireTradingConnection 不再对 Gate 抛错（对账/手工平仓/撤单对 Gate 可用）', () => {
  const start = MANAGER.indexOf('private requireTradingConnection(');
  const end = MANAGER.indexOf('\n  /**', start + 10);
  assert.ok(end > start);
  const span = MANAGER.slice(start, end);
  assert.ok(
    !/Gate 行情适配层|尚未接线|已阻止该操作/.test(span),
    '★ requireTradingConnection 里的 Gate 拒绝必须删除（那会让已停止的 Gate 机器人的对账/手工平仓全部不可用）',
  );
  assert.ok(/return connection;/.test(span), '★ 收窄函数应当直接返回连接');
});

test('★★★ 安全守卫保留：Gate 正式网账户 + dryRun 仍然必须拒绝（否则"模拟盘"真钱下单）', () => {
  /*
   * Gate 的"模拟盘"是官方测试网（真实撮合、假钱），`GateBroker.isDryRun` 恒 false。
   * 所以"dryRun + 正式网账户"会**用真钱下单** —— 这条守卫在
   * `createExchangeConnection()`（建连接之前）里，不随本次放开启动而改变。
   */
  assert.ok(
    /if \(input\.dryRun && !input\.testnet\)/.test(MANAGER),
    '★ 「Gate 正式网 + dryRun」的拒绝判据必须仍然存在',
  );
  assert.ok(
    /Gate 账户不支持本地模拟盘/.test(MANAGER),
    '★ 拒绝时必须有明确中文原因（解释"Gate 的模拟盘是测试网"）',
  );
});

/* -------------------------------------------------------------------------- */
/*  行为验证：Gate 账户真的能走完 attemptStart 的启动分支（I/O 与循环用桩）        */
/* -------------------------------------------------------------------------- */

/**
 * **为什么这条测试能成立**：`attemptStart()` 里真正会碰外部世界的只有三处 ——
 *   ① `connectionFor()`（建连接/拉合约）→ 桩成一条内存里的 `GateConnection`；
 *   ② `buildModel()`（探测 LLM）→ 桩成永远成功的模型客户端；
 *   ③ `autoTrader.start()`（起交易循环）→ 临时替换原型，只记录"被调用了"。
 * 其余（预检、配置可达性、组装 AutoTrader、状态落库）全部走真实代码。
 *
 * 于是"Gate 账户启动不再被拒"从一句注释变成可执行断言：**ok:true + 预检里有
 * Gate 的三项 ok + 没有「交易所适配」blocking**。
 */
test('★★★ 行为：Gate 账户的 attemptStart 返回 ok，预检不再有 blocking 拒绝', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'aq-gate-start-'));
  initDb(path.join(workDir, 'gate-start.sqlite'));

  const originalStart = AutoTrader.prototype.start;
  const originalStop = AutoTrader.prototype.stop;
  let startCalled = 0;

  try {
    const account = exchanges.create({
      exchange: 'gate',
      label: 'gate-start',
      apiKey: 'k',
      apiSecretEnc: 'v1:00:00:00',
      testnet: true,
      canTrade: true,
    });
    const model = aiModels.create({
      provider: 'deepseek',
      label: 'm',
      model: 'm',
      baseUrl: 'https://example.invalid',
      apiKeyEnc: '',
      temperature: 0.2,
      maxTokens: 4096,
      timeoutSeconds: 60,
      maxRetries: 1,
    });
    const strategy = strategies.create({
      name: 'gate-start',
      description: '',
      config: defaultStrategyConfig(),
      presetId: null,
    });
    const trader = traders.create({
      name: 'gate-start',
      exchangeAccountId: account.id,
      aiModelId: model.id,
      strategyId: strategy.id,
      cycleIntervalMinutes: 15,
      initialEquity: 776.26,
    });

    const connection = fakeGateConnection();
    const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
    const internals = manager as unknown as {
      connectionFor: () => Promise<GateConnection>;
      buildModel: () => Promise<unknown>;
      attemptStart: (
        traderId: number,
        row: unknown,
        dryRun: boolean,
      ) => Promise<{ result: { ok: boolean; error?: string; preflight: Array<{ name: string; ok: boolean; blocking: boolean }> } }>;
    };
    internals.connectionFor = async () => connection;
    internals.buildModel = async () => ({
      client: {
        complete: async () => ({
          text: '<decision></decision>',
          latencyMs: 1,
          usage: { promptTokens: 0, completionTokens: 0 },
        }),
      },
      config: { maxTokens: 4096 },
    });
    /* 交易循环本身不属于本测试：只证明启动分支走到"该起循环"这一步。 */
    (AutoTrader.prototype as unknown as { start: () => Promise<void> }).start = async () => {
      startCalled += 1;
    };

    const row = traders.get(trader.id);
    assert.ok(row);
    const outcome = await internals.attemptStart(trader.id, row, true);

    assert.equal(outcome.result.ok, true, `Gate 账户必须能启动：${outcome.result.error ?? ''}`);
    assert.equal(startCalled, 1, '启动分支必须走到起交易循环（而不是被拒绝）');
    const names = outcome.result.preflight.map((c) => c.name);
    assert.ok(names.includes('账户访问'), `预检必须包含 Gate 账户检查：${names.join('/')}`);
    assert.ok(names.includes('合约元数据'), '预检必须包含合约注册表检查');
    assert.ok(
      !names.includes('交易所适配'),
      '★ 旧的「交易所适配」blocking 项必须消失 —— Gate 账户不再被启动前拒绝',
    );
    assert.deepEqual(
      outcome.result.preflight.filter((c) => !c.ok && c.blocking),
      [],
      'Gate 启动预检不应有 blocking 失败',
    );
    /* 失败时 attemptStart 会把状态写成 error；成功路径不得留下 error。 */
    assert.notEqual(traders.get(trader.id)?.status, 'error');
  } finally {
    AutoTrader.prototype.start = originalStart;
    AutoTrader.prototype.stop = originalStop;
    closeDb();
    rmSync(workDir, { recursive: true, force: true });
  }
});

/**
 * 内存里的 Gate 连接：只需要 `attemptStart` 在启动阶段会碰的两三个方法。
 * 任何"本不该在启动阶段发生"的调用都会直接抛错，防止测试悄悄变成联调。
 */
function fakeGateConnection(): GateConnection {
  const accountState = {
    equity: 776.26,
    walletBalance: 776.26,
    availableBalance: 776.26,
    unrealizedPnl: 0,
    marginUsed: 0,
    openOrderMargin: 0,
  };
  const broker = {
    isDryRun: false,
    async getAccountState() {
      return accountState;
    },
    async getMarkPrice() {
      return 70_000;
    },
    async getPositions() {
      return [];
    },
    async ensureOneWayMode() {
      return { changed: false, warning: null };
    },
    async isHedgeMode() {
      return false;
    },
    async getIncome() {
      return [];
    },
  };
  const registry = new SymbolRegistry([
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      status: 'TRADING',
      pricePrecision: 1,
      quantityPrecision: 4,
      tickSize: 0.1,
      stepSize: 0.0001,
      minQty: 0.0001,
      maxQty: 100,
      minNotional: 0.0001,
      contractSize: 1,
    },
  ]);
  const market = {
    klines: async () => [],
    fetchClosedKlines: async () => [],
    ticker24h: async () => [],
    premiumIndex: async () => [],
    openInterest: async () => null,
    openInterestHist: async () => [],
    takerBuySellVolume: async () => [],
    longShortRatio: async () => [],
  };
  return {
    exchange: 'gate',
    environment: 'testnet',
    rest: {} as GateConnection['rest'],
    contracts: {} as GateConnection['contracts'],
    broker: broker as unknown as GateConnection['broker'],
    market: market as unknown as GateConnection['market'],
    registry,
    clockOffsetMs: 0,
  };
}
