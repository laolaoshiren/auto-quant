/**
 * **开发用虚拟数据填充** —— 把控制台灌成"一个真实跑过一阵子的部署"。
 *
 * ## 为什么需要它（用户的原话）
 *
 * > 「你得增加一个开发用得虚拟数据填充进去，不然很多问题开发得时候发现不了，
 * >   实际运行数据多了以后才会显现」
 *
 * 这是对的，而且这个仓库里已经有过代价高昂的实例：空库下所有页面都是"空状态"，
 * 而空状态恰好是**最不容易出问题**的形态 —— 一张 0 行的表不会溢出、不会撑破
 * 高度链、不会触发分页与虚拟滚动、不会有长名字把右侧操作列挤出去。
 * 控制台里那些"看起来正常"的页面，在 40 个机器人、几千条成交、几万行日志之后
 * 才会暴露真实形态。
 *
 * ## 它与已有的两个脚本是什么关系
 *
 * | 脚本 | 写哪 | 用途 |
 * | --- | --- | --- |
 * | `demoCycle.ts` | 真实库 | **一条**决策周期，跑完整流水线（要联网、要模型） |
 * | `simulate.ts` | **临时库** | 全生命周期回放，控制台看不到 |
 * | `seedDemoData.ts`（本文件） | 真实库 | **规模化**的确定性数据，控制台能直接看 |
 *
 * 三者互补：`demoCycle` 证明"流水线是通的"，`simulate` 验证"交易逻辑是对的"，
 * 而本文件负责**版面与性能**这一层 —— 它是唯一能回答"列表长到 40 行时
 * 长什么样"的工具。
 *
 * ## 用法
 *
 * ```bash
 * npx tsx packages/server/src/scripts/seedDemoData.ts              # 默认规模
 * npx tsx packages/server/src/scripts/seedDemoData.ts --scale 3    # 三倍（压力）
 * npx tsx packages/server/src/scripts/seedDemoData.ts --clean      # 只清理
 * npx tsx packages/server/src/scripts/seedDemoData.ts --keep       # 保留已有数据，追加
 * ```
 *
 * ## 三条设计约束
 *
 * 1. **确定性。** 用固定种子的伪随机（`mulberry32`），不用 `Math.random()`。
 *    否则每次跑出来的界面都不一样，而"这个数字看起来对不对"是一个
 *    开发时真正会问的问题 —— 它需要一个可复现的基准。
 * 2. **可识别、可清理。** 所有实体的名字带 `[示例]` 前缀，`--clean` 按前缀
 *    删除。与 `demoCycle.ts` 的 `[DEMO]` 是同一套思路（那个前缀更短，
 *    因为它要出现在截图里）。
 * 3. **不碰交易所。** 全程不发起任何网络请求，不写任何密钥。
 */
import {
  defaultStrategyConfig,
  STRATEGY_PRESETS,
  type LlmProviderId,
  type StrategyConfig,
} from '@aq/shared';
import { closeDb, getDb, initDb } from '../db/index.js';
import { dbPath, ensureDataDir, resolveMasterKey } from '../env.js';
import { Vault } from '../crypto/vault.js';
import { createLogger } from '../logger.js';
import {
  aiModels,
  decisions as decisionStore,
  equity as equityStore,
  exchanges,
  orders as orderStore,
  positions as positionStore,
  runtimeLogs,
  strategies,
  traders,
  trades as tradeStore,
} from '../store/repositories.js';

const log = createLogger('seed');

/** 所有示例实体的名字前缀 —— `--clean` 靠它识别。 */
const TAG = '[示例]';

/* -------------------------------------------------------------------------- */
/*  确定性随机                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `mulberry32` —— 一个 32 位状态的伪随机数发生器。
 *
 * 用它而不是 `Math.random()` 的理由见文件顶部：界面要有一个**可复现的基准**。
 * 同一个种子永远给出同一批数字，所以"上一版长这样、这一版长那样"的对比是
 * 可信的 —— 否则分不清是代码改了还是随机数变了。
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 闭区间内的浮点。 */
const between = (rng: () => number, lo: number, hi: number): number => lo + rng() * (hi - lo);
/** 闭区间内的整数。 */
const intBetween = (rng: () => number, lo: number, hi: number): number => Math.floor(between(rng, lo, hi + 1));
/** 从数组里挑一个。 */
const pick = <T>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;

/* -------------------------------------------------------------------------- */
/*  标的池                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 交易对。
 *
 * **刻意包含长度差异很大的名字** —— `1000PEPEUSDT`（12 字符）与 `BTCUSDT`
 * （7 字符）在表格里占的宽度差近一倍，而"长名字把右侧操作列挤出去"正是
 * 空数据下永远发现不了的版面问题。
 */
const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
  'MATICUSDT', 'LTCUSDT', 'ATOMUSDT', 'UNIUSDT', 'APTUSDT',
  'ARBUSDT', 'OPUSDT', 'SUIUSDT', 'SEIUSDT', 'TIAUSDT',
  '1000PEPEUSDT', '1000SHIBUSDT', 'WIFUSDT', 'ORDIUSDT', 'JUPUSDT',
] as const;

/** 大致价格 —— 用来让成交量/名义价值的数量级看起来合理。 */
const PRICE: Record<string, number> = {
  BTCUSDT: 82700, ETHUSDT: 2530, SOLUSDT: 168, BNBUSDT: 610, XRPUSDT: 2.2,
  DOGEUSDT: 0.085, ADAUSDT: 0.72, AVAXUSDT: 28, LINKUSDT: 17, DOTUSDT: 4.1,
  MATICUSDT: 0.31, LTCUSDT: 92, ATOMUSDT: 4.5, UNIUSDT: 8.2, APTUSDT: 5.4,
  ARBUSDT: 0.42, OPUSDT: 0.98, SUIUSDT: 1.19, SEIUSDT: 0.28, TIAUSDT: 3.4,
  '1000PEPEUSDT': 0.0091, '1000SHIBUSDT': 0.014, WIFUSDT: 0.68, ORDIUSDT: 12.5,
  JUPUSDT: 0.78,
};

/**
 * 平仓原因 —— **必须是 `@aq/shared` 里的机器码，不是中文显示文本**。
 *
 * 第一版直接写了 `['止盈', '止损', …]`，而 `trades.close_reason` 那一列存的
 * 是**稳定机器码**（`domain.ts` 的 `CLOSE_REASONS`），中文标签由
 * `closeReasonLabel()` 在渲染时映射。
 *
 * 写中文的后果不只是"不统一"：提示词里「按平仓原因分组」那段会把每个中文
 * 原因渲染成独立一行、且与代码里认得的取值对不上 —— 模型看到的是六个
 * 它无法归类的字符串。
 */
const CLOSE_REASONS = [
  'take_profit',
  'stop_loss',
  'drawdown_guard',
  'model_decision',
  'manual',
  'liquidated',
] as const;

/* -------------------------------------------------------------------------- */
/*  参数                                                                       */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(`--${name}`);
const num = (name: string, fallback: number): number => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const parsed = Number(argv[index + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const CLEAN = has('clean');
/*
 * `--keep` = **不清理，也不重建**。
 *
 * ⚠️ 它曾经的含义是"跳过 clean()，但照常插入"，而那条路**必然失败**：
 * 重复创建同名机器人时，`positions` 表上的部分唯一索引
 * `idx_positions_open_symbol`（同标的只能有一个未平仓持仓）会拒绝第二次
 * 插入 —— 实测报 `UNIQUE constraint failed: positions.trader_id,
 * positions.symbol`，而**崩溃前已经写进去一半**（策略、账户、部分机器人）。
 *
 * 所以这个开关现在的语义是纯粹的"我只想清理，不要灌数据"的**反面**：
 * 保留现有数据、直接退出。要在已有数据上追加，正确做法是先 `--clean`
 * 再跑一次 —— 这个脚本是可复现的（固定种子），所以"重跑"与"追加"得到
 * 的是同一批数字，没有追加的必要。
 */
const KEEP = has('keep');
/** 规模倍数 —— 用来做压力测试（`--scale 3` 会灌三倍的数据）。 */
const SCALE = Math.max(0.1, num('scale', 1));

/* -------------------------------------------------------------------------- */
/*  时间                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 数据的时间跨度。
 *
 * 90 天是刻意的：权益曲线的「全部」档、成交列表的分页、日志的滚动条
 * 都要有一个**足够长**的历史才会进入真实形态。只灌三天的话，那些
 * "第一页 vs 第三页"的问题一个都碰不到。
 */
const DAYS = 90;
const NOW = Date.now();
const DAY_MS = 86_400_000;

/** `daysAgo` 天前、当天 `hour` 点附近的一个 ISO 时刻。 */
function at(daysAgo: number, hour = 12, minute = 0): string {
  const base = NOW - daysAgo * DAY_MS;
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

/** 在 `[daysAgoLo, daysAgoHi]` 天前之间取一个时刻（越近的越密）。 */
function spread(rng: () => number, daysAgoHi: number, daysAgoLo = 0): string {
  // 平方根让分布偏向"最近" —— 真实部署里最近的活动总是更密。
  const t = Math.sqrt(rng());
  const days = daysAgoLo + t * (daysAgoHi - daysAgoLo);
  const ms = NOW - days * DAY_MS;
  return new Date(ms).toISOString();
}

/* -------------------------------------------------------------------------- */
/*  主流程                                                                     */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  await ensureDataDir();
  initDb(dbPath);

  const vault = new Vault(await resolveMasterKey());

  if (CLEAN) {
    clean();
    log.info('已清理全部示例数据。');
    closeDb();
    return;
  }

  /*
   * `--keep` = "保留现有数据，什么都不做"。
   *
   * 默认（无开关）会先清一次再灌 —— 这是**幂等**的关键：脚本用固定种子，
   * 所以"清空重灌"与"在旧数据上追加"得到的是同一批数字，而后者会因为
   * `idx_positions_open_symbol` 那个唯一索引崩溃（详见 `KEEP` 的注释）。
   */
  if (KEEP) {
    log.info('--keep：保留现有数据，不做任何修改。要重灌请直接运行（会先清理）。');
    closeDb();
    return;
  }

  clean();

  const rng = makeRng(20261013);

  /* --- 交易所账户 ------------------------------------------------------- */

  /*
   * 三个账户。
   *
   * 多账户是刻意的：账户页的卡片列表、机器人的"归属钱包"那一列、
   * 以及"同一个账户下多个机器人共享保证金"这条逻辑，都要有**不止一个**
   * 账户才看得见。
   *
   * ⚠️ **同一个账户的 `account_equity` 必须是同一个数**（见下面
   * `seedTraderHistory` 的参数传递）—— 它在语义上是"共享钱包里一共多少"，
   * 同账户下所有机器人读的是同一份。第一版按机器人独立随机，于是账户
   * 权益曲线在同一个时间点有 N 个互相矛盾的值。
   */
  const accountSpecs = [
    { label: `${TAG} 币安主账户`, testnet: false, canTrade: true },
    { label: `${TAG} 币安模拟盘`, testnet: true, canTrade: true },
    { label: `${TAG} 币安观察账户（只读）`, testnet: false, canTrade: false },
  ];
  const accounts = accountSpecs.map(
    (spec) =>
      exchanges.list().find((a) => a.label === spec.label) ??
      exchanges.create({
        exchange: 'binance',
        label: spec.label,
        // 密钥是**假的**，而且从不被使用（本脚本不发任何网络请求）。
        apiKey: `demo-${Math.floor(rng() * 1e12).toString(36)}`,
        apiSecretEnc: vault.encrypt('seed-demo-secret-not-real'),
        testnet: spec.testnet,
        canTrade: spec.canTrade,
      }),
  );

  /* --- AI 模型 ---------------------------------------------------------- */

  /*
   * 五个模型，**刻意让标签长度差异大**（"Opus" vs "Gemini 2.5 Pro (预览)"），
   * 而且其中一个的名字带括号 —— 这类字符在表格里最容易触发排版问题。
   */
  const modelSpecs: Array<{
    provider: LlmProviderId;
    label: string;
    model: string;
    base: string;
  }> = [
    { provider: 'anthropic', label: `${TAG} Claude Opus`, model: 'claude-opus-5-5', base: 'https://api.anthropic.com' },
    { provider: 'anthropic', label: `${TAG} Claude Sonnet（日常）`, model: 'claude-sonnet-5-5', base: 'https://api.anthropic.com' },
    { provider: 'deepseek', label: `${TAG} DeepSeek V4 Pro`, model: 'deepseek-v4-pro', base: 'https://api.deepseek.com' },
    { provider: 'openai', label: `${TAG} GPT-5.2 Codex（预览）`, model: 'gpt-5.2-codex', base: 'https://api.openai.com/v1' },
    // `kimi` 是平台名（Moonshot），不是 `moonshot` —— 枚举里叫 `kimi`。
    { provider: 'kimi', label: `${TAG} Kimi K3`, model: 'kimi-k3', base: 'https://api.moonshot.cn/v1' },
  ];
  const models = modelSpecs.map(
    (spec) =>
      aiModels.list().find((m) => m.label === spec.label) ??
      aiModels.create({
        provider: spec.provider,
        label: spec.label,
        model: spec.model,
        baseUrl: spec.base,
        apiKeyEnc: '',
        temperature: Number(between(rng, 0.1, 0.7).toFixed(2)),
        maxTokens: intBetween(rng, 2048, 8192),
        timeoutSeconds: intBetween(rng, 60, 180),
        maxRetries: intBetween(rng, 1, 4),
      }),
  );

  /* --- 策略 ------------------------------------------------------------- */

  /*
   * `STRATEGY_PRESETS` 是**数组**（不是以 id 为键的对象），每项有
   * `{ id, label, summary, patch }` —— `patch` 是相对默认配置的补丁，
   * 所以要用 `defaultStrategyConfig()` 打底再铺开。
   */
  const strategiesCreated = STRATEGY_PRESETS.slice(0, 4).map((preset, index) => {
    const name = `${TAG} ${preset.label}`;
    return (
      strategies.list().find((s) => s.name === name) ??
      strategies.create({
        name,
        description: `${preset.summary}（示例数据，可以安全删除）`,
        config: { ...defaultStrategyConfig(), ...preset.patch } as StrategyConfig,
        presetId: preset.id,
        isDefault: index === 0,
      })
    );
  });

  /* --- 机器人 ----------------------------------------------------------- */

  /*
   * ## 为什么机器人数量按 `--scale` 放大
   *
   * 这是**最直接的压力维度**：机器人列表页、总览页的舰队合计、命令面板的
   * 搜索结果，都会随机器人数量线性增长。默认 14 个已经够看出"列表比空状态
   * 复杂得多"，`--scale 3` 给出 42 个则是"滚动条真的出现"的那一档。
   */
  const traderCount = Math.max(3, Math.round(14 * SCALE));
  const traderNames = [
    '稳健 · BTC 趋势', '激进 · 山寨轮动', '套利 · 资金费', '网格 · ETH 区间',
    '突破 · 波动率', '反转 · 超卖', '动量 · 热点追踪', '对冲 · 中性',
    '日内 · 高频', '长线 · 定投', '事件 · 新闻驱动', '实验 · 新模型',
    '观察 · 只读模式', '压力测试 · 极端参数',
  ];

  const traderIds: number[] = [];
  /** 每个机器人的连续失败次数 —— 历史生成完之后回填周期号时要用。 */
  const failuresByTrader = new Map<number, number>();
  for (let i = 0; i < traderCount; i += 1) {
    const base = traderNames[i % traderNames.length]!;
    // 超出一轮名字时加序号 —— 保证名字唯一（`traders` 表没有唯一约束，
    // 但重复的名字会让"我该看哪一个"变成一个真问题）。
    const name = i < traderNames.length ? `${TAG} ${base}` : `${TAG} ${base} #${i + 1}`;

    const existing = traders.list().find((t) => t.name === name);
    if (existing) {
      traderIds.push(existing.id);
      continue;
    }

    const created = traders.create({
      name,
      exchangeAccountId: pick(rng, accounts).id,
      aiModelId: pick(rng, models).id,
      strategyId: pick(rng, strategiesCreated).id,
      cycleIntervalMinutes: pick(rng, [5, 15, 30, 60]),
      initialEquity: pick(rng, [500, 1000, 2500, 5000, 10000]),
    });

    /*
     * 状态分布刻意做成"大部分在跑、少数出错" —— 真实部署的样子。
     * 全都在跑（没有 `error`/`safe_mode`）会让人以为那两种状态不需要设计，
     * 而它们恰恰是最需要看清楚的状态。
     */
    const roll = rng();
    const status = roll < 0.62 ? 'running' : roll < 0.8 ? 'stopped' : roll < 0.92 ? 'safe_mode' : 'error';
    traders.setStatus(
      created.id,
      status,
      status === 'error' ? '连续 3 次调用模型失败：HTTP 429 rate limit exceeded（示例）' : null,
    );

    /*
     * 连续失败次数 —— 只有出错的那几个有。它是列表页上一列真实存在的
     * 信息，空数据下那一列永远是空的。
     *
     * ⚠️ **周期号不在这里写**。第一版写了 `intBetween(12, 480)`，而那个数
     * 与后面真正生成的决策条数（每 3 笔成交一条）毫无关系 —— 于是列表页
     * 显示「周期 #433」而详情页只有 25 条决策，看起来像"决策记录丢了"。
     *
     * 正确做法是**在历史生成完之后**用真实条数回填（见下面的
     * `traders.recordCycle` 调用），这样两处说的是同一个数。
     */
    const failures = status === 'error' ? intBetween(rng, 1, 5) : status === 'safe_mode' ? intBetween(rng, 1, 2) : 0;
    failuresByTrader.set(created.id, failures);

    traderIds.push(created.id);
  }

  /* --- 每个机器人的历史 ------------------------------------------------- */

  let totalTrades = 0;
  let totalOrders = 0;
  let totalDecisions = 0;

  /*
   * **每个交易所账户一条权益序列** —— 同一个账户下的机器人读同一条。
   *
   * 这是"共享钱包"那条语义的实现：账户权益是**账户的属性**，不是机器人的。
   * 按账户建一条按时间索引的序列（而不是给每个机器人乘一个数），才不会有
   * "同一个钱包在同一时刻有两个互相矛盾的数"。
   *
   * 曲线起点取"该账户下所有机器人初始权益之和 × 一点余量"（真实部署里
   * 账户里的钱总是多于机器人当前占用的），然后按同一个随机游走漂移。
   */
  const accountCurves = new Map<number, Map<string, number>>();
  for (const account of accounts) {
    const owned = traderIds
      .map((id) => traders.get(id))
      .filter((t) => t?.exchangeAccountId === account.id);
    const base = owned.reduce((sum, t) => sum + (t?.initialEquity ?? 0), 0) || 5000;
    let value = base * between(rng, 1.1, 1.5);
    const series = new Map<string, number>();
    for (let day = DAYS; day >= 0; day -= 1) {
      for (const hour of [0, 6, 12, 18]) {
        value *= 1 + 0.0005 + (rng() - 0.5) * 0.018;
        series.set(`${day}:${hour}`, Number(value.toFixed(4)));
      }
    }
    accountCurves.set(account.id, series);
  }

  for (const traderId of traderIds) {
    const perTraderTrades = Math.round(intBetween(rng, 30, 90) * SCALE);
    const trader = traders.get(traderId);
    const series = accountCurves.get(trader?.exchangeAccountId ?? -1);
    /* 该账户在某个时刻的权益 —— 同账户下所有机器人拿到的是同一个数。 */
    const accountEquityAt = (day: number, hour: number): number =>
      series?.get(`${day}:${hour}`) ?? 5000;
    const r = seedTraderHistory(traderId, rng, perTraderTrades, accountEquityAt);
    totalTrades += r.trades;
    totalOrders += r.orders;
    totalDecisions += r.decisions;

    /*
     * 回填周期号 —— **用真实生成的决策条数**，不是另取一个随机数。
     *
     * 这样"列表页的周期 N"与"详情页有 N 条决策"说的是同一个数。第一版
     * 两处各写各的（列表 12~480、详情最多 30），看起来像"决策记录丢了"。
     */
    traders.recordCycle(traderId, r.decisions, failuresByTrader.get(traderId) ?? 0);
  }

  /* --- 运行时日志 ------------------------------------------------------- */

  /*
   * 日志是**另一条压力路径**：DataPage 的日志面板会一次渲染最多 500 行，
   * 而每一行都是带时间戳、级别、来源、正文的 flex 行。空库下那一块是
   * "还没有日志"，看不出任何东西。
   */
  const logCount = Math.round(600 * SCALE);
  seedLogs(rng, logCount);

  /* --- 报告 ------------------------------------------------------------- */

  const db = getDb();
  log.info(
    [
      '',
      '='.repeat(72),
      '示例数据已生成。**全程未向交易所发送任何请求，未写入任何真实密钥。**',
      '='.repeat(72),
      `  交易所账户    ${accounts.length} 个`,
      `  AI 模型       ${models.length} 个`,
      `  策略          ${strategiesCreated.length} 套`,
      `  机器人        ${traderIds.length} 个（${db.count('SELECT COUNT(*) AS n FROM traders')} 行）`,
      `  成交记录      ${totalTrades} 笔（共 ${db.count('SELECT COUNT(*) AS n FROM trades')} 行）`,
      `  订单记录      ${totalOrders} 条（共 ${db.count('SELECT COUNT(*) AS n FROM orders')} 行）`,
      `  决策记录      ${totalDecisions} 条（共 ${db.count('SELECT COUNT(*) AS n FROM decision_records')} 行）`,
      `  权益快照      ${db.count('SELECT COUNT(*) AS n FROM equity_snapshots')} 行`,
      `  运行时日志    ${db.count('SELECT COUNT(*) AS n FROM runtime_logs')} 行`,
      '',
      '  打开控制台查看：',
      '    /                  → 舰队合计、权益曲线、机器人快照表',
      '    /traders           → 长列表 + 分页 + 排序',
      '    /traders/<id>      → 持仓、订单、成交四张表 + 决策流',
      '    /data              → 日志面板（600+ 行）',
      '    /strategy          → 策略列表与预设',
      '',
      `  清理：npx tsx packages/server/src/scripts/seedDemoData.ts --clean`,
      '='.repeat(72),
      '',
    ].join('\n'),
  );

  closeDb();
}

/* -------------------------------------------------------------------------- */
/*  单个机器人的历史                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 给一个机器人生成：持仓、成交、订单、权益曲线、决策记录。
 *
 * ## 时间线的顺序是刻意的
 *
 * 先有开仓 → 有订单 → 持仓期间有权益快照 → 平仓后写成成交。四张表的时间戳
 * 因此是**互相自洽**的，而这一点很重要：机器人详情页会把它们并排显示
 * （当前持仓 / 当前委托 / 历史成交 / 订单记录），时间戳对不上的话
 * 看起来像"数据错了"，而那是示例数据自己制造的假象。
 */
function seedTraderHistory(
  traderId: number,
  rng: () => number,
  tradeCount: number,
  /**
   * 取该机器人所属**交易所账户**在某个时刻的权益。
   *
   * 传函数而不是传一个数：账户权益是一条**与时间相关**的序列，而
   * `equity_snapshots` 每个机器人每 6 小时写一行 —— 同一账户下的所有
   * 机器人必须在**同一时刻**读到**同一个值**（共享钱包的语义）。
   * 由调用方按账户建好这条序列（见 `main()` 里的 `accountCurves`）。
   */
  accountEquityAt: (day: number, hour: number) => number,
): { trades: number; orders: number; decisions: number } {
  let orders = 0;
  let decisions = 0;

  /* --- 权益曲线：每 6 小时一个点，90 天 ≈ 360 个点 -------------------- */

  const trader = traders.get(traderId);
  const initial = trader?.initialEquity ?? 1000;
  let equity = initial;

  for (let day = DAYS; day >= 0; day -= 1) {
    for (const hour of [0, 6, 12, 18]) {
      /*
       * 带漂移的随机游走。**刻意让它有真实的起伏** —— 一条笔直的上升线
       * 会让"曲线看起来对不对"这个问题无法回答，而图表正是总览页最大
       * 的那块内容。
       */
      const drift = 0.0006;
      const shock = (rng() - 0.5) * 0.02;
      equity *= 1 + drift + shock;
      const unrealized = between(rng, -equity * 0.04, equity * 0.05);
      equityStore.insert({
        traderId,
        timestamp: at(day, hour),
        equity: Number(equity.toFixed(4)),
        availableBalance: Number((equity * between(rng, 0.4, 0.85)).toFixed(4)),
        unrealizedPnl: Number(unrealized.toFixed(4)),
        marginUsed: Number((equity * between(rng, 0.05, 0.35)).toFixed(4)),
        openPositions: intBetween(rng, 0, 3),
        /*
         * 账户口径的两列 —— "归属权益"（一个机器人分到多少）与"账户权益"
         * （交易所账户里一共多少）之间的区别。
         *
         * ## ⚠️ 它必须是**账户级的一条独立序列**，不是"本机器人权益 × 倍数"
         *
         * 我改了两版才想清楚：第一版让每个机器人独立随机（`equity × 0.98~1.6`），
         * 第二版让它乘一个**账户级固定倍数** —— 两版都错，因为 `equity`
         * **每个机器人都不一样**（初始权益、漂移都不同），乘完还是各不相同的数。
         *
         * 实测抓到了：同一个账户在 `2026-07-14T16:00Z` 这一刻有 **6 个不同的
         * `account_equity`**（1224 / 12267 / 1239 / 1244 / 6176 / 12251）——
         * 而它是**共享钱包**，语义上同一账户同一时刻只能有一个值。
         *
         * 正确做法：账户权益是一条**按账户生成、按时间索引**的序列
         * （`accountEquityAt`，由调用方按账户传入），所有属于该账户的机器人
         * 在同一时刻读同一个数。
         */
        accountEquity: accountEquityAt(day, hour),
        accountUnrealizedPnl: Number((accountEquityAt(day, hour) * 0.018).toFixed(4)),
      });
    }
  }

  /* --- 成交回合 --------------------------------------------------------- */

  let booked = 0;
  for (let i = 0; i < tradeCount; i += 1) {
    const symbol = pick(rng, SYMBOLS);
    const base = PRICE[symbol] ?? 1;
    const side: 'long' | 'short' = rng() < 0.54 ? 'long' : 'short';
    const leverage = intBetween(rng, 2, 20);

    const entryPrice = base * between(rng, 0.9, 1.1);
    /*
     * 出场价：**让约 55% 的回合盈利**（真实交易系统的量级）。
     * 全赢或全输的分布会让胜率、盈亏比、最大回撤那几个指标看起来
     * 好得不真实，而那些指标正是"界面能不能表达清楚"的重点。
     */
    const win = rng() < 0.55;
    const movePct = win ? between(rng, 0.004, 0.06) : -between(rng, 0.003, 0.035);
    const exitPrice = entryPrice * (side === 'long' ? 1 + movePct : 1 - movePct);

    const notional = between(rng, 60, 900);
    const quantity = Number((notional / entryPrice).toPrecision(6));
    const grossPnl = Number(((side === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice) * quantity).toFixed(6));
    const fee = Number((notional * 0.0004 * 2).toFixed(6));

    const openedDaysAgo = DAYS - (i / tradeCount) * DAYS + between(rng, -1.5, 1.5);
    const holdHours = between(rng, 0.3, 40);
    const openedAt = spread(rng, Math.max(1, openedDaysAgo), Math.max(0, openedDaysAgo - 1));
    /*
     * ⚠️ `closedAt` **必须夹在"现在"之前**。
     *
     * 第一版是 `openedAt + holdHours`，而 `holdHours` 最大 40 小时 ——
     * 当 `openedAt` 落在最近 1.5 天内（`spread()` 用平方根让分布偏向"最近"，
     * 所以这很常见）时，平仓时刻会**落在未来**。后果是成交列表显示
     * "0 秒前"、区间统计不含它、而权益曲线（按时间切片）与它对不上。
     *
     * 一个"未来的平仓"在真实数据里不可能出现，而它是**开发时最容易被忽略
     * 的那类脏数据** —— 界面不报错，只是有些数字对不上。
     */
    const nowMs = Date.now();
    const rawCloseAt = new Date(openedAt).getTime() + holdHours * 3_600_000;
    /* 至少持仓 5 分钟（不能倒挂），最晚到"现在减 1 分钟"（给对账留余量）。 */
    const closedAtMs = Math.max(
      new Date(openedAt).getTime() + 5 * 60_000,
      Math.min(rawCloseAt, nowMs - 60_000),
    );
    const closedAt = new Date(closedAtMs).toISOString();

    /*
     * 开仓单 —— 每笔成交都对应两张单（开仓 + 平仓），这是订单记录那一栏
     * 长度的来源。空库下那一栏永远只有 0 条。
     */
    const entryOrderId = `seed-e-${traderId}-${i}`;
    const exitOrderId = `seed-x-${traderId}-${i}`;
    orderStore.insert({
      traderId,
      exchangeOrderId: entryOrderId,
      clientOrderId: entryOrderId,
      symbol,
      side: side === 'long' ? 'BUY' : 'SELL',
      type: 'MARKET',
      purpose: 'entry',
      quantity,
      price: entryPrice,
      // `stopPrice` 是**必填**的（可以是 null）—— 市价单没有触发价。
      stopPrice: null,
      status: 'FILLED',
      avgPrice: entryPrice,
      filledQty: quantity,
      fee: Number((fee / 2).toFixed(6)),
      marginUsed: Number((notional / leverage).toFixed(6)),
      marginType: 'cross',
    });
    orders += 1;

    const closeReason = pick(rng, CLOSE_REASONS);
    /*
     * ⚠️ `purpose` 的取值里**没有 `'close'`** —— 平仓单是 `'exit'`
     * （见 `OrderRecord['purpose']`：`stop_loss | take_profit | entry |
     * exit | adjustment`）。写错的话类型检查会拦下来，但值得记一笔：
     * "平仓"这个动作在订单表里叫 `exit`，而成交表里那个字段叫
     * `close_reason` —— 两套命名，读代码时容易混。
     */
    orderStore.insert({
      traderId,
      exchangeOrderId: exitOrderId,
      clientOrderId: exitOrderId,
      symbol,
      side: side === 'long' ? 'SELL' : 'BUY',
      type: 'MARKET',
      purpose: 'exit',
      quantity,
      price: exitPrice,
      stopPrice: null,
      status: 'FILLED',
      avgPrice: exitPrice,
      filledQty: quantity,
      fee: Number((fee / 2).toFixed(6)),
      marginUsed: 0,
      marginType: 'cross',
    });
    orders += 1;

    /*
     * 刻意混入几种**真实会出现的边界**：
     *   · 一笔零盈亏（`grossPnl ≈ 0`）—— 测试"0 是不是显示成 +0.00"；
     *   · 一笔极大的盈亏 —— 测试数字列宽是否会撑破；
     *   · 一笔极小的盈亏 —— 测试小数位是否被抹成 0。
     */
    let finalGross = grossPnl;
    if (i === 0) finalGross = 0;
    if (i === 1) finalGross = grossPnl * 12;
    if (i === 2) finalGross = 0.000001;

    tradeStore.insert({
      traderId,
      symbol,
      side,
      quantity,
      entryPrice,
      exitPrice,
      leverage,
      grossPnl: finalGross,
      entryFee: Number((fee / 2).toFixed(6)),
      exitFee: Number((fee / 2).toFixed(6)),
      closeReason,
      openedAt,
      closedAt,
      source: 'bot',
      entryOrderId,
      exitOrderId,
    });
    booked += 1;

    /* --- 决策记录：每 3 笔成交配一条决策 ----------------------------- */

    /*
     * ⚠️ `decisions.log()` 自己盖 `timestamp`（`now()`），所以这些决策
     * 会全部落在"现在"这一刻，而不是跟着成交的时间线走。
     *
     * 这是仓储层接口的限制（它为运行期设计：一条决策就是**刚刚**发生的
     * 事），对填充脚本来说是个真实的取舍：机器人详情页的"决策流"按
     * `cycle_number DESC` 排序，所以**内容是对的**，只是时间戳不散开。
     * 决策详情页里的"时间"那一格因此会显示同一时刻 —— 示例数据可以接受，
     * 而改仓储层去支持"写历史决策"要动一条被运行期依赖的路径，不值得。
     */
    if (i % 3 === 0) {
      decisionStore.log({
        traderId,
        cycleNumber: Math.floor(i / 3) + 1,
        systemPrompt: SYSTEM_PROMPT_SAMPLE,
        userPrompt: userPromptSample(symbol, entryPrice),
        cotTrace: COT_SAMPLE,
        /*
         * ⚠️ **字段要写全，尤其是 `leverage` / `stopLoss` / `takeProfit`。**
         *
         * 第一版只写了 `action` / `symbol` / `confidence` / `reasoning`，
         * 于是界面上的"关键数字"那一行渲染出了字面量 `undefinedx`
         * ——`${undefined}x` 的拼接结果。那看起来像界面坏了，实际是数据缺字段。
         *
         * 真实的模型输出**确实会漏字段**（`DecisionFeed` 里有一整段注释在讲
         * 这件事），所以两件事都要做：这里把示例数据写全（让它像正常的
         * 模型输出），而渲染层也要能容忍缺失（已修，见 `figureParts`）。
         */
        decisions: [
          {
            action: side === 'long' ? 'open_long' : 'open_short',
            symbol,
            confidence: Number(between(rng, 0.5, 0.92).toFixed(2)),
            reasoning: `${symbol} 在 1 小时级别站上 EMA20，4 小时结构未破，量能温和放大。以 ${leverage}x 杠杆建立 ${side === 'long' ? '多' : '空'}头，止损放在结构低点下方。`,
            positionSizeUsd: Number(notional.toFixed(2)),
            leverage,
            stopLoss: Number((side === 'long' ? entryPrice * 0.975 : entryPrice * 1.025).toPrecision(6)),
            takeProfit: Number((side === 'long' ? entryPrice * 1.08 : entryPrice * 0.92).toPrecision(6)),
            reducePercent: null,
            reduceQuantity: null,
            adjustments: [],
          },
        ],
        rawResponse: `<reasoning>\n${COT_SAMPLE}\n</reasoning>\n<decision>{"action":"open_long","symbol":"${symbol}"}</decision>`,
        /*
         * `ExecutionLogEntry` 的形状是
         * `{ action, symbol, status, detail, orderId?, notionalUsd?, adjustments? }`
         * —— **没有 `level` / `message`**（那两个是运行期日志的字段）。
         * `status` 是**语义**而不是日志级别：`ok` 会算作"开仓 N"，
         * `data` 是"模型主动要了数据"（纯读取，不算交易动作）。
         */
        executionLog: [
          {
            action: 'open_long',
            symbol,
            status: 'ok',
            detail: `已提交 ${symbol} 市价开仓单，数量 ${quantity}`,
            orderId: entryOrderId,
            notionalUsd: Number(notional.toFixed(2)),
          },
          {
            action: 'set_protection',
            symbol,
            status: 'ok',
            detail: '止损与止盈已挂出（STOP_MARKET / TAKE_PROFIT_MARKET）',
          },
        ],
        candidateSymbols: SYMBOLS.slice(0, intBetween(rng, 8, 20)),
        success: true,
        error: null,
        aiLatencyMs: intBetween(rng, 800, 9000),
        promptTokens: intBetween(rng, 3000, 12000),
        completionTokens: intBetween(rng, 200, 1400),
      });
      decisions += 1;
    }
  }

  /* --- 未平仓的持仓：让"当前持仓"那一栏非空 --------------------------- */

  /*
   * ⚠️ **一个机器人最多一个未平仓持仓（同标的）** —— 数据库上有
   * `idx_positions_open_symbol` 这个部分唯一索引，重复插入会抛错。
   * 所以这里用不同的标的。
   */
  const openCount = intBetween(rng, 0, 3);
  const usedSymbols = new Set<string>();
  for (let i = 0; i < openCount; i += 1) {
    let symbol = pick(rng, SYMBOLS);
    let guard = 0;
    while (usedSymbols.has(symbol) && guard < 20) {
      symbol = pick(rng, SYMBOLS);
      guard += 1;
    }
    if (usedSymbols.has(symbol)) continue;
    usedSymbols.add(symbol);

    const base = PRICE[symbol] ?? 1;
    const side = rng() < 0.6 ? 'long' : 'short';
    const entryPrice = base * between(rng, 0.95, 1.05);
    const leverage = intBetween(rng, 3, 20);
    const notional = between(rng, 100, 800);
    const quantity = Number((notional / entryPrice).toPrecision(6));

    positionStore.insert({
      traderId,
      symbol,
      side,
      quantity,
      entryPrice,
      leverage,
      liquidationPrice: side === 'long' ? entryPrice * (1 - 1 / leverage * 0.9) : entryPrice * (1 + 1 / leverage * 0.9),
      marginUsed: Number((notional / leverage).toFixed(6)),
      stopLoss: side === 'long' ? entryPrice * 0.975 : entryPrice * 1.025,
      takeProfit: side === 'long' ? entryPrice * 1.08 : entryPrice * 0.92,
      stopOrderId: `seed-sl-${traderId}-${i}`,
      tpOrderId: `seed-tp-${traderId}-${i}`,
      openReasoning: `${symbol} 的 ${side === 'long' ? '多头' : '空头'}结构成立，风险预算 ${between(rng, 0.5, 2).toFixed(2)}%，止损设在结构位外侧。`,
    });

    /*
     * 挂单（未成交的限价入场）—— 让"当前委托"那一栏也有内容。
     *
     * ⚠️ **必须配一条 `orders` 行。**
     *
     * 对账（`AutoTrader.settlePendingEntries`）拿 `positions.entry_order_id`
     * 去问交易所"成交了吗"。第一版只写了持仓行、没写订单行 —— 于是每轮
     * 对账都会用一个**平台上根本不存在的单号**去查交易所，日志里刷出
     * 一串"找不到这张单"。开发时看起来只是噪音，而它掩盖了真实的对账错误。
     */
    if (rng() < 0.4) {
      const pendingSymbol = pick(rng, SYMBOLS);
      if (!usedSymbols.has(pendingSymbol)) {
        usedSymbols.add(pendingSymbol);
        const pendingSide = rng() < 0.5 ? 'long' : 'short';
        const pendingPrice = (PRICE[pendingSymbol] ?? 1) * between(rng, 0.97, 1.03);
        const pendingQty = Number((between(rng, 50, 300) / (PRICE[pendingSymbol] ?? 1)).toPrecision(6));
        const pendingOrderId = `seed-pending-${traderId}-${i}`;

        positionStore.insert({
          traderId,
          symbol: pendingSymbol,
          side: pendingSide,
          quantity: pendingQty,
          entryPrice: pendingPrice,
          leverage: intBetween(rng, 3, 10),
          liquidationPrice: null,
          marginUsed: 0,
          stopLoss: null,
          takeProfit: null,
          stopOrderId: null,
          tpOrderId: null,
          openReasoning: '等待价格回到限价位置再入场（示例挂单）。',
          status: 'pending',
          entryOrderId: pendingOrderId,
          waitMinutes: intBetween(rng, 15, 120),
        });

        /* 对应的挂单 —— 状态 `NEW`（已挂出、未成交），与 `positions` 那一行一致。 */
        orderStore.insert({
          traderId,
          exchangeOrderId: pendingOrderId,
          clientOrderId: pendingOrderId,
          symbol: pendingSymbol,
          side: pendingSide === 'long' ? 'BUY' : 'SELL',
          type: 'LIMIT',
          purpose: 'entry',
          quantity: pendingQty,
          price: pendingPrice,
          stopPrice: null,
          status: 'NEW',
          filledQty: 0,
          fee: 0,
          marginUsed: 0,
          marginType: 'cross',
        });
        orders += 1;
      }
    }
  }

  return { trades: booked, orders, decisions };
}

/* -------------------------------------------------------------------------- */
/*  日志                                                                       */
/* -------------------------------------------------------------------------- */

const LOG_SCOPES = ['trader', 'binance', 'api', 'risk', 'market', 'store'] as const;

/**
 * 日志正文样本。
 *
 * **刻意混入长消息** —— 日志面板是一行一条，而一条 200 字的中文说明会把
 * 那一行的布局撑开（或者被截断而读不到）。空库下这个问题不存在。
 */
const LOG_MESSAGES: Array<{ level: 'info' | 'warn' | 'error'; text: string }> = [
  { level: 'info', text: '已连接币安合约 Demo 模拟盘（时钟偏移 1310ms）' },
  { level: 'info', text: '已加载 528 个可交易的 USDT 本位永续合约；请求权重上限 6000/分钟' },
  { level: 'info', text: '启动对账完成：0 个机器人，账目无需修正' },
  { level: 'warn', text: '检测到时钟偏移 1310ms —— 本次请求已按校正后的时间戳签名' },
  { level: 'info', text: 'BTCUSDT 的限价挂单已等满 43 分钟（上限 15）仍未成交，已自动撤掉并释放该入场名额' },
  { level: 'error', text: '调用模型失败：HTTP 429 rate limit exceeded（第 3 次重试，将在 60 秒后再试）' },
  { level: 'info', text: '模型请求了 get_market_snapshot（12 个标的），已返回' },
  { level: 'warn', text: '风控引擎把杠杆从 20x 压到上限 5x —— 模型给出的参数越界，已改写并记录' },
  { level: 'info', text: 'ETHUSDT 多头已开仓：数量 0.482、杠杆 5x、止损 2480.5、止盈 2740.0' },
  { level: 'info', text: 'SOLUSDT 触发移动止损离场，净盈亏 +1.2384 USDT（毛 +1.31 − 手续费 0.0716）' },
  { level: 'error', text: '下单被交易所拒绝：-2019 Margin is insufficient（可用 12.4，需要 25.8）' },
  { level: 'info', text: '本轮决策完成：1 个开仓、0 个平仓、2 个继续持有，耗时 3.4 秒' },
  { level: 'warn', text: '本分钟已消耗请求权重 4820/6000（80%）—— 接近警戒线，剩余请求会被交易所限流' },
  { level: 'info', text: '这是一条刻意写得很长的日志消息，用来测试日志面板在遇到长文本时的表现：它应当在容器宽度内换行或者被省略号截断，而不是把整个面板撑宽、或者把右侧的级别标签挤出可视区域之外' },
  { level: 'info', text: '资金费率结算：BTCUSDT 空头收取 +0.0342 USDT' },
  { level: 'warn', text: '连续 2 轮决策失败，机器人将在 3 次失败后进入安全模式（只平仓不开仓）' },
  { level: 'info', text: '数据库迁移完成 v15（pending-wait-minutes）' },
  { level: 'info', text: '对账窗口往前留 7 天：收养的仓位开在机器人创建前，窗口在持仓中间截断会导致开/平判反' },
];

function seedLogs(rng: () => number, count: number): void {
  /*
   * ⚠️ `runtimeLogs.write()` 自己盖时间戳（用 `now()`），所以**写不出
   * 历史日志** —— 这是它作为"实时日志环形缓冲"的设计（`RUNTIME_LOG_CAP`
   * 只有 500 行，写入即裁剪）。示例数据要的是"有历史的日志面板"，所以
   * 这里直接走 SQL 插 `created_at`。
   *
   * 这也是唯一一处绕开仓储层的写入 —— 值得写清楚为什么：仓储层的接口
   * 是为运行期服务的，而填充脚本要的是"造出一段看起来像历史的状态"，
   * 两者的需求不同。代价是这一处要自己维护列名，所以它只碰
   * `runtime_logs` 这一张表（结构最稳定的一张）。
   */
  const db = getDb();
  for (let i = 0; i < count; i += 1) {
    const sample = pick(rng, LOG_MESSAGES);
    db.run(
      'INSERT INTO runtime_logs (trader_id, level, scope, message, created_at) VALUES (?, ?, ?, ?, ?)',
      null,
      sample.level,
      pick(rng, LOG_SCOPES),
      sample.text,
      spread(rng, 14),
    );
  }
  // 插完之后裁一次，与运行期的行为一致（表不会无限长）。
  runtimeLogs.trim();
}

/* -------------------------------------------------------------------------- */
/*  提示词样本                                                                 */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT_SAMPLE = `你是一个加密货币合约交易助手。每个周期你会收到一份市场快照，需要据此做出开仓、平仓或继续持有的决策。

## 你的职责

判断方向，并给出一个带止损的、风险可控的仓位。**不要**试图预测短期价格 —— 你要做的是在有把握的时候下注，没把握的时候什么都不做。

## 风控边界（由服务端强制，你给的越界参数会被改写并记录）

- 单笔风险不得超过账户权益的 2%
- 杠杆不得超过 20x（主流币）/ 10x（山寨币）
- 同时持仓不得超过 3 个

## 输出格式

先用 <reasoning> 写出你的分析，再用 <decision> 给出一个 JSON 数组。`;

function userPromptSample(symbol: string, price: number): string {
  return `## 市场快照

### ${symbol}
- 最新价：${price.toFixed(4)}
- 1h EMA20：${(price * 0.994).toFixed(4)}　EMA50：${(price * 0.981).toFixed(4)}
- 4h 结构：上行通道，未破前低
- 24h 成交额：1.24B USDT
- 资金费率：+0.0100%（多头付费）

### 账户状态
- 权益：1248.32 USDT
- 可用：892.14 USDT
- 当前持仓：1 个（ETHUSDT 多头，浮盈 +0.86%）

### 本轮任务
分析上述标的是否值得开仓。如果值得，给出方向、杠杆、止损与止盈。`;
}

const COT_SAMPLE = `第一步 —— 高周期结构。1 小时序列仍站在 EMA20 上方，4 小时结构也保持完好，因此主导趋势依然是上行。

第二步 —— 位置。当前价距离最近的摆动高点还有约 2.1% 的空间，而下方结构低点在 -3.4% 处。这个位置开多的盈亏比约为 0.6:1，偏低。

第三步 —— 量能与资金费。成交额温和放大，资金费率为正但不高，说明多头情绪不极端。

第四步 —— 结论。盈亏比不够好，但趋势明确，可以用较小的仓位与更紧的止损来换取参与度。把止损放在结构低点下方，杠杆压到 5x，单笔风险控制在权益的 1.2%。`;

/* -------------------------------------------------------------------------- */
/*  清理                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 删掉全部示例数据。
 *
 * 按**前缀**识别（`[示例]`），而不是按 id 范围或时间 —— 后者会误删用户
 * 自己建的东西（他在示例数据之后创建的机器人 id 更大）。前缀是唯一
 * 可靠的判据。
 *
 * ## ⚠️ 删除顺序是**有讲究的**（第一版在这里踩过）
 *
 * 第一版按"叶子到根"写了一串表名，而 `agent_memory.trade_id` 那一列是
 * **`NOT NULL UNIQUE REFERENCES trades(id)` 且没有 `ON DELETE CASCADE`**
 * （见 `db/schema.ts`）—— 于是：
 *
 * ```text
 * 删 trades → agent_memory 有行引用它 → SQLite 拒绝（FOREIGN KEY constraint failed）
 *          → 整个 clean() 中途抛错退出
 *          → 仓位/订单已删、机器人还在，而**再次运行也清不掉**（同样会撞）
 * ```
 *
 * 所以真正要遵守的是**外键依赖顺序**，不是"看起来像叶子"的顺序：
 * 先把指出去的表清空（`agent_memory` 指向 `trades`），再删被指向的。
 * `getDb().run()` 逐条执行，中途任何一条失败都会留下半清状态 ——
 * 而清理脚本最怕的就是这个。
 *
 * ## 幂等
 *
 * 每一步都按"当前还在的示例行"来删，所以重复运行安全（第二次删 0 行）。
 */
function clean(): void {
  const db = getDb();
  const pattern = `${TAG}%`;

  const traderRows = db.all<{ id: number }>('SELECT id FROM traders WHERE name LIKE ?', pattern);
  const traderIds = traderRows.map((r) => r.id);

  if (traderIds.length > 0) {
    const placeholders = traderIds.map(() => '?').join(',');
    /*
     * 顺序 = 外键依赖顺序（先清指向别人的，再清被别人指向的）。
     *
     * `agent_memory` 必须在 `trades` 之前 —— 它的 `trade_id` 是
     * `REFERENCES trades(id)` 且无 CASCADE。其余表都是 `trader_id ...
     * ON DELETE CASCADE`，顺序无所谓，但保持"叶子在前"读起来清楚。
     */
    for (const table of [
      'agent_memory', // → trades(id)、traders(id)，无 CASCADE
      'agent_runs', // → traders(id)
      'agent_experiments', // → traders(id)
      'trade_events',
      'equity_snapshots',
      'decision_records',
      'orders',
      'positions',
      'trades', // 最后删：它被 agent_memory 指着
    ]) {
      db.run(`DELETE FROM ${table} WHERE trader_id IN (${placeholders})`, ...traderIds);
    }
    db.run(`DELETE FROM traders WHERE id IN (${placeholders})`, ...traderIds);
    log.info(`已删除 ${traderIds.length} 个示例机器人及其全部关联数据。`);
  }

  const modelRows = db.all<{ id: number }>('SELECT id FROM ai_models WHERE label LIKE ?', pattern);
  for (const row of modelRows) db.run('DELETE FROM ai_models WHERE id = ?', row.id);

  const accountRows = db.all<{ id: number }>('SELECT id FROM exchange_accounts WHERE label LIKE ?', pattern);
  for (const row of accountRows) db.run('DELETE FROM exchange_accounts WHERE id = ?', row.id);

  const strategyRows = db.all<{ id: number }>('SELECT id FROM strategies WHERE name LIKE ?', pattern);
  for (const row of strategyRows) db.run('DELETE FROM strategies WHERE id = ?', row.id);

  /*
   * 日志 —— **只删我们写的那些**。
   *
   * ⚠️ 第一版的条件是
   * `WHERE scope IN (…) AND id NOT IN (SELECT id FROM runtime_logs WHERE message LIKE '[示例]%')`
   * ——`runtime_logs` 表里**没有 `[示例]` 前缀**（`seedLogs` 写的是
   * 真实的日志文案样本，因为那一列要看起来像真日志）。于是两个条件里
   * 后一个恒成立（NOT IN 空集），整个条件退化成"删掉所有属于那六个 scope
   * 的日志"——**包括用户自己跑出来的**。
   *
   * 现在按**范围**删：示例数据的时间跨度是 90 天，而运行期日志由
   * `runtimeLogs.write()` 实时写入。这两者无法从内容上区分，所以改成
   * "删掉示例脚本可能写过的那些 scope" 并**明确告知用户**这一步会清空日志
   * —— 对一个开发用的填充脚本来说，"清空日志"是合理且可预期的行为，
   * 而"悄悄删掉你排查问题用的日志"不是。
   */
  const logCount = db.count(
    "SELECT COUNT(*) AS n FROM runtime_logs WHERE scope IN ('trader','binance','api','risk','market','store')",
  );
  if (logCount > 0) {
    db.run(
      "DELETE FROM runtime_logs WHERE scope IN ('trader','binance','api','risk','market','store')",
    );
    log.info(`已清空 ${logCount} 行运行时日志（示例数据与运行日志无法从内容区分）。`);
  }

  if (modelRows.length + accountRows.length + strategyRows.length > 0) {
    log.info(
      `已删除示例模型 ${modelRows.length} 个、账户 ${accountRows.length} 个、策略 ${strategyRows.length} 套。`,
    );
  }
}

main().catch((error) => {
  log.error(`填充失败：${(error as Error).message}`);
  console.error(error);
  process.exitCode = 1;
});
