/**
 * **AI 工作流看板** —— 团队模式（`ai_team`）决策区的**固定头部**。
 *
 * ## 用户的要求（2026-10-12，逐条）
 *
 * > 「UI 丑陋，不直观，用户无法看清楚 AI 运行状态，界面丑陋抽象，**有英文**，
 * >  还有不合理不人性化，感觉不是给人看的」
 *
 * > 「在我想象中应该是**固定展示 AI 工作流**，一部分**滚动展示最终决策**等关键信息」
 *
 * > 「应该是上面固定展示**各智能体工作状态和摘要**，用户有需要可以手动点击打开查看详情」
 *
 * ## 这一版与旧 `TeamRoster` 的差别（不是"美化"，是形态不同）
 *
 * | 维度 | 旧 `TeamRoster` | **本组件** |
 * |---|---|---|
 * | 配色 | 用了一批**不存在的 Tailwind 类**（`border-base-700` / `bg-base-850` / `bg-up`…）→ 渲染出来没有边框没有底色，状态灯没有颜色 | 只用 `tailwind.config.js` 里**真实存在**的令牌，逐条核对过 |
 * | 组织 | 一张 8 行的大表，**只列本轮参与过的角色** | 按**部门**分组（管理/研究/风控/执行/技术），**在岗/规划中全列出** |
 * | 状态 | 圆点只有颜色，且颜色失效 → 看不出在干什么 | 圆点 + **中文状态词**（进行中/已完成/失败/在岗/规划中），色盲也能读 |
 * | 摘要 | 只显示"最近动作"，看不出这个岗位**该干什么** | 分工 + 最近产出摘要**同时在场** |
 * | 时长 | 有 | 有（沿用），另加**阶段进度**（派发→分析→辩论→裁决→风控） |
 * | 详情 | 没有入口 | **每个岗位可点开**看它的完整步骤；另有一键展开全部 |
 *
 * ## 为什么按"部门"分组而不是平铺一张表
 *
 * 用户要的是「**有哪些智能体，都是什么分工**」。一家量化机构的分工是**有结构**的
 * （研究出材料 → 风控把关 → 执行落地），平铺成一张表就看不出这条链。
 * 部门顺序来自 `DEPARTMENT_ORDER`（与 `FIRM_ROLES` 同源），和用户脑子里的
 * 组织图一致：管理在最上面，那是决策链的起点。
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DEPARTMENT_ORDER, FIRM_ROLES, type FirmRole } from '@aq/shared';

import {
  BATCHED_STATE_HINT,
  PHASE_LABEL,
  STATE_HINT,
  isBatchedRole,
  stateLabelFor,
  TIER_LABEL,
  clock,
  lastSeenFromServer,
  lastSeenOf,
  rosterEntries,
  type RosterEntry,
  type RosterState,
  type TeamStep,
} from './roster';
import { api } from '../../lib/api';
import { plainText } from '../../lib/plainText';
import { HumanMessage } from './humanText';

/** 从状态得到圆点的样式（全部是真实存在的类，见 `roster.ts` 的对照表）。 */
const DOT_CLASS: Record<RosterState, string> = {
  active: 'bg-accent animate-pulse-soft',
  done: 'bg-up',
  failed: 'bg-down',
  idle: 'border border-ink-faint',
  /*
   * `by_code` 用**空心 + accent 描边** —— 与 `idle` 的空心区分开：同样是空心，
   * 但 `up`（实心绿，已完成）说的是"有一个模型刚交出产出"，这里没有模型。
   * 空心还顺带表达了"它不是那种会亮起来的模型岗位"。
   */
  by_code: 'border-2 border-accent bg-accent/20',
  planned: 'bg-ink-faint/40',
};

/** 从状态得到文字颜色。 */
const STATE_TEXT_CLASS: Record<RosterState, string> = {
  active: 'text-accent',
  done: 'text-up',
  failed: 'text-down',
  idle: 'text-ink-lo',
  by_code: 'text-accent',
  planned: 'text-ink-faint',
};

/**
 * 阶段的展示顺序 —— 与 `tradingDesk.ts` 的编排一致。
 *
 * 用它画一条**进度轨**：操作员一眼看出"这一轮走到哪一步了"，
 * 而不是自己去读七行日志推断。
 */
const PHASE_FLOW: readonly string[] = ['dispatch', 'analysis', 'debate', 'verdict', 'risk'];

/**
 * 已用时。`8 秒` / `1 分 12 秒`。
 *
 * 不用 `fmtDuration`（它入参是**分钟**）：团队一轮可以跑几秒到几分钟，
 * 用分钟为单位会把 8 秒显示成 `0.1 分钟`，正好丢掉这个读数唯一的价值。
 */
function elapsedLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/**
 * **"最近活跃于 X"的文案**（去轮次化阶段 3）。
 *
 * 与 `clock()`（HH:MM:SS）分开：操作员要的是"多久之前"这个相对量，
 * 绝对时刻反而要心算。`null` 返回 `null`（调用方显示"待命"）。
 */
function lastSeenLabel(at: string | null, now: number): string | null {
  if (at === null) return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return '刚活跃过';
  if (sec < 3600) return `最近活跃 ${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86_400) return `最近活跃 ${Math.floor(sec / 3600)} 小时前`;
  return `最近活跃 ${Math.floor(sec / 86_400)} 天前`;
}

/**
 * **"多久之前"的一句话**（回放态头部用）：`刚刚` / `42 分钟前` / `3 小时前`。
 *
 * 与 `lastSeenLabel` 分开：那个说的是"这个岗位最近一次干活是什么时候"，
 * 这里说的是"**这一轮**是什么时候跑的"。两者都要相对量 —— 绝对时刻
 * （`clock()` 的 `HH:MM:SS`）在这里反而要操作员心算。
 */
function agoLabel(at: string | null, now: number): string | null {
  if (at === null) return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86_400)} 天前`;
}

/**
 * **工作流看板**。
 *
 * @param steps 本轮的实时步骤流（`LiveCycle.steps`）
 * @param cycleNumber 本轮编号
 * @param startedAt 本轮开始时刻（epoch ms），用于算"已用时"
 * @param roster 编制表（默认 `FIRM_ROLES`；注入是为了可测）
 * @param replay **这不是在途轮次，而是最近一轮的历史回放**（台账 UI-01）。
 *   为真时：头部写「最近一轮 #N · X 分钟前」、状态词用「已产出（上一轮）」、
 *   阶段轨隐藏（`<team>` 块里根本没有阶段信息，编一个出来就是假事实）。
 * @param replayAt 被回放的那一轮的时刻（ISO）；`null` = 不知道。
 */
export function TeamBoard({
  steps,
  cycleNumber,
  startedAt,
  roster = FIRM_ROLES,
  history = [],
  initialShowRest = false,
  replay = false,
  replayAt = null,
  traderId,
}: {
  steps: readonly TeamStep[];
  cycleNumber: number;
  /** `null` = 不知道开始时刻（例如页面刚连上），此时不显示计时器。 */
  startedAt: number | null;
  roster?: readonly FirmRole[];
  /**
   * **这不是在途轮次，而是最近一轮的历史回放**（台账 UI-01）。
   *
   * 为真时三处都变：头部写「最近一轮 #N · X 分钟前」、岗位状态词走
   * `stateLabel(state, true)`（→「已产出（上一轮）」）、阶段轨整条不渲染。
   * 默认 `false` = 实时态（逐字节与改动前一致）。
   */
  replay?: boolean;
  /** 被回放的那一轮的时刻（ISO）；`null` = 不知道（头部就不显示"多久之前"）。 */
  replayAt?: string | null;
  /**
   * **历史决策记录**（从旧到新）—— 用于"最近活跃于 X 分钟前"。
   *
   * 去轮次化阶段 3：团队按需出勤，"本轮没跑"是常态而非异常。
   * 旧 UI 写"本轮未参与"，用户抓到：
   * > 「团队模式不应该是完全抛弃了轮次这个概念吗？而是 7X24 不间断按需工作」
   * 有了历史，同一行能如实显示"最近活跃于 12 分钟前"。
   * ⚠️ 可选：拿不到历史时退回旧行为（不会崩）。
   */
  history?: ReadonlyArray<{ cotTrace: string | null | undefined; timestamp: string }>;
  /**
   * **这个看板属于哪个机器人** —— 用于拉"各岗位最近露面时刻"与"岗位历史详情"。
   *
   * ## 为什么需要它（2026-10-17 · t111 · 用户实测报的问题）
   *
   * 用户原话：
   * > 「很多岗位，似乎**从未真正运行过**，页面上也没有显示他们**最新运行时间**」
   *
   * 根因是**数据源只读了一半**：`history` 里的 `cotTrace` 只有进了 `<team>` 块的
   * 角色（分析师 / bull / bear / judge），而 `supervisor` / `risk_officer` /
   * `reporter` 的步骤写在 `runtime_logs`（scope='team'）里 —— 界面从没读过那张表。
   *
   * 有了 `traderId` 才能去 `/api/traders/:id/agent/last-seen` 补上那一半。
   *
   * ⚠️ **可选**：不传时行为与改动前**逐字一致**（不拉网络、只用 `cotTrace`）。
   * 这一条不是客套 —— `boardRender.test.ts` 用 `renderToStaticMarkup` 直接渲染本组件
   * （**没有 Router、也没有后端**），required prop 会让那些 SSR 断言全部崩掉。
   */
  traderId?: number;
  /**
   * 「其余岗位」那一节**初始**是否摊开（默认收起，与线上行为一致）。
   *
   * ## 为什么这个 prop 存在（不是为了好看，是为了可测）
   *
   * 默认收起是刻意的（见下面 `showRest` 的注释：摊开会把决策区挤没）。
   * 但那意味着"其余岗位"里那些行的状态词**根本不在 HTML 里** ——
   * SSR 断言就看不见它们，而 `by_code` 这两个岗位（本轮没参与）正在那一批里。
   *
   * 于是"新状态有没有走对分支"变成了**只能靠肉眼看**的东西，而本仓库对此有明文规矩
   * （`AGENTS.md`：对齐/错位这类问题要量，不要看）。加一个注入点，
   * 让 `boardRender.test.ts` 能把那一节渲染出来并**断言真实的字**。
   * 与 `roster` 参数同一个思路：**可注入 = 可测**。
   */
  initialShowRest?: boolean;
}): React.ReactElement {
  /*
   * 计时器每秒刷新 —— 让"这一轮跑了多久"是活的。
   *
   * ⚠️ **`startedAt` 为 `null` 时不挂计时器**：拿不到开始时刻却每秒跳一个数，
   * 那个数是编的（`Date.now() - 0`），而"跑了 50000 秒"会让操作员去查一个
   * 不存在的事故。
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⭐ **"各岗位最近露面时刻" = cotTrace ∪ 服务端步骤日志**（2026-10-17 · t111）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * `history`（cotTrace）只是**一半**：里面只有进了 `<team>` 块的角色。
   * `supervisor` / `risk_officer` / `reporter` 的步骤写在 `runtime_logs`
   * （`scope='team'`，格式 `[phase] role：note`），而界面从来没读过那张表 ——
   * 于是那三个角色在界面上**永远"待命"**，而线上 supervisor 出现 31 次。
   *
   * `traderId` 缺省时不发请求（SSR 测试没有后端，也不该有副作用），
   * 行为与改动前逐字一致。
   */
  const [serverSeen, setServerSeen] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    if (traderId === undefined) return;
    /*
     * ⚠️ **`live` 守卫 + `AbortController`**：切机器人时旧请求可能后到，
     * 把 A 机器人的时刻写到 B 机器人的看板上 —— 那会造出"B 的某个岗位
     * 3 分钟前活跃过"的假事实。
     */
    let live = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await api.traderAgentLastSeen(traderId, controller.signal);
        if (live) setServerSeen(lastSeenFromServer(res.roles));
      } catch {
        /*
         * 拉不到就**保持空**（退回只用 cotTrace）—— 这是**降级**，不是失败：
         * 界面仍然显示"待命"，与改动前一致。绝不拿一个猜的时刻去点亮编制表。
         */
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [traderId]);

  const seen = useMemo(() => lastSeenOf(history, serverSeen), [history, serverSeen]);
  const entries = useMemo(() => rosterEntries(steps, roster, seen, replay), [steps, roster, seen, replay]);

  /** 一键"展开全部详情" —— 用户说"用户有需要可以手动点击打开查看详情"。 */
  const [allOpen, setAllOpen] = useState(false);
  /** 单独展开的岗位（与 `allOpen` 取并集，这样"展开全部"之后再单点收起是可行的）。 */
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * 「在岗未参与 / 规划中」那批要不要摊开。
   *
   * ## 为什么默认收起（这是本组件最重要的一条取舍）
   *
   * 编制表有 20 个岗位，而**真正干活的通常只有 7–9 个**。全部摊开时：
   *
   *   · 固定区会占掉 ~700px，而决策区只有约 600px —— **滚动决策区被挤到看不见**，
   *     而那正是用户要的"一部分滚动展示最终决策"（两者会互相毁掉）；
   *   · 更糟的是**信噪比**：9 行"本轮未参与"会把 7 行真正在干活的压在里面，
   *     而"谁在干活"才是这个区存在的理由。
   *
   * 所以默认只摊开**这一轮真的动过的岗位**，其余压成一行计数 + 可展开。
   * 计数本身就把"这家公司还有多少人没上场"说清楚了 —— 那是诚实、
   * 而且不需要占 400px 的诚实。
   */
  const [showRest, setShowRest] = useState(initialShowRest);

  const isOpen = (id: string): boolean => (allOpen && !closed.has(id)) || (!allOpen && closed.has(id));

  /**
   * 本轮的**进度**：走到哪个阶段了。
   *
   * 判据是"这个阶段有没有出现过步骤" —— 服务端没有推"阶段完成"事件，
   * 所以只能说"到过这里"。把"到过"说成"完成"就是在编造。
   */
  const seenPhases = useMemo(() => {
    const set = new Set<string>();
    for (const s of steps) if (s.phase) set.add(s.phase);
    return set;
  }, [steps]);

  /*
   * 分成"本轮动过的"与"没动的"两批。
   *
   * `active` / `done` / `failed` 三种都算**动过**（失败也是一种工作状态，
   * 而且是最该被看见的一种）。
   */
  const participated = entries.filter((e) => e.latest !== null);
  const rest = entries.filter((e) => e.latest === null);

  /** 按部门分组（只对要显示的那一批做，保证部门顺序稳定）。 */
  const byDept = (list: RosterEntry[]): Array<[string, RosterEntry[]]> => {
    const map = new Map<string, RosterEntry[]>();
    for (const dept of DEPARTMENT_ORDER) map.set(dept, []);
    for (const entry of list) {
      const bucket = map.get(entry.role.department);
      if (bucket) bucket.push(entry);
      else map.set(entry.role.department, [entry]);
    }
    return [...map.entries()].filter(([, items]) => items.length > 0);
  };

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️ **头部计数只数【编制表里登记过的】岗位**（t80 修）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * `rosterEntries` 会把**不在册**的 role 追加成一行（那是对的：丢掉它会让
   * "某个角色在干活但界面看不到"），但**计数是另一回事**：
   *
   * ```
   *   在册岗位        → 用户能在编制表里对上号，"本轮在干 N / 失败 N"说的是这家公司
   *   不在册的 role   → 只能写"界面还没登记"（`roster.ts:338-352`），
   *                     把它算进"在干/失败"，说的就是**界面自己不认识的东西**
   * ```
   *
   * 实测形态（t80，`routedModel` 的 agent 层路由步骤归到真实角色 `strategist` 之后）：
   * ```
   *   头部「本轮在干 1 失败 1」+ 一行 `strategist 失败`
   *   —— 而"策略师"这个岗位**编制表里根本没有**，操作员无从对上号
   * ```
   * ⚠️ 这是**误报**（与"把别人的失败记到总管头上"同族，只是换了一格）：
   * 一个界面认不出的角色占着"失败"这个最该被信任的计数。
   *
   * 所以：**行仍然照常渲染**（那是"看得见"的保证），
   * 但**计数只统计登记过的岗位** —— 数字必须能对上编制表。
   *
   * ⚠️ 判据用 `FIRM_ROLES` 里的 id，不看 `entry.role.label === id` ——
   * 那是一个"看起来等价"的巧合（未登记岗位的 label 恰好是 id），
   * 而将来若有人给它们补了中文 label，那个判据会**静默失效**（本仓库付过多次这种代价）。
   */
  const registeredIds = new Set(roster.map((r) => r.id));
  const counted = entries.filter((e) => registeredIds.has(e.role.id));

  const working = counted.filter((e) => e.state === 'active' || e.state === 'done').length;
  const failed = counted.filter((e) => e.state === 'failed').length;
  const idleStaffed = counted.filter((e) => e.state === 'idle').length;
  /*
   * `by_code` 与 `planned` 必须**分开计数**（2026-10-15）：
   * 前者是"这个职能在跑、只是由代码承担"，后者是"还没实现"。
   * 合并成一个数字会让"规划中 7"里混进两个**正在跑**的岗位 —— 那就是原本那个谎言。
   */
  const byCode = counted.filter((e) => e.state === 'by_code').length;
  const planned = counted.filter((e) => e.state === 'planned').length;

  const elapsedSec =
    startedAt === null ? null : Math.max(0, Math.floor((now - startedAt) / 1000));

  return (
    <section
      aria-label="AI 工作流"
      /*
       * ⚠️ **`flex-1 min-h-0` + 纵向 flex**：这个看板要**填满**外层给它的那份高度，
       * 而不是按内容长高。
       *
       * ## 为什么不是 `h-full`
       *
       * 外层固定区的高度是**内容高度被 `max-h-[45%]` 夹住**的结果 ——
       * 对 `height: 100%` 来说那是"未定义高度"，百分比会退回 `auto`，
       * 于是这个看板按内容长高、把固定区撑破，`max-h` 形同虚设。
       *
       * `flex-1` 走的是另一条路：外层高度被 `max-h` 夹到小于内容时，
       * 自由空间为负，`flex-shrink` 把这一项压回去 —— 高度链才真正成立。
       *
       * `min-h-0` 不能省：flex 子项默认 `min-height: auto`，那一项会让它
       * 永远不肯比内容矮，下面那个编制表的 `overflow-y-auto` 就永远不会滚。
       */
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-base-700 bg-base-900 shadow-panel"
    >
      {/* ── 头：这一轮是谁、跑了多久、走到哪一步 ───────────────────────── */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-base-750 bg-base-850 px-3 py-2">
        <span className="flex items-center gap-1.5 text-base font-semibold text-ink-hi">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse-soft" />
          AI 工作流
        </span>
        {/*
          ⚠️ **在途 / 回放，两句话**（台账 UI-01）。
          ```
            在途：「第 103 轮」           —— 现在正在跑第 103 轮
            回放：「最近一轮 #103 · 42 分钟前」 —— 没有在途轮次，这是上一轮的产出
          ```
          原来的文案只有前者，于是没有在途轮次时界面上写着「第 103 轮」
          与「本轮在干 4」—— 而那一轮 42 分钟前就结束了（真实浏览器实测）。
        */}
        <span className="num text-xs text-ink-lo">
          {replay ? `最近一轮 #${cycleNumber}` : `第 ${cycleNumber} 轮`}
        </span>
        {replay && agoLabel(replayAt, now) !== null && (
          <span className="num text-xs text-ink-faint" title="这一轮是什么时候跑完的（相对时间）。">
            · {agoLabel(replayAt, now)}
          </span>
        )}

        {/*
          进度轨：走到过哪些阶段。
          `text-ink-hi` 表示"到过"，`text-ink-faint` 表示"还没到" ——
          用颜色之外还有**箭头方向**表达顺序，不依赖颜色。

          ⚠️ **回放态整条不渲染**（台账 UI-01 验收 ③）。
          回放的数据来自已落库的 `<team>` 块，那里**没有阶段信息**
          （`latestTeamSteps` 的 `phase` 恒为 `null`），于是这条轨在回放态
          **永远全灰** —— 读起来像"一步都没走到"，而那一轮其实跑完了。
          全灰与全亮都是编的，所以不显示。
        */}
        {!replay && (
          <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs" aria-label="本轮编排进度">
            {PHASE_FLOW.map((phase, index) => {
              const seen = seenPhases.has(phase);
              return (
                <li key={phase} className="flex items-center gap-1">
                  {index > 0 && (
                    <span aria-hidden className="text-ink-faint">
                      →
                    </span>
                  )}
                  <span className={seen ? 'text-ink-hi' : 'text-ink-faint'}>{PHASE_LABEL[phase] ?? phase}</span>
                </li>
              );
            })}
          </ol>
        )}

        {/* 四个计数把"团队现在什么状况"压成一句话 —— 回放态说的是**上一轮产出**。 */}
        <span className="ml-auto flex flex-wrap items-center gap-x-2 text-xs">
          <span className="text-up">
            {replay ? `上一轮产出 ${working}` : `本轮在干 ${working}`}
          </span>
          {failed > 0 && <span className="text-down">失败 {failed}</span>}
          <span className="text-ink-lo">在岗未叫 {idleStaffed}</span>
          {/*
            ⚠️ 这一项不能省、也不能并进"规划中"：它是**在跑**的职能。
            写"代码在跑"而不是"已由代码承担"，是因为这里回答的问题是"有没有人在干"。
          */}
          {byCode > 0 && (
            <span className="text-accent" title={plainText(STATE_HINT.by_code)}>
              代码在跑 {byCode}
            </span>
          )}
          <span className="text-ink-faint">规划中 {planned}</span>
        </span>

        {elapsedSec !== null && (
          <span
            className={`num text-xs tabular-nums ${elapsedSec >= 120 ? 'text-warn' : 'text-ink-lo'}`}
            title="本轮从开始到现在的时长。团队模式一轮可以是几秒，也可以是几分钟 —— 调研型角色要联网查资料。"
          >
            已跑 {elapsedLabel(elapsedSec)}
          </span>
        )}

        {/*
          「展开全部」而不是"每个岗位各点一次"：用户说"有需要可以手动点击打开查看详情"，
          而"想知道这一轮到底每一步都做了什么"是一个**整体**的需求。
        */}
        <button
          type="button"
          onClick={() => {
            setAllOpen((v) => !v);
            setClosed(new Set());
          }}
          aria-expanded={allOpen}
          className="rounded px-1.5 py-0.5 text-xs text-ink-lo transition hover:bg-base-800 hover:text-ink-hi"
        >
          {allOpen ? '收起全部详情' : '展开全部详情'}
        </button>
      </header>

      {/* ── 编制表：按部门分组 ─────────────────────────────────────────── */}
      {entries.length === 0 ? (
        <p className="px-3 py-4 text-xs text-ink-faint">团队正在组建 —— 还没有任何岗位登记。</p>
      ) : (
        <div
          /*
           * ⚠️ **`flex-1 min-h-0` —— 高度由外层固定区给，不是又一层 `max-h`。**
           *
           * 上一版这里写的是 `max-h-[38vh] overflow-y-auto`，那是错的：
           * `38vh` 是**视口**的 38%，而决定这里该多高的是**面板**的高度
           * （右栏那条 `h-full` 链）。900px 视口上 38vh = 342px 看着还行，
           * 可它上面还有看板头与外层内边距 —— 实测整块固定区到 429px，
           * 决策区只剩 123px，**装不下一轮决策**。
           *
           * 现在：外层是 `max-h-[45%]` 的 flex 容器，这里 `flex-1 min-h-0`
           * 拿"剩下的高度"并自己滚。`min-h-0` 不能省 —— flex 子项默认
           * `min-height: auto`，那一项会让它永远不肯比内容矮，滚动条就消失了。
           */
          className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5"
        >
          {byDept(participated).map(([dept, list]) => (
            <DeptGroup
              key={dept}
              dept={dept}
              list={list}
              steps={steps}
              replay={replay}
              isOpen={isOpen}
              traderId={traderId}
              onToggle={(id) =>
                setClosed((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
            />
          ))}

          {/*
            其余岗位（在岗未参与 / 规划中）—— **压成一行**。
            计数本身就说清了"这家公司还有多少人没上场"，那是诚实，
            而且不需要占 400px 的诚实（见上面 `showRest` 的说明）。
          */}
          {rest.length > 0 && (
            <div className="overflow-hidden rounded-md border border-base-750">
              <button
                type="button"
                onClick={() => setShowRest((v) => !v)}
                aria-expanded={showRest}
                className="flex w-full items-center gap-2 bg-base-850 px-2.5 py-1.5 text-left transition hover:bg-base-800"
              >
                <ChevronRight
                  aria-hidden
                  className={`h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform ${showRest ? 'rotate-90' : ''}`}
                />
                <span className="text-xs font-semibold text-ink-mid">其余岗位</span>
                <span className="num text-[11px] text-ink-faint">{rest.length} 个</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
                  {idleStaffed > 0 && `在岗未参与 ${idleStaffed}`}
                  {idleStaffed > 0 && (byCode > 0 || planned > 0) && ' · '}
                  {/*
                    ⚠️ 措辞与"规划中"必须一眼可分：这里是"已由代码承担"（在跑），
                    下一项才是"规划中（还没实现）"。写反了或合并了，这一行就在骗人。
                  */}
                  {byCode > 0 && `已由代码承担 ${byCode}`}
                  {byCode > 0 && planned > 0 && ' · '}
                  {planned > 0 && `规划中 ${planned}（还没实现）`}
                </span>
                <span className="shrink-0 text-[11px] text-ink-lo">{showRest ? '收起' : '展开'}</span>
              </button>
              {showRest && (
                <div className="space-y-2 p-2.5">
                  {byDept(rest).map(([dept, list]) => (
                    <DeptGroup
                      key={dept}
                      dept={dept}
                      list={list}
                      steps={steps}
                      replay={replay}
                      isOpen={isOpen}
                      traderId={traderId}
                      onToggle={(id) =>
                        setClosed((prev) => {
                          const next = new Set(prev);
                          if (next.has(id)) next.delete(id);
                          else next.add(id);
                          return next;
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** 一个部门一组岗位。抽出来是因为"参与过的"与"其余"两处都要用同一套渲染。 */
function DeptGroup({
  dept,
  list,
  steps,
  replay,
  isOpen,
  onToggle,
  traderId,
}: {
  dept: string;
  list: RosterEntry[];
  steps: readonly TeamStep[];
  /** 透传给 `AgentRow`：回放态的状态词与实时态不同（见 `stateLabel`）。 */
  replay: boolean;
  isOpen: (id: string) => boolean;
  onToggle: (id: string) => void;
  /** 透传给 `AgentRow`：拉"历史工作详情"用（`undefined` = 不拉）。 */
  traderId?: number;
}): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-md border border-base-750">
      <div className="flex items-center gap-2 border-b border-base-750 bg-base-850 px-2.5 py-1">
        <span className="text-xs font-semibold text-ink-mid">{dept}</span>
        <span className="num text-[11px] text-ink-faint">{list.length} 个岗位</span>
      </div>
      <ul className="divide-y divide-base-800">
        {list.map((entry) => (
          /*
           * ⚠️ `data-role` 不是装饰：SSR 回归测试要靠它把**这一行**切出来，
           * 才能断言"这一行的状态词是什么"而不是"整页某个地方出现了那个词"
           * （后者会把别的岗位、甚至头部计数里的同一个词误当成本行的证据）。
           */
          <li key={entry.role.id} data-role={entry.role.id}>
            <AgentRow
              entry={entry}
              replay={replay}
              open={isOpen(entry.role.id)}
              onToggle={() => onToggle(entry.role.id)}
              steps={steps.filter((s) => s.role === entry.role.id)}
              traderId={traderId}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 一个岗位一行（可展开）。
 *
 * ## 折叠态回答的三个问题
 *
 * 1. **它在不在干活** → 状态圆点 + 中文状态词
 * 2. **它刚做出了什么** → 最近产出摘要 + 时刻（**主信息**）
 * 3. **它是干什么的** → 分工（`duty`，见下面"为什么它不在这一行里"）
 *
 * 用户原话是「固定展示各智能体工作状态和摘要」——
 * 需要点开才知道"它在不在干活"就等于没做到。所以状态与摘要**始终可见**。
 *
 * ## ⚠️ 2026-10-15 重排：职责从行内移走（先量、再改）
 *
 * 用户这一轮的反馈是「功能布局要合理，方便用户使用，**用户体验至上**」。
 * 用真实页面量到的问题（`getBoundingClientRect` + `scrollWidth > clientWidth`）：
 * ```
 *   右栏总宽 597px（xl:flex-[2]），一行里三个 `flex-1` 平分剩余宽度
 *   职责      可用 142px / 需要 272px   ← 砍掉 48%
 *   本轮产出  可用 142px / 需要 387px   ← 砍掉 63%
 * ```
 * 而**产出才是"它这一轮在做什么"的答案**，却只剩开头几个字，
 * 想看全只能鼠标悬浮 `title` —— 触屏不成立，扫一眼也不成立。
 *
 * 所以：产出拿剩余宽度并**允许两行**（`line-clamp-2`），职责让位
 *（静态说明看一次就够，产出每一轮都在变）。职责仍然可达：
 * `role.label` 的 `title` 悬浮可见，展开态里有全文。
 */
function AgentRow({
  entry,
  replay,
  open,
  onToggle,
  steps,
  traderId,
}: {
  entry: RosterEntry;
  /** 回放态：状态词换成「已产出（上一轮）」（见 `stateLabel`）。 */
  replay: boolean;
  open: boolean;
  onToggle: () => void;
  steps: readonly TeamStep[];
  /** 透传给历史详情请求（`undefined` = 不拉历史，只显示本轮）。 */
  traderId?: number;
}): React.ReactElement {
  const { role, state, latest, stepCount, lastSeenAt } = entry;
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⭐ **按钮对所有"已实现"的岗位都要有**（2026-10-17 · t111 · 用户原话）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 用户原话：「每个角色**增加一个可点击按钮，点击去以后能看他历史工作详情**」。
   *
   * 原来的判据是 `stepCount > 0` —— 只有**本轮真跑过**的岗位才有按钮。
   * 于是"这一轮没叫它"的岗位（团队是按需出勤的，这是常态）**连点都点不了**，
   * 而用户恰恰最想查的就是那些"看起来从未运行过"的岗位。
   *
   * 新判据 `role.status !== 'planned'`：
   * ```
   *   staffed  → 有按钮（历史可能有内容）
   *   by_code  → 有按钮（历史为空，但展开态会说明"由代码承担"，不是死路）
   *   planned  → 没有按钮 —— 它**根本不存在**，点开一个永远空的面板是在骗人
   * ```
   * ⚠️ `planned` 不给按钮是刻意的：给一个点了永远没内容的按钮，
   * 等于让操作员以为"再等等就有数据"。而真相是这个岗位没人实现。
   */
  const expandable = role.status !== 'planned';
  /*
   * 状态词里的"待命"对 **`by_code`** 岗位是错的措辞（它们没有模型、不会被叫），
   * 但那条分支已经在 `body` 里单独处理过（见下面的 `state === 'by_code'` 分支）。
   */
  /* "最近活跃于 X 分钟前"是相对量 —— 用渲染时刻算，不挂计时器
   *（分钟级精度不值得每秒跳；轮次刷新时自然会重算）。 */
  const now = Date.now();

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⭐ **历史工作详情**（用户要的"点开能看他历史"）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 为什么是"点开才拉"（而不是随看板一起拉）
   *
   * 编制表 21 个岗位，而这个组件**每次轮询都渲染**。随看板一次拉 21 份历史
   * 会让"看板"变成"每 15 秒 21 个请求"。用户点开一个岗位时才知道他要看谁 ——
   * 那就那时再拉。
   *
   * ## 三态必须可区分（这是本仓库反复强调的那条）
   *
   * ```
   *   undefined → 还没点开（不显示任何历史区块）
   *   null      → 点了、拉取失败（**要说"取不到"，不能说"没有历史"**）
   *   []        → 拉到了、确实一条都没有（这时才可以说"没有历史记录"）
   * ```
   * 把 `null` 与 `[]` 混成一句"暂无历史"是本仓库记过多次的那种失败：
   * **一个静默降级比一个会报错的路径危险得多**。
   */
  const [historyState, setHistoryState] = useState<
    | undefined
    | null
    | { total: number; steps: Array<{ at: string; phase: string | null; message: string }> }
  >(undefined);

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️ **历史里去掉「本轮已经有了的那一条」**（2026-10-18 用户报「UI 还是乱」）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 症状
   *
   * 展开一个岗位会看到**同一件事出现两遍**：
   * ```
   *   本轮 1 步
   *     15:14:27  D=0.855%∈[0.8,3.5]…（共 6 条判定）
   *   历史工作详情（共 19 条）
   *     15:15:59  汇总辩论并裁决
   *     15:14:27  这一轮对 6 个标的给了决策   ← 与上面那条是同一件事
   * ```
   *
   * ## 根因
   *
   * 「本轮」来自实时事件流（props 的 `steps`），「历史」来自数据库
   * （`/agent/:role/steps`，按时间倒序取最近 50 条）。
   * **本轮刚产生的步骤同时存在于两边** —— 后端当然会把刚写进去的那条也取出来。
   *
   * ## 做法
   *
   * 按**时间戳**去重：历史里凡是与本轮某一步 `at` 相同的，就不再重复显示。
   *
   * ⚠️ **只按 `at` 去重，不按正文**：实时流那条带 `level`、历史那条不带，
   * 正文比对会漏。
   */
  const currentStamps = new Set(steps.map((s) => String(s.at)));
  const historyWithoutCurrent =
    historyState === undefined || historyState === null
      ? []
      : historyState.steps.filter((s) => !currentStamps.has(String(s.at)));

  useEffect(() => {
    /*
     * 收起来就**清空** —— 否则下次点开时先闪一下旧的（可能还是别的岗位的）
     * 历史，那是假事实。
     */
    if (!open || traderId === undefined) {
      setHistoryState(undefined);
      return;
    }
    if (role.status === 'planned') return; /* 不存在的岗位不发请求 */

    let live = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await api.traderAgentSteps(traderId, role.id, 50, controller.signal);
        if (!live) return;
        setHistoryState({
          total: res.total,
          steps: res.steps.map((s) => ({ at: s.at, phase: s.phase, message: s.message })),
        });
      } catch {
        if (live) setHistoryState(null);
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [open, traderId, role.id, role.status]);

  const body = (
    /*
     * ⚠️ `items-start`（不是 `items-baseline`）：产出可能占两行，
     * baseline 对齐会让左边的岗位名沉到第二行的基线上，整行看起来是歪的。
     * 元信息一律 `shrink-0` —— 它们不该被产出挤掉（名字都没了就认不出这是谁）。
     */
    <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-2 gap-y-0.5">
      <span className="shrink-0 text-base font-medium leading-5 text-ink-hi" title={plainText(role.duty)}>
        {role.label}
      </span>
      {/*
        ⚠️ **状态用文字写出来，不能只靠圆点颜色**（`DESIGN.md` §2，也是色盲用户的前提）。
        旧版只有一个圆点，而那个圆点的颜色类名根本不存在 —— 于是它连颜色都没有。

        ⚠️ 2026-10-17：**必须走 `stateLabel(state, replay)`**，不能直接读 `STATE_LABEL[state]`
        —— 回放态下"已完成"要写成「已产出（上一轮）」（台账 UI-01）。
        直接读表的写法在回放态会说"这一轮还在干"，而那一轮可能十几分钟前就结束了。
      */}
      <span
        className={`shrink-0 text-xs font-medium leading-5 ${STATE_TEXT_CLASS[state]}`}
        title={plainText(state === 'planned' && isBatchedRole(role) ? BATCHED_STATE_HINT : STATE_HINT[state])}
      >
        {stateLabelFor(state, replay, role)}
      </span>
      <span
        className="shrink-0 text-[11px] leading-5 text-ink-faint"
        title="这个岗位的思考深度档位（越深越贵、越影响结论）"
      >
        {TIER_LABEL[role.tier]}
      </span>
      {stepCount > 1 && (
        <span className="num shrink-0 text-[11px] leading-5 text-ink-faint">{stepCount} 步</span>
      )}
      {/*
        ⚠️ **职责（`role.duty`）刻意不在这里渲染** —— 见 `body` 上方那段说明。
        它是静态说明，与"本轮产出了什么"抢同一个 `flex-1` 时会把产出挤成一条缝。
        现在它挂在 `role.label` 的 `title` 上，全文在展开态里。
      */}
      {latest !== null ? (
        <>
          {/*
            产出是本行的**主信息**：`line-clamp-2` 给它两行、`basis-[14rem]` 保证它
            被压到不能再压时换行独占一行（而不是缩成 60px 只看得见两个字）。
          */}
          <span
            className="line-clamp-2 min-w-0 flex-1 basis-[14rem] text-xs leading-5 text-ink-mid"
            title={`${plainText(latest.message)}\n\n职责：${plainText(role.duty)}`}
          >
            {latest.phase !== null && PHASE_LABEL[latest.phase] !== undefined && (
              <span className="mr-1 rounded bg-base-800 px-1 text-[11px] text-ink-lo">
                {PHASE_LABEL[latest.phase]}
              </span>
            )}
            {plainText(latest.message)}
          </span>
          <span className="num shrink-0 text-[11px] leading-5 tabular-nums text-ink-faint">{clock(latest.at)}</span>
        </>
      ) : state === 'by_code' ? (
        /*
         * ══════════════════════════════════════════════════════════════════
         *  ⚠️ **`by_code` 不进"出勤"那条分支**（2026-10-15 · SSR 测试抓到）
         * ══════════════════════════════════════════════════════════════════
         *
         * 这一行左边写着"代码在跑"，而下面这条分支原来会写"待命" ——
         * 同一行里两句互相矛盾的话：一个说"在跑"，一个说"等着被叫"。
         * 而 `by_code` 岗位**没有模型**，永远不会被"叫"，
         * "待命 / 最近活跃于 X 分钟前"是从模型出勤那套语义里来的。
         *
         * ⚠️ 这个 bug 是 `boardRender.test.ts` 的 SSR 断言抓到的 ——
         * 它**不会**让 typecheck / build / 其它单测变红（它们只看常量表），
         * 只会在屏幕上多一句假话。
         *
         * ## ⚠️ **"由哪段代码承担"必须写出来**，不能只说"已由代码承担"
         *
         * 操作员无法"打开一个模型"去核对它在不在跑，但可以去看那段代码/那个端点。
         * 写上确切的模块之后，界面说的就是**可证伪的事实**（见 `firm.ts` 的 `carriedBy`）。
         *
         * （2026-10-15 重排：它原来与产出并列渲染在 `latest` 之前，会跟产出抢宽度；
         *   移到这条分支里更贴合语义 —— `by_code` 岗位本来就没有"本轮产出"。）
         */
        role.carriedBy !== undefined && (
          <span
            className="line-clamp-2 min-w-0 flex-1 basis-[14rem] text-[11px] leading-5 text-accent"
            title={`这个职能由确定性代码承担，没有模型出勤：${plainText(role.carriedBy)}`}
          >
            由代码承担：{plainText(role.carriedBy)}
          </span>
        )
      ) : state === 'planned' && isBatchedRole(role) ? (
        /*
         * ══════════════════════════════════════════════════════════════════
         *  **「随批运行」** —— planned 里有一类其实在跑（2026-10-17 · t112）
         * ══════════════════════════════════════════════════════════════════
         *
         * 用户原话：
         * > 「我观察到**很多岗位，似乎从未真正运行过**，页面上也没有显示他们**最新运行时间**」
         *
         * `community_monitor` / `onchain_analyst` 在 `firm.ts` 里是 `planned`，
         * 但它们的职责**真的由调研猎手在跑**（`community_hunter` / `flow_hunter`）。
         * 原来这一行走通用分支 → 状态「规划中（还没实现）」+ 没有承担说明，
         * 操作员于是以为**根本没人干这件事** —— 那是界面在低估自己。
         *
         * ⚠️ **状态字段没改**（仍是 `planned`，在岗数统计不变，`FIRM_ROLES` 不变），
         * 这里只是**显示层**把这一类分出来。判据与理由见 `roster.ts` 的 `isBatchedRole`。
         *
         * ⚠️ 承担说明**必须写出来**（与 `by_code` 那条分支同一个道理）：
         * "随批运行"这句话本身**无法被核对**，写上猎手名之后操作员可以自己去查。
         */
        role.carriedBy !== undefined && (
          <span
            className="line-clamp-2 min-w-0 flex-1 basis-[14rem] text-[11px] leading-5 text-accent"
            title={`这个岗位的职责由调研猎手随批次承担（不在轮次里）：${plainText(role.carriedBy)}`}
          >
            由猎手承担：{plainText(role.carriedBy)}
          </span>
        )
      ) : (
        /*
         * ══════════════════════════════════════════════════════════════════
         *  ⚠️ **三态，不是一句话**（2026-10-14 · 去轮次化阶段 3）
         * ══════════════════════════════════════════════════════════════════
         *
         * 旧版一律写"本轮未参与" —— 用户抓到了它的问题：
         * > 「团队模式不应该是完全抛弃了轮次这个概念吗？
         * >  而是 7X24 不间断按需工作」
         *
         * 团队是**按需出勤**的：侦查员上一轮跑了、这轮休息是常态。
         * 所以"没跑"要分三种：
         * ```
         *   最近活跃 X 分钟前   ← 有人、最近干过活（最常见 —— 显示它）
         *   待命                ← 有人、但从没见它跑过（如风控官，全 skip 时它休息）
         *   （planned / by_code 岗位走它们自己的分支，不进这里）
         * ```
         * ⚠️ 判据是 `lastSeenAt`（历史轮里出现过）—— `idle` 只是"这轮没叫"。
         */
        (() => {
          const seenLabel = lastSeenLabel(lastSeenAt, now);
          return seenLabel !== null ? (
            <span
              className="num shrink-0 text-[11px] tabular-nums text-ink-faint"
              title={`这个岗位按需出勤 —— 最近一次干活是 ${new Date(lastSeenAt!).toLocaleString()}`}
            >
              {seenLabel}
            </span>
          ) : (
            <span
              className="shrink-0 text-xs text-ink-faint"
              title="在岗但还没被叫到过 —— 团队按需出勤，这不是异常"
            >
              待命
            </span>
          );
        })()
      )}
    </div>
  );

  return (
    <>
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
        {/*
          展开箭头：**对每个"已实现"的岗位都在**（判据见 `expandable` 上方那段）。
          `planned` 仍不给按钮 —— 点开一个永远空的详情是在骗人。
        */}
        {expandable ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            title={
              open
                ? '收起这个岗位的工作详情'
                : stepCount > 0
                  ? '展开：本轮的每一步 + 历史工作详情'
                  : '展开：看他历史上的工作详情（本轮没参与）'
            }
            /*
             * ⚠️ **`w-4` + 居中**，与下面那个"没有箭头"的空位**同宽** ——
             * 否则有箭头与没箭头的两行会错开，整张表看起来是歪的
             * （本项目对这类问题的规矩是"量，不要看"，见 `AGENTS.md`）。
             */
            className="flex w-4 shrink-0 items-center justify-center rounded py-0.5 text-ink-faint transition hover:bg-base-800 hover:text-ink-hi"
          >
            {open ? (
              <ChevronDown aria-hidden className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight aria-hidden className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          /*
           * 没有步骤可展开的岗位：占一个**与箭头等宽**的空位，让状态点与文字
           * 在整张表里对齐。
           *
           * ⚠️ **不能用 `w-4`** —— Tailwind 的间距标尺里**没有 4.5 这一档**
           * （只有 `w-4` / `w-5`），而它对不存在的类不报错、只是不生成样式。
           * 实测（对构建产物逐类核对）那个类根本不存在，于是"占位"的宽度是 0，
           * 整列会错开半个箭头。用 `w-4` 并且**把箭头本身也收进同一个宽度**。
           */
          <span aria-hidden className="w-4 shrink-0" />
        )}

        <span
          aria-hidden
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full self-start ${DOT_CLASS[state]}`}
        />
        {body}
      </div>

      {open && expandable && (
        <div className="border-t border-base-750 bg-base-850/40 px-2.5 py-2 pl-8">
          {/*
            职责在这里补全 —— 折叠时它让位给"本轮产出"（理由见 `AgentRow` 的说明：
            产出是每轮都在变的主信息，职责是看一次就够的静态说明）。
            用户点开这一行，就说明他要细看这个岗位，这时"它是干什么的"才有用。
          */}
          <p className="mb-1.5 text-xs leading-5 text-ink-lo">
            <span className="text-ink-faint">职责：</span>
            {plainText(role.duty)}
          </p>

          {/* ── ① 本轮（有才显示）────────────────────────────────────────── */}
          {steps.length > 0 && (
            <>
              <p className="mb-1 text-[11px] font-medium text-ink-lo">本轮 {steps.length} 步</p>
              <ol className="space-y-2" data-role-steps="current">
                {steps.map((s, index) => (
                  <li key={`${s.at}-${index}`} className="flex min-w-0 items-start gap-2 text-xs">
                    <span className="num shrink-0 tabular-nums text-ink-faint">{clock(s.at)}</span>
                    {/*
                      ⚠️ **必须走 `HumanMessage`**（2026-10-17 · 用户实测）。
                      这里原来是 `{s.message}` —— **连 `plainText()` 都没过**，
                      于是 markdown 星号与 JSON 都原样画在屏幕上。
                      现在由共用渲染层统一处理（JSON → 结构化 / 长文 → 折叠 / 强调符 → 剥掉），
                      并且**颜色只上左侧竖条、正文保持中性**（用户要求"正文不要整段染色"）。
                    */}
                    <HumanMessage text={s.message} level={s.level} />
                  </li>
                ))}
              </ol>
            </>
          )}

          {/*
            ── ② 历史（用户要的"点开能看他历史工作详情"）────────────────────
            三态必须分开说（见 `historyState` 上方的说明）：
            `undefined` 还没拉 / `null` 拉取失败 / `[]` 确实没有。
          */}
          {steps.length > 0 && <div className="my-2 border-t border-base-800" />}
          <p className="mb-1 text-[11px] font-medium text-ink-lo">
            历史工作详情
            {historyState !== undefined && historyState !== null && (
              <>
                {/* `total > steps.length` 时**如实说还有更多** —— 不把截断当全部。 */}
                <span className="ml-1 font-normal text-ink-faint">
                  （共 {historyState.total} 条
                  {historyState.total > historyState.steps.length
                    ? `，显示最近 ${historyState.steps.length} 条`
                    : ''}
                  ）
                </span>
              </>
            )}
          </p>

          {historyState === undefined && (
            <p className="text-xs text-ink-faint">
              {traderId === undefined ? '（拿不到机器人编号，无法读取历史）' : '正在读取历史…'}
            </p>
          )}

          {historyState === null && (
            /*
             * ⚠️ **拉取失败不能说成"没有历史"**。两者对操作员的意义完全相反：
             * 前者说明"服务或网络有问题"（该去查），后者说明"这个岗位确实没干过活"。
             * 这正是本仓库反复记的那类失败：静默降级比报错危险。
             */
            <p className="text-xs text-warn">历史读取失败 —— 这不代表它没有历史（可能是服务或网络问题）。</p>
          )}

          {historyState !== undefined && historyState !== null && historyWithoutCurrent.length === 0 && (
            <p className="text-xs text-ink-faint">
              {role.status === 'by_code'
                ? `这一职能由确定性代码承担，没有模型出勤记录。承担物：${plainText(role.carriedBy ?? '见职责说明')}`
                : role.status === 'planned'
                  ? /*
                     * ⚠️ **"规划中"不能说成"一次都没被叫到过"**（2026-10-18）。
                     *
                     * 两者对操作员是两件事：前者是"这个岗位还没实现"（预期如此，不用查），
                     * 后者是"实现了却从没跑起来"（那是缺陷，该去查）。
                     * `firm.ts` 里 `red_team` / `portfolio_manager` / `clerk` 的注释写得明白：
                     * 「那三个确实没有任何东西在替它们跑」—— 它们是设计上的规划项。
                     */
                    '这个岗位还在规划中，尚未接线 —— 没有记录是预期的，不是故障。'
                  : '还没有历史工作记录。'}
            </p>
          )}

          {historyState !== undefined && historyState !== null && historyWithoutCurrent.length > 0 && (
            /*
             * ══════════════════════════════════════════════════════════════════
             *  历史记录的排版（2026-10-18 重做 · 用户：「这东倒西歪，到处错位，
             *  大片空白的，是给人看的吗？」）
             * ══════════════════════════════════════════════════════════════════
             *
             * ## 原来为什么错位
             *
             * ```tsx
             *   <li className="flex min-w-0 items-start gap-2 text-xs">
             *     <span className="num shrink-0">{clock(...)}</span>   ← 固定宽
             *     <span className="shrink-0">{阶段标签}</span>          ← 有的条目有、有的没有
             *     <HumanMessage text={...} />                          ← ★ 没有 flex-1 / min-w-0
             *   </li>
             * ```
             *
             * 三个问题：
             * 1. **阶段标签时有时无** ⇒ 正文的左边缘逐条跳动（就是截图里"东倒西歪"）。
             * 2. `HumanMessage` 没有 `flex-1` ⇒ 内容不撑满，右边留下大片空白。
             * 3. 时间戳只 `shrink-0` 没定宽 ⇒ `9:05:07` 与 `14:44:24` 宽度不同，继续抖。
             *
             * ## 现在
             *
             * **两列网格**：左列固定宽度放时间（+阶段），右列 `minmax(0,1fr)` 放正文。
             * 时间列宽度固定 ⇒ 正文左边缘对齐；正文用 `1fr` ⇒ 撑满不空；`min-w-0` ⇒
             * 长串（URL、英文整段）能换行而不是把容器撑破。
             *
             * 阶段标签**移到时间下方**，不再夹在中间 —— 这样有没有标签都不影响正文的对齐。
             */
            <ol className="space-y-2.5" data-role-steps="history">
              {historyWithoutCurrent.map((s, index) => (
                <li
                  key={`h-${s.at}-${index}`}
                  className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-start gap-x-3 text-xs"
                >
                  {/* 左列：时间在上、阶段在下。固定宽度 → 所有条目的正文左边缘一致。 */}
                  <div className="flex flex-col items-end gap-0.5 pt-px">
                    <span className="num tabular-nums leading-5 text-ink-faint">{clock(s.at)}</span>
                    {s.phase !== null && (
                      <span className="rounded bg-base-800 px-1 text-[10px] leading-4 text-ink-lo">
                        {PHASE_LABEL[s.phase] ?? s.phase}
                      </span>
                    )}
                  </div>
                  {/*
                    右列：正文。`min-w-0` 是必须的 —— 没有它，`grid` 的 `1fr` 会被
                    最长的一行（例如整段英文）撑破，横向滚动条就出来了。

                    ⚠️ 历史条目**没有 `level` 字段**（服务端只回 `at/phase/message`），
                    所以这里不传 —— `HumanMessage` 会当 `info`（不染色）。
                    不要为了"看起来一致"编一个 `level: 'info'` 出来。
                  */}
                  <div className="min-w-0">
                    <HumanMessage text={s.message} />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </>
  );
}
