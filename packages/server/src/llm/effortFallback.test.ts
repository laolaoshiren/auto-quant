import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextReasoningEffort } from './effortFallback.js';

/* -------------------------------------------------------------------------- */
/*  连续超时后自动降低推理量                                                    */
/* -------------------------------------------------------------------------- */

test('★ 连续网关超时后把思考等级降一档 —— 否则每一轮都跑不完', () => {
  /*
   * ## 实测（2026-10-01）
   *
   * 一次 100K tokens 的请求要 **220 秒**，其中推理（`reasoning_content`）
   * 占 **2 万 tokens** —— 也就是说**耗时几乎全在"想"上**，提示词处理只占一小部分。
   *
   * 而链路上的网关等 **100 秒**没有响应头就发 `HTTP 524`。实测一轮 8 轮里
   * **4 次**这样失败，每次都要重试 3 遍（`elapsedMs` 累计 380 秒）才彻底放弃 ——
   * **整轮决策作废，还烧掉三倍的 token**。
   *
   * ## 为什么这属于"系统保障"而不是"替模型判断"
   *
   * `reasoningEffort` 是**模型运行配置**（AI 可以用 `set_params` 改），
   * 而这里做的不是"决定它该想多深"，而是：**当这一轮已经因为超时失败过，
   * 下一次用更小的思考预算把这一轮救回来**。判断的内容一点没变 ——
   * 该看什么、该不该出手，仍然是模型的事。
   *
   * ## 为什么是"降一档"而不是"直接关掉"
   *
   * 思考是这个机器人判断质量的主要来源（它的入场标准很细）。
   * 一次降一档、只降不升到本轮结束，既能让重试有机会跑完，
   * 也不会把一次偶发拥堵变成"以后都不想了"。
   */
  assert.equal(nextReasoningEffort('high', 0), 'high', '没有超随时不动它');
  assert.equal(nextReasoningEffort('high', 1), 'medium', '超时一次就降一档');
  assert.equal(nextReasoningEffort('high', 3), 'low', '继续超时就继续降');
  assert.equal(nextReasoningEffort('medium', 1), 'low');
});

test('已经是最低档时保持不变 —— 不要降到不存在的档位', () => {
  assert.equal(nextReasoningEffort('low', 5), 'low');
});

test('没有配置思考等级时返回 undefined，不要凭空加一个', () => {
  /*
   * `reasoningEffort` 是可选项：`undefined` 表示"不发送这个参数"，
   * 而那是**有意义的配置**（有些 provider 不认它）。
   * 凭空给一个值会让那些 provider 直接 400 —— 那是我们在制造故障。
   */
  assert.equal(nextReasoningEffort(undefined, 3), undefined);
});
