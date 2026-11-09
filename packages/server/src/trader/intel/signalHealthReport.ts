/**
 * **信号健康度报告** —— 把 `signalHealth.assessSignal()` 接到真实数据上。
 *
 * ## 它接的是哪条断链（2026-11-09 审计发现）
 *
 * ```
 *   情报（freshness）→ 决策标注 intel_keys → positions.intel_keys
 *                                            ↓ 平仓搬运
 *                          trades.intel_keys ──只写不读──✗
 *                                            ↓
 *                          attribution.ts（只有测试引用）
 *                                            ↓
 *                          signalHealth.assessSignal()（只有测试引用）
 * ```
 *
 * `docs/archive/FINDING-clerk-unwired.md` 里曾写"`clerk` 的职责已由 `attribution.ts` +
 * `signalHealth.ts` 承担" —— **那句话与事实不符**：那两个文件在生产代码里
 * 零调用，`trades.intel_keys` 也没有读取侧。`clerk` 缺的那块能力（"这个信号
 * 引用之后结果如何"）**同样不存在**。
 *
 * 本文件补上最后一段：读仓储 → 按信号归组 → `assessSignal()` → 一行可读结论。
 *
 * ## ⚠️ 它只做**观测**，不参与决策
 *
 * 报告只写日志（操作员在控制台的日志/周期步骤里能看到），**不降权、不过滤、
 * 不改变任何决策**。把健康度喂给模型（提示词）或用来拦截信号，会改变交易行为，
 * 那需要单独的产品决策。
 *
 * ## ⚠️ 反应衰减（`detectReactionDecay`）为什么这里不评估
 *
 * 它需要**开仓时那条情报的权重**（`freshness.decay().weight`），而
 * `trades.intel_keys` 只存键、不存权重。所以：
 *
 * ```
 *   归因记录里的 signalStrength 只能填等权占位 1
 *   ⇒ 单位强度收益的比较失去意义（分母全都一样）
 *   ⇒ detectReactionDecay 不适用于当前数据，本报告**不输出**它
 * ```
 *
 * 要接上它，需要新增一列（或另存一份 `signalKey → weight`），并改写入侧 ——
 * 那是一次迁移 + 写入路径改动，属于下一轮（需要 Lead 决策）。
 *
 * ## 与 `factSheet.ts` 的分工
 *
 * | | `factSheet.ts` | 本文件 |
 * |---|---|---|
 * | 回答 | "最近发生了什么"（五类事实按时间混合） | "**这个信号**还有效吗" |
 * | 粒度 | 逐条事实 | 按信号聚合的结论 |
 * | 输出 | `entries[]` | `signals[]` + 一句话摘要 |
 */

import {
  trades as tradeStore,
  type TradeIntelAttributionRow,
} from '../../store/repositories.js';
import { signalsWithEnoughSamples, tradesForSignal, type Attribution } from './attribution.js';
import {
  assessSignal,
  SIGNAL_LIMITS,
  type SignalHealth,
  type SignalVerdict,
} from './signalHealth.js';

/**
 * 归因回看窗口（天）。
 *
 * `signalHealth` 的判据需要每个信号 ≥ `SIGNAL_LIMITS.MIN_SAMPLES`（20）笔样本，
 * 而消息面成交本来就稀疏 —— 窗口太短会让所有信号永远停在 `insufficient_data`。
 * 90 天是"足够积累样本"与"不无限增长"之间的折中（另有
 * `TRADE_INTEL_ATTRIBUTION_MAX` 的条数上限兜底）。
 *
 * ⚠️ 这是一个**起步值**，应按实测样本量校准（与 `SIGNAL_LIMITS` 上的说明一致）。
 */
export const SIGNAL_HEALTH_WINDOW_DAYS = 90;

/** 一个信号的健康度结论。 */
export interface SignalHealthEntry {
  /** `attribution.signalKeyOf()` 的键：`<来源域名>|<方向>|<标的们>`。 */
  signalKey: string;
  verdict: SignalVerdict;
}

/** 一份可读、可序列化的信号健康度报告。 */
export interface SignalHealthReport {
  /** 生成时刻（ISO）。 */
  generatedAt: string;
  /** 归因窗口起点（含，ISO）。 */
  windowStart: string;
  /** 窗口内**由情报驱动**的已平仓成交笔数（不是信号样本数）。 */
  attributedTrades: number;
  /**
   * 样本量足够的信号结论，**最严重的在前**（failed → decaying → effective）。
   *
   * 样本不足的信号不在这里 —— `assessSignal()` 对它们只会返回保守的
   * `insufficient_data`，列出来只会稀释真正需要看的那几条。
   */
  signals: SignalHealthEntry[];
  /** 窗口内被引用过、但样本不足以下结论的信号键数量。 */
  belowSampleSignals: number;
  /**
   * 一句话中文摘要（给人看，可直接进日志）；**没有任何够样本的信号时为 null**。
   *
   * 返回 null 而不是"一切正常"：样本不足时**没有结论**，把它说成"健康"
   * 是编造（§3.2）。
   */
  summary: string | null;
}

/** 排序权重：越该被先看到越靠前。 */
const SEVERITY: Record<SignalHealth, number> = {
  failed: 0,
  decaying: 1,
  insufficient_data: 2,
  effective: 3,
};

/**
 * 从**已读出的归因行**构建报告（纯函数，不碰数据库）。
 *
 * @param rows 每笔"由情报驱动"的已平仓成交（`trades.intelAttributionsSince()` 的产出）
 */
export function buildSignalHealthReport(
  rows: readonly TradeIntelAttributionRow[],
  options: { windowStart: string; generatedAt?: string },
): SignalHealthReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  /*
   * 一笔成交可能同时引用**多条**情报（`intel_keys` 是数组），所以这里按
   * "成交 × 键"展开成归因记录 —— 与 `Attribution` 的语义一致（一条 = 一个
   * 信号的一次成交）。同一个键在数组里重复出现时只算一次（`new Set`）：
   * 重复计数会把样本量虚增，让 `MIN_SAMPLES` 提前成立。
   */
  const attributions: Attribution[] = [];
  const allKeys = new Set<string>();
  for (const row of rows) {
    const closedAt = Date.parse(row.closedAt);
    if (!Number.isFinite(closedAt)) continue;
    for (const signalKey of new Set(row.intelKeys)) {
      allKeys.add(signalKey);
      attributions.push({
        signalKey,
        returnPct: row.returnPct,
        /*
         * ⚠️ **等权占位，不是真实信号强度** —— 见文件头"反应衰减为什么不评估"。
         *
         * `SignalTrade.signalStrength` 只被 `detectReactionDecay()` 使用；
         * `assessSignal()` 不看它。所以填 1 不会污染本报告的任何结论，
         * 而它让"归因 → 信号成交"这段形状保持完整（将来补上真实权重后，
         * 这里换成权重即可，调用方不用改）。
         */
        signalStrength: 1,
        closedAt,
      });
    }
  }

  const enoughSampleKeys = signalsWithEnoughSamples(attributions, SIGNAL_LIMITS.MIN_SAMPLES);
  const signals = enoughSampleKeys
    .map((signalKey) => ({
      signalKey,
      verdict: assessSignal(tradesForSignal(attributions, signalKey)),
    }))
    .sort(
      (a, b) =>
        SEVERITY[a.verdict.health] - SEVERITY[b.verdict.health] ||
        /* 同一档位内样本多的优先 —— 结论更稳。 */
        b.verdict.samples - a.verdict.samples,
    );

  return {
    generatedAt,
    windowStart: options.windowStart,
    attributedTrades: rows.length,
    signals,
    belowSampleSignals: allKeys.size - enoughSampleKeys.length,
    summary: summarize(signals, allKeys.size),
  };
}

/**
 * 读仓储并生成报告。
 *
 * 仓储层只回"发生了什么"（成交、收益、时间），判定逻辑全部在
 * `signalHealth` / `attribution` 这两个纯函数模块里 —— 这样报告可以用
 * fixture 直接测，不需要数据库。
 */
export function signalHealthReportFor(
  traderId: number,
  options: { windowStart: string; generatedAt?: string; limit?: number },
): SignalHealthReport {
  const rows = tradeStore.intelAttributionsSince(traderId, options.windowStart, options.limit);
  return buildSignalHealthReport(rows, options);
}

/**
 * **日志去重用的状态键** —— 只包含"需要关注"的那部分（失效/衰减的信号与档位）。
 *
 * 为什么不直接用 `summary` 当键：摘要里带样本数与胜率，那些数字每出现一笔新成交
 * 就会变 —— 拿它当键等于每轮都写一条日志，把真正的告警埋掉（这个仓库为"每轮都响
 * 的告警"写过三段注释，见 `AutoTrader.emitOnChange`）。
 *
 * 一个信号从 `decaying` 升级成 `failed` 时键会变（`=health` 部分），
 * 所以"病情加重"不会漏报。
 */
export function signalHealthStateKey(report: SignalHealthReport): string {
  const attention = report.signals
    .filter((s) => s.verdict.health === 'failed' || s.verdict.health === 'decaying')
    .map((s) => `${s.signalKey}=${s.verdict.health}`)
    .sort();
  return attention.length > 0 ? attention.join('|') : 'all-effective';
}

/** 一行摘要：只把**需要关注**的写具体，"有效"的只报个数。 */
function summarize(signals: readonly SignalHealthEntry[], totalSignals: number): string | null {
  if (signals.length === 0) return null;
  const failed = signals.filter((s) => s.verdict.health === 'failed');
  const decaying = signals.filter((s) => s.verdict.health === 'decaying');
  const effective = signals.filter((s) => s.verdict.health === 'effective');
  const detail = (s: SignalHealthEntry): string => `${s.signalKey} — ${s.verdict.reason}`;

  const parts: string[] = [];
  if (failed.length > 0) parts.push(`失效 ${failed.length} 个（${failed.map(detail).join('；')}）`);
  if (decaying.length > 0) parts.push(`衰减中 ${decaying.length} 个（${decaying.map(detail).join('；')}）`);
  if (effective.length > 0) parts.push(`有效 ${effective.length} 个`);
  const omitted = totalSignals - signals.length;
  const tail = omitted > 0 ? `（另有 ${omitted} 个信号样本不足，未下结论）` : '';
  return `消息面信号健康度：${parts.join('，')}${tail}。`;
}
