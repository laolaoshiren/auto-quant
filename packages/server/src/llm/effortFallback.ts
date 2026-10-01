/**
 * 连续网关超时后把思考等级降一档。
 *
 * ## 实测（2026-10-01）
 *
 * 一次 100K tokens 的请求要 **220 秒**，其中推理（`reasoning_content`）占
 * **2 万 tokens** —— **耗时几乎全在"想"上**，提示词处理只占一小部分。
 *
 * 而链路上的网关（Cloudflare）等 **100 秒**没有响应头就发 `HTTP 524`。
 * 实测一轮 8 轮里 **4 次**这样失败，每次重试 3 遍（`elapsedMs` 累计 380 秒）
 * 才彻底放弃 —— **整轮决策作废，还烧掉三倍 token**。
 *
 * （流式请求也试过：它只在**我方 ↔ 网关**这一跳让响应头提前回来；
 * 而**网关 ↔ 模型服务**那一跳如果网关不流式转发，它仍在等完整结果。
 * 实测 `#1788` 在流式上线后仍然是 `HTTP 524`。）
 *
 * ## 为什么这是"系统保障"而不是"替模型判断"
 *
 * `reasoningEffort` 是**模型运行配置**（AI 能自己改）。这里做的不是
 * "决定它该想多深"，而是：**当这一轮已经因为超时失败过，用更小的思考预算
 * 把这一轮救回来**。判断内容一点没变 —— 看什么、做不做，仍然是模型的事。
 *
 * ## 为什么只降一档、且本实例内不回升
 *
 * 思考是这个机器人判断质量的主要来源（它的入场标准很细）。一次降一档
 * 能让重试有机会跑完；而"不回升"是为了避免"降了→成功→升回去→又超时"的振荡 ——
 * 那会让每轮的成功率取决于上一次的运气。
 */

export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * 下一次请求该用什么思考等级。
 *
 * @param current 当前配置的等级（`undefined` = 不发这个参数，保持不变）
 * @param timeoutCount 这一实例内已经发生过的"网关超时"次数
 */
export function nextReasoningEffort(
  current: ReasoningEffort | undefined,
  timeoutCount: number,
): ReasoningEffort | undefined {
  if (current === undefined) return undefined;
  if (!Number.isFinite(timeoutCount) || timeoutCount <= 0) return current;
  /* 每超时一次降一档，最低到 low。 */
  const ladder: ReasoningEffort[] = ['low', 'medium', 'high'];
  const currentIndex = ladder.indexOf(current);
  if (currentIndex <= 0) return 'low';
  const steps = Math.min(currentIndex, Math.floor(timeoutCount));
  return ladder[currentIndex - steps] ?? 'low';
}
