/**
 * **风控官关卡** —— 团队模式里"谁来负责风格"（用户需求 #3）。
 *
 * ## 用户的原始要求（这是本文件存在的理由）
 *
 * > 「**系统不再设置内置风控**（我的想法是既然都要做这么智能了，那么**风格也应该由
 * >  一个智能体来负责**，而不是系统内置简单风控规则）」
 *
 * ## 我必须说清的取舍：**不能全部交给智能体**
 *
 * 调研有硬证据反对"把风控完全交给 LLM"：
 *
 * | 证据 | 出处 |
 * |---|---|
 * | 让"最终决定权由代码强制"比交给 LLM 高 **+9.4%** 任务成功率 | MAST 分类法实测（arXiv:2503.13657）|
 * | 真实机构的风控是**硬性否决**，不是建议 | Millennium 的中央风控设硬停 |
 * | TradingAgents 的风控**只输出建议** —— 那等于没有风控 | 该项目自身的拓扑 |
 *
 * 把"保证金够不够"交给一个**会幻觉**的东西判断，等于把爆仓风险交给运气。
 *
 * ## 所以做成**两层**（这是用户意图与技术现实的交集）
 *
 * ```
 *   ① 裁决官给出提案（团队讨论的结论）
 *        ↓
 *   ② 【智能体层】风控官审阅 —— 仓位大小、集中度、回撤容忍、"现在该不该收手"
 *        ↓  它可以否决、削减、或放行
 *   ③ 【代码层】RiskEngine 物理底线 —— 保证金足够、数量可交易、止损存在
 *        ↓  它**不可被绕过**
 *   ④ 执行
 * ```
 *
 * **用户要的"智能风格"由第 ② 层给**（那是真正需要判断力的部分），
 * 而第 ③ 层只挡**物理与合规的底线**（那部分交给 LLM 是拿爆仓换"智能"）。
 *
 * ## 为什么两层而不是只留智能体层
 *
 * 智能体层的输出**也是文本**，可能解析失败、可能被幻觉影响。
 * 代码层是**兜底**：即使风控官说"重仓没问题"，交易所也只会按保证金拒绝 ——
 * 但那时已经是"下单失败"而不是"被拦下"，体验与安全都更差。
 */

import { isCloseAction, type Decision, type DecisionAction } from '@aq/shared';

/** 风控官的裁决。 */
export interface RiskOfficerVerdict {
  /** 它是否放行。 */
  approved: boolean;
  /** 它是否想削减（而不是全盘否决）。 */
  reduced: boolean;
  /** 削减后的决策（`reduced` 为真时有值）。 */
  adjusted: Decision[] | null;
  /** 它给的理由（**必须落到日志** —— 用户要求看得见"为什么"）。 */
  reason: string;
  /** 它担心的主要风险（可空）。 */
  concern: string | null;
}

/**
 * **解析风控官的输出**。
 *
 * ## 为什么必须容错
 *
 * 风控官的输出是模型文本，**可能不合格式**。而"解析失败"在这一层是**安全攸关**的：
 *
 * · 失败时**不能当成"它批准了"** —— 那等于没有风控；
 * · 失败时也**不能直接全部否决** —— 那会让一次格式抖动变成"机器人停止交易"。
 *
 * 所以采用**保守但不停摆**的策略：解析失败 → **只放行"降低风险"的动作**
 *（平仓、减仓、调保护位），**拦住"增加风险"的动作**（开仓、加仓）。
 *
 * 这个方向是明确的：**看不清楚的时候，宁可少冒险。**
 */
export function parseRiskOfficerVerdict(text: string, decisions: readonly Decision[]): RiskOfficerVerdict {
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **表态只看"结论行"，全文只做兜底**（2026-10-14 线上实测抓到的 BUG）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事故：风控官明确"批准"，而 43% 的轮次被拦下、订单不发出
   *
   * 线上统计（`#11`，40 轮）：**17 轮（43%）出现自相矛盾的 `<risk>` 块**：
   * ```
   *   <risk>
   *   否决（group/auto-qfmodel）：## 风控审批结论：**批准** ✅   ← 前缀否决、理由批准
   *   担心：唯一开仓（QUSDT）名义仅 10 USDT…可忽略不计。
   *   </risk>
   *   <decision>[]</decision>                                    ← 订单没发出
   * ```
   * 而风控官的原文（`c160`）是明确批准：
   * ```
   *   ## 风控审批结论：**批准** ✅
   *   唯一开仓（QUSDT）名义仅10 USDT、保证金1 USDT、止损锁死亏损上限约0.1 USDT
   *   ——即便止损因小币流动性断裂而失效，最坏损失也只是1 USDT保证金归零，
   *   对账户风险敞口可忽略不计。
   * ```
   *
   * ## 根因：两个判定的**扫描范围不一致**
   *
   * ```
   *   reason   = 第一行非空文本          ← 「批准 ✅」（结论行）
   *   approve  = 全文正则 approve
   *   reject   = 全文正则 reject         ← 正文里某处出现"否决/拒绝/不同意"就命中
   *   → reject 优先 → approved = false
   *   → 渲染层写"否决"，而 reason 显示"批准" → 操作员看到矛盾
   * ```
   * 风控官在**论证过程**里会引用"若跌破 X 则否决本次开仓"这类条件句，
   * 而全文正则会把它读成"它否决了"。
   *
   * ## 修法：表态在结论行判定，全文只在结论行**没有表态**时兜底
   *
   * ```
   *   ① 结论行（第一行非空、非 JSON）里找 approve / reject
   *      有明确表态 → 以它为准（这是模型表达结论的位置）
   *   ② 结论行没表态 → 扫全文（保留原来的兜底能力）
   * ```
   *
   * ⚠️ **"宁可拦下"的安全方向不变**：同一范围内双真时**仍然否决优先**。
   * 变的只是**扫描范围** —— 从"全文任意位置"收窄到"结论行优先"。
   *
   * ⚠️ 这个 bug 的代价是**双向**的：它不只让 43% 的批准被拦，
   * 还让操作员看到"否决：批准 ✅"这种自相矛盾的审计块 ——
   * 而审计块的唯一用途就是"事后能说清当时为什么这么做"。
   */
  const approveRe = /批准|放行|(?<!不)同意|approved|approve/i;
  /* ⚠️ 必须包含「不同意」—— 实测模型常用这个词，而它不含「否决」也不含「拒绝」。 */
  const rejectRe = /否决|拒绝|不同意|不批准|rejected|reject|denied/i;

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **先认结构化 `verdict` —— 那才是提示词要求的格式**（2026-10-15 修）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事故：`tighten` 被判成「否决」，于是**有机会也不出手**
   *
   * `roles.ts` 的风控官输出契约是**结构化 JSON**：
   * ```
   *   {"verdict":"approve|tighten|reject",
   *    "lossScenarios":[{"scenario":"…","likelihood":"…","severity":"…"}],
   *    "checked":"…"}
   * ```
   * 并且明说：「你**只能**否决（reject）或要求收紧（tighten）。你没有"放宽"这个选项。」
   *
   * 而解析器只认**中文散文**（`approveRe` / `rejectRe`）——
   * 于是 `"verdict":"tighten"` **两边都不命中** ⇒ 判不出表态 ⇒ 走保守兜底。
   *
   * ## 实测代价（最近 60 轮）
   *
   * ```
   *   verdict 分布: tighten=5 · approve=5 · reject=1
   *   而那 5 次 tighten 全部渲染成：
   *     <risk> 否决（…）：（风控官未给出理由）      ← 判成"否决"
   *     <decision> []                              ← 所有决策被清空
   *   而 judge 原本提议的是: close_short / open_long / open_long …
   * ```
   * ⇒ **风控官说"要求收紧"，系统读成"否决"**，于是真实动作被全部拦下。
   *
   * ## 三个缺陷叠加
   * ```
   *   ① `tighten` 不在 approveRe/rejectRe 里      → 判不出表态
   *   ② 判不出时走保守兜底，而渲染层写成「否决」  → 比实际更严重
   *   ③ `reason` 取"第一行非空文本" —— 而它是 JSON 对象，取不到散文理由
   * ```
   *
   * ## 语义（必须与提示词一致）
   * ```
   *   approve  → 放行（不削减）
   *   tighten  → 【放行但要收紧】= 削减仓位（不是否决！）
   *   reject   → 否决
   * ```
   * ⚠️ `tighten` 归到"批准 + 削减"这一支 —— 因为它的字面意思是
   * "要求收紧"，而收紧在系统里就是 `reduceDecisions()`。
   * 把它当成否决会让**每一次风控官想保守一点都变成完全不出手**。
   */
  const jsonVerdict = ((): 'approve' | 'tighten' | 'reject' | null => {
    /*
     * ⚠️ 从**任意位置**找 `"verdict"` —— 实测它出现在 `担心：{...}` 那一行里
     *（渲染层把整段 JSON 塞进了 `concern`），不在行首。
     */
    const m = /"verdict"\s*:\s*"?(approve|tighten|reject)"?/i.exec(text);
    if (m === null) return null;
    return m[1]!.toLowerCase() as 'approve' | 'tighten' | 'reject';
  })();

  /* 结论行：第一行非空、且不是 JSON/表格/标题装饰的文本。 */
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('{') && !l.startsWith('['));
  /*
   * ⚠️ 表态判定分**三级**，从窄到宽 —— 每一级里"否决优先"的安全方向都不变。
   *
   * ```
   *   ① 第一行（结论行）           —— 模型表达结论的位置
   *   ② 前 3 行非空文本（表态区）   —— 结论常常写两行（`## 结论` + 内容）
   *   ③ 全文                       —— 兜底（模型把结论写在末尾时）
   * ```
   *
   * ## 为什么必须分级（`c155` 实测暴露的边界）
   *
   * 风控官输出：
   * ```
   *   ## 风险审查结论：**批准** ✅（附强制条件）      ← 第 1 行：批准
   *   条件：若跌破止损位则否决本次开仓并立即平仓。    ← 第 2 行：含"否决"（条件句）
   * ```
   * 若表态区取 3 行，第 2 行的"否决"会命中 → 判成否决 → **批准被拦**。
   * 而那是**条件句**（"若 X 则否决"），不是"我现在否决"。
   *
   * 所以：**第一行有表态就用第一行**，不再往下看 ——
   * 第一行是模型放结论的地方，后续行是论证与条件。
   */
  const allLines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('{') && !l.startsWith('['));

  const scopeOf = (lines: string[]): string | null => {
    const s = lines.join('\n');
    if (s.length === 0) return null;
    return approveRe.test(s) || rejectRe.test(s) ? s : null;
  };

  const scope = scopeOf(allLines.slice(0, 1)) ?? scopeOf(allLines.slice(0, 3)) ?? text;

  const approve = approveRe.test(scope);
  const reject = rejectRe.test(scope);
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **"削减"必须排除否定式**（2026-10-15 修，一次真实事故）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 原来这一行是：
   * ```
   *   const reduce = /削减|减半|降低仓位|reduce/i.test(scope);
   * ```
   * **没有否定式排除** —— 于是风控官明确说"不用削"时，仓位照样被砍一半：
   * ```
   *   ## 裁决：批准（无需削减）        → reduced=true → 11 USDT 砍成 5.5
   *   ## 审批结论：批准，无需削减仓位   → reduced=true → 6 砍成 3
   *   ## 风险审查结论：**批准**（不建议削减）→ reduced=true
   * ```
   * 实测线上 `cyc 153`（`2026-10-14T03:15:21Z`）：
   * ```
   *   <risk>  削减后放行：## 裁决：批准（无需削减）      ← 它说的是"无需"
   *   <decision>  QUSDT open_long positionSizeUsd:5.5    ← 实际砍了一半
   *   judge 原始:  QUSDT open_long positionSizeUsd:11
   *   reasoning: "[风控官削减 50%] …"                     ← 还留了一条假痕
   * ```
   * `cyc 148` 同样（说"批准"、6 砍成 3）。
   *
   * ## 为什么这比"少削一次"严重
   *
   * ```
   *   ① 直接后果：仓位被无故减半 —— 而这会改变真实盈亏（真钱）
   *   ② 更糟的是【留痕是假的】：审计块写"削减后放行"，
   *      而"事后能说清当时为什么这么做"正是审计块唯一的用途
   *   ③ 它与 `approveRe` 的 `(?<!不)同意` 是**同一种缺陷**，
   *      而那一处早就修了 —— 这一处被漏掉（"只做一半"的又一次）
   * ```
   *
   * ## 判据：先用否定式消掉"无需削减/不建议削减"这类短语，再看有没有削减意图
   *
   * ⚠️ 用**消去法**（把否定短语从文本里去掉再匹配）而不是给每个动词加后顾断言：
   * 后者要为「削减/减半/降低仓位/reduce」各写一份，漏一个就是同一个 bug 再来一次。
   */
  const withoutNegatedReduce = scope
    .replace(/无需削减|无须削减|不必削减|不用削减|不建议削减|无须减半|不必减半/g, '')
    .replace(/无需|无须|不必|不用|不建议/g, '');
  const reduce = /削减|减半|降低仓位|reduce/i.test(withoutNegatedReduce);

  /*
   * ⚠️ **理由的提取要认 JSON 结构**（2026-10-15）。
   *
   * 原来是 `firstLine`（第一行非空文本）—— 而结构化输出时**第一行就是那个 JSON 对象**，
   * 于是线上渲染成「（风控官未给出理由）」：
   * ```
   *   <risk> 否决（group/auto-qfmodel）：（风控官未给出理由）
   * ```
   * **它明明给了理由**（`lossScenarios` 里写得清清楚楚）。
   *
   * 现在：优先取 JSON 里的 `checked`（它自己写的"我查了什么"），
   * 没有则用第一条 `lossScenarios[].scenario`（它担心的具体亏损场景）。
   * 两者都没有才退回散文第一行。
   */
  const jsonReason = ((): string | null => {
    const checked = /"checked"\s*:\s*"((?:[^"\\]|\\.){1,300})"/.exec(text);
    if (checked !== null) return checked[1]!.replace(/\\"/g, '"');
    const scenario = /"scenario"\s*:\s*"((?:[^"\\]|\\.){1,300})"/.exec(text);
    if (scenario !== null) return scenario[1]!.replace(/\\"/g, '"');
    return null;
  })();
  const reason = (jsonReason ?? firstLine ?? '（风控官未给出理由）').slice(0, 300);

  /* 担心点：找含"风险/担心/不确定"的那一句。 */
  const concernLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /风险|担心|不确定|隐患/.test(l));
  const concern = concernLine === undefined ? null : concernLine.slice(0, 300);

  /*
   * ⚠️ **结构化 `verdict` 优先**（2026-10-15）—— 见上面 `jsonVerdict` 的完整说明。
   *
   * ```
   *   approve  → 放行
   *   tighten  → 放行 + 削减（**不是否决**）
   *   reject   → 否决
   * ```
   * 它比散文正则可靠：那是**提示词要求模型输出的字段**，是机器契约（§5.2）。
   */
  if (jsonVerdict === 'reject') {
    return { approved: false, reduced: false, adjusted: null, reason, concern };
  }
  if (jsonVerdict === 'tighten') {
    return {
      approved: true,
      reduced: true,
      adjusted: reduceDecisions(decisions),
      reason,
      concern,
    };
  }
  if (jsonVerdict === 'approve') {
    return { approved: true, reduced: false, adjusted: null, reason, concern };
  }

  /*
   * ⚠️ **否决优先**（`reject` 为真就拦，不管 `approve` 是否也为真）。
   *
   * 第一版写的是 `reject && !approve` —— 那让"同时出现批准与否决"时**放行**。
   * 而风控的方向应该是**宁可拦下**：双真意味着模型的表态自相矛盾
   *（或者我的正则又误判了），那种情况下放行是最坏的选择。
   *
   * 纵深防御：正则已经修好了（`(?<!不)同意`），但**判断顺序也要对** ——
   * 两个都修，任一个出问题都还有另一个兜着。
   *
   * ⚠️ 这一支现在只服务**散文格式**的输出（没有 `verdict` 字段时）。
   */
  if (reject) {
    return { approved: false, reduced: false, adjusted: null, reason, concern };
  }
  if (approve || reduce) {
    return { approved: true, reduced: reduce, adjusted: reduce ? reduceDecisions(decisions) : null, reason, concern };
  }

  /*
   * **既没说批准也没说否决**（格式不合）→ 保守策略。
   *
   * 只放行"降低风险"的动作，拦住"增加风险"的。
   * 这样一次格式抖动不会让机器人停摆（平仓照常能做），
   * 也不会让它在这种情况下加仓。
   */
  const safe = decisions.filter((d) => isRiskReducing(d.action));
  return {
    approved: safe.length > 0,
    reduced: safe.length !== decisions.length,
    adjusted: safe.length === decisions.length ? null : safe,
    reason: `${reason}（未能识别风控官的表态，按保守策略只放行降低风险的动作）`,
    concern,
  };
}

/**
 * 这个动作是"降低风险"的吗。
 *
 * ## ⚠️ 为什么必须用共享包的判定，而不是自己写字符串列表
 *
 * 第一版我手写了 `action === 'close_position'` —— **而那个动作名根本不存在**
 *（真实值是 `close_long` / `close_short`）。后果很严重且很隐蔽：
 *
 * · `isRiskReducing` 对**所有真实平仓动作都返回 false**；
 * · 于是"表态不明时的保守策略"会把**平仓也拦住** ——
 *   而那是风控官最不该拦的东西（看不清楚时该允许降低风险，不是禁止）。
 *
 * 类型检查抓到了它（`'close_position'` 与联合类型无交集），
 * 但**只因为共享包里已经有 `DecisionAction` 联合类型**。
 * 用现成的谓词（`isCloseAction`）就不可能有这个错。
 *
 * 这就是"不重复造轮子"在**类型安全**上的具体价值。
 */
function isRiskReducing(action: DecisionAction): boolean {
  return isCloseAction(action) || action === 'reduce_position' || action === 'adjust_protection';
}

/**
 * 削减决策的仓位 —— **只动"规模"，不动方向**。
 *
 * ## 为什么只削规模
 *
 * 风控官说"仓位太大"时，它表达的是**规模**问题，不是方向问题。
 * 去改方向（把 `open_long` 改成 `open_short`）是**越权** ——
 * 那推翻了裁决官的结论，而裁决官才是做方向判断的那个人。
 *
 * ## 削减比例固定 50%（而不是让模型给一个数）
 *
 * "减半"是**可审计的、确定的**规则；让模型给数字会引入
 * "它说减到 30% 但我解析错了"的风险。要更精细就多削一次，而不是让它写小数。
 *
 * ## 削哪些
 *
 * **只削"增加风险"的动作**（开仓 / 加仓）—— 那才是"仓位太大"指的东西。
 * 平仓、减仓、调保护位是**降低风险**的，削它们等于让风控官帮倒忙
 *（把"该减的仓"减得更少）。
 */
/**
 * 这个动作**有没有仓位可以削**。
 *
 * ## ⚠️ 为什么必须与 `isRiskReducing` 分开（2026-10-15 修，一次真实留痕事故）
 *
 * 原来的削减分支只判了 `isRiskReducing`：
 * ```
 *   if (isRiskReducing(d.action)) return d;   // 降低风险的 → 不动
 *   …                                         // 其余【全部】加"削减 50%"前缀
 * ```
 * 而 `isRiskReducing` 只认 `close_*` / `reduce_position` / `adjust_protection` ——
 * 于是 **`skip` / `hold` / `wait` 也走进了削减分支**，被加上
 * `[风控官削减 50%]` 前缀，而它们**根本没有仓位可削**。
 *
 * 线上实测：**20 条 `skip` 带这个前缀**。后果：
 * ```
 *   审计块显示"削减后放行"，而实际一个仓位都没削 ——
 *   而"事后能说清当时为什么这么做"正是审计块唯一的用途。
 * ```
 * ⚠️ 它与上一条（否定式误判）**叠加**时会让人以为风控官真的在管仓位。
 *
 * ## 判据：只有"会占用保证金"的动作才谈得上削减
 *
 * ```
 *   能削：open_long / open_short / add_to_position
 *   不能削：skip / hold / wait（无仓位）· close_* / reduce_position（降风险）
 * ```
 */
function canBeReduced(action: DecisionAction): boolean {
  return action === 'open_long' || action === 'open_short' || action === 'add_to_position';
}

function reduceDecisions(decisions: readonly Decision[]): Decision[] {
  return decisions.map((d) => {
    /*
     * ⚠️ **只有"能削的动作"才进削减分支**（2026-10-15 修）。
     * 原来只判 `isRiskReducing`，于是 `skip`/`hold` 也被加上了削减留痕
     *（线上 20 条）—— 见 `canBeReduced` 的说明。
     */
    if (!canBeReduced(d.action)) return d;

    const next: Decision = { ...d };
    /*
     * ══════════════════════════════════════════════════════════════════════
     *  ⚠️⚠️ **必须同时改 snake_case 与 camelCase**（2026-10-15 修，真钱事故）
     * ══════════════════════════════════════════════════════════════════════
     *
     * ## 事故：数值没动，却留痕说"削了"
     *
     * `routedModel.ts` 把裁决官的**原始 JSON** 交给风控官，而模型惯用
     * **snake_case**（`position_size_usd` / `risk_usd`）。而这里原来只改 camelCase：
     * ```
     *   裁决官用 snake_case → 11 USDT 原样通过（【没削】）
     *   而 reasoning 已经被加上 "[风控官削减 50%]"
     *   ⇒ 事后看审计块会以为"风控官削过了"，实际仓位是原值
     * ```
     * 实测线上：225 轮里裁决官 **10 轮用 snake_case**、26 轮用 camelCase；
     * 削减生效的 5 轮**全部是 camelCase** —— 两种形状都已出现，
     * 只是还没撞在一起，而 `#11` 正在频繁开仓。
     *
     * ## 修法：两个键名都改（并且**只有真的改到了才留痕**）
     *
     * 顺序很重要：**先看有没有可改的字段，改到了才写前缀**。
     * 否则"没削成"仍然会留下假痕 —— 那正是这个 bug 最坏的部分。
     */
    let touched = false;
    if (typeof next.positionSizeUsd === 'number') {
      next.positionSizeUsd = next.positionSizeUsd / 2;
      touched = true;
    }
    if (typeof next.riskUsd === 'number') {
      next.riskUsd = next.riskUsd / 2;
      touched = true;
    }
    /*
     * snake_case 别名。类型上 `Decision` 没有这两个键，所以用一次显式收窄 ——
     * 运行时它们确实可能出现（那是模型给的原始形状）。
     */
    const loose = next as unknown as Record<string, unknown>;
    for (const key of ['position_size_usd', 'risk_usd'] as const) {
      if (typeof loose[key] === 'number') {
        loose[key] = (loose[key] as number) / 2;
        touched = true;
      }
    }

    /*
     * ⚠️ **没改到任何字段就不留痕** —— 留一条"削减 50%"却说不出削了什么，
     * 比不削更糟（它让审计块说谎）。
     */
    if (!touched) return d;

    /*
     * 在理由里**标明这是被削减过的** —— 否则事后看记录会以为
     * "AI 当时就想开这么小的仓"，而真相是风控官削了一半。
     * 审计的可信度靠这种痕迹。
     */
    next.reasoning = `[风控官削减 50%] ${next.reasoning ?? ''}`.trim();
    return next;
  });
}
