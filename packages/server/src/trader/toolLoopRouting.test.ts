/**
 * **团队模型不能接管工具循环的调用**（2026-10-13）。
 *
 * ## 为什么单独一条测试
 *
 * 这是一个**"看起来在正常工作、实际全部失败"**的 BUG：
 * ```
 *   #11 的 agent_runs：全部 outcome=failed
 *   agent_experiments：**0 条**
 *   而界面上看不出异常（策略师确实在跑、日志确实在写）
 * ```
 *
 * ## 事故的形状
 *
 * `ai_team` 的团队模型挂在机器人的**模型出口**上
 *（`manager.ts` 的 `DecisionModel.complete`），所以**任何**调用都会进来 ——
 * 包括 `agent/loop.ts` 的工具循环（策略师、绩效分析、复盘员…）。
 *
 * 而工具循环解析的是**工具调用 JSON**：
 * ```
 *   {"thought":"…","tool":"get_experiments","args":{…}}
 * ```
 * 实测它收到的是（`agent_runs.detail` 原文）：
 * ```
 *   模型连续两轮没有输出可解析的工具调用：
 *   无法从回复里解析出 JSON 对象（前 120 字符：<decision>
 *   []
 *   </decision>
 *   …
 *   <team>
 *   交易台：分析师 2/2 成功 · 做多论证已出）
 * ```
 * **也就是说：策略师每走一步，系统就召集 8 个角色开一次会** ——
 * 那正是实测 `324–870 秒/轮` 的来历。而结果是必然失败。
 *
 * ## 而"每轮 8 次调用"的代价
 *
 * ```
 *   策略师一轮（panel 档 6 步）→ 6 × 团队会议 = 最多 48 次模型调用
 *   而 6 步本来只需要 6 次
 * ```
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ROUTED = readFileSync(new URL('./routedModel.ts', import.meta.url), 'utf8');
const LOOP = readFileSync(
  new URL('./agent/loop.ts', import.meta.url),
  'utf8',
);

test('★★★ 团队模型必须能识别"这次是工具循环在调用"', () => {
  assert.ok(
    /export const TOOL_LOOP_MARKER/.test(ROUTED),
    '★ 必须有那个可识别的标记',
  );
  /*
   * ⚠️ 2026-10-15 改：判据从"直接用 TOOL_LOOP_MARKER 比对"放宽为
   * "经一个具名判据函数"，因为**单次结论档也要被认出来**（见下一条测试）。
   */
  assert.ok(
    /isAgentLayerCall\(systemPrompt\)/.test(ROUTED) ||
      /systemPrompt\.includes\(TOOL_LOOP_MARKER\)/.test(ROUTED),
    '★ 必须在 complete() 里用它做判据',
  );
});

test('★★★ 标记必须与 loop.ts 的协议说明【逐字一致】', () => {
  /*
   * ⚠️ 这是本修复**唯一的脆弱点**：两处文本必须同步。
   * 若哪天有人改了 `loop.ts` 的措辞而没改这里，
   * 症状会**回到**"策略师全部失败、而界面上看不出来"。
   *
   * 所以这里直接从两个文件里各取一次那个字面量，比对它们相等。
   */
  const markerMatch = /export const TOOL_LOOP_MARKER = '([^']+)'/.exec(ROUTED);
  assert.ok(markerMatch !== null, '★ 必须能取出标记的字面量');
  const marker = markerMatch[1] ?? '';
  assert.ok(
    LOOP.includes(marker),
    `★★★ 标记「${marker}」必须逐字出现在 loop.ts 的协议说明里（两处必须同步）`,
  );
});

test('★★★ 单次结论档（`runSingleShot`）也必须被认出来 —— 否则它跑整个交易台', () => {
  /*
   * ## 事故（2026-10-15，两个独立审计各自独立抓到）
   *
   * `TOOL_LOOP_MARKER` 只存在于 `runToolLoop` 的 `PROTOCOL` 里，而
   * **`runSingleShot` 不拼 `PROTOCOL`**（它是"不开工具循环"的档）——
   * 于是它的调用被判成"交易决策" → **跑整个交易台**。
   *
   * 受影响的是 `performance_analyst` / `attribution_analyst`（panel 档）
   * 与**复盘员**。实测后果：
   * ```
   *   #11（ai_team）: 39 笔成交 · agent_memory 【0 行】· 「复盘」日志 0 条
   *   #10（ai_managed）: 192 笔 · agent_memory 111 行
   *   ⇒ 团队模式【从未从自己的交易结果里学到任何东西】，而日志一条错误都没有
   *
   *   agent_runs #833/#834: failed 29s/33s tokens_in=0
   *     detail：单次调用的输出无法解析：…（前 120 字符：<decision>
   *   ↑ 这段文案是 runSingleShot 独有的 —— 直接证明它被劫持了
   * ```
   *
   * ## 判据
   *
   * ```
   *   ① loop.ts 必须导出一个 agent 层标记
   *   ② runSingleShot 的 system 必须带上它
   *   ③ complete() 的判据必须同时认两个标记
   * ```
   */
  assert.ok(
    /export const AGENT_CALL_MARKER/.test(LOOP),
    '★ loop.ts 必须导出 agent 层标记（单一来源，不在两处各写一遍字面量）',
  );
  /*
   * 取 runSingleShot 的函数体，确认它拼上了标记。
   */
  const at = LOOP.indexOf('export async function runSingleShot');
  assert.ok(at > 0, '★ 应当能找到 runSingleShot');
  const body = LOOP.slice(at, at + 900);
  assert.ok(
    /AGENT_CALL_MARKER/.test(body),
    '★ runSingleShot 的 system 必须带上 agent 层标记 —— 否则它会被当成交易决策、跑整个交易台',
  );
  /* complete() 必须同时认两个标记。 */
  assert.ok(
    /systemPrompt\.includes\(TOOL_LOOP_MARKER\)/.test(ROUTED) &&
      /systemPrompt\.includes\(AGENT_CALL_MARKER\)/.test(ROUTED),
    '★ complete() 的判据必须同时认"工具循环"与"单次结论"两种 agent 调用',
  );
});

test('★★★ agent 层的调用必须转给单模型，而不是跑团队会议', () => {
  /* 分支必须存在，且必须返回（不能继续往下走团队编排）。 */
  assert.ok(
    /if \(agentLayerCall\) \{[\s\S]{0,1600}?return /.test(ROUTED),
    '★ agent 层分支必须 return（否则会继续跑团队会议）',
  );
  /* 它必须走单模型调用（`callByTier`），而不是 `runTradingDesk`。 */
  const branch = /if \(agentLayerCall\) \{([\s\S]{0,2400}?)\n      \}/.exec(ROUTED);
  assert.ok(branch !== null, '★ 必须能定位那个分支');
  const body = branch[1] ?? '';
  assert.ok(
    /callByTier|singleModel\.complete/.test(body),
    '★ 必须走单模型（callByTier 或注入的 singleModel）',
  );
  assert.ok(
    !/runTradingDesk/.test(body),
    '★ 分支里不能再跑交易台（那正是 BUG）',
  );
});

test('★ 转给单模型这件事必须【可见】（不能静默）', () => {
  /*
   * ⚠️ 否则将来排查"策略师为什么不调参"时会看到一个谜：
   * 团队模型明明在，工具循环却拿到了普通回答。
   */
  assert.ok(
    /工具循环调用 → 转给单模型/.test(ROUTED),
    '★ 必须有可见的说明（onStep / 日志）',
  );
});
