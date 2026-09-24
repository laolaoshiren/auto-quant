import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultStrategyConfig } from '@aq/shared';
import { closeDb, getDb, initDb } from '../db/index.js';
import {
  aiModels,
  exchanges,
  strategies,
  traders,
  trades as tradeStore,
} from './repositories.js';

/**
 * 「同一个真实回合在 `trades` 里只能有一行」—— **用交易所的单号来保证**。
 *
 * ## 为什么这个文件存在
 *
 * 用户的原话：「查一下盈亏计算是否正确？归属权益（USDT）和收益，为什么和钱包
 * 实际余额对不上？（当前没有持仓和挂单）」
 *
 * 查下去是**重复记账**：平台记的净额比交易所流水多出 **1.51 USDT**，六组重复，
 * 每一组都是「同一个平仓时刻、同一个入场价、同一个出场价，只是数量不同」，
 * 而每组里都恰好有一笔 `bot`（运行期记的）和一到两笔 `reconciled`（对账重建的）。
 *
 * 根因有两层，两层都在这份用例里钉住：
 *
 *  1. **数量容差（20%）原来写在 WHERE 的最外层**，一票否决了正确的判据 ——
 *     而数量本来就是两条路径之间**最不可靠**的维度（口径不同源）。
 *  2. **确定性键一直躺在表里没人用**：`trades.exit_order_id` 实测 100% 有值，
 *     而一笔平仓在交易所**只有一个** `orderId`。最硬的那对（ZECUSDT `#107`/`#120`）
 *     正因为判据只看启发式、没看单号，才漏到账上。
 *
 * 按 AGENTS.md §3.6：临时目录，绝不碰 `data/`。
 */

let workDir: string;
let traderId: number;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-dedup-'));
  initDb(path.join(workDir, 'dedup.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().run('DELETE FROM trades');
});

function seedTrader(name = 'dedup'): number {
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
    initialEquity: 1000,
  }).id;
}

/** 直接落一行成交（`idempotent` 默认关闭，所以它**不去重** —— 正是造重复所需）。 */
function book(over: Partial<Parameters<typeof tradeStore.insert>[0]> = {}): number {
  return tradeStore.insert({
    traderId,
    symbol: 'HEDGEUSDT',
    side: 'long',
    quantity: 0.009,
    entryPrice: 1546,
    exitPrice: 1545.08,
    leverage: 5,
    grossPnl: -0.00368,
    entryFee: 0.0012368,
    exitFee: 0.00432696,
    closeReason: 'stop_loss',
    openedAt: '2026-09-22T16:59:47.151Z',
    closedAt: '2026-09-22T17:37:17.018Z',
    source: 'bot',
    exitOrderId: 'SHARED-EXIT-ID',
    ...over,
  }).id;
}

test('★ 共用同一个平仓单号 = 同一个回合，不看数量也不看时间窗', () => {
  /*
   * 实测那一对：ZECUSDT `#107`（0.009）/ `#120`（0.004）共用 `exit_order_id`
   * `807238763718`，却被判成两个回合 —— 因为
   *
   *   · 数量差 0.005，超出 20% 容差（0.009 × 0.2 = 0.0018）；
   *   · 平仓时刻差 6 秒，超出 2 秒窗口。
   *
   * 于是账上多记一笔，**归属权益比钱包高 0.015**。
   * 交易所的单号是**身份**，不是相似度 —— 这一条把那个边界关掉。
   */
  traderId = seedTrader();
  const first = book();
  book({
    quantity: 0.004,
    /* 差 6 秒 —— 刻意落在 2 秒窗口之外，让启发式判据全部落空。 */
    closedAt: '2026-09-22T17:37:11.051Z',
    source: 'reconciled',
  });

  const found = tradeStore.findDuplicate({
    traderId,
    symbol: 'HEDGEUSDT',
    quantity: 0.004,
    entryPrice: 1546,
    exitPrice: 1545.08,
    openedAt: '2026-09-22T16:59:47.151Z',
    closedAt: '2026-09-22T17:37:11.051Z',
    exitOrderId: 'SHARED-EXIT-ID',
  });
  assert.equal(found, first, '单号相同就是同一个回合 —— 必须认出已有的那一行');
});

test('★ 存量重复的复核报告也要按单号报出来', () => {
  /*
   * `duplicateSuspects()` 是给操作者复核存量重复用的报告，而它用的是**同一套
   * 容差** —— 所以它既没拦住那一对、也没报出来。这条用例保证下次不会再漏报。
   */
  traderId = seedTrader();
  book();
  book({
    quantity: 0.004,
    closedAt: '2026-09-22T17:37:11.051Z',
    source: 'reconciled',
  });

  const suspects = tradeStore.duplicateSuspects(traderId);
  assert.equal(suspects.length, 1, `必须报出这一对，实际 ${suspects.length} 对`);
});

test('不同单号的两个回合不许被合并 —— 判据不是"永远匹配"', () => {
  /*
   * 反面。没有这一条，把判据改成"只要同标的就算同一个"也能让上面全绿 ——
   * 而那会把两笔**真实**回合并成一笔，比重复更严重（凭空吃掉一笔交易）。
   * 所以这里让两个回合连启发式也区分得开（入场价与出场价都不同）。
   */
  traderId = seedTrader();
  book({ exitOrderId: 'EXIT-A' });
  book({
    exitOrderId: 'EXIT-B',
    quantity: 0.004,
    entryPrice: 1500,
    exitPrice: 1490,
    closedAt: '2026-09-22T17:37:11.051Z',
    source: 'reconciled',
  });

  const found = tradeStore.findDuplicate({
    traderId,
    symbol: 'HEDGEUSDT',
    quantity: 0.004,
    entryPrice: 1500,
    exitPrice: 1490,
    openedAt: '2026-09-22T16:59:47.151Z',
    closedAt: '2026-09-22T17:37:11.051Z',
    exitOrderId: 'EXIT-B',
  });
  const rows = tradeStore.list(traderId, 10);
  assert.equal(rows.length, 2, '前提：两个回合都在账上');
  /*
   * B 是后插的，id 更大。判据必须命中**单号相同的那个**（B）；
   * 如果它退化成"同标的就算同一个"，`ORDER BY id ASC` 会命中 A —— 那就是
   * 把两笔真实回合并成一笔，比重复更严重。
   */
  const bId = Math.max(...rows.map((r) => r.id));
  assert.equal(found, bId, '必须命中单号相同的 B，而不是靠价格/数量猜到的 A');
});
