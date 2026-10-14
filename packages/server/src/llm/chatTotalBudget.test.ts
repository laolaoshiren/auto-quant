/**
 * **单次超时不该被理解成"总时长"**（2026-10-14 线上实测抓到的真问题）
 *
 * ## 现象
 *
 * 线上配置 `ai_models #13`（`group/auto-deepseek-v4-1-flash`，`#10` 与 `#11` 都在用）：
 * ```
 *   timeout_seconds = 600
 *   max_retries     = 2
 * ```
 * 而实测（`server.log`，17,366 次调用里）：
 * ```
 *   >600s 的调用   39 次
 *   最慢           900068ms（15 分钟）
 *   次慢           898698 / 898570 / 896519 / 890876 / 882969
 * ```
 * **而交易周期本身就是 15 分钟** —— 于是「一次调用吃掉整个周期，那一轮没有任何产出」。
 *
 * ## 根因
 *
 * `timeoutSeconds` 只作用于**单次 HTTP 请求**（它被传给
 * `executeJsonRequest({ timeoutMs })`），而 `chat()` 会按 `maxRetries` 重试。
 * 所以总时长的上界是：
 * ```
 *   timeoutMs × (maxRetries + 1) + 退避
 *   = 600 × 3 + 退避 ≈ 1830s（30 分钟）
 * ```
 * **运维看到的数字（600s）与他实际得到的行为（最多 30 分钟）不一致** ——
 * 那比"慢"更糟：它让"调小超时"这个动作看起来会生效，实际不会。
 *
 * ## 修法
 *
 * 给 `chat()` 一个**显式的总时长预算**，在**发起下一次尝试之前**检查：
 * ```
 *   totalBudgetMs = min(timeoutMs × (maxRetries + 1), 20 分钟)
 * ```
 * ⚠️ 检查点在"发起之前"而不是"失败之后"：前者省掉一次注定超时的请求
 * 与它的退避等待，后者会把总时长再撑长一整轮。
 *
 * ⚠️ 为什么封顶 20 分钟而不是"一个周期"：重试的价值在于"上游偶发失败能救回来"
 *（见 `DEFAULT_MAX_RETRIES` 那段用户原话）。要防的是**失控**，不是"偶尔慢"。
 * 周期到点会先看这一轮跑完没有（`cycleInFlight` 守卫）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../testUtils/sourceText.js';

const CLIENT = readFileSync(new URL('./client.ts', import.meta.url), 'utf8');
const CODE = codeOnly(CLIENT);

test('★★★ 必须有总时长预算常量（不能只靠单次超时）', () => {
  assert.ok(
    /const MAX_TOTAL_CHAT_MS = 20 \* 60_000;/.test(CODE),
    '★ 必须有总时长封顶 —— 否则 timeout × retries 可以到 30 分钟',
  );
});

test('★★★ chat() 必须在【发起下一次尝试之前】检查预算', () => {
  /*
   * ⚠️ 判据：预算检查必须在 `for` 循环体的【开头】，且早于 `this.attempt(`。
   */
  const at = CODE.indexOf('const totalBudgetMs =');
  assert.ok(at > 0, '★ 必须算出总预算');
  const body = CODE.slice(at, at + 2500);
  const checkAt = body.indexOf('elapsedMs >= totalBudgetMs');
  const attemptAt = body.indexOf('await this.attempt(');
  assert.ok(checkAt > 0, '★ 必须有预算检查');
  assert.ok(
    attemptAt > 0 && checkAt < attemptAt,
    '★ 检查必须在发起请求【之前】—— 放在失败之后会把总时长再撑一轮',
  );
});

test('★★★ 到达预算时抛超时错误（让上层换模型，而不是继续等）', () => {
  const at = CODE.indexOf('const totalBudgetMs =');
  const body = CODE.slice(at, at + 2500);
  assert.ok(
    /throw timeoutError\(this\.provider, elapsedMs\)/.test(body),
    '★ 到达预算要抛超时 —— 上层（ModelRouter）有候选链降级',
  );
});

test('★★★ 只在 attempt > 0 时检查（第一次必须让它跑）', () => {
  /*
   * ⚠️ 若第一次就检查，一个"单次超时大于剩余预算"的配置会在**没发任何请求**
   * 的情况下失败 —— 那是把功能改坏了，不是修好。
   */
  const at = CODE.indexOf('const totalBudgetMs =');
  const body = CODE.slice(at, at + 2500);
  assert.ok(
    /if \(attempt > 0 && elapsedMs >= totalBudgetMs\)/.test(body),
    '★ 第一次尝试必须无条件放行',
  );
});

test('★★ 日志必须把"单次超时 × 重试 = 实际总时长"讲清楚', () => {
  /*
   * ⚠️ 没有这条日志，运维只会看到一堆"慢"，而不会知道
   * "配置的 600s 与实际的 20 分钟对不上"是刻意的。
   */
  assert.ok(
    /perAttemptTimeoutMs: this\.timeoutMs/.test(CODE),
    '★ 日志要带上单次超时（否则无法把两个数对上）',
  );
  assert.ok(
    /单次超时 × 重试次数 = 实际总时长/.test(CLIENT),
    '★ 日志要说清这个因果关系',
  );
});

test('★★ 预算公式必须同时受"重试次数"与"封顶"约束', () => {
  assert.ok(
    /Math\.min\(this\.timeoutMs \* \(this\.maxRetries \+ 1\), MAX_TOTAL_CHAT_MS\)/.test(CODE),
    '★ 预算 = min(单次超时 × (重试+1), 封顶)',
  );
});
