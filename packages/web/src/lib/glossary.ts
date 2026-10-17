/**
 * **用户可见名称的唯一登记处**（2026-10-17 · 台账 UI-10 / UI-11）。
 *
 * ## 为什么需要它
 *
 * 同一个东西在界面上有多个名字，用户就得先花时间判断"这两个名字说的是不是一件事"。
 * 实测（`文案与语言约定校对.md`）：
 * ```
 *   strategy 模式   固定策略 / 普通 / 按策略参数       ← 三个名字
 *   页面            策略工作室（侧栏）/ 策略工坊（标题、返回链接、FAQ）
 *   三套模板        稳健/进取/短线（shared 的 label）/ 保守/激进/短线（编辑器按钮）
 *   模拟盘          模拟 / 模拟盘 / 纸面模式 …
 * ```
 *
 * 所以这里做两件事：
 * 1. **登记**每个概念的唯一用户可见名称（组件从这里取，不写字面量）；
 * 2. 给出**禁用别名清单**，由 `glossary.test.ts` 在源码层扫出来 ——
 *    一个名字改回去，测试立刻红，而不是等用户在截图上发现。
 *
 * ## ⚠️ 为什么登记在 `web/` 而不是 `shared/`
 *
 * 本任务（`t47` B4）的写作用域是 `packages/web/src/**`；`shared/` 里的
 * `STRATEGY_PRESETS[].label`（稳健/进取/短线）**已经**是唯一事实源，
 * 这里只是把它取过来用，不改它的值（红线：不改模板数值）。
 * 将来若要给服务端日志也用同一套名字，应当把这份表上移到 `@aq/shared`。
 */

import { STRATEGY_PRESETS, type TraderMode } from '@aq/shared';

/**
 * 三种运行模式的用户可见名称。
 *
 * `Record<TraderMode, string>` 而不是 `Record<string, string>`：**漏一个取值就编译不过**
 * —— 与 `roster.ts` 的 `ROLE_STATE_BY_STATUS` 同一条纪律（那里写着"把静默降级
 * 变成编译期就红"）。
 */
export const MODE_LABEL: Record<TraderMode, string> = {
  strategy: '固定策略',
  ai_managed: '智能托管',
  ai_team: 'AI 团队',
};

/** 一句话说明每种模式的**代价**（用户靠它决定"这台要不要一直开着"）。 */
export const MODE_HINT: Record<TraderMode, string> = {
  strategy: '按策略参数跑，不调用模型 —— 秒级一轮，不花模型额度',
  ai_managed: '一个模型负责决策 —— 每轮一次调用，1–10 分钟',
  ai_team: '一支智能体团队开会决策 —— 每轮多次调用，数分钟',
};

/** 页面名登记（导航、标题、返回链接、FAQ 全部取这里）。 */
export const PAGE_LABEL = {
  overview: '总览',
  traders: '机器人',
  strategy: '策略工作室',
  market: '行情',
  models: 'AI 模型',
  exchanges: '交易所',
  account: '操作员账户',
  data: '数据与日志',
  appearance: '外观',
  faq: '帮助',
} as const;

/**
 * 三套模板（`conservative` / `aggressive` / `scalping`）的**用户可见名称**。
 *
 * ⚠️ 名字的唯一事实源是 `@aq/shared` 的 `STRATEGY_PRESETS[].label`（稳健/进取/短线），
 * 这里只是把它取出来 —— **不得**在界面里另起一套别名（编辑器按钮上曾经写着
 * 「保守 / 激进 / 短线」，与列表页、与系统提示词里的名字对不上：用户会以为
 * 模板换了）。取不到时**回落到 id 本身**而不是编一个中文名：那样至少能 grep。
 */
export function presetLabel(id: string): string {
  return STRATEGY_PRESETS.find((preset) => preset.id === id)?.label ?? id;
}

/**
 * **禁用别名** —— 用户可见文本里不允许再出现这些写法。
 *
 * 只登记"整词级别、不会误伤普通表达"的别名：像「普通」这样一个词，
 * 在别处可能是"普通模式之外的解释"这类正常中文，但它作为**模式名**的用法
 * 已经全部换成 `MODE_LABEL.strategy`，所以整词仍然进清单（`glossary.test.ts`
 * 按**字符串字面量**匹配，不会命中注释与散文）。
 */
export const BANNED_ALIASES: readonly string[] = [
  /** `strategy` 模式的旧名（三个名字里的另外两个）。 */
  '按策略参数',
  '普通模式',
  /** 页面旧名。 */
  '策略工坊',
  /** 三套模板的两套旧名（编辑器按钮上用过）。 */
  '保守',
  '激进',
];

/* -------------------------------------------------------------------------- */
/*  模拟盘 / 实盘：三态与它的唯一判据                                            */
/* -------------------------------------------------------------------------- */

/**
 * **这台机器人现在在不在模拟盘** —— 与**服务端** `isPaperTrader()` 同一条取值顺序。
 *
 * ```
 *   ① 运行时（`stats.dryRun`，来自 manager）—— 正在跑的那台以它为准
 *   ② 落库的操作员选择（`trader.dryRun`）—— 停止的机器人只有这一份
 *   ③ 进程级默认（`system.dryRun`）—— 从未被指定过时的回落
 * ```
 *
 * ⚠️ 三个事实源**必须分开传进来**，不允许在调用点先合并成一个布尔值：
 * 服务端注释（`server.ts:2328-2331`）明确写着"顶栏那个徽章读的是进程级 `env.dryRun`，
 * 两者可以不一致，所以**必须分开说**"。把它们混成一个显示值，正是用户
 * 「智能托管模式 / 普通模式不清楚」的一半成因（台账 UI-11）。
 */
export function isPaperView(input: {
  /** `stats.dryRun`：`null` = 没在运行、读不到。 */
  runtimeDryRun: boolean | null | undefined;
  /** `trader.dryRun`：`undefined` = 从未指定过（**不是** false）。 */
  persistedDryRun: boolean | null | undefined;
  /** `system.dryRun`：进程级默认。 */
  processDryRun: boolean | null | undefined;
}): boolean {
  if (input.runtimeDryRun === true) return true;
  if (input.runtimeDryRun === false) return false;
  if (input.persistedDryRun === true) return true;
  if (input.persistedDryRun === false) return false;
  return input.processDryRun === true;
}

/**
 * 模拟盘 / 实盘的用户可见名称。`null` = 读不到（**不要显示成"实盘"**）。
 *
 * ⚠️ 三态：`true` 模拟盘、`false` 实盘、`null` **未知**。
 * 把"读不到"渲染成"实盘"会让操作员以为一台停止的机器人在花真钱；
 * 反过来渲染成"模拟"会让他在花真钱时以为是纸面 —— 两侧都是真钱事故。
 */
export function paperLabel(paper: boolean | null): string {
  if (paper === null) return '未知（未在运行）';
  return paper ? '模拟盘' : '实盘';
}
