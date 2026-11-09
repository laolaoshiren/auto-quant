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
 * | `seedDemoData.impl.ts`（本文件） | **演示库**（默认 `.dsh/demo-data`） | **规模化**的确定性数据，控制台能直接看 |
 *
 * 三者互补：`demoCycle` 证明"流水线是通的"，`simulate` 验证"交易逻辑是对的"，
 * 而本文件负责**版面与性能**这一层 —— 它是唯一能回答"列表长到 40 行时
 * 长什么样"的工具。
 *
 * ## 它覆盖哪些"实盘数据形态"（这张表就是本脚本的验收清单）
 *
 * | 形态 | 怎么覆盖 |
 * | --- | --- |
 * | 四种运行模式 | `strategy` / `ai_managed` / `ai_team` / `jev` 各有机器人 |
 * | 模拟盘 / 实盘 / 无账户 | `dryRun` 三态（`true` / `false` / 未指定）+ `exchangeAccountId` 为空 |
 * | 持仓 / 挂单 / 保护单 | 未平仓持仓 + 限价待成交 + `STOP_MARKET` / `TAKE_PROFIT_MARKET` 条件单 |
 * | 成交与账目 | 多空、杠杆 2–20x、盈亏/手续费/资金费、`intel_keys` 归因、`reconciled` 补录 |
 * | 订单边界 | `FILLED` / `NEW` / `REJECTED` / `CANCELED` / `PARTIALLY_FILLED` / `EXPIRED` |
 * | 决策审计 | 思维链、执行日志、风控 `adjustments`、失败周期、被拒提案、零决策、团队 `<team>` 块 |
 * | 团队模式 | `agent_runs` / `agent_experiments` / `agent_memory` + `scope='team'` 步骤流 |
 * | intel 归因 | 同一信号键积累 ≥ `MIN_SAMPLES`(20) 笔成交 —— `signalHealth` 才有样本可判 |
 * | 告警/异常态 | 模型离线（`llm_health`）、账目差额（`ledger_check`）、外部活动、`safe_mode` |
 * | UI 边界 | 超长名字、超长文本、单机器人 > 200 行分页、空状态机器人、0 行与大量行 |
 *
 * ## 用法（入口在 `seedDemoData.ts`，它负责选演示库）
 *
 * ```bash
 * npm run seed:demo                 # 默认写 .dsh/demo-data
 * npm run seed:demo:clean           # 只清理
 * npm run seed:demo -- --scale 3    # 三倍（压力）
 * npm run seed:demo -- --keep       # 保留现有数据，什么都不做
 * npm run seed:demo -- --data-dir .dsh/demo-data-b
 * ```
 *
 * ## 三条设计约束
 *
 * 1. **确定性。** 用固定种子的伪随机（`mulberry32`），不用 `Math.random()`。
 *    否则每次跑出来的界面都不一样，而"这个数字看起来对不对"是一个
 *    开发时真正会问的问题 —— 它需要一个可复现的基准。
 *    （时间戳按"现在"相对生成，所以两次运行的具体时刻会变，但**结构、条数、
 *    数值关系**一致 —— 这是确定性在这里的准确含义。）
 * 2. **可识别、可清理。** 所有实体的名字带 `[示例]` 前缀，`--clean` 按前缀
 *    删除。与 `demoCycle.ts` 的 `[DEMO]` 是同一套思路（那个前缀更短，
 *    因为它要出现在截图里）。
 * 3. **不碰交易所。** 全程不发起任何网络请求，不写任何真实密钥；
 *    **只写演示库**（`DATA_DIR` 由入口文件锁定，见其文件头）。
 *
 * ## 模型为什么以本机 magpie 网关为主
 *
 * 用户 2026-11-10 要求：项目里的 LLM 调用一律走本机 magpie 网关的
 * `workbuddy/deepseek-v4.1-flash`，不要用 DeepSeek 官方端点。
 * 所以示例模型清单把那条设成**默认模型**，其它厂商只作为"多模型形态"保留。
 * 本脚本**不会真的调用任何模型** —— 模型行只是数据（凭据是空的/加密的假串）。
 */
import {
  defaultAiTeamConfig,
  defaultJevConfig,
  defaultStrategyConfig,
  isAiDriven,
  STRATEGY_PRESETS,
  unboundedAiManagedConfig,
  type AgentRunKind,
  type AgentRunOutcome,
  type AiModelConfig,
  type Decision,
  type StrategyConfig,
  type TraderMode,
  type WakeTrigger,
} from '@aq/shared';
import { closeDb, getDb, initDb } from '../db/index.js';
import { dbPath, ensureDataDir, resolveMasterKey } from '../env.js';
import { Vault } from '../crypto/vault.js';
import { createLogger } from '../logger.js';
import {
  aiModels,
  equity as equityStore,
  exchanges,
  orders as orderStore,
  positions as positionStore,
  runtimeLogs,
  settings,
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
/*  模型网关（用户 2026-11-10 的硬要求）                                        */
/* -------------------------------------------------------------------------- */

/**
 * 本机 magpie 网关 —— **示例数据里的默认模型必须是它**。
 *
 * 用户原话（2026-11-10）：项目里的 LLM 调用一律走本机 magpie 网关的
 * `workbuddy/deepseek-v4.1-flash`，不要用 DeepSeek 官方端点。
 *
 * ⚠️ 模型 id 里的分隔符是**斜杠**（`workbuddy/deepseek-v4.1-flash`），
 * 不是连字符 —— 这个字面量必须与 `useMagpieModel.ts` 以及网关实际暴露的
 * `/v1/models` 完全一致，否则请求会 404。
 *
 * ⚠️ 本脚本**不发起任何网络请求**：这里只是把"要用哪个模型"写成一行数据，
 * 让控制台的"新建机器人"默认选中它。真实调用发生在用户点"启动"之后。
 */
const MAGPIE_BASE_URL = 'http://127.0.0.1:3425/v1';
const MAGPIE_MODEL = 'workbuddy/deepseek-v4.1-flash';

/* -------------------------------------------------------------------------- */
/*  情报归因键                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 示例的 intel 信号键（格式 `<来源域名>|<方向>|<标的们>`，见
 * `trader/intel/attribution.ts` 的 `signalKeyOf()`）。
 *
 * ## 为什么需要"同一个键出现很多次"
 *
 * `signalHealth.assessSignal()` 的样本门槛是 **20 笔**（`MIN_SAMPLES`）。
 * 一个每次都不重复的键永远凑不满样本，于是失效检测对它**永远返回
 * `insufficient_data`** —— 代码在跑、界面正常，但功能从未生效。
 * 所以示例数据刻意让同一个信号键落在多笔成交上（见 `historyOpts.intelProfile`）。
 */
const INTEL_KEYS = {
  btcBull: 'coindesk.com|bullish|BTCUSDT',
  ethBear: 'theblock.com|bearish|ETHUSDT',
  solBull: 'cryptoslate.com|bullish|SOLUSDT',
  marketNeutral: 'cointelegraph.com|neutral|BTCUSDT,ETHUSDT',
} as const;

/* -------------------------------------------------------------------------- */
/*  团队模式（`ai_team`）的角色输出样本                                          */
/* -------------------------------------------------------------------------- */

/**
 * `runtime_logs` 里团队步骤的**唯一合法形状**：`[phase] role：note`。
 *
 * 解析正则见 `api/server.ts` 的 `parseTeamStepLine()`：
 * `/^\[([a-z_]+)\] ([a-z][a-z_]*)[：:]([\s\S]*)$/`
 *
 * ⚠️ 角色名只允许 `[a-z_]`、阶段名同理 —— 中文字符写在角色位会让整行
 * 解析不出来，而"解析不出来"在界面上表现为**"这个岗位从未运行过"**，
 * 不是报错。这是这个仓库花过代价的一类假事实（t111）。
 */
const TEAM_STEPS: Array<{ phase: string; role: string; note: string }> = [
  { phase: 'dispatch', role: 'supervisor', note: '按币并行：18 个标的，并发 4' },
  { phase: 'dispatch', role: 'supervisor', note: '按币并行完成：成功 16 · 失败 2 · 并发峰值 4' },
  { phase: 'dispatch', role: 'supervisor', note: '不派 newscaster：上一轮快讯为空，重复调用只会烧预算' },
  { phase: 'analysis', role: 'market_analyst', note: '全市场 24h 成交额排名前 8 的合约里，有 5 个处在 EMA20 上方；资金费率整体偏正，没有极端拥挤。' },
  { phase: 'analysis', role: 'technical', note: 'BTCUSDT 1h MACD 柱连续 3 根缩短，RSI 58；4h 仍未破前低。只描述形态，不给建议。' },
  { phase: 'analysis', role: 'newscaster', note: '整理 6 条快讯：ETF 净流入 2 条、交易所上币 1 条、监管 1 条、宏观 2 条。' },
  { phase: 'analysis', role: 'sentiment', note: '情绪分 0.62（样本 1840 条，够用）；显著偏多头，但讨论量没有同步放大。' },
  { phase: 'analysis', role: 'symbol_scout', note: 'ETHUSDT：4h 结构完整，关键位 2480 / 2620；失效条件 = 收盘跌破 2440。' },
  { phase: 'debate', role: 'bull', note: '多头论证：趋势 + 资金费温和 + 上方套牢盘稀疏。失效条件：收盘跌破 2440。' },
  { phase: 'debate', role: 'bear', note: '空头论证：量能跟不上、情绪与价格背离。失效条件：放量突破 2620。' },
  { phase: 'verdict', role: 'judge', note: '结论：ETHUSDT 做多，置信度 0.71；理由是多头论证的失效条件比空头更近且可证伪。' },
  { phase: 'risk', role: 'risk_officer', note: '方案通过，但杠杆从 20x 压到 10x、仓位从 1200 压到 800 USDT。' },
  { phase: 'report', role: 'reporter', note: '本轮汇报：团队一致偏多，最终只开 1 个仓位；风控官压低了杠杆与名义。' },
];

/**
 * 决策记录里的团队审计块（`<team>`）—— 回放态看板读的就是它。
 *
 * 格式必须是 `- <role>（<model>）：<一句话>`：
 * 前端 `teamTrace.ts` 与后端 `parseCotTraceRoles()` 都用
 * `/^- ([a-z_]+)（[^）]*）：/` 锚定这个形状。写成别的样子（比如 markdown 的
 * `- **实体**：…`）会被当成"角色行"，看板上就会冒出十几个假岗位 ——
 * 这个仓库为一个真实事故记录过这件事。
 */
function teamCotTrace(modelHint = 'magpie/workbuddy'): string {
  return [
    '第一步 —— 高周期结构：1h 序列站在 EMA20 上方，4h 未破前低；趋势仍偏多。',
    '第二步 —— 位置与赔率：距上方摆动高点约 2.1%，下方结构低点 −3.4%；盈亏比约 0.6:1。',
    '第三步 —— 消息面：ETF 净流入偏正，资金费率 +0.01%，没有极端拥挤。',
    '',
    '<team>',
    `- market_analyst（${modelHint}）：全市场成交额前 8 里有 5 个在 EMA20 上方，整体偏多但不极端。`,
    `- technical（${modelHint}）：BTCUSDT 1h MACD 柱连续缩短；ETHUSDT 4h 结构未破。`,
    `- newscaster（${modelHint}）：6 条快讯里 2 条 ETF 净流入、1 条上币、1 条监管、2 条宏观。`,
    `- sentiment（${modelHint}）：情绪分 0.62（样本 1840 条，够用），偏多但讨论量未同步放大。`,
    `- bull（${modelHint}）：趋势 + 资金费温和 + 上方套牢盘稀疏；失效条件 = 收盘跌破 2440。`,
    `- bear（${modelHint}）：量能跟不上、情绪与价格背离；失效条件 = 放量突破 2620。`,
    `- judge（${modelHint}）：结论 ETHUSDT 做多、置信度 0.71；多头论证的失效条件更近且可证伪。`,
    `- risk_officer（${modelHint}）：通过，但杠杆 20x → 10x、仓位 1200 → 800。`,
    '</team>',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/*  机器人形态清单                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 一个机器人的"剧本" —— 它决定这个机器人是哪种形态、灌多少历史。
 *
 * ⚠️ 这些形态是**刻意挑的**，不是随机分布：随机分布会让"应该覆盖的那种形态"
 * 偶尔缺席，而演示数据的价值恰恰在于"每种形态都能看到"。
 *
 * ## 为什么默认状态一律 `stopped`（Lead 2026-11-10 走查要求）
 *
 * 服务启动时 `manager.resumePersisted()` 会**自动恢复** `running` / `safe_mode`
 * 的机器人。演示数据如果写 `running`，演示实例一重启就会真的把十几个机器人拉起来
 * （调模型、跑周期、写库）—— 用户只是打开控制台看版面，却得到一个"自己在动的"实例。
 * 更糟的是只要有一个模型/凭据没配好，启动失败会刷一串错误，看起来像系统坏了。
 *
 * 所以默认全部停止；`error` 保留一台用于展示错误状态（`error` **不在**自动恢复列表里）。
 * 想看 running / safe_mode：在控制台手动点启动，或让它连续失败几次进入安全模式。
 */
interface TraderSpec {
  /** 名字主体（最终会加 `[示例] ` 前缀）。 */
  name: string;
  mode: TraderMode;
  /** 绑定的交易所账户下标；`null` = 纯模拟盘（不需要真实账户，M19）。 */
  accountIndex: number | null;
  /**
   * 落库的模拟/实盘选择；`null` = 从未指定（回落到进程级 `env.dryRun`）。
   *
   * 它决定的是"万一被启动，走哪条路径"，与 `status` 无关 —— 所以即使默认
   * 全部 stopped，三种取值仍然都要有（界面顶部会如实显示"模拟/实盘/未指定"）。
   */
  dryRun: boolean | null;
  status: 'running' | 'stopped' | 'starting' | 'error' | 'safe_mode';
  /** 初始权益（同时是收益率的分母）。 */
  initialEquity: number;
  cycleIntervalMinutes: number;
  /** 生成多少笔已平仓成交。0 = 空状态机器人（一个从没跑过的形态）。 */
  tradeCount: number;
  /** 历史里要不要带团队/审计数据。 */
  aiProfile: 'none' | 'managed' | 'team';
  /** 情报归因画像：`signal-sample` 会给同一个信号键堆够 20 笔样本。 */
  intelProfile: 'mixed' | 'signal-sample';
  /** 错误态要显示的原因。 */
  lastError?: string;
}

const TRADER_SPECS: TraderSpec[] = [
  {
    name: '稳健 · BTC 趋势',
    mode: 'strategy',
    accountIndex: 0,
    /*
     * 三种 `dryRun` 取值都要有（界面上"模拟盘 / 实盘 / 未指定"三种文案与颜色）：
     *
     *  · `true`  —— 操作员显式选了模拟盘（重启后按它恢复，不会变实盘）；
     *  · `false` —— 操作员显式选了实盘（本剧本里只用**已停止**的机器人演示它）；
     *  · `null`  —— 从未指定（回落到进程级 `env.dryRun`）。
     *
     * 演示数据不写 `running`，所以这些取值当前都只是"落库的选择"，
     * 不会让演示实例真的去下单。
     */
    dryRun: true,
    status: 'stopped',
    initialEquity: 5000,
    cycleIntervalMinutes: 15,
    tradeCount: 62,
    aiProfile: 'none',
    intelProfile: 'mixed',
  },
  {
    name: '激进 · 山寨轮动',
    mode: 'strategy',
    accountIndex: 0,
    dryRun: true,
    status: 'stopped',
    initialEquity: 2500,
    cycleIntervalMinutes: 5,
    tradeCount: 88,
    aiProfile: 'none',
    intelProfile: 'mixed',
  },
  {
    name: '套利 · 资金费',
    mode: 'strategy',
    accountIndex: 1,
    dryRun: true,
    status: 'stopped',
    initialEquity: 10000,
    cycleIntervalMinutes: 30,
    tradeCount: 54,
    aiProfile: 'none',
    intelProfile: 'mixed',
  },
  {
    name: '网格 · ETH 区间',
    mode: 'strategy',
    accountIndex: 1,
    dryRun: true,
    status: 'stopped',
    initialEquity: 1000,
    cycleIntervalMinutes: 15,
    tradeCount: 36,
    aiProfile: 'none',
    intelProfile: 'mixed',
  },
  {
    /*
     * 纯模拟盘 + AI 托管：`exchangeAccountId = null` 是 M19 之后**合法**的形态
     * （模拟盘不需要真实凭据）。`dryRun: true` 也必须落库 —— 否则服务重启后
     * 会按进程级 `env.dryRun` 恢复，可能变成实盘（2026-10-13 的真实事故）。
     */
    name: 'AI 托管 · 自适应（纯模拟盘）',
    mode: 'ai_managed',
    accountIndex: null,
    dryRun: true,
    status: 'stopped',
    initialEquity: 2000,
    cycleIntervalMinutes: 10,
    tradeCount: 72,
    aiProfile: 'managed',
    intelProfile: 'mixed',
  },
  {
    name: 'AI 团队 · 多角色交易台',
    mode: 'ai_team',
    accountIndex: null,
    dryRun: true,
    status: 'stopped',
    initialEquity: 5000,
    cycleIntervalMinutes: 15,
    tradeCount: 96,
    aiProfile: 'team',
    intelProfile: 'mixed',
  },
  {
    name: 'AI 团队 · 深池（绑定账户）',
    mode: 'ai_team',
    accountIndex: 1,
    dryRun: true,
    status: 'stopped',
    initialEquity: 3000,
    cycleIntervalMinutes: 20,
    tradeCount: 44,
    aiProfile: 'team',
    intelProfile: 'mixed',
    lastError: '连续 3 次调用模型失败：HTTP 429 rate limit exceeded（示例数据）',
  },
  {
    name: 'JEV · 实验模式',
    mode: 'jev',
    accountIndex: 2,
    dryRun: true,
    status: 'stopped',
    initialEquity: 1500,
    cycleIntervalMinutes: 15,
    tradeCount: 38,
    aiProfile: 'none',
    intelProfile: 'mixed',
  },
  {
    /*
     * **超长名字** —— 列表页的截断、详情页标题换行、命令行面板搜索结果
     * 都要在这个形态下看一眼。它是空数据永远发现不了的那类版面问题。
     */
    name: '长名字压力测试 · 这是一个刻意写得非常非常长的机器人名字用来验证列表截断、详情页标题换行以及命令面板搜索结果的显示行为',
    mode: 'strategy',
    accountIndex: 2,
    dryRun: true,
    status: 'stopped',
    initialEquity: 800,
    cycleIntervalMinutes: 60,
    tradeCount: 24,
    aiProfile: 'none',
    intelProfile: 'mixed',
  },
  {
    /*
     * **空状态**：一个刚创建、从未跑过的机器人。0 成交 / 0 订单 / 0 决策 /
     * 0 权益快照。空库能看到它，但"同一个页面上别人有数据、它没有"才是
     * 真实会遇到的空状态。
     */
    name: '刚创建 · 还没跑过（空状态）',
    mode: 'strategy',
    accountIndex: 0,
    dryRun: true,
    status: 'stopped',
    initialEquity: 1000,
    cycleIntervalMinutes: 15,
    tradeCount: 0,
    aiProfile: 'none',
    intelProfile: 'mixed',
  },
  {
    /*
     * **分页压力**：单机器人 260 笔成交 / 520 张订单 / 60+ 条决策，
     * 超过成交与订单接口的单页上限（200）。只做 20 条的话，
     * "翻页后游标还对不对"这个问题一次都碰不到。
     */
    name: '分页压力 · 交易频繁',
    mode: 'strategy',
    accountIndex: 1,
    dryRun: true,
    status: 'stopped',
    initialEquity: 4000,
    cycleIntervalMinutes: 5,
    tradeCount: 260,
    aiProfile: 'none',
    intelProfile: 'signal-sample',
  },
  {
    name: '错误态 · 模型连续失败',
    mode: 'strategy',
    accountIndex: 0,
    dryRun: true,
    status: 'error',
    initialEquity: 1200,
    cycleIntervalMinutes: 15,
    tradeCount: 18,
    aiProfile: 'none',
    intelProfile: 'mixed',
    lastError:
      '连续 5 次调用模型失败：HTTP 502 Bad Gateway（网关返回了非 JSON 的 HTML 错误页）。机器人已停止，等待人工检查模型配置。这是一段刻意写得很长的错误信息，用来验证详情页与列表页对长错误文本的换行与截断。',
  },
  {
    name: '观察 · 只读账户',
    mode: 'strategy',
    accountIndex: 2,
    dryRun: null,
    status: 'stopped',
    initialEquity: 500,
    cycleIntervalMinutes: 60,
    tradeCount: 12,
    aiProfile: 'none',
    intelProfile: 'mixed',
  },
  {
    name: '压力测试 · 极端参数',
    mode: 'strategy',
    accountIndex: 0,
    dryRun: false,
    status: 'stopped',
    initialEquity: 20000,
    cycleIntervalMinutes: 5,
    tradeCount: 120,
    aiProfile: 'none',
    intelProfile: 'mixed',
  },
];

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
   * 四个账户。
   *
   * 多账户是刻意的：账户页的卡片列表、机器人的"归属钱包"那一列、
   * 以及"同一个账户下多个机器人共享保证金"这条逻辑，都要有**不止一个**
   * 账户才看得见。
   *
   * 刻意覆盖的形态：实盘可交易 / 模拟盘 / **只读（canTrade=false）** /
   * 一个标签很长的账户（列表行的中文长文本换行）。
   *
   * ⚠️ **凭据全是假的**：`apiKey` 是随机串、secret 是加密后的占位符，
   * 而且本脚本不发任何网络请求。它们只用于让"凭据已配置"这个界面状态有数据 ——
   * 真的拿它去连交易所会失败，那正是期望行为。
   *
   * ⚠️ **同一个账户的 `account_equity` 必须是同一个数**（见下面
   * `seedTraderHistory` 的参数传递）—— 它在语义上是"共享钱包里一共多少"，
   * 同账户下所有机器人读的是同一份。第一版按机器人独立随机，于是账户
   * 权益曲线在同一个时间点有 N 个互相矛盾的值。
   */
  const accountSpecs = [
    { label: `${TAG} 币安主账户（实盘形态）`, testnet: false, canTrade: true },
    { label: `${TAG} 币安模拟盘`, testnet: true, canTrade: true },
    { label: `${TAG} 币安观察账户（只读 · 不可交易）`, testnet: false, canTrade: false },
    {
      label: `${TAG} 旧网关遗留账户 · 标签很长很长用来验证账户卡片与下拉框的截断行为`,
      testnet: true,
      canTrade: false,
    },
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
   * ## 默认模型必须是本机 magpie 网关
   *
   * 用户 2026-11-10 的硬要求（见文件头的 `MAGPIE_*` 常量）：所有 LLM 调用走
   * 本机 magpie 的 `workbuddy/deepseek-v4.1-flash`，**不能用 DeepSeek 官方端点**。
   *
   * 所以示例模型清单的第一条是它，并且会被写进 `settings.default_ai_model_id`
   * —— 那个键决定"新建机器人时默认选中哪个模型"，也就是用户第一眼看到的模型。
   *
   * ## 为什么按 `baseUrl + model` 复用而不是按标签
   *
   * `useMagpieModel.ts`（切默认模型的那个脚本）可能先于本脚本跑过，
   * 它创建的模型标签**不带 `[示例]` 前缀**。按标签找会产生第二条一模一样的
   * 模型行，控制台上出现两个看起来完全相同的条目 —— 而它们指向同一个端点。
   * 按"端点 + 模型 id"识别才是这个模型的稳定身份。
   */
  const findModel = (baseUrl: string, model: string) =>
    aiModels.list().find((m) => m.baseUrl === baseUrl && m.model === model);

  /*
   * ## 模型 key 必须是**非空占位**（Lead 2026-11-10 走查踩到）
   *
   * 启动路径对非 `custom` 提供商的判据是
   * `!apiKey && row.provider !== 'custom'`（`manager.buildModel()`）——
   * 也就是"解密后的 key 为空"会让机器人**永久启动失败**
   *（`PERMANENT_START_FAILURES` 里那几条，不会重试），演示实例上看起来像
   * "演示机器人全都起不来"。
   *
   * ⚠️ **判据是解密后的明文，不是 `api_key_enc` 是否为空串**：
   * `vault.encrypt('')` 产出的密文本身非空（有 IV 与 auth tag），但解密出来是空串。
   * 第一版按"密文长度"判断会漏掉这种模型 —— 实测 `useMagpieModel.ts` 建的那条
   * 就是 `encrypt('')`，密文非空、明文为空。
   *
   * 所以这里统一写入一个**非空明文的假 key**（加密后的占位串，不是真实凭据）。
   * 本机 magpie 网关根本不校验 key，所以它能正常调用；其余厂商模型有了非空 key
   * 也只是"看起来配置过"，真要调用会失败 —— 而那正是示例数据要表达的形态。
   *
   * ⚠️ 对 `useMagpieModel.ts` 先创建的那条模型也要补：本脚本会**复用**它
   * （按 baseUrl+model 识别），不补的话界面与启动路径看到的是"未配置凭据"。
   */
  const DEMO_MODEL_KEY_PLACEHOLDER = 'demo-placeholder-key-not-real';
  const ensureModelKey = (model: AiModelConfig): AiModelConfig => {
    const row = aiModels.getWithSecret(model.id);
    if (row === undefined) return model;
    let plain = '';
    try {
      plain = vault.decryptOptional(row.api_key_enc);
    } catch {
      /*
       * 密文坏了（换过主密钥、手改过库）：**不动它**。
       * 覆盖成占位 key 会把"这把凭据坏了"这个事实藏起来 —— 而那正是最该被看到的。
       */
      log.warn(`模型 #${model.id} 的密钥无法解密，保留原值（演示脚本不覆盖坏密文）。`);
      return model;
    }
    if (plain !== '') return model;
    aiModels.update(model.id, { apiKeyEnc: vault.encrypt(DEMO_MODEL_KEY_PLACEHOLDER) });
    return aiModels.get(model.id) ?? model;
  };

  const magpieExisting = findModel(MAGPIE_BASE_URL, MAGPIE_MODEL);
  const magpieModel = magpieExisting
    ? ensureModelKey(magpieExisting)
    : aiModels.create({
        provider: 'custom',
        label: `${TAG} magpie 网关（workbuddy/deepseek-v4.1-flash）`,
        model: MAGPIE_MODEL,
        baseUrl: MAGPIE_BASE_URL,
        apiKeyEnc: vault.encrypt(DEMO_MODEL_KEY_PLACEHOLDER),
        temperature: 0.2,
        maxTokens: 8192,
        timeoutSeconds: 120,
        maxRetries: 2,
      });

  /*
   * ⚠️ **不再创建其它厂商模型**（用户 2026-11-10 要求）：
   * 「那些以前遗留添加的模型提供商删了吧，留一个本地 magpie 就行了」。
   *
   * 演示数据也遵守同一条规则 —— 否则每次重灌都会把已经删掉的 4 条厂商模型
   * 又造回来，用户看到的就是"删了又回来"。
   */
  const models = [magpieModel];

  /*
   * 默认模型指向 magpie —— 这是"策略性地不让人选错"的一步：新建机器人的人
   * 通常不会去改模型下拉框，默认值就是实际会被使用的那条。
   */
  settings.set('default_ai_model_id', String(magpieModel.id));

  /*
   * 模型健康读数（`llm_health:<id>`，由 `manager.recordLlmHealth()` 写、
   * `/api/ai-models` 读回来给界面显示"最近一次调用成功/失败"）。
   * 只有 magpie 一条，记一次成功调用即可。
   */
  settings.set(
    `llm_health:${magpieModel.id}`,
    JSON.stringify({ ok: true, at: spread(rng, 0.02), latencyMs: intBetween(rng, 420, 1800) }),
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
   * ## 为什么按"形态剧本"（`TRADER_SPECS`）而不是随机分布
   *
   * 随机分布会让"应该覆盖的那种形态"偶尔缺席 —— 而演示数据的价值恰恰在于
   * **每种形态都能看到**。所以模式、模拟/实盘、状态、是否有账户、历史条数
   * 都是写死的剧本；随机只用在"同一形态内部的数字"上（盈亏、杠杆、时间）。
   *
   * ## 数量按 `--scale` 放大
   *
   * 这是**最直接的压力维度**：机器人列表页、总览页的舰队合计、命令面板的
   * 搜索结果，都会随机器人数量线性增长。默认 14 个已经够看出"列表比空状态
   * 复杂得多"，`--scale 3` 给出 42 个则是"滚动条真的出现"的那一档。
   *
   * ⚠️ **AI 模式的机器人 `strategy_id` 必须为 `null`**（M7/M12 的语义）：
   * 它的参数在 `agent_config_json` 里，挂一个策略会让界面显示"正在引用"，
   * 而那份策略对它**完全不生效** —— 一个看起来有、实际没有的关联。
   */
  const seededTraders: SeededTrader[] = [];
  const traderTotal = Math.max(TRADER_SPECS.length, Math.round(TRADER_SPECS.length * SCALE));
  for (let i = 0; i < traderTotal; i += 1) {
    const spec = TRADER_SPECS[i % TRADER_SPECS.length]!;
    /* 超出一轮剧本时加序号 —— 名字重复会让"我该看哪一个"变成一个真问题。 */
    const name = i < TRADER_SPECS.length ? `${TAG} ${spec.name}` : `${TAG} ${spec.name} #${i + 1}`;
    const accountId = spec.accountIndex === null ? null : accounts[spec.accountIndex]!.id;
    /* AI 模式不挂策略（见上面那段）；固定策略模式按序分配三套预设。 */
    const strategyId = isAiDriven(spec.mode)
      ? null
      : strategiesCreated[i % strategiesCreated.length]!.id;
    /*
     * ## 所有示例机器人一律绑定 magpie 模型（Lead 2026-11-10 走查要求）
     *
     * 演示实例里用户会真的点"启动"—— 如果某个机器人绑的是没有真实凭据的
     * 厂商模型，它一启动就报"还没有配置 API Key"并停住，看起来像系统坏了。
     * 用户的要求也是"项目里的 LLM 调用一律走本机 magpie 网关"。
     *
     * 其它厂商模型仍然留在模型列表里（覆盖"多模型"这种数据形态），
     * 只是**不被任何示例机器人引用** —— 它们在界面上是"配置过、未使用"。
     */
    const aiModelId = magpieModel.id;

    const created = traders.create({
      name,
      exchangeAccountId: accountId,
      aiModelId,
      strategyId,
      mode: spec.mode,
      cycleIntervalMinutes: spec.cycleIntervalMinutes,
      initialEquity: spec.initialEquity,
      /* 模拟盘的起始余额是它对 UI 显示的"纸面本金"，没有就回落 initialEquity。 */
      paperStartingBalance: spec.dryRun === true ? spec.initialEquity : 0,
    });

    /* AI 模式下"参数在 agent_config_json 里"—— 非空即代表这种模式（M6）。 */
    if (isAiDriven(spec.mode)) {
      traders.setAgentConfig(created.id, JSON.stringify(aiConfigFor(spec.mode, rng)));
    }

    /*
     * `dry_run` 三态：`true`/`false` 是操作员显式选择（重启后按它恢复），
     * `null` 是"从未指定"（回落到进程级 env.dryRun）。
     *
     * ⚠️ **正在运行的机器人一律显式落库 `dryRun`** —— 只写 `status=running`
     * 而 `dry_run` 为 null 时，demo 服务重启会按 env 恢复，可能变成实盘
     * （2026-10-13 的真实事故：测试机器人被重启恢复成实盘）。
     */
    traders.setDryRun(created.id, spec.dryRun);
    traders.setStatus(created.id, spec.status, spec.lastError ?? null);

    seededTraders.push({ id: created.id, spec, closedTrades: [] });
  }

  /* --- 每个机器人的历史 ------------------------------------------------- */

  let totalTrades = 0;
  let totalOrders = 0;
  let totalDecisions = 0;
  let totalAgentRuns = 0;
  let totalExperiments = 0;
  let totalMemory = 0;

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
    const owned = seededTraders
      .map((s) => traders.get(s.id))
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

  for (const seeded of seededTraders) {
    const traderId = seeded.id;
    const trader = traders.get(traderId);
    /*
     * `tradeCount: 0` 的剧本是**空状态机器人** —— 权益快照也不生成。
     * 一个"刚创建、从未跑过"的机器人本来就是 0 行；给它画一条 90 天的曲线
     * 会让这个形态自相矛盾（有曲线却没有一次决策）。
     */
    const perTraderTrades = Math.round(seeded.spec.tradeCount * SCALE);
    const series = accountCurves.get(trader?.exchangeAccountId ?? -1);
    /* 该账户在某个时刻的权益 —— 同账户下所有机器人拿到的是同一个数。 */
    const accountEquityAt = (day: number, hour: number): number =>
      series?.get(`${day}:${hour}`) ?? 5000;
    const history = seedTraderHistory({
      traderId,
      rng,
      tradeCount: perTraderTrades,
      teamMode: seeded.spec.aiProfile === 'team',
      intelProfile: seeded.spec.intelProfile,
      accountEquityAt,
    });
    seeded.closedTrades = history.closedTrades;
    totalTrades += history.trades;
    totalOrders += history.orders;
    totalDecisions += history.decisions;

    /*
     * AI 模式的三张审计表（`agent_runs` / `agent_experiments` / `agent_memory`）。
     * 只有"真的会写它们"的模式才生成 —— 固定策略模式写这三张表是假数据。
     */
    if (seeded.spec.aiProfile !== 'none') {
      const agent = seedAgentAudit({
        traderId,
        rng,
        mode: seeded.spec.mode,
        team: seeded.spec.aiProfile === 'team',
        closedTrades: history.closedTrades,
      });
      totalAgentRuns += agent.runs;
      totalExperiments += agent.experiments;
      totalMemory += agent.memory;
    }

    const failures =
      seeded.spec.status === 'error'
        ? intBetween(rng, 3, 5)
        : seeded.spec.status === 'safe_mode'
          ? intBetween(rng, 1, 2)
          : 0;
    /*
     * 回填周期号 —— **用真实生成的决策条数**，不是另取一个随机数。
     *
     * 这样"列表页的周期 N"与"详情页有 N 条决策"说的是同一个数。第一版
     * 两处各写各的（列表 12~480、详情最多 30），看起来像"决策记录丢了"。
     */
    traders.recordCycle(traderId, history.decisions, failures);
  }

  /* --- 运行时日志 ------------------------------------------------------- */

  /*
   * 日志是**另一条压力路径**：DataPage 的日志面板会一次渲染最多 500 行，
   * 而每一行都是带时间戳、级别、来源、正文的 flex 行。空库下那一块是
   * "还没有日志"，看不出任何东西。
   *
   * 团队模式还多一条用途：`scope='team'` 的 `[phase] role：note` 行是
   * 「岗位出勤」判据（`/api/traders/:id/agent/:role/steps` 与
   * `agent/last-seen` 解析它们）。所以团队机器人必须有这种行，
   * 否则界面上那十几个岗位会永远显示"待命"。
   */
  const teamTraderIds = seededTraders
    .filter((s) => s.spec.aiProfile === 'team')
    .map((s) => s.id);
  const logStats = seedLogs(
    rng,
    seededTraders.map((s) => ({ id: s.id, name: s.spec.name })),
    teamTraderIds,
  );

  /* --- 告警类读数（账目差额 / 机器人之外的活动）------------------------- */

  seedAlarmSettings(seededTraders, rng);

  /* --- 报告 ------------------------------------------------------------- */

  const db = getDb();
  log.info(
    [
      '',
      '='.repeat(72),
      '示例数据已生成。**全程未向交易所发送任何请求，未写入任何真实密钥。**',
      `写入的数据库：${dbPath}`,
      '='.repeat(72),
      `  交易所账户    ${accounts.length} 个`,
      `  AI 模型       ${models.length} 个（默认：${magpieModel.label}）`,
      `  策略          ${strategiesCreated.length} 套`,
      `  机器人        ${seededTraders.length} 个（${db.count('SELECT COUNT(*) AS n FROM traders')} 行）`,
      '    形态：' + modeBreakdown(seededTraders),
      `  成交记录      ${totalTrades} 笔（共 ${db.count('SELECT COUNT(*) AS n FROM trades')} 行；` +
        `带 intel 归因 ${db.count("SELECT COUNT(*) AS n FROM trades WHERE intel_keys <> '[]'")} 笔）`,
      `  订单记录      ${totalOrders} 条（共 ${db.count('SELECT COUNT(*) AS n FROM orders')} 行；` +
        `被拒 ${db.count("SELECT COUNT(*) AS n FROM orders WHERE status = 'REJECTED'")} 条）`,
      `  决策记录      ${totalDecisions} 条（共 ${db.count('SELECT COUNT(*) AS n FROM decision_records')} 行；` +
        `失败周期 ${db.count('SELECT COUNT(*) AS n FROM decision_records WHERE success = 0')} 条）`,
      `  智能体审计    runs ${totalAgentRuns} / experiments ${totalExperiments} / memory ${totalMemory}`,
      `  团队步骤日志  ${logStats.teamSteps} 行（scope='team'，共 ${db.count('SELECT COUNT(*) AS n FROM runtime_logs')} 行日志）`,
      `  权益快照      ${db.count('SELECT COUNT(*) AS n FROM equity_snapshots')} 行`,
      `  告警类读数    ledger_check / foreign_activity / llm_health 已写入`,
      '',
      '  打开控制台查看：',
      '    /                  → 舰队合计、权益曲线、机器人快照表',
      '    /traders           → 长列表 + 分页 + 排序（含超长名字与各状态）',
      '    /traders/<id>      → 持仓、订单、成交四张表 + 决策流',
      '      · ai_team 机器人 → 智能体审计 + 团队看板（角色出勤/各角色历史）',
      '      · ai_managed     → 智能体审计（参数实验 / 教训记忆）',
      '      · jev            → JEV 选项面板',
      '    /traders/<id>/decisions/<recordId> → 思维链、执行日志、风控调整（含被拒/失败）',
      '    /data              → 日志面板（500 行）',
      '    /models            → 模型列表（只有本机 magpie 一条）',
      '    /exchanges         → 四个账户（含只读与超长标签）',
      '    /strategy          → 策略列表与预设',
      '',
      `  清理：npm run seed:demo:clean`,
      '='.repeat(72),
      '',
    ].join('\n'),
  );

  closeDb();
}

/** 一行里汇总机器人形态分布（报告用）。 */
function modeBreakdown(seeded: readonly SeededTrader[]): string {
  const counts = new Map<string, number>();
  for (const s of seeded) {
    const key = s.spec.dryRun === true ? `${s.spec.mode}·模拟` : s.spec.dryRun === false ? `${s.spec.mode}·实盘` : `${s.spec.mode}·未指定`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, n]) => `${key}×${n}`).join('  ');
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
function seedTraderHistory(options: {
  traderId: number;
  rng: () => number;
  /** 要生成多少笔已平仓成交。0 = 空状态机器人（什么都不写）。 */
  tradeCount: number;
  /** 是否生成团队模式的 `<team>` 审计块（`ai_team` 的历史才需要）。 */
  teamMode: boolean;
  /** 情报归因画像：`signal-sample` 会给同一个信号键堆够样本量。 */
  intelProfile: 'mixed' | 'signal-sample';
  /**
   * 取该机器人所属**交易所账户**在某个时刻的权益。
   *
   * 传函数而不是传一个数：账户权益是一条**与时间相关**的序列，而
   * `equity_snapshots` 每个机器人每 6 小时写一行 —— 同一账户下的所有
   * 机器人必须在**同一时刻**读到**同一个值**（共享钱包的语义）。
   * 由调用方按账户建好这条序列（见 `main()` 里的 `accountCurves`）。
   */
  accountEquityAt: (day: number, hour: number) => number;
}): {
  trades: number;
  orders: number;
  decisions: number;
  closedTrades: ClosedTradeRef[];
} {
  const { traderId, rng, tradeCount, teamMode, intelProfile, accountEquityAt } = options;
  let orders = 0;
  let decisions = 0;

  /*
   * **空状态机器人**：一个刚创建、从未跑过的形态是真实存在的，而它
   * 在所有页面上的表现（0 行表、空图表、"还没有决策"）只有真的不写数据才能看到。
   * 给它补几条"看起来完整"的历史，等于把要测的那个形态删掉了。
   */
  if (tradeCount === 0) {
    return { trades: 0, orders: 0, decisions: 0, closedTrades: [] };
  }

  /** 该机器人的已平仓成交（`agent_memory` 需要能对上的 `trade_id`）。 */
  const closedTrades: ClosedTradeRef[] = [];

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
     * **情报归因**：约 35% 的成交带 `intel_keys`（模拟"消息面驱动的交易"），
     * 其余是纯技术面（`[]`，与历史行为一致）。
     *
     * ⚠️ `signal-sample` 画像会把**同一个键**堆到 ≥20 笔：`signalHealth`
     * 的样本门槛是 `MIN_SAMPLES = 20`，堆不满它，失效检测就永远
     * `insufficient_data` —— 代码在跑，功能从未生效。
     */
    const intelKeys: string[] = [];
    if (intelProfile === 'signal-sample') {
      /* 分页压力那台机器人：70% 落在同一个信号键上，才能凑够 20 笔样本。 */
      if (rng() < 0.7) intelKeys.push(INTEL_KEYS.btcBull);
      else if (rng() < 0.5) intelKeys.push(INTEL_KEYS.ethBear);
    } else if (rng() < 0.35) {
      intelKeys.push(pick(rng, [INTEL_KEYS.btcBull, INTEL_KEYS.ethBear, INTEL_KEYS.solBull, INTEL_KEYS.marketNeutral]));
    }
    /*
     * **资金费**：每 8 小时结算一次，而任何成交记录里都看不到它 ——
     * 所以示例数据必须单独给它一个数，否则「净 = 毛 − 手续费 − 资金费」
     * 那条口径在界面上永远只体现前两项。约 1/4 的回合带一笔小额资金费。
     */
    const fundingFee = rng() < 0.25 ? Number(between(rng, -0.12, 0.09).toFixed(6)) : 0;

    /*
     * 开仓单 —— 每笔成交都对应两张单（开仓 + 平仓），这是订单记录那一栏
     * 长度的来源。空库下那一栏永远只有 0 条。
     */
    const entryOrderId = `seed-e-${traderId}-${i}`;
    const exitOrderId = `seed-x-${traderId}-${i}`;
    /*
     * ⚠️ 订单时间戳**必须跟着成交走**，不能是"现在"。
     *
     * `orders.insert()` 自己盖 `now()`（仓储层为运行期设计），而填充脚本要的是
     * 90 天历史 —— 不改的话订单记录里 1700 多行全部显示"刚刚"，而它们对应
     * 的成交却在三个月前。那种"两列时间互相矛盾"是示例数据自己制造的假象，
     * 开发时最容易被误判成界面 bug。所以插完把 `created_at` 校正到成交时刻。
     */
    insertOrderAtTime(
      {
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
        marginType: side === 'long' ? 'cross' : 'isolated',
      },
      openedAt,
    );
    orders += 1;

    const closeReason = pick(rng, CLOSE_REASONS);
    /*
     * ⚠️ `purpose` 的取值里**没有 `'close'`** —— 平仓单是 `'exit'`
     * （见 `OrderRecord['purpose']`：`stop_loss | take_profit | entry |
     * exit | adjustment`）。写错的话类型检查会拦下来，但值得记一笔：
     * "平仓"这个动作在订单表里叫 `exit`，而成交表里那个字段叫
     * `close_reason` —— 两套命名，读代码时容易混。
     */
    insertOrderAtTime(
      {
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
        marginType: side === 'long' ? 'cross' : 'isolated',
      },
      closedAt,
    );
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

    const entryFee = Number((fee / 2).toFixed(6));
    const exitFee = Number((fee / 2).toFixed(6));
    const inserted = tradeStore.insert({
      traderId,
      symbol,
      side,
      quantity,
      entryPrice,
      exitPrice,
      leverage,
      grossPnl: finalGross,
      entryFee,
      exitFee,
      /* 资金费只有一小部分回合有 —— 它是「净 = 毛 − 手续费 − 资金费」的第三项。 */
      fundingFee,
      closeReason,
      openedAt,
      closedAt,
      /*
       * 来源：绝大多数是运行期记的 `bot`；约 8% 用 `reconciled` 模拟
       * "进程没起来时由成交历史补录"的回合。界面上这两种来源的措辞不同，
       * 而空数据下永远只看到一种。
       */
      source: rng() < 0.08 ? 'reconciled' : 'bot',
      entryOrderId,
      exitOrderId,
      intelKeys,
    });
    closedTrades.push({
      id: inserted.id,
      symbol,
      closeReason,
      /* 净额口径与 `trades.insert()` 内部一致：毛 − 手续费 − 资金费。 */
      netPnl: Number((finalGross - entryFee - exitFee - fundingFee).toFixed(6)),
      closedAt,
    });
    booked += 1;

    /* --- 决策记录：每 3 笔成交配一条决策 ----------------------------- */

    /*
     * ⚠️ `decisions.log()` 自己盖 `timestamp`（`now()`），而且没有"写历史决策"
     * 的参数 —— 它是为运行期设计的（一条决策就是**刚刚**发生的事）。
     *
     * 填充脚本需要的是"90 天里的一轮轮决策"，所以这里直插一行并指定时刻
     * （见 `insertDecisionAtTime`）。这是脚本里**第二处**绕开仓储层的写入
     * （第一处是 `runtime_logs`），理由相同：**满足的是造历史，不是运行期**。
     * 代价是要自己维护列名 —— 所以列名只写一次，集中在那一个 helper 里。
     */
    if (i % 3 === 0) {
      const cycleNumber = Math.floor(i / 3) + 1;
      /* 决策发生在成交之前几千秒内 —— 时间线顺序必须自洽。 */
      const decidedAt = new Date(
        new Date(openedAt).getTime() - intBetween(rng, 1, 8) * 60_000,
      ).toISOString();
      const isTeamCycle = teamMode && cycleNumber % 3 === 0;
      const action = side === 'long' ? 'open_long' : 'open_short';
      /*
       * 约 28% 的周期会被风控改写参数。**这是本产品最核心的可见行为**
       * （"模型提议，运行时裁决"）—— 没有它，风控调整那一块在控制台上
       * 永远是一段不出现的设计说明。
       */
      const riskAdjusted = rng() < 0.28;
      const askedLeverage = leverage + intBetween(rng, 1, 8);
      const stopLoss = Number((side === 'long' ? entryPrice * 0.975 : entryPrice * 1.025).toPrecision(6));
      const takeProfit = Number((side === 'long' ? entryPrice * 1.08 : entryPrice * 0.92).toPrecision(6));
      const adjustments = riskAdjusted
        ? [
            `杠杆已从 ${askedLeverage}x 压到上限 ${leverage}x。`,
            `仓位规模已从 ${(notional * 2).toFixed(2)} 压到 ${notional.toFixed(2)} USDT（单笔风险不得超过权益的 2%）。`,
            '模型给出的止损方向与仓位方向相反，已按结构位修正。',
          ]
        : [];

      const decision: Decision = {
        action,
        symbol,
        confidence: Number(between(rng, 0.5, 0.92).toPrecision(2)),
        reasoning: `${symbol} 在 1 小时级别站上 EMA20，4 小时结构未破，量能温和放大。以 ${askedLeverage}x 杠杆建立 ${side === 'long' ? '多' : '空'}头，止损放在结构低点下方。`,
        positionSizeUsd: Number((notional * (riskAdjusted ? 2 : 1)).toFixed(2)),
        quantity,
        leverage: riskAdjusted ? askedLeverage : leverage,
        entryType: 'market',
        marginMode: 'isolated',
        stopLoss,
        takeProfit,
        riskUsd: Number((notional * 0.02).toFixed(2)),
        reducePercent: null,
        reduceQuantity: null,
        setupScore: intBetween(rng, 55, 95),
        setupScoreBasis: '趋势、位置与量能三项中两项通过',
        /* ⚠️ 字段要写全（见上一版注释：缺字段会让界面渲染出 `undefinedx`）。 */
        adjustments,
        intelKeys,
      };

      insertDecisionAtTime(
        {
          traderId,
          cycleNumber,
          timestamp: decidedAt,
          systemPrompt: SYSTEM_PROMPT_SAMPLE,
          userPrompt: userPromptSample(symbol, entryPrice),
          cotTrace: isTeamCycle ? teamCotTrace() : COT_SAMPLE,
          decisions: [decision],
          rawResponse: [
            `<reasoning>`,
            isTeamCycle ? teamCotTrace() : COT_SAMPLE,
            `</reasoning>`,
            `<decision>[{"action":"${action}","symbol":"${symbol}"}]</decision>`,
          ].join('\n'),
          executionLog: [
            ...(isTeamCycle
              ? ([
                  {
                    action: 'get_market_snapshot',
                    symbol,
                    status: 'data' as const,
                    detail: '模型主动要了行情快照（12 个标的）—— 纯读取，不是交易动作。',
                  },
                ] as const)
              : []),
            {
              action,
              symbol,
              status: riskAdjusted ? ('submitted' as const) : ('ok' as const),
              detail: riskAdjusted
                ? `风控已改写参数后提交 ${symbol} 市价开仓单，数量 ${quantity}`
                : `已提交 ${symbol} 市价开仓单，数量 ${quantity}`,
              orderId: entryOrderId,
              notionalUsd: Number(notional.toFixed(2)),
              ...(adjustments.length > 0 ? { adjustments } : {}),
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
          cachedTokens: rng() < 0.5 ? intBetween(rng, 0, 2500) : null,
          reasoningTokens: rng() < 0.5 ? intBetween(rng, 0, 700) : null,
        },
        rng,
      );
      decisions += 1;
    }
  }

  /* --- 额外的决策形态（失败 / 零决策 / 被拒 / 团队轮）------------------- */

  decisions += seedDecisionExtras({ traderId, rng, teamMode, nextCycle: Math.floor(tradeCount / 3) + 1 });

  /* --- 未平仓的持仓：让"当前持仓"那一栏非空 --------------------------- */

  /*
   * ⚠️ **一个机器人最多一个未平仓持仓（同标的）** —— 数据库上有
   * `idx_positions_open_symbol` 这个部分唯一索引，重复插入会抛错。
   * 所以这里用不同的标的。
   *
   * ⚠️ **每个持仓都要有对应的保护单**（`STOP_MARKET` / `TAKE_PROFIT_MARKET`，
   * `purpose` 分别是 `stop_loss` / `take_profit`，状态 `NEW`）。
   * 第一版写了 `positions.stop_order_id` / `tp_order_id` 却没有对应的
   * `orders` 行 —— 于是"当前委托"里看不到这两张真实存在的保护单，
   * 而界面上的持仓行又显示"已保护"。一个自相矛盾的状态。
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
    const stopLoss = Number((side === 'long' ? entryPrice * 0.975 : entryPrice * 1.025).toPrecision(6));
    const takeProfit = Number((side === 'long' ? entryPrice * 1.08 : entryPrice * 0.92).toPrecision(6));
    /*
     * 开仓时刻散在最近 3 天里 —— 持仓时长（"3 天前" / "2 小时前"）是
     * 详情页真实存在的一列，全写"现在"会让它永远显示同一句话。
     */
    const openedAt = spread(rng, 3);
    const stopOrderId = `seed-sl-${traderId}-${i}`;
    const tpOrderId = `seed-tp-${traderId}-${i}`;

    insertPositionAtTime(
      {
        traderId,
        symbol,
        side,
        quantity,
        entryPrice,
        leverage,
        liquidationPrice: side === 'long' ? entryPrice * (1 - 1 / leverage * 0.9) : entryPrice * (1 + 1 / leverage * 0.9),
        marginUsed: Number((notional / leverage).toFixed(6)),
        stopLoss,
        takeProfit,
        stopOrderId,
        tpOrderId,
        openReasoning: `${symbol} 的 ${side === 'long' ? '多头' : '空头'}结构成立，风险预算 ${between(rng, 0.5, 2).toFixed(2)}%，止损设在结构位外侧。`,
        intelKeys: rng() < 0.3 ? [pick(rng, [INTEL_KEYS.btcBull, INTEL_KEYS.ethBear])] : [],
      },
      openedAt,
    );

    /* 止损单（条件单：`stopPrice` 有值、`price` 为空）。 */
    insertOrderAtTime(
      {
        traderId,
        exchangeOrderId: stopOrderId,
        clientOrderId: stopOrderId,
        symbol,
        side: side === 'long' ? 'SELL' : 'BUY',
        type: 'STOP_MARKET',
        purpose: 'stop_loss',
        quantity,
        price: null,
        stopPrice: stopLoss,
        status: 'NEW',
        filledQty: 0,
        marginUsed: 0,
        marginType: side === 'long' ? 'cross' : 'isolated',
      },
      openedAt,
    );
    orders += 1;

    /* 止盈单。 */
    insertOrderAtTime(
      {
        traderId,
        exchangeOrderId: tpOrderId,
        clientOrderId: tpOrderId,
        symbol,
        side: side === 'long' ? 'SELL' : 'BUY',
        type: 'TAKE_PROFIT_MARKET',
        purpose: 'take_profit',
        quantity,
        price: null,
        stopPrice: takeProfit,
        status: 'NEW',
        filledQty: 0,
        marginUsed: 0,
        marginType: side === 'long' ? 'cross' : 'isolated',
      },
      openedAt,
    );
    orders += 1;

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
        const submittedAt = spread(rng, 1);

        insertPositionAtTime(
          {
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
          },
          submittedAt,
        );

        /* 对应的挂单 —— 状态 `NEW`（已挂出、未成交），与 `positions` 那一行一致。 */
        insertOrderAtTime(
          {
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
          },
          submittedAt,
        );
        orders += 1;
      }
    }
  }

  /* --- 订单边界：被拒 / 撤单 / 部分成交 / 过期 ------------------------- */

  orders += seedOrderEdgeCases({ traderId, rng, tradeCount });

  return { trades: booked, orders, decisions, closedTrades };
}

/* -------------------------------------------------------------------------- */
/*  脚本内部的数据形状                                                          */
/* -------------------------------------------------------------------------- */

/** 一笔已平仓成交的轻量引用 —— `agent_memory` 与告警统计要对上 `trades.id`。 */
interface ClosedTradeRef {
  id: number;
  symbol: string;
  closeReason: string;
  /** 净额（毛 − 手续费 − 资金费），与 `trades.insert()` 内部同一口径。 */
  netPnl: number;
  closedAt: string;
}

/** 一台已经创建好的示例机器人 + 它的剧本。 */
interface SeededTrader {
  id: number;
  spec: TraderSpec;
  closedTrades: ClosedTradeRef[];
}

/* -------------------------------------------------------------------------- */
/*  带时间戳的插入（脚本专用）                                                  */
/* -------------------------------------------------------------------------- */

/*
 * ## 为什么这里要绕开仓储层改时间戳
 *
 * `orders.insert()` / `positions.insert()` / `agentStore.*.insert()` 都会自己盖
 * `now()` —— 这是**为运行期设计的**：一条订单/持仓/实验就是刚刚发生的事。
 * 而填充脚本要造的是 90 天历史；如果几百上千行全都写着"现在"，
 * 详情页上「成交在三个月前、对应订单却在刚刚」这种自相矛盾会**到处都是**，
 * 开发时很容易被误判成界面 bug。
 *
 * 所以插完立刻用一条 UPDATE 把时间列校正到真实时刻。代价是每行多一次
 * 同步写（脚本跑得稍慢），收益是**时间线自洽** —— 对演示数据来说这个交换划算。
 */

/**
 * 插一张订单并把 `created_at`/`updated_at` 校正到 `atIso`。
 *
 * `updated_at` 取 `atIso` 而不是"现在"：订单在成交那一刻之后没有变化，
 * 两个时间戳相同才是这条记录的真相。
 */
function insertOrderAtTime(
  input: Parameters<typeof orderStore.insert>[0],
  atIso: string,
): number {
  const id = orderStore.insert(input);
  getDb().run('UPDATE orders SET created_at = ?, updated_at = ? WHERE id = ?', atIso, atIso, id);
  return id;
}

/** 插一行持仓并把 `opened_at` 校正到 `atIso`。 */
function insertPositionAtTime(
  input: Parameters<typeof positionStore.insert>[0],
  atIso: string,
): number {
  const id = positionStore.insert(input);
  getDb().run('UPDATE positions SET opened_at = ? WHERE id = ?', atIso, id);
  return id;
}

/** `insertDecisionAtTime` 的入参 —— 与 `decision_records` 的列一一对应。 */
interface DecisionRecordInput {
  traderId: number;
  cycleNumber: number;
  timestamp: string;
  systemPrompt: string;
  userPrompt: string;
  cotTrace: string;
  decisions: Decision[];
  rawResponse: string;
  executionLog: Array<{
    action: string;
    symbol: string;
    status: 'ok' | 'submitted' | 'rejected' | 'failed' | 'skipped' | 'data';
    detail: string;
    orderId?: string;
    notionalUsd?: number;
    adjustments?: string[];
  }>;
  candidateSymbols: string[];
  success: boolean;
  error: string | null;
  aiLatencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
}

/**
 * 直插一行决策记录，**时间戳由调用方指定**。
 *
 * 为什么不用 `decisions.log()`：它把 `timestamp` 写成 `now()`，而且没有
 * "写历史决策"的参数（那个接口的契约是运行期的"这一轮刚刚结束"）。
 * 这里是脚本里**第二处**直插（第一处是 `runtime_logs`），理由相同：
 * 造历史与运行期是两种需求。列名只在这一个 helper 里写一次。
 */
function insertDecisionAtTime(input: DecisionRecordInput, rng: () => number): number {
  const db = getDb();
  /*
   * 决策记录的裁剪（`trimDecisionsIfDue`）只在仓储写路径上发生；
   * 脚本直插不走它 —— 但脚本自己生成的条数是有界的（每机器人几十条），
   * 所以不会让表无限增长。这里显式说明一下，免得下一个人以为漏了。
   */
  const { lastInsertRowid } = db.run(
    `INSERT INTO decision_records (
       trader_id, cycle_number, timestamp, system_prompt, user_prompt, cot_trace,
       decisions_json, raw_response, execution_log_json, candidate_symbols_json,
       success, error, ai_latency_ms, prompt_tokens, completion_tokens,
       cached_tokens, reasoning_tokens
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.traderId,
    input.cycleNumber,
    input.timestamp,
    input.systemPrompt,
    input.userPrompt,
    input.cotTrace,
    JSON.stringify(input.decisions),
    input.rawResponse,
    JSON.stringify(input.executionLog),
    JSON.stringify(input.candidateSymbols),
    input.success,
    input.error,
    input.aiLatencyMs,
    input.promptTokens,
    input.completionTokens,
    input.cachedTokens ?? null,
    input.reasoningTokens ?? null,
  );
  void rng;
  return Number(lastInsertRowid);
}

/* -------------------------------------------------------------------------- */
/*  AI 模式配置与审计三表                                                       */
/* -------------------------------------------------------------------------- */

/**
 * AI 模式机器人的"当前生效参数"（`traders.agent_config_json`）。
 *
 * ⚠️ 必须过 `StrategyConfigSchema` 的形状（读取点会 `safeParse`，不通过就
 * **静默回落到策略配置**）—— 所以这里从 shared 的工厂函数出发，只改**有界**字段。
 */
function aiConfigFor(mode: TraderMode, rng: () => number): StrategyConfig {
  if (mode === 'jev') {
    const config = defaultJevConfig();
    return {
      ...config,
      riskControl: {
        ...config.riskControl,
        /* 实验参数：AI 自己动过一点（在 schema 范围内）。 */
        maxPositions: intBetween(rng, 2, 4),
        minConfidence: intBetween(rng, 35, 55),
      },
    };
  }
  const base = mode === 'ai_team' ? defaultAiTeamConfig() : unboundedAiManagedConfig();
  return {
    ...base,
    riskControl: {
      ...base.riskControl,
      maxPositions: mode === 'ai_team' ? intBetween(rng, 8, 20) : intBetween(rng, 3, 8),
      btcEthMaxLeverage: mode === 'ai_team' ? intBetween(rng, 20, 125) : intBetween(rng, 5, 25),
      altcoinMaxLeverage: mode === 'ai_team' ? intBetween(rng, 10, 50) : intBetween(rng, 3, 15),
      /* AI 托管/团队模式按设计把门槛交给模型，但参数是"它自己改过的"，所以有值。 */
      minConfidence: mode === 'ai_team' ? 0 : intBetween(rng, 20, 50),
    },
  };
}

/**
 * 给 AI 模式的机器人灌 `agent_runs` / `agent_experiments` / `agent_memory`。
 *
 * ## 这三张表为什么必须出现在演示数据里
 *
 * 它们是「AI 越跑越厉害」的**唯一落地处**，也是控制台上那两块面板的全部内容：
 *
 * | 表 | 面板上回答的问题 |
 * | --- | --- |
 * | `agent_runs` | 谁跑了、多久、花了多少 token |
 * | `agent_experiments` | 改了什么参数、之后真实结果如何 |
 * | `agent_memory` | 从每笔平仓里学到了什么 |
 *
 * 空数据下 `AgentAuditPanel` 永远是「还没有审计记录」—— 而那恰好是最不可能
 * 出问题的一行字。条数、长文本、失败态都要有，面板才可能暴露真实版面问题。
 */
function seedAgentAudit(options: {
  traderId: number;
  rng: () => number;
  mode: TraderMode;
  team: boolean;
  closedTrades: readonly ClosedTradeRef[];
}): { runs: number; experiments: number; memory: number } {
  const { traderId, rng, mode, team, closedTrades } = options;
  const db = getDb();
  const nowMs = Date.now();

  /* --- 运行轨迹（`agent_runs`）----------------------------------------- */

  /*
   * 时间戳**升序插入**：`agentRuns.recent()` 按 `id DESC` 取"最近 N 条"，
   * 所以 id 顺序必须与时间顺序一致，否则面板上的"最近一次"其实是随机的。
   */
  const runTimes = Array.from({ length: team ? 26 : 18 }, () =>
    nowMs - Math.sqrt(rng()) * 30 * DAY_MS,
  ).sort((a, b) => a - b);
  const runKinds: AgentRunKind[] = team ? ['team_cycle', 'team_cycle', 'review', 'strategy'] : ['strategy', 'strategy', 'review'];
  const runOutcomes: AgentRunOutcome[] = ['ok', 'ok', 'ok', 'ok', 'degraded', 'failed'];
  const triggers: WakeTrigger[] = ['new_result', 'losing_streak', 'drawdown', 'timeout', 'idle', 'manual', 'none'];
  let runs = 0;
  for (const atMs of runTimes) {
    const outcome = pick(rng, runOutcomes);
    const agents = Array.from({ length: intBetween(rng, 2, 5) }, (_, index) => ({
      step: index + 1,
      tool: pick(rng, ['get_klines', 'get_account', 'get_performance', 'web_search', 'get_signal_health']),
      thought:
        outcome === 'failed'
          ? `第 ${index + 1} 步：工具调用失败，正在重试。`
          : `第 ${index + 1} 步：读到 ${pick(rng, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])} 的 ${pick(rng, ['1h', '4h'])} 结构，与会话里的其余证据一致。`,
    }));
    db.run(
      `INSERT INTO agent_runs (
         trader_id, created_at, kind, trigger, intensity, steps, agents_json,
         outcome, detail, tokens_in, tokens_out, latency_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      traderId,
      new Date(atMs).toISOString(),
      pick(rng, runKinds),
      pick(rng, triggers),
      team ? 'panel' : 'single',
      agents.length,
      JSON.stringify(agents),
      outcome,
      outcome === 'degraded'
        ? '撞到步数上限，本轮没有得出结论（不是失败，是预算不够）。'
        : outcome === 'failed'
          ? '模型输出无法解析，且重试后仍失败。'
          : '本轮得出结论并写入决策。',
      intBetween(rng, 3000, 48000),
      intBetween(rng, 300, 4200),
      intBetween(rng, 1500, 42000),
    );
    runs += 1;
  }

  /* --- 参数实验（`agent_experiments`）---------------------------------- */

  /*
   * `patch_json` 与 `applied_json` **分开存**是这张表的重点（守卫钳制时两者不同）。
   * 示例数据刻意造一条"被钳制"的实验：界面能一眼看出"I 想改 40x、实际只能 10x"。
   */
  let experiments = 0;
  const settledCount = 5;
  const experimentTimes = Array.from({ length: settledCount + 1 }, () =>
    nowMs - Math.sqrt(rng()) * 45 * DAY_MS,
  ).sort((a, b) => a - b);
  for (let index = 0; index < experimentTimes.length; index += 1) {
    const settled = index < settledCount;
    const clamped = index === 1;
    const patch = { riskControl: { btcEthMaxLeverage: clamped ? 40 : intBetween(rng, 5, 25) } };
    const applied = { riskControl: { btcEthMaxLeverage: clamped ? 10 : patch.riskControl.btcEthMaxLeverage } };
    db.run(
      `INSERT INTO agent_experiments (
         trader_id, created_at, trigger, observed_json, patch_json, applied_json,
         clamps_json, reason, tool_calls_json, outcome_trades, outcome_net_pnl, outcome_evaluated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      traderId,
      new Date(experimentTimes[index]!).toISOString(),
      pick(rng, ['new_result', 'drawdown', 'losing_streak', 'rejections', 'timeout']),
      JSON.stringify({
        trades: intBetween(rng, 5, 60),
        netPnl: Number(between(rng, -12, 20).toFixed(4)),
        winRatePercent: intBetween(rng, 30, 70),
        drawdownPercent: Number(between(rng, 0.5, 18).toFixed(2)),
      }),
      JSON.stringify(patch),
      JSON.stringify(applied),
      JSON.stringify(
        clamped
          ? [
              {
                field: 'riskControl.btcEthMaxLeverage',
                asked: 40,
                allowed: 10,
                why: '风控上限：杠杆不得超过配置的 10x。',
              },
            ]
          : [],
      ),
      clamped
        ? '最近 12 笔里 9 笔止损都在开仓后 6 分钟内被扫，怀疑止损太近；尝试放大杠杆换取更远的止损空间，但被守卫挡在 10x。'
        : `最近 ${intBetween(rng, 5, 20)} 笔的胜率与盈亏比同时下降，怀疑入场门槛太松；把最小置信度上调一档再观察。`,
      JSON.stringify([
        { tool: 'get_performance', args: { window: intBetween(rng, 20, 80) } },
        { tool: 'get_trades', args: { limit: 30 } },
      ]),
      settled ? intBetween(rng, 3, 12) : null,
      settled ? Number(between(rng, -8, 14).toFixed(4)) : null,
      settled ? new Date(experimentTimes[index]! + 36 * 3_600_000).toISOString() : null,
    );
    experiments += 1;
  }

  /* --- 教训记忆（`agent_memory`）--------------------------------------- */

  /*
   * `trade_id` 上有 UNIQUE 且引用 `trades(id)` —— 只能挑**本机器人自己的**
   * 已平仓成交。这也解释了为什么 `seedTraderHistory` 要把 trade id 传出来。
   */
  let memory = 0;
  for (const trade of closedTrades.slice(0, 24)) {
    const win = trade.netPnl > 0;
    db.run(
      `INSERT INTO agent_memory (
         trader_id, trade_id, created_at, symbol, close_reason, net_pnl, lesson, tags_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      traderId,
      trade.id,
      new Date(new Date(trade.closedAt).getTime() + 5 * 60_000).toISOString(),
      trade.symbol,
      trade.closeReason,
      trade.netPnl,
      win
        ? `${trade.symbol} 这笔试错成功：入场位置在结构位附近，止损放在失效条件外侧，${team ? '团队辩论里多头的失效条件更近，' : ''}这笔的赔率是划算的。可复用点：同样的结构 + 同样的风控位置。`
        : `${trade.symbol} 这笔亏损的直接原因是${trade.closeReason === 'stop_loss' ? '止损被正常扫掉（结构位放得太近）' : '在震荡区间中间入场'}。教训：${team ? '裁决官给的方向没错，但入场价离结构位太远，' : ''}下次把入场条件收紧到"只在关键位附近"。`,
      JSON.stringify(win ? ['结构位入场', '赔率划算', team ? '团队裁决' : '单模型'] : ['追高', '止损过近', '震荡区间']),
    );
    memory += 1;
  }

  void mode;
  return { runs, experiments, memory };
}

/* -------------------------------------------------------------------------- */
/*  决策的额外形态                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 给一个机器人补 4–5 条**真实会出现的特殊周期**：
 *
 * 1. **失败周期**（`success = 0`）—— 模型 429，整轮没有任何产出；
 * 2. **零决策周期** —— 模型看了、判断"什么都不做"（与故障是两件事）；
 * 3. **被拒提案** —— 模型给出开仓，风控拒绝（`executionLog` 里 `status='rejected'`）；
 * 4. **风控改写 + 部分失败** —— 多决策周期，其中一张保护单挂失败；
 * 5. 团队模式再加一轮**完整 `<team>` 块**的周期（给看板的回放态用）。
 *
 * 这些形态在真实运行里都不罕见，而随机生成的"全是成功开仓"覆盖不到它们。
 * 决策详情页的 `RejectedBanner`、失败横幅、`classifyZeroDecision()` 的五态文案
 * 全都靠这几条数据才会被真正渲染出来。
 */
function seedDecisionExtras(options: {
  traderId: number;
  rng: () => number;
  teamMode: boolean;
  nextCycle: number;
}): number {
  const { traderId, rng, teamMode, nextCycle } = options;
  /* 越新的周期号应当对应越近的时刻（列表按 cycle_number DESC 排序）。 */
  const agesDays = [0.1, 0.8, 1.6, 3.2, 5.0];
  const cycleOf = (index: number): number => nextCycle + (agesDays.length - index);
  const timeOf = (index: number): string =>
    new Date(Date.now() - agesDays[index]! * DAY_MS).toISOString();
  let added = 0;

  /* ① 失败周期。 */
  insertDecisionAtTime(
    {
      traderId,
      cycleNumber: cycleOf(0),
      timestamp: timeOf(0),
      systemPrompt: SYSTEM_PROMPT_SAMPLE,
      userPrompt: '## 市场快照\n\n（本轮行情获取成功，但模型调用失败）',
      cotTrace: '',
      decisions: [],
      rawResponse: '',
      executionLog: [],
      candidateSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      success: false,
      error: '调用模型失败：HTTP 429 rate limit exceeded（已按 3 次重试策略放弃本轮）',
      aiLatencyMs: 30_120,
      promptTokens: null,
      completionTokens: null,
    },
    rng,
  );
  added += 1;

  /* ② 零决策周期（判断，不是故障）。 */
  const zeroReason =
    '本轮看完了 12 个候选：没有一个同时满足"结构成立 + 失效位清晰 + 赔率≥2"三条。\n' +
    '最接近的是 ETHUSDT，但止损位离现价 3.4%、止盈位只有 2.1%，赔率不划算 —— 宁可错过，不勉强交易。';
  insertDecisionAtTime(
    {
      traderId,
      cycleNumber: cycleOf(1),
      timestamp: timeOf(1),
      systemPrompt: SYSTEM_PROMPT_SAMPLE,
      userPrompt: userPromptSample('ETHUSDT', PRICE.ETHUSDT ?? 2530),
      cotTrace: zeroReason,
      decisions: [],
      rawResponse: `<reasoning>\n${zeroReason}\n</reasoning>\n<decision>[]</decision>`,
      executionLog: [],
      candidateSymbols: SYMBOLS.slice(0, 12),
      success: true,
      error: null,
      aiLatencyMs: intBetween(rng, 2400, 8000),
      promptTokens: intBetween(rng, 4000, 9000),
      completionTokens: intBetween(rng, 200, 800),
    },
    rng,
  );
  added += 1;

  /* ③ 被风控拒绝的提案。 */
  insertDecisionAtTime(
    {
      traderId,
      cycleNumber: cycleOf(2),
      timestamp: timeOf(2),
      systemPrompt: SYSTEM_PROMPT_SAMPLE,
      userPrompt: userPromptSample('DOGEUSDT', PRICE.DOGEUSDT ?? 0.085),
      cotTrace: '模型想追一个刚放量突破的标的，但给出的置信度只有 41，低于策略要求的最低值。',
      decisions: [],
      rawResponse:
        '<reasoning>突破刚刚发生，量能是过去 20 根的 3.2 倍。</reasoning>\n<decision>[{"action":"open_long","symbol":"DOGEUSDT","confidence":41}]</decision>',
      executionLog: [
        {
          action: 'open_long',
          symbol: 'DOGEUSDT',
          status: 'rejected',
          detail: '风控拒绝：置信度 41 低于要求的最低值 68。',
        },
        {
          action: 'skip',
          symbol: 'WIFUSDT',
          status: 'skipped',
          detail: '模型自己放弃：24h 成交额不足 5000 万 USDT，滑点风险太高。',
        },
      ],
      candidateSymbols: ['DOGEUSDT', 'WIFUSDT', '1000PEPEUSDT'],
      success: true,
      error: null,
      aiLatencyMs: intBetween(rng, 3000, 9000),
      promptTokens: intBetween(rng, 4000, 10000),
      completionTokens: intBetween(rng, 300, 900),
      reasoningTokens: intBetween(rng, 100, 500),
    },
    rng,
  );
  added += 1;

  /* ④ 风控改写 + 一张保护单挂失败的周期。 */
  insertDecisionAtTime(
    {
      traderId,
      cycleNumber: cycleOf(3),
      timestamp: timeOf(3),
      systemPrompt: SYSTEM_PROMPT_SAMPLE,
      userPrompt: userPromptSample('SOLUSDT', PRICE.SOLUSDT ?? 168),
      cotTrace: COT_SAMPLE,
      decisions: [
        {
          action: 'open_long',
          symbol: 'SOLUSDT',
          confidence: 74,
          reasoning: 'SOLUSDT 4 小时结构完整，回踩 EMA20 后放量。',
          positionSizeUsd: 520.4,
          quantity: 3.1,
          leverage: 20,
          entryType: 'market',
          marginMode: 'isolated',
          stopLoss: 163.2,
          takeProfit: 182.4,
          riskUsd: 10.4,
          reducePercent: null,
          reduceQuantity: null,
          setupScore: 78,
          setupScoreBasis: '结构、量能、赔率三项通过',
          adjustments: ['杠杆已从 20x 压到上限 10x。', '仓位规模已从 1040.80 压到 520.40 USDT（单笔风险不得超过权益的 2%）。'],
          intelKeys: [INTEL_KEYS.solBull],
        },
        {
          action: 'hold',
          symbol: 'BTCUSDT',
          confidence: 66,
          reasoning: '已有仓位结构未破，继续持有。',
          positionSizeUsd: 0,
          leverage: 5,
          stopLoss: null,
          takeProfit: null,
          riskUsd: 0,
          reducePercent: null,
          reduceQuantity: null,
          setupScore: 62,
          setupScoreBasis: '趋势仍在，但位置不适合加仓',
          adjustments: [],
        },
      ],
      rawResponse:
        '<reasoning>结构与量能支持做多 SOL，同时 BTC 已有仓位继续持有。</reasoning>\n<decision>[{"action":"open_long","symbol":"SOLUSDT"},{"action":"hold","symbol":"BTCUSDT"}]</decision>',
      executionLog: [
        {
          action: 'open_long',
          symbol: 'SOLUSDT',
          status: 'ok',
          detail: '风控改写参数后已提交市价开仓（数量 3.1）。',
          orderId: `seed-edge-${traderId}-3`,
          notionalUsd: 520.4,
          adjustments: ['杠杆已从 20x 压到上限 10x。'],
        },
        {
          action: 'set_protection',
          symbol: 'SOLUSDT',
          status: 'failed',
          detail: '止盈单挂失败：Binance -4120 Order type not supported for this endpoint（已重试 2 次）。',
        },
      ],
      candidateSymbols: SYMBOLS.slice(0, 16),
      success: true,
      error: null,
      aiLatencyMs: intBetween(rng, 5000, 15000),
      promptTokens: intBetween(rng, 6000, 14000),
      completionTokens: intBetween(rng, 400, 1500),
      cachedTokens: 1200,
      reasoningTokens: 900,
    },
    rng,
  );
  added += 1;

  /* ⑤ 团队模式：一轮带完整 `<team>` 块的周期（看板回放态读它）。 */
  if (teamMode) {
    insertDecisionAtTime(
      {
        traderId,
        cycleNumber: cycleOf(4),
        timestamp: timeOf(4),
        systemPrompt: SYSTEM_PROMPT_SAMPLE,
        userPrompt: userPromptSample('BTCUSDT', PRICE.BTCUSDT ?? 82700),
        cotTrace: teamCotTrace(),
        decisions: [
          {
            action: 'hold',
            symbol: 'BTCUSDT',
            confidence: 71,
            reasoning: '团队结论：趋势偏多但位置不佳，已有仓位继续持有，不开新仓。',
            positionSizeUsd: 0,
            leverage: 5,
            stopLoss: null,
            takeProfit: null,
            riskUsd: 0,
            reducePercent: null,
            reduceQuantity: null,
            setupScore: 64,
            setupScoreBasis: '趋势通过、位置不通过',
            adjustments: [],
            intelKeys: [INTEL_KEYS.btcBull],
          },
        ],
        rawResponse: `<reasoning>${teamCotTrace()}</reasoning>\n<decision>[{"action":"hold","symbol":"BTCUSDT"}]</decision>`,
        executionLog: [
          {
            action: 'get_market_snapshot',
            symbol: 'BTCUSDT',
            status: 'data',
            detail: '模型主动要了行情快照（18 个标的）。',
          },
          { action: 'hold', symbol: 'BTCUSDT', status: 'ok', detail: '继续持有，本轮不开新仓。' },
        ],
        candidateSymbols: SYMBOLS.slice(0, 18),
        success: true,
        error: null,
        aiLatencyMs: intBetween(rng, 15000, 45000),
        promptTokens: intBetween(rng, 12000, 26000),
        completionTokens: intBetween(rng, 1200, 3800),
        cachedTokens: 3400,
        reasoningTokens: 1600,
      },
      rng,
    );
    added += 1;
  }

  return added;
}

/* -------------------------------------------------------------------------- */
/*  订单边界形态                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 每个有历史成交的机器人补几条**真实会出现的订单边界**：
 *
 * | 状态 | 场景 |
 * | --- | --- |
 * | `REJECTED` | 保证金不足被交易所拒绝（带 `error` + `raw_response`） |
 * | `CANCELED` | 限价单等太久被撤（`M11` 的"自动撤单释放名额"） |
 * | `EXPIRED` | 条件单到期未触发 |
 * | `PARTIALLY_FILLED` | 限价单部分成交 |
 *
 * 订单表是"每一张单都要记录"（`docs/AGENTS.md` §2.2）的落地处，而空数据下
 * 界面上那一列只有一个 `FILLED` —— 被拒/撤单/部分成交的**排版与措辞**
 * 一次都不会被看到。
 */
function seedOrderEdgeCases(options: {
  traderId: number;
  rng: () => number;
  tradeCount: number;
}): number {
  const { traderId, rng, tradeCount } = options;
  if (tradeCount === 0) return 0;
  let orders = 0;
  const symbol = pick(rng, SYMBOLS);
  const price = PRICE[symbol] ?? 1;
  const recent = (): string => new Date(Date.now() - rng() * 2 * DAY_MS).toISOString();

  /* ① 被交易所拒绝的开仓单（保证金不足）。 */
  insertOrderAtTime(
    {
      traderId,
      exchangeOrderId: null,
      clientOrderId: `seed-rejected-${traderId}`,
      symbol,
      side: 'BUY',
      type: 'MARKET',
      purpose: 'entry',
      quantity: Number((180 / price).toPrecision(6)),
      price: null,
      stopPrice: null,
      status: 'REJECTED',
      error: 'Binance -2019: Margin is insufficient.',
      rawResponse: { code: -2019, msg: 'Margin is insufficient.' },
      filledQty: 0,
      fee: 0,
      marginUsed: null,
      marginType: 'cross',
    },
    recent(),
  );
  orders += 1;

  /* ② 撤单：限价入场等太久，被自动撤掉。 */
  insertOrderAtTime(
    {
      traderId,
      exchangeOrderId: `seed-canceled-${traderId}`,
      clientOrderId: `seed-canceled-${traderId}`,
      symbol: pick(rng, SYMBOLS),
      side: rng() < 0.5 ? 'BUY' : 'SELL',
      type: 'LIMIT',
      purpose: 'entry',
      quantity: Number((between(rng, 60, 260) / price).toPrecision(6)),
      price: Number((price * between(rng, 0.97, 1.03)).toPrecision(6)),
      stopPrice: null,
      status: 'CANCELED',
      filledQty: 0,
      fee: 0,
      marginUsed: 0,
      marginType: 'cross',
    },
    recent(),
  );
  orders += 1;

  /* ③ 条件单到期未触发。 */
  insertOrderAtTime(
    {
      traderId,
      exchangeOrderId: `seed-expired-${traderId}`,
      clientOrderId: `seed-expired-${traderId}`,
      symbol: pick(rng, SYMBOLS),
      side: rng() < 0.5 ? 'BUY' : 'SELL',
      type: 'TAKE_PROFIT_MARKET',
      purpose: 'take_profit',
      quantity: Number((between(rng, 60, 260) / price).toPrecision(6)),
      price: null,
      stopPrice: Number((price * between(rng, 1.05, 1.12)).toPrecision(6)),
      status: 'EXPIRED',
      filledQty: 0,
      fee: 0,
      marginUsed: 0,
      marginType: 'isolated',
    },
    recent(),
  );
  orders += 1;

  /* ④ 部分成交的限价单。 */
  const partialQty = Number((between(rng, 60, 260) / price).toPrecision(6));
  insertOrderAtTime(
    {
      traderId,
      exchangeOrderId: `seed-partial-${traderId}`,
      clientOrderId: `seed-partial-${traderId}`,
      symbol: pick(rng, SYMBOLS),
      side: 'BUY',
      type: 'LIMIT',
      purpose: 'entry',
      quantity: partialQty,
      price: Number((price * between(rng, 0.98, 1.02)).toPrecision(6)),
      stopPrice: null,
      status: 'PARTIALLY_FILLED',
      avgPrice: Number((price * between(rng, 0.99, 1.01)).toPrecision(6)),
      filledQty: Number((partialQty * between(rng, 0.2, 0.7)).toPrecision(6)),
      fee: Number((partialQty * price * 0.0002).toFixed(6)),
      marginUsed: Number((partialQty * price / 5).toFixed(6)),
      marginType: 'cross',
    },
    recent(),
  );
  orders += 1;

  /* ⑤ 减仓单（`purpose='adjustment'`）。 */
  insertOrderAtTime(
    {
      traderId,
      exchangeOrderId: `seed-adjust-${traderId}`,
      clientOrderId: `seed-adjust-${traderId}`,
      symbol: pick(rng, SYMBOLS),
      side: 'SELL',
      type: 'MARKET',
      purpose: 'adjustment',
      quantity: Number((between(rng, 20, 80) / price).toPrecision(6)),
      price: null,
      stopPrice: null,
      status: 'FILLED',
      avgPrice: Number((price * between(rng, 0.99, 1.01)).toPrecision(6)),
      filledQty: Number((between(rng, 20, 80) / price).toPrecision(6)),
      fee: Number(between(rng, 0.01, 0.08).toFixed(6)),
      marginUsed: 0,
      marginType: 'cross',
    },
    recent(),
  );
  orders += 1;

  return orders;
}

/* -------------------------------------------------------------------------- */
/*  告警类读数                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 写几组**界面会读的"告警类"读数**（它们不是表，而是 `settings` 里的台账）。
 *
 * | 键 | 界面表现 |
 * | --- | --- |
 * | `ledger_check:<id>` | "账本与交易所流水差额"横幅（一个干净、一个可疑） |
 * | `foreign_activity:<id>` | "机器人之外的活动"告警（账户里有别的来源的成交） |
 *
 * 这两类状态在空数据下完全不可见，但它们恰恰是操作员最需要看懂的东西。
 * 一个 forever-0 的差额和一个 0.52 USDT 的差额，在界面上的措辞与颜色不同 ——
 * 只有真的写两条不同的数据才能验证。
 */
function seedAlarmSettings(seededTraders: readonly SeededTrader[], rng: () => number): void {
  const candidates = seededTraders.filter((t) => t.spec.tradeCount > 0);
  if (candidates.length === 0) return;

  const clean = candidates[0]!;
  const suspect =
    candidates.find((t) => t.spec.name.includes('分页压力')) ?? candidates[candidates.length - 1]!;
  const foreign = candidates.find((t) => t.spec.name.includes('激进')) ?? candidates[0]!;

  /*
   * 干净的一份：`gap` 为 0 —— 界面显示"账目与交易所一致"。
   * `checkedAt` 用相对时间，避免一年后显示"2025 年的对账"。
   */
  settings.set(
    `ledger_check:${clean.id}`,
    JSON.stringify({
      platformNet: Number(between(rng, 8, 40).toFixed(6)),
      exchangeNet: 0,
      gap: 0,
      platformSelf: 0,
      foreignNet: 0,
      foreignRounds: 0,
      openCosts: 0,
      checkedAt: spread(rng, 0.1),
    }),
  );
  /* 把 clean 的 exchangeNet 与 platformNet 对齐，才算"真的没有差额"。 */
  const cleanRaw = settings.get(`ledger_check:${clean.id}`);
  if (cleanRaw) {
    const parsed = JSON.parse(cleanRaw) as { platformNet: number };
    settings.set(
      `ledger_check:${clean.id}`,
      JSON.stringify({ ...parsed, exchangeNet: parsed.platformNet }),
    );
  }

  /*
   * 可疑的一份：`gap` ≠ 0 —— 界面上会提示"账本与交易所流水对不上"，
   * 并给出差额数字。这是"账目失真"这种最高优先级故障在界面上的样子。
   */
  settings.set(
    `ledger_check:${suspect.id}`,
    JSON.stringify({
      platformNet: Number(between(rng, 60, 90).toFixed(6)),
      exchangeNet: Number(between(rng, 60, 90).toFixed(6)),
      gap: Number(between(rng, 0.2, 1.2).toFixed(6)),
      platformSelf: Number(between(rng, 10, 20).toFixed(6)),
      foreignNet: 0,
      foreignRounds: 0,
      openCosts: Number(between(rng, 0.01, 0.2).toFixed(6)),
      checkedAt: spread(rng, 0.2),
    }),
  );

  /* 机器人之外的活动：账户里出现了不是本机器人挂的单造成的成交。 */
  settings.set(
    `foreign_activity:${foreign.id}`,
    JSON.stringify({
      rounds: intBetween(rng, 1, 3),
      net: Number(between(rng, -6, 6).toFixed(6)),
      symbols: ['BTCUSDT', 'ETHUSDT'],
      firstAt: spread(rng, 6),
      lastAt: spread(rng, 1),
      detectedAt: spread(rng, 0.1),
    }),
  );
}

/* -------------------------------------------------------------------------- */
/*  日志                                                                       */
/* -------------------------------------------------------------------------- */

const LOG_SCOPES = ['trader', 'binance', 'api', 'risk', 'market', 'store', 'llm'] as const;

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
  { level: 'info', text: '数据库迁移完成 v19（paper-trading）' },
  { level: 'info', text: '对账窗口往前留 7 天：收养的仓位开在机器人创建前，窗口在持仓中间截断会导致开/平判反' },
  /* 超长行（≈450 字）—— 用来验证日志正文在极端长度下的换行与滚动。 */
  {
    level: 'warn',
    text:
      '这是一条刻意写得极长的日志，用来验证日志面板在遇到超长正文时的完整行为：它首先应当在容器宽度内自然换行，其次不应当把右侧的级别/来源/时间三列挤到可视区域之外，再次不应当让整个面板出现横向滚动条；如果三者中任意一条不成立，说明正文容器缺少 min-width:0 或 break-words。' +
      '这条日志还刻意包含一段很长且没有空格的连续内容：BTCUSDT_ETHUSDT_SOLUSDT_BNBUSDT_XRPUSDT_DOGEUSDT_ADAUSDT_AVAXUSDT_LINKUSDT_DOTUSDT_MATICUSDT_LTCUSDT_ATOMUSDT_UNIUSDT_APTUSDT_ARBUSDT_OPUSDT_SUIUSDT_SEIUSDT_TIAUSDT_1000PEPEUSDT_1000SHIBUSDT_WIFUSDT_ORDIUSDT_JUPUSDT，' +
      '以及一个超长单号 seed-e-99999-1234567890-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ。',
  },
];

/**
 * 灌运行时日志（含团队步骤）。
 *
 * ## 为什么按"填满 500 行"而不是写 600 行再裁
 *
 * `RUNTIME_LOG_CAP = 500`，`runtimeLogs.trim()` 按 **id 倒序保留最后 500 行**。
 * 先写 600 再裁，被删掉的是**最早插入的 100 行** —— 而时间乱序插入时
 * 那未必是最旧的日志。直接算好配额（团队步骤 ~30%）再按时间升序插入，
 * 表的内容才是**可控且可复现**的。
 *
 * ## 团队步骤为什么必须在日志里
 *
 * 岗位出勤（`/agent/:role/steps`、`agent/last-seen`、`TeamBoard` 的编制表）
 * 都从 `scope='team'` 的 `[phase] role：note` 行里解析出来。没有这些行，
 * 界面上十几个岗位全部显示"待命"—— 而那是一个**假事实**（它们其实跑过）。
 */
function seedLogs(
  rng: () => number,
  tradersInfo: ReadonlyArray<{ id: number; name: string }>,
  teamTraderIds: readonly number[],
): { total: number; teamSteps: number } {
  const db = getDb();
  const cap = 500;
  type Row = { traderId: number | null; level: string; scope: string; message: string; atMs: number };
  const rows: Row[] = [];

  /*
   * 团队步骤占 30%：两个团队机器人各分一半。
   * 这样 `runtime_logs` 里每个岗位都有多条（`TEAM_STEPS` 有 13 种），
   * 出勤表与"某岗位历史"两端都能读到东西。
   */
  const teamQuota =
    teamTraderIds.length === 0 ? 0 : Math.min(160, Math.floor(cap * 0.3));
  const perTeamTrader = teamTraderIds.length > 0 ? Math.floor(teamQuota / teamTraderIds.length) : 0;
  for (const traderId of teamTraderIds) {
    for (let i = 0; i < perTeamTrader; i += 1) {
      /*
       * 前几条落在最近 1 小时内：界面上的"最近活跃于 X 分钟前"才有意义 ——
       * 全是 14 天前的日志会让所有岗位显示"很久没动过"。
       *
       * ⚠️ 这几条要**覆盖不同角色**：如果按顺序取前 4 个步骤，恰好全是
       * `dispatch`/`supervisor`（角色行排在前面），于是"最近活跃"只有主管有、
       * 其余岗位全是 14 天前 —— 一个看起来像"只有主管在干活"的假象。
       */
      const RECENT_STEP_INDEXES = [0, 4, 7, 10, 12, 11];
      const step =
        i < RECENT_STEP_INDEXES.length
          ? TEAM_STEPS[RECENT_STEP_INDEXES[i]!]!
          : TEAM_STEPS[i % TEAM_STEPS.length]!;
      const atMs =
        i < RECENT_STEP_INDEXES.length
          ? Date.now() - rng() * 60 * 60_000
          : Date.now() - Math.sqrt(rng()) * 14 * DAY_MS;
      rows.push({
        traderId,
        level: step.note.includes('失败') ? 'error' : 'info',
        scope: 'team',
        /* ⚠️ 形状必须是 `[phase] role：note`（见 TEAM_STEPS 的注释）。 */
        message: `[${step.phase}] ${step.role}：${step.note}`,
        atMs,
      });
    }
  }

  /* 其余是普通的运行日志，一部分绑定到具体机器人（详情页/出勤判据按 trader 过滤）。 */
  for (let i = rows.length; i < cap; i += 1) {
    const sample = pick(rng, LOG_MESSAGES);
    const attachToTrader = tradersInfo.length > 0 && rng() < 0.55;
    rows.push({
      traderId: attachToTrader ? pick(rng, tradersInfo).id : null,
      level: sample.level,
      scope: pick(rng, LOG_SCOPES),
      message: sample.text,
      atMs: Date.now() - Math.sqrt(rng()) * 14 * DAY_MS,
    });
  }

  /*
   * **必须按时间升序插入**：`runtimeLogs.list()` 按 `id DESC` 取最近 N 行再
   * reverse 展示。id 顺序与时间顺序不一致时，日志面板上相邻两行的时间会跳来
   * 跳去 —— 看起来像"日志时间坏了"，实际是插入顺序的问题。
   */
  rows.sort((a, b) => a.atMs - b.atMs);
  for (const row of rows) {
    db.run(
      'INSERT INTO runtime_logs (trader_id, level, scope, message, created_at) VALUES (?, ?, ?, ?, ?)',
      row.traderId,
      row.level,
      row.scope,
      row.message,
      new Date(row.atMs).toISOString(),
    );
  }
  /* 插完之后裁一次，与运行期的行为一致（表不会无限长）。 */
  runtimeLogs.trim();
  return { total: rows.length, teamSteps: rows.filter((r) => r.scope === 'team').length };
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
   * ## `settings` 里的两台"台账"也要清
   *
   * `ledger_check:<id>` / `foreign_activity:<id>` 是运行期写在 `settings` 里的
   * 告警读数，**没有外键指向 traders** —— 删了机器人它们会留下来变成孤儿。
   * 后果不是崩溃，而是"新建的机器人 id 恰好复用时，页面上出现了上一台的账目差额"。
   * 这正是演示脚本应该顺手清干净的那类残留。
   */
  if (traderIds.length > 0) {
    for (const traderId of traderIds) {
      for (const key of [
        `ledger_check:${traderId}`,
        `foreign_activity:${traderId}`,
        `watchlist:${traderId}`,
        `param_change_log:${traderId}`,
      ]) {
        db.run('DELETE FROM settings WHERE key = ?', key);
      }
    }
  }

  /*
   * 模型健康读数同理：`llm_health:<modelId>` 没有外键。
   * 删模型时不删它，界面上"最近一次调用"会显示一条来自已删除模型的记录
   * （界面上找不到那条模型，于是那行读数永远没地方展示）。
   */
  for (const row of modelRows) db.run('DELETE FROM settings WHERE key = ?', `llm_health:${row.id}`);

  /*
   * 默认模型指针：**只在不指向任何现存模型时清掉**。
   *
   * 这里有一个真实的两难：`seed` 会把默认模型指向 magpie；如果 magpie 那条是
   * `useMagpieModel.ts` 创建的（标签不带 `[示例]`、`--clean` 不会删它），
   * 那么这个指针仍然有效，**不该清**。只有当它指向一条被删掉的示例模型时，
   * 留着它才会让"新建机器人"读到不存在的模型 id。
   */
  const defaultModelId = settings.get('default_ai_model_id');
  if (defaultModelId !== undefined && defaultModelId !== null && defaultModelId !== '') {
    const stillExists = db.get<{ id: number }>('SELECT id FROM ai_models WHERE id = ?', Number(defaultModelId));
    if (stillExists === undefined) settings.set('default_ai_model_id', '');
  }

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
    "SELECT COUNT(*) AS n FROM runtime_logs WHERE scope IN ('trader','binance','api','risk','market','store','llm','team','selfcheck')",
  );
  if (logCount > 0) {
    db.run(
      "DELETE FROM runtime_logs WHERE scope IN ('trader','binance','api','risk','market','store','llm','team','selfcheck')",
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
