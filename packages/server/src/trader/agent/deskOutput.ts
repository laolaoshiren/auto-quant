/**
 * **团队决策 → 交易循环格式的适配器**。
 *
 * ## 为什么需要它（这是 S3 能不能真正跑起来的关键一环）
 *
 * `autoTrader` 对模型的输出**只有一个契约**（见 `strategy/prompt.ts` 的「输出格式要求」）：
 *
 *     <decision>
 *     [ {"symbol":"BTCUSDT","action":"open_long", ...} ]
 *     </decision>
 *
 * 而交易台的产出是**多角色结构化卡片**（分析、论证、裁决）。两者形状不同，
 * 中间必须有一层翻译 —— 否则团队跑完一轮，交易循环解析不到任何决策，
 * **整轮白跑**（而且不会报错，只是"没有动作"，那是最难发现的一种失败）。
 *
 * ## 设计原则：**翻译必须可审计、不吞信息**
 *
 * 用户要求「看得见系统在做什么」。所以：
 *
 *   · 裁决里的**决策数组**原样搬进 `<decision>` 块（不做任何"智能"加工）；
 *   · 各角色的论证**附在后面**（`<team>` 块），让操作员能看到"为什么这么决策"；
 *   · **解析失败时不编造** —— 返回空决策块 + 说明，而不是猜一个动作。
 *
 * ## 风控官关卡（用户需求 #3）
 *
 * 裁决之后、渲染之前，**风控官**会再审一遍（见 `riskOfficer.ts`）：
 * 它可以否决或削减。它的结论写进 `<risk>` 块。
 *
 * ⚠️ **本层仍不做风控计算** —— 它只负责"把风控官的结论应用上去"。
 * 真正的物理底线在 `RiskEngine`（下一层），**那一层不可绕过**。
 */

import { isCloseAction, type Decision, type DecisionAction } from '@aq/shared';
import type { DeskOutcome } from './tradingDesk.js';
/*
 * ⚠️「全部不行动」的判据只有一份 —— 与 askRiskOfficer 共用（见该模块）。
 * 各写一份会出现"跳过是因为全是 skip、文案却说调用失败"的自相矛盾审计记录。
 */
import { allNonAction } from './nonAction.js';

/** 从裁决的原始文本里抽出决策数组。 */
export interface ExtractedDecisions {
  /** 抽到的决策数组（`null` = 没抽到）。 */
  decisions: unknown[] | null;
  /**
   * 抽到的原因。
   *
   * 五种状态**各说一件事**（混在一起会让"模型判断不做"与"系统故障"看起来一样）：
   *   · `ok`             —— 抽到数组，且每个元素都是带 `action` 的决策
   *   · `empty`          —— 抽到 `[]` —— **这是合法结论**（模型明确说"不行动"），不是故障
   *   · `not-decisions`  —— 解析出数组了，但它**不是决策数组**（见 `looksLikeDecision`）
   *   · `no-block`       —— 文本里根本没有 `[`（模型只写了散文，或这一轮没产出）
   *   · `bad-json`       —— 有未闭合的 `[`，或片段解析失败（可能是被截断）
   *
   * ⚠️ `not-decisions` / `empty` / `ok` 由 `extractDecisionArray` 产出；
   * 通用的 `extractFirstJsonArray` 只会给 `ok` / `empty` / `no-block` / `bad-json`
   *（它不知道"什么算决策"）。
   */
  status: 'ok' | 'empty' | 'not-decisions' | 'no-block' | 'bad-json';
  /** `bad-json` / `not-decisions` 时的原始片段（截断，供排查）。 */
  snippet?: string;
}

/**
 * **这个数组看起来是不是"决策数组"** —— 判据只有一个：元素带 `action`。
 *
 * ## 为什么必须有这一条（2026-10-15，线上 `c192` 实测）
 *
 * ```
 *   id=2761 · cycle=192 · decisions_json=[]
 *   raw_response:  <decision>
 *                  [-1]                                  ← 进了交易循环
 *                  </decision>
 * ```
 *
 * 而那个 `[-1]` **不是模型给的决策** —— 它是裁决官在推理里写的
 * `close[-1]`（"最后一根收盘价"）被 `extractFirstJsonArray` 当成数组抓走了。
 *
 * 后果不在安全面（`strategy/parser.ts` 会拒掉这种元素，本轮仍然不行动），
 * 而在**审计面**：汇报员拿着 `[-1]` 写出
 * 「本轮团队唯一一条决策不带 action 字段……需操作员核实是否漏发动作」——
 * **一条假告警，而操作员无从核实**（模型从来没给过那个"决策"）。
 * 审计块唯一的作用就是"事后说清当时为什么这么做"，它不能自己造假线索。
 *
 * ⚠️ 全库统计：286 轮里只出现 1 次。但判据是**纯形态**的
 *（推理里凡有 `xxx[-1]` / `[0]` / `[-6]` 这类下标写法都可能被抓），
 * 而裁决官的推理里大量使用这种写法 —— 所以必须在这一层挡住。
 *
 * ⚠️ 判据刻意**只看形态、不看语义**：带 `action` 就交给下游
 *（`strategy/parser.ts` 才是做语义校验的那一层：action 枚举、候选集、止损方向…）。
 * 在这里顺手做语义校验会变成"两处各有一份校验规则"，而那正是本仓库反复踩过的坑。
 */
export function looksLikeDecision(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'action' in value;
}

/**
 * **裁决文本 → 决策数组**（在通用抽取器之上加一层"这是不是决策"的形态判据）。
 *
 * ## 为什么不把形态判据写进 `extractFirstJsonArray`（我第一版就是这么写的，被测试打回）
 *
 * `extractFirstJsonArray` 的契约是**通用的**："从任意文本里抽出第一个 JSON 数组"。
 * 现有测试钉着它，而且钉得有道理：
 * ```
 *   '[{"a":1},"多余的"]'                        → 依然是"抽到了数组"（ok）
 *   '[{"symbol":"BTC","levels":[1,2,3]}]'       → 依然是"抽到了数组"（ok）
 * ```
 * 把"元素必须带 action"塞进去，会让这两个用例里 `status` 从 `ok` 变成别的 ——
 * 也就是**改了一个通用函数的语义去服务一个专用调用点**。实测代价：9 个既有用例变红。
 *
 * ## 所以分层：通用抽取归通用，"这是不是决策"归这里
 *
 * ```
 *   extractFirstJsonArray(text)  → 找到了吗？是不是坏 JSON？      （原样不动）
 *   extractDecisionArray(text)   → 再问一句：它是不是【决策】数组？（本函数）
 * ```
 * 而这一层**只被裁决/决策的消费方用**（`renderDeskOutcome`）。
 * ⚠️ 反过来，`askRiskOfficer` 用通用抽取器也**不会**出事 ——
 * 它拿 `not-decisions` 之外的东西时 `decisions.length === 0`，直接跳过风控官，
 * 结果与用本函数一致（都是"没决策、不叫风控官"）。
 *
 * ## 五种状态各说一件事（`empty` 与 `not-decisions` 是这次新增的两种）
 *
 * ```
 *   ok             抽到真决策数组
 *   empty          抽到 [] —— 模型明确"不行动"（合法结论，不是故障）
 *   not-decisions  抽到了数组，但它不是决策（见上面 c192 的 [-1]）
 *   no-block       压根没有数组
 *   bad-json       有未闭合的 [ 或解析失败 —— 确凿的截断
 * ```
 */
export function extractDecisionArray(text: string): ExtractedDecisions {
  const base = extractFirstJsonArray(text);
  if (base.status !== 'ok') {
    /*
     * ⚠️ `empty` 原样透传 —— 那是**合法结论**，绝不能与 `no-block` 混成一句
     *（混了以后"模型说这轮不做"和"模型没给数组"在审计块里长得一样）。
     */
    return base;
  }
  const decisions = base.decisions ?? [];
  /* 空数组由 `extractFirstJsonArray` 直接返回 `empty`，这里只需判"是不是决策"。 */
  if (decisions.some((d) => !looksLikeDecision(d))) {
    return {
      decisions: null,
      status: 'not-decisions',
      snippet: JSON.stringify(decisions).slice(0, 200),
    };
  }
  return { decisions, status: 'ok' };
}

/**
 * 从任意文本里抽出**第一个 JSON 数组**（**通用**函数，不做"这是不是决策"的判断）。
 *
 * ## 为什么要自己扫括号而不是正则
 *
 * 正则 `\[[\s\S]*\]` 在**嵌套数组**上会贪婪匹配到最后一个 `]`，
 * 于是 `[{"a":[1,2]},{"b":3}]` 后面的尾巴会被吃进来变成非法 JSON。
 * 而模型的输出里嵌套数组很常见（止损止盈的数组、理由里的列表）。
 *
 * 所以扫括号计数，且**跳过字符串内部的括号** —— 否则 `{"reasoning":"买[入]点"}`
 * 会让计数错位。
 *
 * ⚠️ **抽的是第一个平衡数组，不是最后一个** —— 这一条是实测定的，别顺手改（2026-10-15）：
 * 裁决官的输出常被 4,000 字 clip 截断，而**推理里最后那个 `[` 往往是未闭合的
 * `close[-1]` / `[` 残片**。我对着线上 `#11` 的**全部 287 条**记录量过两种策略：
 * ```
 *   改成"最后一个可解析数组" → 会改坏 **112 轮**
 *     （把 6 条真决策读成 `close[-1]` 那 1 条残片；而"救回来"的轮次是 0）
 * ```
 * ⇒ "第一个"不是随手写的，是量过之后的选择。
 */
export function extractFirstJsonArray(text: string): ExtractedDecisions {
  const start = text.indexOf('[');
  if (start < 0) return { decisions: null, status: 'no-block' };

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          const parsed: unknown = JSON.parse(slice);
          if (!Array.isArray(parsed)) {
            return { decisions: null, status: 'bad-json', snippet: slice.slice(0, 200) };
          }
          /*
           * ⚠️ **空数组是合法结论** —— 它必须与"没抽到"分开报（2026-10-15）。
           *
           * 模型写 `[]` 的意思是"这一轮不行动"，而 `decisions: []` 与
           * `decisions: null` 在调用方是**两种不同的分支**：
           * ```
           *   []     → 评过了，结论是不做（与"全是 skip"同源）
           *   null   → 根本没抽到 —— 要报"这一轮是格式/预算问题"
           * ```
           * 两者原来都返回 `ok` + `[]`，于是渲染层**没有告警** ——
           * 而"模型给了空数组"与"模型没给数组"混在一起时，
           * 审计块无法回答"这一轮到底是有意不做，还是输出坏了"。
           */
          if (parsed.length === 0) return { decisions: [], status: 'empty' };
          return { decisions: parsed, status: 'ok' };
        } catch {
          return { decisions: null, status: 'bad-json', snippet: slice.slice(0, 200) };
        }
      }
    }
  }
  /* 括号没闭合 —— 输出被截断了（实测确有此事：token 上限）。 */
  return { decisions: null, status: 'bad-json', snippet: text.slice(start, start + 200) };
}

/**
 * 把交易台的产出翻成 `autoTrader` 能解析的文本。
 *
 * ## 输出的三部分
 *
 * 1. **`<decision>` 块** —— 交易循环唯一认的东西。裁决里抽到的决策数组搬进来。
 * 2. **`<risk>` 块** —— 风控官的结论（批准/削减/否决 + 理由）。**审计用。**
 * 3. **`<team>` 块** —— 各角色产出摘要。**审计用。**
 *
 * 后两部分**不影响解析**（`autoTrader` 只找 `<decision>`），但它们是
 * "为什么这么决策"的唯一现场 —— 用户明确要求看得见。
 *
 * ## 风控官怎么接进来
 *
 * 由调用方把**已经问过风控官的结论**传进来（`risk`），本函数只负责
 * **把它应用到决策上**并渲染。
 *
 * 为什么不在这里问风控官：那需要一次模型调用，而本函数是**纯函数**
 *（有测试钉着、无 IO）。把 IO 留在调用方，这一层就能被测得很细 ——
 * 而"削减多少、否决了怎么办"正是最该被测的部分。
 */
export function renderDeskOutcome(
  outcome: DeskOutcome,
  risk?: {
    /** 风控官是否放行。 */
    approved: boolean;
    /** 削减后的决策（`null` = 没削减）。 */
    adjusted: Decision[] | null;
    /** 风控官给的理由。 */
    reason: string;
    /** 它担心什么。 */
    concern: string | null;
    /** 风控官用的模型（审计）。 */
    modelId?: string | null;
    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️ **为什么没审 —— 三种原因必须分开说**（2026-10-15 修）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * 原来的文案对**所有**"没审阅"的情况都写同一句：
     * ```
     *   ⚠️ 本轮未经风控官审阅（风控角色未启用或调用失败）—— 决策按裁决官结论直接放行。
     * ```
     * 而实测（`#11`，272 轮）**74% 的轮次**都是这一句，它们的真实原因是：
     * ```
     *   ① 裁决官给的决策【全是 skip】→ 设计内跳过（"没有动作就没有风险敞口可审"）
     *      —— 这是【正常】，而且是省一次 ~120 秒调用的【有意优化】
     *   ② 真的调用失败
     *   ③ 角色未启用
     * ```
     * 而 ① 占了绝大多数。**把"设计内跳过"写成"未启用或调用失败"，
     * 会让操作员去查一个不存在的问题** —— 与"把故障说成观望"是同一类病，
     * 只是方向相反。
     *
     * ## 判据来源
     *
     * `askRiskOfficer` 本来就区分了这三种（它通过 `onStep` 分别写
     * 「裁决结果全是"不行动"（N 条）—— 风控官无需审阅，省一次调用」与
     * 「调用失败：…」），只是**渲染时把信息丢掉了**。
     *
     * ⚠️ `'all_non_action'` 是**唯一可以由代码确定**的那一种
     *（它由 `NON_ACTION` 集合判定，不是猜的）；另外两种留给调用方传。
     */
    skipReason?: 'all_non_action' | 'call_failed' | 'not_enabled' | null;
  } | null,
  /**
   * 额外的渲染信息。
   *
   * ⚠️ 单独一个参数（而不是塞进 `risk`）—— 因为**它描述的是"`risk` 为 null 时
   * 为什么是 null"**，而 `risk` 为 `null` 时没有对象可以挂字段。
   */
  extra?: { skipReason?: 'all_non_action' | 'call_failed' | 'not_enabled' | null },
): string {
  const verdict = outcome.verdict;
  /*
   * ⚠️ **决策消费方用 `extractDecisionArray`**（带"这是不是决策"的形态判据）——
   * 而通用的 `extractFirstJsonArray` 保持原契约不变。见 `extractDecisionArray` 的说明。
   */
  const extracted =
    verdict?.ok === true
      ? extractDecisionArray(verdict.raw)
      : { decisions: null, status: 'no-block' as const };
  /*
   * ⚠️ **"为什么没审"要自己推出来，不能等调用方传**（2026-10-15）。
   *
   * `all_non_action` 这一种**完全由代码可判定** —— 它就是
   * `askRiskOfficer` 里那条 `!hasAction` 分支的条件（用同一个 `NON_ACTION` 集合）。
   * 若靠调用方传，一旦有人忘了传，文案就会退回那句笼统的
   * "未启用或调用失败" —— 而它占 74%，等于没修。
   *
   * 另外两种（真失败 / 未启用）**这里判不出来**（失败信息在调用方手里），
   * 所以只有调用方显式传了才用；否则如实说"原因未记录"，
   * **不猜**（猜错比不写更糟）。
   */
  const decisionsForRisk = (extracted.decisions ?? []) as Decision[];
  const riskSkipReason =
    extra?.skipReason ??
    risk?.skipReason ??
    (allNonAction(decisionsForRisk) ? 'all_non_action' : null);

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **把模型产出整理成"人能读的一行"**（2026-10-14 两次用户反馈）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 第一次反馈：「出现大量 `<reasoning>`、空的，还有杂乱无章」
   *
   * 两件事：
   * ```
   *   ① 模型的产出是【多行 markdown】，它的列表项 `- **实体**：…`
   *      被前端 `teamTrace.ts` 当成了"角色" → 看板上冒出十几行假岗位
   *   ② 展开后第一行是 `<reasoning>` —— 那是模型输出的**机器包装标签**，
   *      不是给人看的内容，却占了 300 字预算里最显眼的位置
   * ```
   *
   * ## 修法：**先剥标签，再压单行**
   *
   * ```
   *   ✗ <reasoning> 让我先把这轮材料按我自己的规则走一遍…
   *   ✓ 让我先把这轮材料按我自己的规则走一遍…
   * ```
   *
   * ⚠️ 剥的是**项目自己的输出契约标签**（`AGENTS.md` §5.2：XML 标签是机器契约）——
   * `renderDeskOutcome` 自己也在产出 `<decision>` / `<risk>` / `<team>`，
   * 那些块各有自己的渲染，所以剥掉不会丢信息。
   *
   * ⚠️ 压单行**不是"只截断"**：截断到 300 字仍保留换行，解析照旧被污染。
   *
   * ⚠️ 前端也有一道防线（`teamTrace.ts` 的 role 形态判据）——
   * 两层都要：单行化依赖这里记得做，形态判据是解析器的自保。
   *
   * ⚠️ 定义在函数**顶部**：它被汇报段与角色段两处用到，
   * 放在中间会触发 TS2448（块级作用域变量在用之前声明）。
   */
  /*
   * ⚠️⚠️ **只剥"包装类"标签，绝不碰 `<tool>`**（2026-10-14 实测踩到）。
   *
   * ## 事故：我的兜底正则把 `<tool>` 块拆散了
   *
   * 第一版写了两条规则：
   * ```
   *   .replace(/<\/?(?:reasoning|thinking|…)>/gi, ' ')   ← 白名单，对的
   *   .replace(/<\/?[a-z_]+>/gi, ' ')                     ← 兜底，错的
   * ```
   * 那条兜底会把 `<tool>{"tool":"list_candidates"}</tool>` 的**标签**剥掉、
   * 留下裸 JSON —— 而 `stripToolBlocks()` 是按**整块**匹配的，
   * 标签被拆散后它就找不到了 → `teamModel.test.ts` 当场变红。
   *
   * ⚠️ **而且后果不只是测试**：`<tool>` 残留会让 `autoTrader` 的按需取数循环
   * 以为"模型想调工具"，于是**重跑整个交易台**（实测 8 次交易台 = 64 次调用零产出）。
   *
   * ## 所以：白名单，且**只列"模型的思考/结论包装"**
   *
   * ```
   *   reasoning / thinking   —— 思考包装（模型习惯用，不是给人看的）
   *   answer                 —— 结论包装
   *   ⚠️ decision / risk / team —— 不剥！renderDeskOutcome 自己要用它们
   *      （剥了会把审计块的边界弄坏）
   *   ⚠️ tool                —— 不剥！那是 stripToolBlocks 的职责
   * ```
   */
  const stripModelTags = (s: string): string =>
    s.replace(/<\/?(?:reasoning|thinking|answer)>/gi, ' ').trim();

  const oneLine = (s: string, limit: number): string =>
    stripModelTags(s).replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, limit);

  /*
   * ── 风控官的应用（用户需求 #3）────────────────────────────────────────
   *
   * 三种情况：
   *   · **否决** → 决策清空（`[]`），本轮不行动；
   *   · **削减** → 用削减后的决策；
   *   · **放行** → 原样。
   *
   * ⚠️ 风控官**没跑**（`risk` 为 `null`）时**原样放行**，并**在审计块里标明
   * "本轮未经风控官审阅"** —— 静默跳过会让操作员以为"风控看过了"。
   */
  let finalDecisions: unknown[] | null = extracted.status === 'ok' ? extracted.decisions : null;
  if (risk !== undefined && risk !== null) {
    if (!risk.approved) {
      finalDecisions = [];
    } else if (risk.adjusted !== null) {
      finalDecisions = risk.adjusted as unknown[];
    }
  }

  const decisionBlock = finalDecisions !== null ? JSON.stringify(finalDecisions) : '[]';

  const lines: string[] = [];
  lines.push('<decision>');
  lines.push(decisionBlock);
  lines.push('</decision>');

  /*
   * ── `<risk>` 风控审计块 ──────────────────────────────────────────────
   */
  if (risk !== undefined && risk !== null) {
    lines.push('');
    lines.push('<risk>');
    lines.push(
      `${risk.approved ? (risk.adjusted !== null ? '削减后放行' : '放行') : '否决'}` +
        `${risk.modelId != null && risk.modelId.length > 0 ? `（${risk.modelId}）` : ''}：${risk.reason}`,
    );
    if (risk.concern !== null && risk.concern.length > 0) lines.push(`担心：${risk.concern}`);
    lines.push('</risk>');
  } else {
    lines.push('');
    lines.push('<risk>');
    /*
     * ⚠️ 三种原因分开说 —— 见 `skipReason` 的说明。
     * 「全是 skip」是**正常且有意**的（省一次 ~120 秒调用），
     * 而「调用失败」才需要查。把两者写成同一句会让操作员白查。
     */
    if (riskSkipReason === 'all_non_action') {
      lines.push(
        '✅ 本轮**无需风控官审阅** —— 裁决结果是"全部不行动"，' +
          '没有风险敞口可审（这是设计内的省略，不是失败）。',
      );
    } else if (riskSkipReason === 'call_failed') {
      lines.push('⚠️ 本轮**未经风控官审阅**（**调用失败**）—— 决策按裁决官结论直接放行。');
    } else if (riskSkipReason === 'not_enabled') {
      lines.push('⚠️ 本轮**未经风控官审阅**（风控角色**未启用**）—— 决策按裁决官结论直接放行。');
    } else {
      lines.push('⚠️ 本轮**未经风控官审阅**（原因未记录）—— 决策按裁决官结论直接放行。');
    }
    lines.push('</risk>');
  }
  lines.push('');
  lines.push('<team>');
  lines.push(`交易台：${outcome.summary}`);
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⭐ **汇报员的人话**（2026-10-14 渲染进审计块）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 为什么放在"各角色产出"之前
   *
   * 它是**给操作员看的一段人话**（用户需求 ⑤ 的"汇报工作的"）——
   * 应该最先看到，而不是埋在技术产出里。角色产出是"过程"，
   * 汇报是"结论"，两者读者不同。
   *
   * ## ⚠️ 三态必须区分（`reporter.test.ts` 已钉住语义）
   *
   * ```
   *   string      它跑了，这是它的话 —— 原样展示
   *   null        它跑了但失败 —— 明说"汇报失败"（不是空白）
   *   undefined   预算不足没被调用 —— 明说"没跑"（不是空白）
   * ```
   * 空白是"看不出异常的失败" —— 操作员会以为"这轮没有值得汇报的"。
   */
  if (typeof outcome.report === 'string' && outcome.report.length > 0) {
    lines.push('');
    lines.push('## 本轮汇报（给人看）');
    /*
     * ⚠️ 同样剥标签 + 压单行（见 `oneLine` 的说明）。
     * 汇报员的产出是 JSON，压单行后仍可读（JSON 本来就不该换行占版面）。
     */
    lines.push(oneLine(outcome.report, 2_000));
  } else if (outcome.report === null) {
    lines.push('');
    lines.push('## 本轮汇报');
    lines.push('（汇报员跑了但失败 —— 决策本身不受影响，见下方各角色产出）');
  } else {
    lines.push('');
    lines.push('## 本轮汇报');
    lines.push('（本轮预算不足，汇报员没有被调用 —— 结论是完整的，只是没有写成人话）');
  }
  if (outcome.truncatedByBudget) {
    lines.push('⚠️ 本轮因预算/轮次上限提前收尾 —— 结论是在受限条件下得出的。');
  }
  if (extracted.status !== 'ok' && extracted.status !== 'empty') {
    /*
     * ══════════════════════════════════════════════════════════════════════════
     * ⚠️⚠️ **失败必须【分级说】—— 一句"可能被截断"把 70 条说成了系统故障**
     *     （2026-10-15，用当前抽取器对线上 108 条空决策逐条重放实测）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 实测分布（`#11`，108 条空决策，按"当前抽取器在 clip 文本上的状态"）
     * ```
     *   no-block         70 条（65%）← 裁决官全程没写 `[`
     *                     · 其中 62 条：它以散文明确说"不行动"（是【判断】）
     *                     · 其中  8 条：它根本没有产出（网关/冷却）（是【故障】）
     *   ok               19 条（18%）← 抽到了真数组，是被旧版风控官解析误判清空的
     *                     （已由 `6bf004f` 修，`riskLiveText.test.ts` 钉住）
     *   bad-json（未闭合）5 条（ 5%）← **这才是真截断**
     *   not-decisions     1 条（ 1%）← 抓错数组（`c192` 的 `[-1]`）
     *   （另 5 条 `clipped_ok`：数组在 4,000 字 clip 之后，全量里其实抽得到 → 不算故障）
     * ```
     * ⇒ **"judge 的 JSON 被截断"在这个账号上只有 5 条（4.6%）**，
     *   而任务描述里的前提（把 107 条都当成截断）不成立。
     *
     * ## 原来的文案错在哪
     *
     * ```
     *   no-block → ⚠️ 裁决里没有找到 JSON 数组 —— 模型可能只写了散文。
     *   bad-json → ⚠️ 裁决里的 JSON 解析失败（可能被截断）—— 片段：…
     * ```
     * ⚠️ 注意：这**不是**"两种失败说成一种" —— 文案本来就分了两句。错的是**方向**：
     * ```
     *   ✗ 把【判断】说成【故障】：no-block 那句的"模型可能只写了散文"太轻，
     *     操作员读完不知道"这一轮到底是有意不做，还是输出坏了"；
     *   ✗ 把【故障】混进【判断】：70 条 no-block 里那 8 条"裁决官没产出"
     *     （`Cannot reach custom: fetch failed` / 档位冷却）与 62 条"主动说不做"
     *     长得**一模一样**，而前者要查网关、后者什么都不用查。
     * ```
     * 于是操作员看到的是：**85% 的非空失败轮都不会被告知"该不该去查"**。
     *
     * ⚠️ 本仓库对此有明确纪律（`docs/AGENTS.md` §3.2 / §5.1）：
     * **"一份说错了的文档比没有文档更糟"**。审计块就是那份文档。
     *
     * ## 现在四种失败各说各的事实
     *
     * ```
     *   not-decisions  解析出了数组，但它不是决策数组（推理里的下标片段）
     *   bad-json       有未闭合的 `[` → 确凿的截断 / 解析失败
     *   no-block+有产出 裁决官以散文给出"不行动"（判断，不是故障）
     *   no-block+无产出 裁决官这一轮没有产出（故障，要查网关）
     * ```
     *
     * ## ⚠️ 一个必须说清的边界（不能假装能分辨）
     *
     * ②那 26 条"写完 ` ```json ` 就停"（模型自己停）在文本形态上**与"数组被截掉"
     * 完全相同** —— 都是"有围栏、没有 `[`"。所以这里只说"没有闭合"，
     * **不**断言"是 token 上限"（那会是我编的）。真要根治只能改输出契约
     *（在提示词那一层，不在本文件）。
     *
     * ## ⚠️⚠️ **这几句是跨目录契约，不是普通文案**
     *
     * `packages/web/src/pages/decisionZeroState.ts` 的 `classifyZeroDecision()`
     * 用**这几行的字样**判断"界面该说【观望】还是【故障】"，而它的判据
     * 是从线上 264 条记录穷举出来的 —— 改错方向的后果是
     * **"把故障显示成观望，于是没人去查"**（那个界面存在的唯一理由）。
     *
     * ## 契约的两条硬要求（前端 `decisionZeroState.test.ts` 会直接从**本文件源码**
     *    抽这几行来验，抽不到或抽多都会变红）
     *
     * ```
     *   ① 这 5 行必须是**独立的、单行的静态字面量**：
     *      不要用 `+` 把内容拼起来，也不要把它们塞进同一个三元表达式 ——
     *      前端的抽取器遇到 `+` 会把相邻字面量拼成一条，于是两个分支会被粘成一句
     *      （实测症状：它只抽到 3 条而不是 5 条，且拼出来的句子读不通）。
     *   ② 每行首必须是 `⚠️ 裁决…`（前端按这个前缀筛）。
     * ```
     *
     * ## 五行各对应前端的哪一种
     *
     * ```
     *   本文件这一行                                   前端 kind
     *   ─────────────────────────────────────────────  ────────────────────
     *   JSON 数组**没有闭合**（解析失败：输出被截断）    bad-json
     *   JSON 数组**没有闭合**（裁决官写到 json 代码块…   no-block-truncated
     *   裁决官这一轮**没有产出**（调用失败或超时/冷却）  no-block-no-output
     *   但它**不是决策数组**（元素没有 action 字段）     not-decisions
     *   JSON 解析失败 ——                                bad-json
     *   （另有"判断"那一行 → no-block-judgment，**不是故障**）
     * ```
     *
     * ⚠️ 「判断」那一行里含「不是截断」四个字 —— 那**不能**被当故障判据：
     * 前端必须先过完上面 4 条故障正向判据，最后才落"判断"（先立后破），
     * 不能用 `被截断|解析失败` 这种纯词根。见 `decisionZeroState.ts` 的说明。
     *
     * ## 为什么不再把片段拼进同一句
     *
     * 原来用模板字面量拼 `片段：${snippet}`。那会让这一行**不是静态字面量**，
     * 前端的抽取器只能把它当成"拼接段"处理（见上面①）。
     * 现在拆成两行：报告行（静态）+ 片段行（数据）—— 静态的判据与数据分离。
     */
    if (extracted.status === 'not-decisions') {
      /*
       * ⚠️ 这条特别重要：**不能让操作员以为"模型漏发了决策"**。
       * 真相是我们抓错了一段文本 —— 见 `looksLikeDecision` 的 `c192` 实测。
       * ⚠️ 它是**故障态**，但**不是截断** —— 所以措辞里不能出现"被截断"
       *（那会把排查方向带向预算）。
       */
      lines.push(
        '⚠️ 裁决里解析出一段像 JSON 数组的文本，但它**不是决策数组**（元素没有 action 字段）—— 那通常是裁决官推理里的下标片段，**不是它给出的决策**。本轮按"不行动"处理。',
      );
      lines.push(`（被误当成决策的片段：${extracted.snippet ?? ''}）`);
    } else {
      const judgeProducedNothing =
        outcome.verdict === null || outcome.verdict.ok === false;
      const raw = verdict?.ok === true ? verdict.raw : '';
      /* 未闭合的 ``` 围栏计数为奇数 —— 模型开了个 json 块却没写完。 */
      const fenceOpenedNotClosed = (raw.match(/```/g) ?? []).length % 2 === 1;
      /* 有未闭合的 `[` —— 最确凿的截断形状（`bad-json` 里 `[` 开头的那一支）。 */
      const arrayOpenedNotClosed =
        extracted.status === 'bad-json' && (extracted.snippet ?? '').trimStart().startsWith('[');

      if (arrayOpenedNotClosed) {
        lines.push(
          '⚠️ 裁决里的 JSON 数组**没有闭合**（解析失败：输出被截断）—— 本轮按"不行动"处理。',
        );
      } else if (extracted.status === 'bad-json') {
        lines.push('⚠️ 裁决里的 JSON 解析失败 —— 本轮按"不行动"处理。');
      } else if (judgeProducedNothing) {
        lines.push(
          '⚠️ 裁决官这一轮**没有产出**（调用失败或超时/冷却）—— 所以没有 JSON 数组可解析，本轮按"不行动"处理。**这是故障，不是它的判断。**',
        );
      } else if (fenceOpenedNotClosed) {
        lines.push(
          '⚠️ 裁决里的 JSON 数组**没有闭合**（裁决官写到 json 代码块就停了，没有输出数组）—— 说明它的输出被截断或者它没写完，本轮按"不行动"处理。**这不是它的判断。**',
        );
      } else {
        /*
         * ⚠️ 这是**唯一**的非故障分支，也是线上最多的一种（62 条 = 57%）。
         * 它必须与上面三条故障**在文本上分得开** —— 靠的是它独有的正面措辞
         * 「以文字给出「不行动」」（前端用它认"判断"）。
         */
        lines.push(
          '⚠️ 裁决里没有找到 JSON 数组 —— 裁决官这一轮**以文字给出「不行动」**（模型只写了散文）。本轮按"不行动"处理，这是它的**判断**（不是截断，无需查预算）。',
        );
      }
      /* 片段单独一行（数据与判据文案分离，见上面①）。 */
      if (extracted.snippet !== undefined) lines.push(`（解析片段：${extracted.snippet}）`);
    }
  }
  lines.push('');
  lines.push('## 各角色产出');
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **产出必须压成【单行】再放进来**（2026-10-14 用户截图抓到的 BUG）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事故：模型的正文被当成了"角色"
   *
   * 用户看到看板上冒出十几行莫名其妙的"岗位"：
   * ```
   *   **实体** · **方向** · **强度** · 6 个候选的完整指标序列 · ARC开空75分 …
   * ```
   * 而它们其实是**某个角色产出里的 markdown 列表项**。
   *
   * 根因链（两处合起来）：
   * ```
   *   ① 这里把 raw.slice(0, 300) 原样插进一行 —— 而 raw 是【多行】的
   *   ② 前端 teamTrace.ts 逐行扫 '## 各角色产出' 之后的内容，
   *      见到 `- xxx：yyy` 就当角色行
   *   → 多行正文里的 `- **实体**：…` 于是变成了一行"角色"
   * ```
   *
   * ## 修法：压成单行（换行 → 空格），并保留截断提示
   *
   * ⚠️ **不是"只截断"**：截断到 300 字仍会保留正文里的换行，问题照旧。
   * 必须把**所有换行压掉**，让每个角色严格占一行。
   *
   * ⚠️ 前端也加了一道防线（`teamTrace.ts` 的 role 形态判据）——
   * 两层都要，因为"单行化"依赖这里记得做，而"形态判据"是解析器的自保。
   *
   * ## ⚠️ 2026-10-14 第二次修：剥掉 `<reasoning>` 这类【机器包装标签】
   *
   * 用户第二次反馈（同一处）：
   * > 「出现大量 `<reasoning>`、空的，还有杂乱无章」
   *
   * 压成单行解决了"杂乱无章"，但**展开后第一行仍然是 `<reasoning>`** ——
   * 因为模型的输出本来就是 `<reasoning>…</reasoning>` 包着的，
   * 而那个标签**是机器标记，不是给人看的内容**。
   * 它占了 300 字预算里最显眼的位置，看起来像"空内容"。
   *
   * 所以：**先剥标签，再压单行**。
   * ```
   *   ✗ <reasoning> 让我先把这轮材料按我自己的规则走一遍…
   *   ✓ 让我先把这轮材料按我自己的规则走一遍…
   * ```
   *
   * ⚠️ 剥的标签是**项目自己的输出契约**（`AGENTS.md` §5.2：XML 标签是机器契约）——
   * `renderDeskOutcome` 自己也在产出 `<decision>` / `<risk>` / `<team>`，
   * 所以这里剥掉它们**不会丢信息**（那些块有各自的渲染）。
   *
   * ⚠️ 实现已上移到函数顶部（它被汇报段与这里两处用到）。
   *
   * ## ⚠️ 2026-10-14 第三次修：截断上限从 300 提到 2,000（配合前端的「展开全文」）
   *
   * 用户第三次反馈（同一处，观感问题）：
   * > 「展开后只有 300 字，看不清它在想什么」
   *
   * 而**前端无法自己拿到更长的版本** —— `teamTrace.ts` 解析的是这里的输出，
   * 所以"展开全文"必须**数据里真的有全文**。
   *
   * ```
   *   300 字   → 只够看到开头（且常常只有一个 `<reasoning>` 标签的开头）
   *   2,000 字 → 装得下一次完整的推理（实测角色产出多在 1,000–3,000 字）
   * ```
   * ⚠️ 截断时要**留下痕迹**（`…（已截断，完整 N 字）`）——
   * 否则前端分不清"这就是全部"和"还有更多"，而"展开全文"按钮会在无事可展时出现
   *（那正是本项目反复说的"看不出异常的失败"）。
   */
  const clip = (s: string, limit: number): string => {
    const one = oneLine(s, limit + 1); /* 多取 1 字用于判断"是否被截断" */
    return one.length > limit ? `${one.slice(0, limit)}…（已截断，完整 ${s.length} 字）` : one;
  };

  for (const a of outcome.analyses) {
    lines.push(`- ${a.role}（${a.modelId}）：${a.ok ? clip(a.raw, 2_000) : `失败 —— ${a.error ?? '未知'}`}`);
  }
  if (outcome.bull) lines.push(`- bull（${outcome.bull.modelId}）：${outcome.bull.ok ? clip(outcome.bull.raw, 2_000) : '失败'}`);
  if (outcome.bear) lines.push(`- bear（${outcome.bear.modelId}）：${outcome.bear.ok ? clip(outcome.bear.raw, 2_000) : '失败'}`);
  /*
   * ⚠️ **裁决官要留完整**（2026-10-13 修）。
   *
   * ## 原来截到 800 字，而那个长度**不够看出它的结论**
   *
   * 实测：裁决官的输出通常在 **1,500–3,000 字**（它要写：结论、置信度、
   * 关键依据、**不同意哪一方**、最大不确定性、失效条件）。
   * 截到 800 字的结果是**审计块里看不到它的 JSON 数组** ——
   * 而那个数组正是"本轮到底做了什么"的唯一凭证。
   *
   * ## 后果（我自己踩的）
   *
   * 我据此**误判**过一次：看到 800 字里没有 JSON，就断定
   * "裁决官从未输出 JSON 数组" —— 而核实后发现**它输出了**，
   * 只是数组是 `[]`（`deskOutput.ts` 的 `extracted.status === 'ok'`，
   * 所以那条"没找到 JSON 数组"的告警**没有出现**）。
   *
   * **一个为了省几百字而做的截断，制造了一个假结论。**
   *
   * 现在给 4,000 字（实测最长约 3,000）—— 完整保留它的推理与数组。
   * 分析师的 300 字**保持不变**：他们是并行产出、量大，
   * 而且他们的结论已经在辩论材料里被完整引用过。
   *
   * ⚠️ 2026-10-14：**同样要压成单行 + 截断留痕**（见上面 `clip` 的说明）——
   * 裁决官的输出是多行 markdown，它的列表项会被解析器当成"角色"。
   * ⚠️ 第一版我漏改了这里（还是 `oneLine`），测试当场抓到 —— 留痕与压单行
   * 两者必须**一起**用在每一行上，漏一处就等于没做。
   */
  if (verdict) lines.push(`- judge（${verdict.modelId}）：${verdict.ok ? clip(verdict.raw, 4_000) : `失败 —— ${verdict.error ?? '未知'}`}`);
  lines.push('</team>');

  return lines.join('\n');
}
