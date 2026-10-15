/**
 * **"这一轮的决策是不是全部不行动"** —— 唯一判据（2026-10-15 抽出）。
 *
 * ## 为什么它必须只有一份
 *
 * 这个判断被**两处**用到，而两处必须给出同一个答案：
 * ```
 *   routedModel.askRiskOfficer()      决定【要不要叫风控官】
 *   agent/deskOutput.renderDeskOutcome() 决定【审计块里怎么写"没审阅"的原因】
 * ```
 * 若各写一份，就会出现自相矛盾的审计记录 —— 实测过的形状：
 * ```
 *   跳过是因为"裁决全是 skip"
 *   而审计块写"风控角色未启用或调用失败"
 *   ⇒ 操作员去查一个不存在的问题
 * ```
 *
 * ## 为什么是黑名单（fail-closed）
 *
 * 只有明确属于"不行动"的三个才跳过，其余（**含将来新增的动作**）
 * 一律送去风控。反过来（白名单"哪些算动作"）会让每加一个新动作
 * 都默认落到"不算动作"里 —— 那意味着**新的动作类型不会被风控审**。
 *
 * ⚠️ 这条与 `NON_ACTION` 原来的注释同源，只是它现在住在共享模块里。
 */

/** 明确属于"不行动"的动作 —— 除此之外都要送风控。 */
export const NON_ACTION: ReadonlySet<string> = new Set(['skip', 'hold', 'wait']);

/**
 * 这一轮的决策是否**全部**是不行动？
 *
 * ⚠️ 空数组返回 `false` —— "没有决策"与"全是 skip"是**两种不同的情况**，
 * 调用方需要分开处理（前者是"本轮不行动"，后者是"评了但都不做"）。
 */
export function allNonAction(decisions: readonly { action: string }[]): boolean {
  return decisions.length > 0 && decisions.every((d) => NON_ACTION.has(d.action));
}
