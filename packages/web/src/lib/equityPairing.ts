import type { EquitySnapshot } from '@aq/shared';

/**
 * 把「id → 权益快照」的成对结果合并成一张按 **id** 索引的表。
 *
 * ## 为什么单独一个纯函数
 *
 * `OverviewPage` 拉每个机器人的权益曲线时，旧写法是 `Promise.all(ids.map(...))`，
 * 拿到的是一个**位置数组**：`data[i]` 属于*发出那次请求时*的第 i 个 id。而下游
 * 按**当前** `traders` 的下标取用（`data[index]`）。机器人增删或改序之后，
 * 两者就错位 —— A 的曲线被记到 B 头上，直接错报首屏的权益合计与曲线。
 *
 * `usePolled` 的 `setData` 只在成功时调用、失败时保留旧 data，所以一次失败的轮询
 * 会把旧顺序的数组无限期留在位置上，错配窗口不是一瞬而是直到下次成功。
 *
 * 走 id 配对之后，唯一剩下的错配是"这一轮没请求到某个 id"（正确留空），不再张冠李戴。
 * 抽成纯函数是为了能被 `.test.ts` 覆盖 —— 组件 effect 在本仓库无 jsdom，测不了，
 * 但配对这件事本身可以（与 `fleetTotals.ts` 同一套做法：算术出组件、进可测模块）。
 */
export function pairEquityByTrader(
  pairs: ReadonlyArray<{ id: number; rows: EquitySnapshot[] }>,
): Record<number, EquitySnapshot[]> {
  const out: Record<number, EquitySnapshot[]> = {};
  for (const { id, rows } of pairs) out[id] = rows;
  return out;
}
