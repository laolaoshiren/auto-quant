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

/* -------------------------------------------------------------------------- */
/*  结构化取"分支体"：不用字符窗口、不依赖缩进                                     */
/* -------------------------------------------------------------------------- */

/**
 * 从 `startIndex` 处的开括号取出一段**配平**的文本（跳过字符串、模板串与行注释）。
 *
 * ⚠️ 与 `riskOnlyPath.test.ts` 的 `balancedFrom()` 同一手法（t63 立的规矩）。
 * ⚠️ 取不到闭合就**抛错**，不返回空串 —— "扫描失败但静默通过"的守卫等于没有守卫。
 */
function balancedFrom(text: string, startIndex: number): string {
  const open = text[startIndex];
  if (open !== '{' && open !== '(' && open !== '[') {
    throw new Error(`balancedFrom 的起点不是括号（位置 ${startIndex}）—— 扫描失效`);
  }
  const close = open === '{' ? '}' : open === '(' ? ')' : ']';
  let depth = 0;
  let quote: string | null = null;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  throw new Error(
    `从位置 ${startIndex} 开始的 ${open} 没有闭合 —— 源码被改了形状，守卫必须报错而不是沉默`,
  );
}

/**
 * 抹掉注释（块注释与行注释），**保留换行与长度**。
 *
 * ## 为什么判据必须先把注释抹掉（本仓库已吃过的亏）
 *
 * `docs/AGENTS.md` 与 `testUtils/cssText.ts` 都记着同一件事：
 * "断言源码里不能出现 X" 而 X **正出现在解释那段历史的注释里** ⇒ 假失败。
 * 本文件里就有活例子：`routedModel.ts` 的 agent 层分支里
 * **注释里写着 `runTradingDesk`**（解释"为什么要转给单模型"）——
 * 不抹注释的话，`!body.includes('runTradingDesk')` 这条判据会**立刻假红**。
 *
 * ⚠️ 不是"为了让它绿"才抹：注释不是代码路径，**判据本来就该只看代码**。
 * 判据的语义是"这条分支会不会真的去跑团队编排"，而注释不会跑任何东西。
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * 取出 `if (agentLayerCall) { … }` 的**整段分支体**（含外层花括号）。
 *
 * ## 为什么不再用 `[\s\S]{0,1600}?return` 那种字符窗口（t80 的教训）
 *
 * 那条判据原来锚在两个**脆弱的文本特征**上：
 * ```
 *   /if \(agentLayerCall\) \{[\s\S]{0,1600}?return /                  ← 字符窗口 1600
 *   /if \(agentLayerCall\) \{([\s\S]{0,2400}?)\n      \}/             ← 窗口 2400 + 精确缩进
 * ```
 * 于是**任何在分支内加注释的正常改动**都会把它撞红（实测：t80 把 `role` 的归属改对
 * 并写了说明注释，两条断言同时失败 —— 而行为一个字节都没错）。
 * 反过来更危险：只要有人把分支写紧一点，`{0,2400}` 里又会**提前**匹配到某个内层 `}`，
 * 判据开始检查半截源码 —— **看着像真的，比彻底失效更糟**。
 *
 * ⇒ 改成**按花括号配平**取整段：分支长短、缩进、注释多少都与它无关。
 * 这与 `riskOnlyPath.test.ts` 的 `balancedFrom()` 是同一手法。
 */
function agentLayerBranch(): string {
  const at = ROUTED.indexOf('if (agentLayerCall) {');
  assert.ok(at >= 0, '★ 找不到 `if (agentLayerCall) {` —— 判据本身失效了，先修这个');
  return balancedFrom(ROUTED, ROUTED.indexOf('{', at));
}

/**
 * 判据本体：**这段分支体有没有缺陷**。
 *
 * 抽成独立函数是**为了负向校准** —— 人造源码可以被直接喂进来，
 * 而不必去伪造一整个 `routedModel.ts`。
 *
 * @param branch 分支体源码（未抹注释；函数内部自己抹）
 * @returns 缺陷说明；`null` = 没发现缺陷
 */
function agentLayerBranchProblem(branch: string): string | null {
  const body = stripComments(branch);
  /*
   * ① 必须 `return`：不 return 就会继续往下跑团队编排 —— 那正是这个 BUG 的形状。
   * ⚠️ 判据是"代码里有 return"（注释已被抹掉），不是"某个字符窗口里有 return"。
   */
  if (!/\breturn\b/.test(body)) {
    return '分支不 return —— 会继续跑团队会议（原始 BUG 的形状）';
  }
  /* ② 必须真的走单模型调用。 */
  if (!/callByTier|singleModel\.complete/.test(body)) {
    return '分支里既没有 callByTier 也没有 singleModel.complete —— 那它没把调用转给单模型';
  }
  /* ③ 绝对不能再跑交易台。 */
  if (/runTradingDesk/.test(body)) {
    return '分支里跑了 runTradingDesk —— 那正是要防的 BUG';
  }
  return null;
}


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
   * 取 runSingleShot 的**函数体**（配平），确认它拼上了标记。
   *
   * ⚠️ 原来是 `LOOP.slice(at, at + 900)` —— 又一个**字符窗口**判据（同一个文件的另一处）。
   * 900 之内只要有人在函数开头多加几行注释，断言就会在**半截函数**上做判断：
   * 「判据锚在脆弱的文本特征上」的同一个形态，所以一并换成配平。
   */
  const at = LOOP.indexOf('export async function runSingleShot');
  assert.ok(at > 0, '★ 应当能找到 runSingleShot');
  const body = balancedFrom(LOOP, LOOP.indexOf('{', at));
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
  /*
   * ## 判据形态（t80 重写）
   *
   * 原来是两条**字符窗口**正则：
   * ```
   *   /if \(agentLayerCall\) \{[\s\S]{0,1600}?return /          ← 窗口 1600
   *   /if \(agentLayerCall\) \{([\s\S]{0,2400}?)\n      \}/     ← 窗口 2400 + 精确缩进
   * ```
   * t80 在那个分支里**加了一段注释**（把 `role: 'supervisor'` 改成真实归属，
   * 并说明为什么不能挂到总管名下）—— 行为完全正确，而两条断言同时变红：
   * **分支体一长过窗口就匹配不到**。
   *
   * 反过来更危险：窗口是**贪婪上界**，窗口内一旦出现某个内层 `}`，
   * 正则就会提前收尾 —— 判据开始检查**半截源码**。
   * 「判据锚在脆弱的文本特征上」正是本仓库反复吃亏的形态
   *（同文件里另一处曾用行号偏移做判据，整整偏了 2 行 —— 看着像真的，比偏 5000 行更危险）。
   *
   * ⇒ 现在按**花括号配平**取整段分支体，分支长短/缩进/注释多少都与判据无关。
   */
  const problem = agentLayerBranchProblem(agentLayerBranch());
  assert.equal(problem, null, `★★★ agent 层分支必须把调用转给单模型且不再跑交易台：${problem}`);
});

test('★★★ 负向校准：这条判据必须真的能抓住缺陷（否则它只是恒真的装饰）', () => {
  /*
   * ## 为什么必须有这一条
   *
   * 把"字符窗口正则"换成"配平取分支体"是一次**判据重写**，
   * 而重写判据最大的风险是**把它换成恒真式** —— 那样测试全绿、缺陷照样溜过去。
   * 所以这里把两类真缺陷**人造出来**，逐条断言判据会红。
   *
   * ⚠️ 校准对象是**字符串**，不读真实文件 —— 所以它不会因为实现改动而失效。
   */
  const GOOD =
    'if (agentLayerCall) {\n' +
    '  /* 注释里的 runTradingDesk 不该被当成代码 */\n' +
    '  onStep?.({ role: r, phase: "route", note: "工具循环调用 → 转给单模型（团队会议只回答交易决策）" });\n' +
    '  if (singleModel !== undefined) { return singleModel.complete(systemPrompt, userPrompt); }\n' +
    '  const res = await router.callByTier("T2_mid", msgs, { baseMaxTokens });\n' +
    '  return { text: res.text, latencyMs: 0, usage: { promptTokens: null, completionTokens: null } };\n' +
    '}';
  assert.equal(
    agentLayerBranchProblem(GOOD),
    null,
    '★ 判据把正确实现判成了缺陷 —— 那会变成"怎么改都红"，先修判据',
  );

  /*
   * ★ **"加注释"这个动作本身不得影响判据** —— 这正是原来那两条字符窗口断言失败的原因。
   * 对同一份源码插一大段注释，行为一字未改 ⇒ 判据必须仍然说"没问题"。
   */
  const GOOD_WITH_COMMENTS = GOOD.replace(
    'if (agentLayerCall) {',
    'if (agentLayerCall) {\n' +
      '        /*\n' +
      '         * 这里放一大段"为什么不是 supervisor"的说明（t80 真实加过的那段）。\n' +
      "         * 里面还提到 runTradingDesk 这个词 —— 注释不该被当成代码。\n" +
      '         * ' + 'x'.repeat(400) + '\n' +
      '         */',
  );
  assert.equal(
    agentLayerBranchProblem(GOOD_WITH_COMMENTS),
    null,
    '★★★ 在分支里加注释不能把判据撞红 —— 那正是这次重写要修的形状（原来锚在 1600/2400 字符窗口上）',
  );

  /* ① 分支不 return（原始 BUG 的形状：继续往下跑团队会议）。 */
  const NO_RETURN =
    'if (agentLayerCall) {\n' +
    '  onStep?.({ role: r, phase: "route", note: "工具循环调用 → 转给单模型" });\n' +
    '  const res = await router.callByTier("T2_mid", msgs, {});\n' +
    '}';
  assert.match(
    agentLayerBranchProblem(NO_RETURN) ?? '',
    /不 return/,
    '★★★ 分支不 return 必须被判为缺陷 —— 否则这条守卫抓不到它存在的理由',
  );

  /* ② 分支里跑了交易台（那正是这个文件存在的理由）。 */
  const RUNS_DESK = GOOD.replace(
    'const res = await router.callByTier("T2_mid", msgs, { baseMaxTokens });',
    'const outcome = await runTradingDesk({ ask, marketContext, newsContext, positionContext: "" });',
  );
  assert.match(
    agentLayerBranchProblem(RUNS_DESK) ?? '',
    /runTradingDesk/,
    '★★★ 分支里跑 runTradingDesk 必须被判为缺陷',
  );

  /* ③ 既不 return 也不走单模型（另一种缺陷组合）。 */
  const NEITHER = 'if (agentLayerCall) {\n  const x = 1;\n}';
  assert.ok(agentLayerBranchProblem(NEITHER) !== null, '★★★ 空分支必须被判为缺陷');
});

test('★★★ 分支必须闭合成合法形状 —— 扫描失败要抛错，不能静默通过', () => {
  /*
   * `balancedFrom` 取不到闭合时抛错。若它改成"返回空串"，上面那条判据会
   * 对一段**空字符串**做断言 —— `!body.includes('runTradingDesk')` 恒真 ⇒ 无声失效。
   * 所以这条把"畸形源码必须抛错"钉住。
   */
  assert.throws(
    () => balancedFrom('if (x) { const a = 1;', 7),
    /没有闭合/,
    '★★★ 未闭合的分支必须抛错 —— 静默返回空串会让判据对畸形源码一律通过',
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
