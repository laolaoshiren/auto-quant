/**
 * **AI 交易公司的编制表** —— 团队模式（`ai_team`）工作流区的**单一事实来源**。
 *
 * ## 用户的要求（这是本文件存在的理由，2026-10-12）
 *
 * > 「UI 丑陋，不直观，用户无法看清楚 AI 运行状态，界面丑陋抽象，**有英文**，
 * >  还有不合理不人性化，感觉不是给人看的」
 *
 * > 「在我想象中应该是**固定展示 AI 工作流**，一部分**滚动展示最终决策**等关键信息」
 *
 * > 「应该是上面固定展示**各智能体工作状态和摘要**，用户有需要可以手动点击打开查看详情」
 *
 * ## ⚠️ 为什么这个文件是新建的，而不是改 `TeamRoster.tsx`
 *
 * `TeamRoster.tsx` / `FirmRoster.tsx` / `DebateView.tsx` 里用了一整批
 * **本项目 Tailwind 配置里根本不存在的类名** —— 实测（对构建产物 CSS 逐类核对）：
 *
 * | 用到的类 | `tailwind.config.js` 里的真相 |
 * |---|---|
 * | `border-base-700` / `divide-line` | ❌ 不存在（有 `base-700`/`750`/`800`，**没有 `line`**） |
 * | `bg-base-900` / `-2` / `-3` | ❌ 不存在（层级色叫 `base-*`） |
 * | `text-ink-soft` | ❌ 不存在（文字四级是 `ink-hi/mid/lo/faint`） |
 * | `bg-up` / `text-up` / `bg-down` / `text-down` | ❌ 不存在（语义色是 `up` / `down` / `warn`） |
 *
 * **Tailwind 对不存在的类不报错、不告警，只是不生成样式** —— 于是那三个组件
 * 渲染出来是"**一堆没有边框、没有底色、状态灯根本没有颜色**"的裸文字。
 * 这正是用户说的「界面丑陋抽象、不是给人看的」的一部分，而且它**编译全绿**。
 * 本仓库为同一类问题付过代价（`animate-pulseSoft` 那个从不闪烁的状态徽章，
 * 见 `scripts/ui-smoke.mjs` 的注释），所以这里不再"改一改"，而是**重写**。
 *
 * ## 岗位状态（用户要"看清楚 AI 运行状态"）
 *
 * 用户抱怨的核心是"看不出 AI 在不在干活"。所以每个岗位有**一个明确的状态**：
 *
 * | 状态 | 什么时候 | 界面 |
 * |---|---|---|
 * | 🟢 **进行中** | 本轮有它的步骤，最后一步还没出结果 | 呼吸圆点 |
 * | ✅ **已完成** | 本轮有它的步骤，且看到了完成类的措辞 | 实心绿点 |
 * | ⚠ **失败** | 本轮它的步骤里有 error / 失败措辞 | 红点 + 原因 |
 * | ⚪ **在岗（本轮未参与）** | 已实现，但这一轮没叫它 | 空心点 |
 * | 🔵 **代码在跑** | 职责由**确定性代码**承担（`firm.ts` 的 `status: 'by_code'`） | 空心青点 |
 * | ⬜ **规划中** | **还没实现** | 灰点 + 明确标注 |
 *
 * 最后**三**态**必须区分**：把它们合成"未参与"会让操作员以为"社区监控有人在看，
 * 只是这轮没轮到" —— 而实际上**根本没有人在看**；而把"代码在跑"叫成"规划中"
 * 又会让他以为"这个职能还没做"。那是三种完全不同的结论。
 *
 * ⚠️ **`by_code` 与 `idle` 的区别是"有没有 LLM 出勤"**：
 * `idle` 说"有个模型岗位在，这轮没叫它"（"最近活跃于 X 分钟前"那种措辞），
 * 而 `by_code` 的岗位**压根没有模型** —— 说成"待命"会让操作员去等一个永远不会来的出勤。
 */

import type { FirmRole } from '@aq/shared';

/*
 * 角色 id → 中文名。**不能从 `TeamDecisionRow` import** ——
 * 那个文件已经 import 了本文件（要 `INK` / `SURFACE`），反着来就是循环依赖。
 * 名表因此单独放在 `./roleLabels.ts`（零依赖），两边都从那里拿。
 */
import { roleLabel } from './roleLabels';

/* -------------------------------------------------------------------------- */
/*  展示用的设计令牌（全部来自 `tailwind.config.js`，逐条核对过）                 */
/* -------------------------------------------------------------------------- */

/**
 * 文字层级。
 *
 * ⚠️ **不要写 `text-ink-soft`** —— 那个类不存在（见文件头）。四级就是这四个。
 */
export const INK = {
  hi: 'text-ink-hi',
  mid: 'text-ink-mid',
  lo: 'text-ink-lo',
  faint: 'text-ink-faint',
} as const;

/** 卡片/分隔的边框与底色（层级色 `base-*`，不是 `surface-*`）。 */
export const SURFACE = {
  /** 抬升面板：比面板底色 `base-900` 高一层，盒子才浮得出来。 */
  raised: 'bg-base-850',
  /** 凹陷（代码块、空态）。 */
  sunken: 'bg-base-950',
  border: 'border-base-700',
  borderSoft: 'border-base-750',
  divider: 'border-base-800',
} as const;

/**
 * 状态色。
 *
 * ⚠️ 语义色只有 `up` / `down` / `warn` / `accent` 四个 —— **没有 `ok` / `danger`**。
 * 写成 `bg-up` 会得到一个没有背景色的 span（那个"状态灯"于是从来不存在）。
 */
export const TONE = {
  active: 'bg-accent',
  done: 'bg-up',
  failed: 'bg-down',
  idle: 'border border-ink-faint',
  planned: 'bg-ink-faint/40',
  activeText: 'text-accent',
  doneText: 'text-up',
  failedText: 'text-down',
} as const;

/* -------------------------------------------------------------------------- */
/*  状态                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 一个岗位在当前这一轮的状态。
 *
 * `active` / `done` / `failed` 三态互斥，优先级 `failed > done > active`：
 * 一个角色**失败过**就绝不能再显示成"已完成"（那会让操作员以为它给了结论）。
 *
 * `by_code` 是**岗位层**的事实（职责由确定性代码承担，没有模型），
 * 不是"这一轮"的运行态 —— 它与 `idle` 的区别见 `ROLE_STATE_BY_STATUS`。
 */
export type RosterState = 'active' | 'done' | 'failed' | 'idle' | 'by_code' | 'planned';

/**
 * 岗位的**实现状态** → 它没参与本轮时该显示什么。
 *
 * ## 为什么写成映射表，而不是 `role.status === 'planned' ? 'planned' : 'idle'`
 *
 * 原来那个三元是**双分支**的：`firm.ts` 新增第三种状态（`by_code`，2026-10-15）时，
 * 新状态会**静默落进 `idle`** —— 于是"代码看门狗"会被渲染成"在岗/待命/
 * 最近活跃于 X 分钟前"，全部是模型出勤的措辞，而它**没有模型**。
 * 那是本仓库最怕的那种失败：typecheck 全绿、测试全绿、屏幕上只是少了一句真话。
 *
 * 写成 `Record<FirmRole['status'], RosterState>` 之后，**漏一个取值就编译不过**
 * （`tsc` 会指出这个对象缺少某个属性），把"静默降级"变成"编译期就红"。
 *
 * ⚠️ `staffed` → `idle` 是**必须的**：已实现但本轮没参与，正是"在岗未参与"。
 */
const ROLE_STATE_BY_STATUS: Record<FirmRole['status'], RosterState> = {
  staffed: 'idle',
  by_code: 'by_code',
  planned: 'planned',
};

/** 一个岗位的完整呈现数据。 */
export interface RosterEntry {
  role: FirmRole;
  state: RosterState;
  /** 最近一条动作（`null` = 本轮没参与）。 */
  latest: { at: string; message: string; level: string; phase: string | null } | null;
  /** 本轮它跑过的步数。 */
  stepCount: number;
  /** 最近一步是否在"进行中"（用于决定圆点闪不闪）。 */
  inFlight: boolean;
  /**
   * **它在历史轮里最后一次出现的时刻**（`null` = 从未跑过）。
   *
   * ## 为什么需要它（2026-10-14 · 去轮次化阶段 3）
   *
   * `latest === null` 只说明"这一轮没跑"，而团队是**按需出勤**的：
   * 侦查员上一轮跑了、这轮休息是完全正常的。
   * 旧 UI 把这种情况写成"本轮未参与" —— 用户抓到了问题：
   * > 「团队模式不应该是完全抛弃了轮次这个概念吗？而是 7X24 不间断按需工作」
   *
   * 有了 `lastSeenAt`，同一行可以如实显示"最近活跃于 12 分钟前"。
   */
  lastSeenAt: string | null;
}

/**
 * 一步实时事件（`cycle_step` 的界面侧形状）。
 *
 * `role` / `phase` 在**声明类型**上是可选的 —— `store.ts` 的 `LiveCycle.steps`
 * 只声明了 `{ at, level, message }`，团队模式才多推这两个字段。
 * 这里显式声明成可选，调用方传入时就不需要 `as` 断言。
 */
export interface TeamStep {
  at: string;
  level: string;
  message: string;
  role?: string | null;
  phase?: string | null;
}

/**
 * 判定一个角色的状态。
 *
 * ## 为什么用措辞而不是"有没有下一条"
 *
 * 服务端只推两样东西：**步骤开始/发生的通知**（`onStep`）与**日志级别**。
 * 它**没有**推"这一步成没成"这个布尔值 —— 见 `tradingDesk.ts` 的 `note()`。
 * 所以这里只能：
 *
 *   · `level === 'error'` 或消息里出现失败措辞 → **失败**（唯一的硬信号）；
 *   · 消息里出现完成措辞（`完成` / `已裁决` / `已出`）→ **已完成**；
 *   · 否则 → **进行中**。
 *
 * ⚠️ **不要把"没有后续步骤"当成"已完成"**：那会把一个**卡住的**角色
 * 显示成"做完了"，而卡住正是最需要被看见的情况。
 *
 * ## ⚠️⚠️ 2026-10-17：`replay` = "这不是实时流，而是最近一轮的历史回放"（台账 UI-01）
 *
 * 上面那条纪律成立的前提是**步骤是实时的**。而没有在途轮次时，看板渲染的是
 * `DecisionFeed` 从**已落库的 `<team>` 块**重建出来的步骤（`latestTeamSteps`）——
 * 那里的 `message` 是"这一轮它产出了什么"的摘要，几乎不会含"完成"字样，
 * `phase` 也是 `null`。于是实测（t3 · 真实浏览器）：
 * ```
 *   4 个岗位显示「进行中」+ 呼吸动画、1 个「失败」，头部写着「本轮在干 4 失败 1」
 *   而那一轮 42 分钟前就结束了、机器人状态是 stopped
 * ```
 * 判据没错，错在**把回放当成实时**。所以回放态下"有产出"就是"已产出"，
 * 不再返回 `active`（呼吸动画正是"正在动"的语义）。
 */
export function stateOfLastStep(
  steps: readonly TeamStep[],
  replay = false,
): 'active' | 'done' | 'failed' {
  let failed = false;
  let done = false;
  for (const s of steps) {
    if (s.level === 'error' || /失败|抛错|不可用|超时/.test(s.message)) failed = true;
    if (/完成|已裁决|已出|已完成/.test(s.message)) done = true;
  }
  if (failed) return 'failed';
  if (done) return 'done';
  return replay ? 'done' : 'active';
}

/**
 * 把 `cycle_step` 流**按岗位归并**，并按**编制表顺序**输出。
 *
 * ## 为什么不按时间顺序显示
 *
 * 团队是**并行**的：4 个分析师的步骤会交错出现
 *（实测日志形状：`technical 完成` → `sentiment 完成` → `newscaster 完成` → …）。
 * 按时间排会把每个角色的过程切碎，看不出"这个角色在干什么"。
 *
 * ## 为什么顺序必须固定
 *
 * 编制表顺序取自 `FIRM_ROLES`（与服务端路由表**同一份定义**，漂移由
 * `routedModel.test.ts` 挡住）。固定顺序意味着**某一轮少派了谁，其他人的
 * 位置也不跳** —— 否则操作员每轮都要重新找"技术面在哪一行"。
 *
 * @param steps 实时步骤流
 * @param activeRoles 编制表（默认取 `FIRM_ROLES`，注入是为了可测）
 */
/**
 * **从历史决策记录里提取"各角色最后一次出现的时刻"**（2026-10-14 · 阶段 3）。
 *
 * ## 为什么从 `cotTrace` 提取（而不是新开接口）
 *
 * 历史轮的 `cot_trace` 里各角色产出带的标记（线上实测格式）：
 * ```
 *   - technical（group/team-grunt）：…
 *   - judge（group/auto-…）：…
 * ```
 * 正则 `- <role>（…）：` 命中即说明该角色在那轮出过勤。
 * 加新接口要动 API 层与 store —— 而这里只需要"哪个角色、哪一轮"两个事实。
 *
 * ## ⚠️ 为什么只看【最近 N 条】而不是全部
 *
 * cotTrace 一条就 4–5k 字符，扫全部历史是 O(轮数 × 5k)。
 * 取最近 12 条（约 3 小时 @15 分钟周期）已覆盖"最近活跃于"的语义 ——
 * 更早的活跃对操作员没有操作意义。
 *
 * ## ⚠️⚠️ **2026-10-17（t111）：这个数据源是【不完整】的，必须叠加服务端日志**
 *
 * 用户实测报的是「**很多岗位似乎从未真正运行过**，页面上也没有显示他们最新运行时间」，
 * 而实测那三个角色**跑得很频繁**：
 * ```
 *   supervisor     线上 team 域 31 次（全系统最多）  ← 界面写"待命"
 *   risk_officer   12 次                            ← 界面写"待命"
 *   reporter       14 次                            ← 界面写"待命"
 * ```
 *
 * 根因：`cot_trace` 里**只有进了 `<team>` 块的角色**才有 `- <role>（…）：` 行，
 * 而 `deskOutput.ts` 只给分析师 / `bull` / `bear` / `judge` 写了这种行。
 * 上面那三个角色的出勤记在 `runtime_logs`（`scope='team'`，格式 `[phase] role：note`）
 * —— **那是另一个数据源，本函数原来完全没看它**。
 *
 * 所以现在接受第二份输入 `fromServer`（服务端 `/agent/last-seen` 的产物），
 * 与 `cotTrace` 的结果**合并取较晚者**。`fromServer` 缺省时行为与旧版逐字一致
 * （SSR 测试、回放态都不受影响）。
 *
 * @param history     历史决策记录（只需 `cotTrace` 与 `timestamp`）
 * @param fromServer  服务端日志给出的"角色 → 最后露面时刻"（可选；缺省 = 只用 cotTrace）
 */
export function lastSeenOf(
  history: ReadonlyArray<{ cotTrace: string | null | undefined; timestamp: string }>,
  fromServer: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const seen = new Map<string, string>();
  /* 从旧到新扫 —— 后面的覆盖前面的，留下的就是"最近一次"。 */
  for (const r of history.slice(0, 12).reverse()) {
    const trace = r.cotTrace;
    if (trace === null || trace === undefined || trace.length === 0) continue;
    for (const m of trace.matchAll(/- ([a-z_]+)（[^）]*）：/g)) {
      seen.set(m[1]!, r.timestamp);
    }
  }
  /*
   * 合并服务端日志：**取较晚者**，不做"无条件覆盖"。
   *
   * ⚠️ 顺序不能反：`history` 覆盖最近 12 轮，而服务端日志表有 500 行上限、
   * 里面可能混着更旧的行 —— 无条件覆盖会把"刚刚活跃"改写成"3 天前"，
   * 那正是这次要修的那类"界面说谎"。
   */
  for (const [role, at] of fromServer) {
    const prev = seen.get(role);
    if (prev === undefined || at > prev) seen.set(role, at);
  }
  return seen;
}

/**
 * 把服务端 `/agent/last-seen` 的响应形状转成 `lastSeenOf` 要的 Map。
 *
 * 单独一个函数是为了**可测**：`roster.test.ts` 与 SSR 渲染都能直接构造它，
 * 不必起 HTTP。
 */
export function lastSeenFromServer(
  roles: ReadonlyArray<{ role: string; at: string }> | undefined | null,
): Map<string, string> {
  const map = new Map<string, string>();
  if (roles === undefined || roles === null) return map;
  for (const row of roles) {
    if (typeof row?.role !== 'string' || row.role.length === 0) continue;
    if (typeof row.at !== 'string' || row.at.length === 0) continue;
    const prev = map.get(row.role);
    if (prev === undefined || row.at > prev) map.set(row.role, row.at);
  }
  return map;
}

export function rosterEntries(
  steps: readonly TeamStep[],
  roster: readonly FirmRole[],
  seen: ReadonlyMap<string, string> = new Map(),
  replay = false,
): RosterEntry[] {
  /** role → 它这一轮的所有步骤 */
  const byRole = new Map<string, TeamStep[]>();
  for (const s of steps) {
    const role = s.role;
    if (role === null || role === undefined || role.length === 0) continue; /* 无角色的步骤不进编制表 */
    const bucket = byRole.get(role);
    if (bucket) bucket.push(s);
    else byRole.set(role, [s]);
  }

  const entries: RosterEntry[] = roster.map((role) => {
    const own = byRole.get(role.id);
    if (!own || own.length === 0) {
      /*
       * 「没参与」还要分三种，而**这个区分是本文件最重要的判断**：
       * `planned` 是"这个岗位根本没人"（还没有实现），
       * `by_code` 是"职责在跑、但没有模型"（确定性代码承担），
       * `idle`    是"有人在，这轮没叫他"。
       * 合并其中任意两个都等于在骗操作员：把 `planned` 说成 `idle` =
       * "社区监控有人在盯着，只是这轮没轮到"；把 `by_code` 说成 `planned` =
       * "这个职能还没做"（而它一直在跑）。
       */
      return {
        role,
        state: ROLE_STATE_BY_STATUS[role.status],
        latest: null,
        stepCount: 0,
        inFlight: false,
        lastSeenAt: seen.get(role.id) ?? null,
      };
    }
    const last = own[own.length - 1]!;
    return {
      role,
      state: stateOfLastStep(own, replay),
      latest: {
        at: last.at,
        message: last.message,
        level: last.level,
        phase: last.phase ?? null,
      },
      stepCount: own.length,
      /* 回放态不是"在途" —— 呼吸动画只在真有在途步骤时挂。 */
      inFlight: !replay,
      lastSeenAt: seen.get(role.id) ?? null,
    };
  });

  /*
   * 编制表之外的角色（后端加了新岗位）**追加在后面**。
   * 丢掉它们会让"某个角色在干活但界面看不到" —— 比显示成"未登记"糟得多。
   *
   * ⚠️ **这里必须优先用中文名表**（2026-10-17 · t108 用户实测）。
   *
   * 原来这里写死 `label: roleId` —— 于是**任何不在 `FIRM_ROLES` 里的角色**
   * 都以**英文 id** 当标题。用户截图里那两个岗位就是：
   * ```
   *   ▼ strategist  进行中  分析  6 步
   *   ▼ reviewer    进行中  分析  工具…
   * ```
   * 而它们其实是「策略师」「复核员」—— agent 层的角色
   *（`server/agent/roles.ts` 的 `AgentRole`），**不在编制表里**，但**真的在干活**。
   *
   * 用户的原话：「**英文、占位符**，而不是正确的显示中文名称」。
   * 现在先查 `roleLabel()`（`./roleLabels.ts`），查不到才回落到 id ——
   * 回落仍然保留：**不知道名字也不能让它消失**。
   */
  const known = new Set(roster.map((r) => r.id));
  for (const [roleId, own] of byRole) {
    if (known.has(roleId)) continue;
    const last = own[own.length - 1]!;
    entries.push({
      /*
       * 未登记的岗位：**不能编造分工**，但也不该把内部缺口说给操作员听。
       *
       * 原文案是「界面还没登记这个岗位的分工 —— 但它在工作」——
       * 它把"我们的界面没跟上"这件事**推到了用户面前**，而用户关心的只有两件：
       * "它是谁"（现在尽力翻译）和"它到底在不在干活"（在）。
       * 所以改成中性表述，**保留"它在工作"这个事实**，并指路去看它的最近动作。
       */
      role: {
        id: roleId,
        label: roleLabel(roleId) ?? roleId,
        duty: '这个岗位不在编制表里，但正在工作（见右侧最近动作）。',
        department: '技术',
        tier: 'T2_mid',
        status: 'staffed',
      },
      state: stateOfLastStep(own, replay),
      latest: { at: last.at, message: last.message, level: last.level, phase: last.phase ?? null },
      stepCount: own.length,
      inFlight: !replay,
      /* 它有实时步骤在跑 —— "最近活跃"就是现在。 */
      lastSeenAt: last.at,
    });
  }

  return entries;
}

/* -------------------------------------------------------------------------- */
/*  给人看的标签                                                               */
/* -------------------------------------------------------------------------- */

/** 编排阶段的中文名（对应服务端 `phase` 字段）。 */
export const PHASE_LABEL: Record<string, string> = {
  dispatch: '派发',
  analysis: '并行分析',
  debate: '多空辩论',
  verdict: '裁决',
  risk: '风控把关',
  execute: '执行',
};

/**
 * 档位 → "这活有多难"。
 *
 * 用户是交易员，不是 ML 工程师：`T3_deep` 对他没有意义，
 * 「深度思考」才说明"这一步最贵、最影响盈亏"。
 */
export const TIER_LABEL: Record<FirmRole['tier'], string> = {
  T3_deep: '深度思考',
  T2_mid: '分析',
  T1_fast: '快速',
  T0_code: '纯代码',
};

/**
 * 状态的**文字**（不能只靠颜色 —— `DESIGN.md` §2 的硬要求，也是色盲用户的前提）。
 *
 * ⚠️ `by_code` 的文案刻意**不用"出勤"类措辞**（在岗/待命/最近活跃）：它没有模型，
 * 用那些词等于让操作员等一个永远不来的出勤。它要说的是"这件事**确实在跑**"，
 * 承担者是谁写在 `FirmRole.carriedBy` 里（那一行会跟在职责后面显示）。
 */
export const STATE_LABEL: Record<RosterState, string> = {
  active: '进行中',
  done: '已完成',
  failed: '失败',
  idle: '在岗',
  by_code: '代码在跑',
  planned: '规划中',
};

/**
 * **回放态**下的状态词（台账 UI-01 验收 ②）。
 *
 * 回放说的是"最近一轮它产出了什么"，不是"它现在在不在动"：
 * ```
 *   实时态  「进行中」   → 它在干活，且还没看到完成信号
 *   回放态  「已产出（上一轮）」 → 这一轮的产出在这里，现在没有在途轮次
 * ```
 * 两句话都是真的，但**只有一句是当时的真相** —— 把回放说成"进行中"，
 * 操作员会以为团队正在干活（而它可能已经停了 40 分钟，实测就是这个形状）。
 *
 * ⚠️ `failed` 在回放态改成「失败（上一轮）」：失败是那一轮的**事实**，要保留；
 * 但必须与"现在正在失败"分开说。`idle` / `by_code` / `planned` 与轮次无关，
 * 沿用原词。
 */
export const STATE_LABEL_REPLAY: Record<RosterState, string> = {
  active: '已产出（上一轮）',
  done: '已产出（上一轮）',
  failed: '失败（上一轮）',
  idle: '在岗',
  by_code: '代码在跑',
  planned: '规划中',
};

/** 按"实时 / 回放"取状态词 —— 组件不许直接读 `STATE_LABEL`（漏判回放就会说假话）。 */
export function stateLabel(state: RosterState, replay: boolean): string {
  return replay ? STATE_LABEL_REPLAY[state] : STATE_LABEL[state];
}

/* -------------------------------------------------------------------------- */
/*  「随批运行」—— 纯显示层的一个特殊状态词（2026-10-17 · t112）                 */
/* -------------------------------------------------------------------------- */

/**
 * **`planned` 里有一类其实在跑：它的工作由批量调研猎手顺带完成。**
 *
 * ## 用户报的问题
 *
 * > 「我观察到**很多岗位，似乎从未真正运行过**，页面上也没有显示他们**最新运行时间**」
 *
 * 其中两个是**看板在低估自己**：
 * ```
 *   community_monitor（社区监控）  → community_hunter（社区猎手）真的在跑
 *   onchain_analyst（链上分析）    → flow_hunter（资金猎手）真的在跑
 * ```
 * 而它们在 `firm.ts` 里是 `status: 'planned'` ⇒ 界面写「规划中（还没实现）」，
 * 操作员于是以为**根本没人干这件事**。
 *
 * ## ⚠️ 为什么**不改 `status`、不新增枚举**（这是本轮最重要的一条判断）
 *
 * 看起来最干净的做法是给它们一个新的 `status`（例如 `'batched'`）。**但那会开一个坏口子**：
 *
 * 四个猎手是**一次批量一起跑**的，产出还**合并成一份**、统一记在 `news_hunter` 名下
 * （`manager.ts:1138` 的 `mapConcurrent(HUNTERS, …)` + `:1195-1196` 的
 * `mergeHunterReports` → `parseIntelReport(merged, …, 'news_hunter')`）。
 * 于是"猎手在跑"这个判据**同时适用于四个岗位**：
 * ```
 *   news_hunter       → newscaster（已 staffed）
 *   flow_hunter       → onchain_analyst      ← 与 community_monitor 同源
 *   community_hunter  → community_monitor
 *   macro_hunter      → （编制表里没有对应岗位）
 * ```
 * 如果把它做成 `status`，那 `onchain_analyst` **必须一起改**；再往下，
 * `red_team` / `portfolio_manager` / `clerk` 也确实没有任何东西在替它们跑 ——
 * **一旦状态机可以因为"有东西在跑"而新增取值，就没有判据能阻止下一个人顺手全改。**
 *
 * ⇒ 所以**状态字段一个字不动**（`planned` 仍是 `planned`、在岗数统计不变、
 * `FIRM_ROLES` 不变），只在**显示层**把这一类岗位的状态词换成「随批运行」。
 * 判据是 `firm.ts` 里已有的 `carriedBy`（"承担它的模块"）——
 * **它本来就是为"职责在跑但不是模型出勤"这件事准备的**。
 *
 * ## 判据：`planned` **且** 写了 `carriedBy`
 *
 * 只有两个条件同时成立才算"随批运行"：
 * ```
 *   planned + 无 carriedBy  → 真的没人干（red_team / portfolio_manager / clerk）
 *   planned + 有 carriedBy  → 有东西在替它跑（community_monitor / onchain_analyst）
 * ```
 * 这样"哪些真没跑"在数据里就是**可分辨的**，不靠代码里另写一份名单
 * （那正是本仓库反复吃亏的"两份名单迟早分叉"）。
 *
 * @param role 编制表里的一行
 * @returns 是不是"随批运行"这一类
 */
export function isBatchedRole(role: { status: string; carriedBy?: string }): boolean {
  return role.status === 'planned' && typeof role.carriedBy === 'string' && role.carriedBy.trim().length > 0;
}

/** 「随批运行」的状态词。与 `STATE_LABEL.planned`（规划中）刻意不同 —— 它们不是一回事。 */
export const BATCHED_STATE_LABEL = '随批运行';

/**
 * **带"随批运行"判据的状态词** —— 组件应当用这个，而不是裸 `stateLabel`。
 *
 * ⚠️ 回放态**不特殊化**：回放说的是"最近一轮它产出了什么"，
 * 而随批运行的岗位**从来不在轮次里**（它们在轮次之外的调研批次里）——
 * 那时说"随批运行"仍然成立，所以两个态都用同一个词。
 */
export function stateLabelFor(
  state: RosterState,
  replay: boolean,
  role: { status: string; carriedBy?: string },
): string {
  if (state === 'planned' && isBatchedRole(role)) return BATCHED_STATE_LABEL;
  return stateLabel(state, replay);
}

/** 悬停说明：为什么这个"规划中"的岗位其实在跑。 */
export const BATCHED_STATE_HINT =
  '这个岗位的职责由调研猎手随批次承担 —— 它不在轮次里，所以没有"出勤"记录，但确实在跑（见右侧承担说明）。';

/** 状态的悬停说明（把"这意味着什么"写清楚，而不是让人猜）。 */
export const STATE_HINT: Record<RosterState, string> = {
  active: '这一轮它正在工作 —— 还没有看到完成信号。',
  done: '这一轮它已经交出了产出。',
  failed: '这一轮它出错了 —— 展开右侧「本轮流程」看具体原因。',
  idle: '这个岗位已实现，但这一轮没有叫它（例如只在特定条件下才启用）。',
  by_code:
    '这个职能在跑，但承担它的是确定性代码、不是模型 —— 所以既没有"出勤"也没有"待命"，' +
    '它的产出在旁边那行写明的模块里（例如 /api/health 的 staleTraders）。',
  planned: '这个岗位还没有实现 —— 不要以为有人在干这件事。',
};

/**
 * 把 ISO 时刻显示成 `HH:MM:SS`。
 *
 * 用 24 小时制且不显示日期：工作流区回答的是"**刚刚**谁动了"，
 * 日期在这里是噪音（跨天的历史在下面的决策流水里，那里带相对时间）。
 */
export function clock(iso: string | null): string {
  if (iso === null) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
