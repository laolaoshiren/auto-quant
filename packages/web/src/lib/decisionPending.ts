/**
 * 识别服务端 `decisionStore.begin()` 提前落库的「进行中占位行」（pending）。
 *
 * 背景（2026-11-26 用户截图标报真 BUG）：
 * - 服务端在每轮周期**开始时**先插一行 `pending` 审计占位行（`aiLatencyMs = 0`、
 *   `decisions = []`、`executionLog = []`、`rawResponse = ''`、`error = null`、`success = true`），
 *   轮次末尾再用 `decisionStore.finish()` 原地 UPDATE 补完终态；
 * - 若前端在周期仍在进行中（例如刚跑了 9 秒）拉到这条未完成占位行，把它当成品渲染：
 *   1. `showLive` 会误判“第 #N 轮已出结果”从而把「AI 正在思考…」进度条顶掉；
 *   2. 列表顶部闪出 `#98 · 9 秒前 · 用量未回传 · 0 ms · 本周期模型没有给出任何决策。`；
 *   3. 更糟的是旧 `mergeFresh` 按 `id` 永不覆盖已缓存行，导致 `finish()` 同 `id` 的终态记录
 *      还会被旧轮询里的 pending 占位行盖回空白。
 *
 * 本模块提供统一判据（与服务端 `repositories.ts` 的 `latestWithPending` 逐字段对齐），
 * 让 `DecisionFeed`、`DecisionArchiveModal` 与 `OverviewPage` 共享同一事实源。
 */
import type { DecisionRecord } from '@aq/shared';

/** 认为一条 pending 占位行仍处于活跃在途的最大时间窗（25 分钟；覆盖最慢的 20 分钟长思考）。 */
export const ACTIVE_PENDING_MAX_AGE_MS = 25 * 60_000;

/**
 * 判断一条决策记录是否仍为 `decisionStore.begin()` 写入、尚未经 `finish()` 补完的空占位行。
 */
export function isPendingDecisionRecord(record: DecisionRecord): boolean {
  return (
    (record.aiLatencyMs ?? 0) === 0 &&
    record.error == null &&
    record.success !== false &&
    (record.decisions?.length ?? 0) === 0 &&
    (record.executionLog?.length ?? 0) === 0 &&
    !(record.rawResponse && record.rawResponse.trim().length > 0) &&
    !(record.cotTrace && record.cotTrace.trim().length > 0)
  );
}

/**
 * 判断一条 pending 占位行是否属于「当前仍在运行中」的在途周期。
 *
 * 满足其一即判定为活跃在途：
 * 1. `isRunning` 为真，且与 WebSocket 正在跟踪的 `liveCycleNumber` 同周期号；
 * 2. `isRunning` 为真，且是列表最新一条占位行、距今不超过 25 分钟（兼容页面中途刷新丢失 `cycle_start` 场景）。
 */
export function isActiveInFlightPending(
  record: DecisionRecord,
  options: {
    isRunning: boolean;
    liveCycleNumber?: number;
    nowMs?: number;
  },
): boolean {
  if (!options.isRunning || !isPendingDecisionRecord(record)) return false;
  if (options.liveCycleNumber !== undefined && record.cycleNumber === options.liveCycleNumber) {
    return true;
  }
  const ts = Date.parse(record.timestamp);
  if (!Number.isFinite(ts)) return false;
  const ageMs = (options.nowMs ?? Date.now()) - ts;
  return ageMs >= -60_000 && ageMs <= ACTIVE_PENDING_MAX_AGE_MS;
}

/**
 * 合并两条同 `id` 的决策记录时，**已完成终态永远优先于 pending 占位行**，
 * 防止陈旧 REST 轮询的 pending 占位行把 WebSocket 刚推到的终态结果覆写回空白。
 */
export function preferCompletedDecision(
  prev: DecisionRecord,
  incoming: DecisionRecord,
): DecisionRecord {
  const prevPending = isPendingDecisionRecord(prev);
  const nextPending = isPendingDecisionRecord(incoming);
  if (!prevPending && nextPending) return prev;
  return incoming;
}
