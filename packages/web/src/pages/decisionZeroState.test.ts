/**
 * **"没有决策"必须分清是【判断】还是【故障】**（2026-10-15 第二次改判据）
 *
 * ## 事故：界面上把故障说成判断
 *
 * `DecisionDetailPage` 原来对"零决策"只有一句文案：
 * ```
 *   没有可执行的决策 — 本周期模型选择观望或持仓。
 * ```
 * 而实测（`#11` 团队模式）真的发生过另外两种情况：
 * ```
 *   ① 裁决官的 JSON 数组被输出预算从末尾砍断 → 解析失败 → decisions = []
 *   ② 裁决官没跑（"未裁决"）→ 没有数组 → decisions = []
 *   ⇒ 而界面都显示"模型选择观望" —— 【没有人会去查它】
 * ```
 *
 * ## 判据是**从线上 264 条记录里穷举出来的**，不是我猜的
 *
 * 前两版都错了：
 * ```
 *   第一版 /解析失败|被截断/           → 漏（线上真实用词是"没有找到 JSON 数组"）
 *   第二版 /解析失败|无法解析|不可解析|被截断|截断/
 *          → 误报率 64.4%（非空轮 160 个里误报 103 个）
 * ```
 * 第二版误报的原因（逐条看过原文）：「截断」这个词在 `raw_response` 里**到处都是**，
 * 描述的却是**别的地方**的截断：
 * ```
 *   第  4 轮：「cline/…/step-5-preview → 输出被 token 上限截断，加大 max_tokens 重试」
 *   第  5 轮：「多空论证均被截断(做多第三部分缺失)」← 某角色产出被截，但本轮 20 条决策正常
 *   第 85 轮：「bear虽然论证被截断，但方向正确」  ← 【裁决官在引用它看到的失败】
 * ```
 *
 * ## ⚠️ 第三次：判断那一句里**也**出现了「截断」（本文件防的就是它）
 *
 * 后端 `deskOutput.ts` 这次把失败文案改成分级四说，于是"判断"那一句变成：
 * ```
 *   …本轮按"不行动"处理，这是它的**判断**（不是截断，无需查预算）。
 * ```
 * 它含「截断」与「预算」—— **纯词根匹配会把它判成故障**（与原来那个错方向相反，
 * 但同样是界面上的一句假话）。
 *
 * ## 所以本文件**不手抄 fixture**，而是去后端源码里读真实原文
 *
 * 判据的输入是 `deskOutput.ts` 写进 `raw_response` 的自然语言，
 * 所以"契约"就是**那份源码里的字符串**。手抄一份 fixture 只能证明
 * "我抄的那句话能被分类"，证明不了"后端真的会写那句话"。
 *
 * ⇒ `parsedDeskCopy()` 直接读 `deskOutput.ts` 并抽出那 5 条报告行；
 *   后端改文案 ⇒ 这份测试变红（这正是 task-7 验收标准第 2 条要的东西）。
 *   ⚠️ **不要**为了让测试变绿去放宽这里的抽取 —— 那等于把契约重新变回"靠运气发现"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { classifyZeroDecision, looksLikeParseFailure } from './decisionZeroState.js';

/* -------------------------------------------------------------------------- */
/*  从后端源码里读"真实原文"                                                     */
/* -------------------------------------------------------------------------- */

const DESK = readFileSync(
  fileURLToPath(new URL('../../../server/src/trader/agent/deskOutput.ts', import.meta.url)),
  'utf8',
);

interface RawLiteral {
  /** 1-based 行号（报错时指路，别让人去猜）。 */
  line: number;
  /** 已经还原转义的字符串本体（`\"` → `"`）。 */
  text: string;
}

/**
 * 从 `deskOutput.ts` 里抽出 `⚠️ 裁决…` 开头的***候选报告行***（含行号）。
 *
 * ## ⚠️ 为什么是"锚定报告行"而不是"通用地扫所有字符串"
 *
 * 我第一版写了个通用扫描器（识别引号 / 模板 / 注释 / `+` 拼接），连踩四个坑，而且
 * **每修一次还是漏**：
 * ```
 *   ① 逐行扫          → 跨行字面量被截成半句
 *   ② 不拼 + 号        → 只拿到第一段，丢掉后半句（「不是截断」正好在后半句里！）
 *   ③ 只认单引号       → 漏掉模板字面量（后端有 3 条是反引号写的）
 *   ④ 把三元 when 的两条分支**拼成一条** → 抽出来的文本同时含
 *      「这是它的**判断**」和「不是它的判断」，分类器必然错
 * ```
 * 一个通用解析器在这里收益很低、维护成本很高 —— 它要解析的只是"固定的那几行"。
 *
 * ## 现在的判据
 *
 * ```
 *   锚点        `lines.push(` —— 报告行只从这里产出（注释里的示例文案因此不会被误收）
 *   一次解析    一个**字符串操作数组**（`'a' + 'b'` 算一组；遇 `?` / `:` 就收尾）
 *   停止        遇到其它非空白代码，或 `;`
 * ```
 * 于是三元 `cond ? 甲 : 乙` 会产出**两个**候选行 —— 正是本测试需要的粒度
 * （分类器与后端一样，是"按条件二选一"的）。
 *
 * ⚠️ 脆弱点与兜底：抽取依赖"报告行只出现在一个 `lines.push(` 的字符串操作数里"这个形状。
 * 形状变了（后端改用变量拼接、或引用了别处定义的常量）→ 抽出来的东西变了 →
 * 前置断言（条数下限 + 每条必须是完整句）与分类断言会红。
 * **那正是希望发生的**：请同步判据与本文件的期望，而不是放宽这里的抽取。
 */
function parsedDeskCopy(): RawLiteral[] {
  /**
   * 扫描上限（防空转）—— 真正的停止条件是"这个锚点没产出新报告行"。
   *
   * ⚠️ **不能**按"已收集 N 条"提前收工：报告行分布在 **2 个** `lines.push(` 里
   *（一个嵌套三元 + 一条模板三元），而"判断态"那一条在**最后**一个锚点里。
   * 我第一版写死"收集到 5 条就 break"，于是判断态整条消失 ——
   * 而症状看起来像"后端把文案删了"（**误诊方向**）。
   */
  const MAX_REPORT_LINES = 12;

  /** 解析一个字符串操作数（含模板插值）；`i` 是引号位置。返回 [文本, 下一个位置]。 */
  const readOperand = (source: string, i: number): [string, number] | null => {
    const quote = source[i]!;
    let piece = '';
    let j = i + 1;
    while (j < source.length) {
      const c = source[j]!;
      if (c === '\\') {
        const next = source[j + 1] ?? '';
        piece += next === 'n' ? '\n' : next;
        j += 2;
        continue;
      }
      /* 模板插值：本模块只关心固定文案，片段内容换成占位符。 */
      if (quote === '`' && c === '$' && source[j + 1] === '{') {
        const close = source.indexOf('}', j);
        if (close < 0) return null;
        piece += '∎';
        j = close + 1;
        continue;
      }
      if (c === quote) return [piece, j + 1];
      if (quote === "'" && c === '\n') return null; /* 单引号字符串不跨行 */
      piece += c;
      j += 1;
    }
    return null; /* 引号没闭合 */
  };

  const out: RawLiteral[] = [];
  for (const m of DESK.matchAll(/lines\.push\(/g)) {
    const source = DESK.slice(m.index + m[0].length, m.index + m[0].length + 6_000);
    const line = DESK.slice(0, m.index).split('\n').length;
    let i = source.search(/['"`]/);
    if (i < 0) continue;

    let group = '';
    let sawWarning = false;
    while (i < source.length) {
      const ch = source[i]!;
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      if (/['"`]/.test(ch)) {
        const read = readOperand(source, i);
        if (read === null) break;
        const [piece, next] = read;
        if (piece.startsWith('⚠️ 裁决')) sawWarning = true;
        group += piece;
        i = next;
        continue;
      }
      /* 三元的分支边界 ⇒ 当前这一条收尾，下一条从零开始。 */
      if (ch === '?' || ch === ':') {
        if (sawWarning && group.length > 0) out.push({ line, text: group });
        group = '';
        sawWarning = false;
        i += 1;
        continue;
      }
      if (ch === '+') {
        i += 1; /* 拼接：继续吃下一个操作数 */
        continue;
      }
      break; /* `,` / `)` / `;` / 其它代码 —— 这一条到此结束 */
    }
    if (sawWarning && group.length > 0) out.push({ line, text: group });

    /*
     * 只有"这个锚点一条都没产出"时才收工 —— 那说明后面的 `lines.push(` 与报告行无关。
     * （也顺手兜住 `out.length` 的上限，防止极端输入下空转。）
     */
    if (out.length >= MAX_REPORT_LINES) break;
  }
  return out;
}

const COPY = parsedDeskCopy();
const copyOf = (needle: string): string => {
  const hit = COPY.find((c) => c.text.includes(needle));
  assert.ok(
    hit !== undefined,
    `★ deskOutput.ts 里找不到含「${needle}」的报告行 —— ` +
      `文案被改过（或位置变了），请同步 decisionZeroState.ts 的判据。` +
      `当前抽到的 ${COPY.length} 条：\n` + COPY.map((c) => `      :${c.line} ${c.text.slice(0, 60)}…`).join('\n'),
  );
  return hit.text;
};

/* -------------------------------------------------------------------------- */
/*  0. 抽取本身的前置断言（判据校准）                                             */
/* -------------------------------------------------------------------------- */

test('★★★ 必须真的从后端源码里抽到报告行（否则下面全部是空转）', () => {
  /*
   * ⚠️ `docs/FINDING-clerk-unwired.md` 2026-10-14 的教训：**判据本身需要被校准** ——
   * 那位维护者的第一版守卫只认一种调用形状，把真被调用的角色误报成死角色。
   * 同理：如果抽取抽不到东西，"所有分类都断言通过"也会绿 —— 那是空转。
   *
   * ⚠️ 这里**不钉死条数**：后端把"判断态"的同一句话注册了两次（`null` 与 `!ok`
   * 两种 `verdict` 形态共用一句），钉 5 会变成"改后端结构就红、而与语义无关"的
   * 假失败。真正要保证的是：**每条抽出来的都是完整的报告行**（下面两条断言），
   * 以及**每条的分类都在预期集合内**（下一条测试）。
   */
  assert.ok(COPY.length >= 5, `★ 只抽出 ${COPY.length} 条报告行 —— 抽取可能失效了（空转风险）`);
  for (const c of COPY) {
    assert.ok(
      c.text.startsWith('⚠️ 裁决') && c.text.length >= 30,
      `★ :${c.line} 抽出来的不是一个完整的报告行（len=${c.text.length}）：${c.text}`,
    );
    /*
     * 每条都必须含"收尾语"—— 这是**抽到完整句**的判据。
     * ⚠️ 不能用「片段：…」做判据：模板里的 `${snippet}` 被换成了占位符 `∎`。
     */
    assert.ok(
      /本轮按"不行动"处理/.test(c.text) || c.text.includes('这是故障，不是它的判断'),
      `★ :${c.line} 抽出来的像是半句（缺收尾语）：${c.text}`,
    );
  }
  /* 五个状态各至少一条 —— 分类可分辨性的前置条件。 */
  const kinds = new Set(COPY.map((c) => classifyZeroDecision(c.text)));
  assert.ok(kinds.size >= 4, `★ 只分出 ${kinds.size} 种状态 —— 抽取或被后端文案改坏了`);
});

/* -------------------------------------------------------------------------- */
/*  1. 逐态判定：只有 A 是【观望】，B/C/D/E 都是【故障】                          */
/* -------------------------------------------------------------------------- */

test('★★★ A（裁决官以文字给出「不行动」）必须判成【观望】，不能判成故障', () => {
  /*
   * ⚠️ 这是**最容易错的方向**，也是本次改判据的核心：
   * A 的文案里含「截断」「预算」两个词，纯词根匹配会把它判成故障。
   * 而 A 是 264 条里**最多**的一种（约 62 条），误判会让操作员去查一个不存在的预算问题。
   */
  const a = copyOf('以文字给出「不行动」');
  assert.ok(
    a.includes('不是截断'),
    '★ A 的文案**必须**含「不是截断」—— 这条断言的意义是：它一旦消失，本测试也就失去了目标',
  );
  assert.ok(a.includes('预算'), '★ A 里也出现「预算」—— 证明"词根匹配"必然误报，必须有组合判据');
  assert.equal(classifyZeroDecision(a), 'no-block-judgment', '★★ A 是判断，不是故障');
  assert.equal(looksLikeParseFailure(a), false, '★★ A 不能被标成故障（否则操作员白查一次）');
});

test('★★★ 每一个抽出条目的分类都在预期集合内（口径探针，不只抽一条）', () => {
  /*
   * `deskOutput.ts` 里"判断态"的同一句话**注册了两次**（`null` 与 `!ok` 两种 `verdict`
   * 形态共用它），所以抽出来的条目数不代表"状态数"。
   *
   * 与其钉一个脆弱的条数，不如**逐条断言分类** —— 这样：
   * ```
   *   ① 后端把任一条文案改坏 ⇒ 抽出来的文本变了 ⇒ 这里的分类断言变红
   *   ② 后端新增一条报告行 ⇒ 它会出现在这里，逼人显式登记它的分类
   * ```
   * ⚠️ 允许的取值集合是**显式**列出的，不是 `assert.ok(x !== undefined)`。
   */
  const allowed = new Set([
    'no-block-judgment',
    'bad-json',
    'no-block-truncated',
    'no-block-no-output',
    'not-decisions',
  ]);
  for (const c of COPY) {
    assert.ok(
      allowed.has(classifyZeroDecision(c.text)),
      `★ :${c.line} 这条报告行的分类不在预期集合里 —— 新状态？请同步 decisionZeroState.ts 与这里`,
    );
  }
  /* 每个状态至少各一条（否则"逐条在集合内"可能因为只剩一条而空转）。 */
  const kinds = new Set(COPY.map((c) => classifyZeroDecision(c.text)));
  for (const k of ['no-block-judgment', 'bad-json', 'no-block-no-output', 'not-decisions']) {
    assert.ok(kinds.has(k as never), `★ 抽出来的条目里缺少 ${k} —— 抽取或后端文案变了`);
  }
});

test('★★★ B/C/D/E 四态必须都判成【故障】（B 含两种形状）', () => {
  /*
   * 故障被显示成"观望"= 没有人去查它 —— 那正是这个模块存在的理由
   * （文件头原话：一个把故障说成判断的界面，比一个报错的界面更危险）。
   */
  const cases: Array<[string, ReturnType<typeof classifyZeroDecision>]> = [
    /* B-1：有未闭合的 `[`（真截断）。⚠️ 判据里的 `**` 是后端原文的 markdown 粗体，必须一起匹配 */
    ['**没有闭合**（解析失败：输出被截断）', 'bad-json'],
    /*
     * B-2：写到自己开的 json 围栏就停。
     * ⚠️ 它**也**含「JSON 数组**没有闭合**」，但**多了**括号里的原因 ——
     * 分类器把这一条排在前（更具体优先），所以它归 `no-block-truncated`，
     * 与后端 `fenceOpenedNotClosed` 那个分支一一对应。
     */
    ['写到 json 代码块就停', 'no-block-truncated'],
    /* C：这一轮没有产出（调用失败 / 超时 / 冷却） */
    ['没有产出', 'no-block-no-output'],
    /* D：抓到的是"像数组但不是决策数组"的文本 */
    ['**不是决策数组**（元素没有 action 字段）', 'not-decisions'],
    /* E：有解析失败、但没有未闭合的 `[` */
    ['JSON 解析失败 ——', 'bad-json'],
  ];
  for (const [needle, expected] of cases) {
    const raw = copyOf(needle);
    assert.equal(classifyZeroDecision(raw), expected, `★ 含「${needle}」的那条应当判为 ${expected}`);
    assert.equal(looksLikeParseFailure(raw), true, `★ 含「${needle}」的那条必须被标成故障`);
  }
});

test('★★★ C 里的「不是它的判断」不能被当成"这是判断"', () => {
  /*
   * ## 我第一版在这里写错了（记录在此，防止下次再犯）
   *
   * 我第一版用 `不是它的?判断` 做"否定语境排除"，把判断态放在最前面。
   * 而 C（`no-block-no-output`，**故障**）的原文是：
   * ```
   *   …本轮按"不行动"处理。**这是故障，不是它的判断。**
   * ```
   * 它**也**含「不是它的判断」⇒ C 会被认成判断。
   *
   * ⇒ 教训：**否定句不能用来认"这是判断"** —— 故障文案也会说"这不是判断"。
   *   "判断"只能由判断态**自己的正面措辞**来认（「以文字给出「不行动」」）。
   */
  const c = copyOf('没有产出');
  assert.ok(
    c.includes('不是它的判断'),
    '★ C 的文案里确实有「不是它的判断」—— 这条断言存在的意义就是把这个陷阱留在测试里',
  );
  assert.ok(
    !c.includes('以文字给出'),
    '★ C 里**不能**出现判断态独有的正面措辞 —— 否则两个状态在文本上就分不开了',
  );
  assert.equal(classifyZeroDecision(c), 'no-block-no-output', '★★ C 是故障，绝不能被"否定句"认成判断');
});

/* -------------------------------------------------------------------------- */
/*  2. 反向守卫：历史上误报过的东西不能再误报                                     */
/* -------------------------------------------------------------------------- */

test('★★★ 正常的零决策轮【不能】被误报成故障', () => {
  /*
   * 最容易犯的错是"判据太宽"—— 我第二版误报率 64.4%，
   * 那会让真正的"模型选择观望"看起来像系统坏了。
   *
   * ⚠️ 下面几条都是**线上真实出现过的**、且**正常轮次里也有**的文本。
   */
  for (const raw of [
    /* 这条在 192 个轮次里出现（空 74 / 非空 118）—— 看起来像故障，其实不是 */
    '⚠️ 本轮**未经风控官审阅**（风控角色未启用或调用失败）—— 决策按裁决官结论直接放行。',
    /* 模型降级链的日志 —— 描述的是别的模型的失败 */
    'cline/cline-free/step-5-preview → 输出被 token 上限截断（思维链占满了预算），加大 max_tokens 重试。',
    /* 裁决官在引用它看到的失败，而本轮有正常决策 */
    'bear虽然论证被截断，但方向正确：数据边界不足、结构都是"涨多了"或"跌透了"。',
    '多空论证均被截断(做多第三部分"最强两选"缺失)，技术/情绪三个分析师全部失败。',
    /* 正常的团队状态行 */
    '<team>交易台：分析师 5/5 成功 · 做多论证已出 · 做空论证已出 · 已裁决 · 已汇报 · 调用 9/9</team>',
    '',
  ]) {
    assert.equal(
      looksLikeParseFailure(raw),
      false,
      `★ 「${raw.slice(0, 34)}…」不该被判为解析失败（那会误报）`,
    );
  }
});

test('★★★ 未知形状落到"观望"（保守方向），并把这个取舍钉在测试里', () => {
  /*
   * 后端将来若新增一种失败文案，本模块**不认识它**。两条路都错，必须选一条：
   * ```
   *   落"故障" → 操作员去查一个不存在的问题（第二版的 64.4% 误报就是这么来的）
   *   落"观望" → 真故障被静默（本次要防的那个方向）
   * ```
   * 本实现选**后者**（与文件头写的一致），但把边界写进测试，让改这个取舍的人必须
   * 有意识地改：**这不是"忘了覆盖"，是被记录下来的决定。**
   */
  const unknown = '⚠️ 裁决里发生了一种这个前端还没登记的新毛病。本轮按"不行动"处理。';
  assert.equal(classifyZeroDecision(unknown), 'no-block-judgment', '★ 未知形状 → 观望（保守）');
  assert.equal(looksLikeParseFailure(unknown), false);
});

/* -------------------------------------------------------------------------- */
/*  3. 旧判据的两条线上原文仍然要被认出（防"改新文案时把老的漏了"）                 */
/* -------------------------------------------------------------------------- */

test('★★★ 线上旧原文仍要能被认出（不能因为改了新文案就把历史记录漏掉）', () => {
  /*
   * ⚠️ 这一条防的是**历史数据的可读性**：
   * 数据库里已经存着 264 条旧文案的记录，这次改的是**生成端**，
   * 但旧的 `raw_response` 永远躺在库里 —— 若新判据只认新文案，
   * 那些历史轮次在界面上会全部退回"模型选择观望"。
   */
  assert.equal(
    looksLikeParseFailure('⚠️ 裁决里的 JSON 解析失败（可能被截断）—— 本轮按"不行动"处理。片段：['),
    true,
    '★ 旧版真截断文案（线上 6 条）仍须判为故障',
  );
  assert.equal(
    looksLikeParseFailure('⚠️ 裁决里没有找到 JSON 数组 —— 模型可能只写了散文。本轮按"不行动"处理。'),
    false,
    '★ 旧版判断文案（线上 27 条）当时被判为故障是**误判**；新判据只认新文案的正面措辞，' +
      '所以这条会落到"观望" —— 这是**已知且可接受**的：它的结论本来就是"不行动"',
  );
});

/* -------------------------------------------------------------------------- */
/*  4. 判据不是长度                                                              */
/* -------------------------------------------------------------------------- */

test('★★ 判据必须只看报告行，不看长度', () => {
  /*
   * ⚠️ 长度不是判据 —— 实测团队一轮 `raw_response` 有 13,000–16,000 字，
   * 而 `<decision>` 块可能只有 4 个字符（`[]`）。用长度会得出完全相反的结论。
   */
  const longButEmpty = 'x'.repeat(15000) + '\n<decision>\n[]\n</decision>';
  assert.equal(
    looksLikeParseFailure(longButEmpty),
    false,
    '★ 长回复不等于解析失败 —— 团队审计块本身就占十几 KB',
  );
});
