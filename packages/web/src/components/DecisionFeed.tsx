/**
 * 最近决策 — 决策流。
 *
 * 交易页的右栏（`LAYOUT.md` §2），也是操作者一直盯着的那个面板。
 *
 * ## 形态：照抄参考产品，`DECISION-FEED.md` 是契约
 *
 * 一轮周期 = **一行纯文字元数据 + 一个带边框的盒子 + 两个纯文字按钮**：
 *
 * ```
 * 3 分钟前 │ 周期 #5404 │ in 34,411 · out 4,980      ← 一行纯文字，无边框无底色无徽章
 * ┌──────────────────────────────────────────────┐
 * │ ⬤ ZECUSDT                              观望  │   ← 币种图标 + 符号 …… 右对齐动作
 * │   置信度: 78%                                │   ← 强调色小字
 * │   📄 AI500=776 达标，价格站上 15m EMA20…     │   ← 文档图标 + 理由，允许折行
 * │                                              │
 * │ Ⓑ BRUSDT                               等待  │
 * │   置信度: 30%                                │
 * │   📄 AI500 仅 66.3 未达 75 红线…             │
 * └──────────────────────────────────────────────┘
 * ✨ 思考过程 ✓   │   🔒 提示词                        ← 两个纯文字按钮
 * ```
 *
 * ## 这一版删掉的东西，以及为什么不能再加回来
 *
 * - **每条决策外面那层带边框的卡片**：一轮本来就只该有**一个**盒子。给每条决策再套
 *   一层，屏幕上就会出现三层边框（盒子 / 决策卡 / 数字表），一屏只能看下两三条。
 * - **决策卡内的 6 格数字表**（数量 / 开仓价 / 止损 / 止盈 / 风险回报 / 杠杆）：
 *   它是三轮溢出 bug 的根源。表格格子有最小宽度，右栏只有 40% 宽，格子一挤，
 *   文字就飘到相邻列里去（见 git 历史里那张 `率.47%` 的截图）。
 *   现在这些数字变成**理由下面的一行小字**——一行文本可以折行，**不可能溢出**。
 * - **周期头左侧的 3px 结果色条、`成功` 徽章、`N 个候选`**：参考里没有。
 *   结果信息改用一行小字表达（`⚠ 2 条被风控拒绝`），见 `CycleBlock`。
 *
 * ## 每条决策都必须写出它的**执行结果**（这一版的核心修复）
 *
 * 这里原来只认两种执行状态：`rejected`（风控拒绝）与 `failed`（执行抛错），
 * 而服务端在 `autoTrader.ts` 里还会发 `skipped` —— 单日亏损熔断、安全模式、
 * 再入冷却、没有行情快照、没有可用价格、本地没有持仓可平。这些条目**一条都不会**
 * 出现在界面上。
 *
 * 后果不是"少显示一行小字"，而是**界面在说假话**：一轮里模型给出
 * `开空 POWERUSDT`，熔断把它拦了下来，操作者看到的却是一行干干净净的开空提案 ——
 * 像是在下单，而账户里既没有仓位也没有订单（`LAYOUT.md` §7：文字说的必须是事实）。
 * 操作者会一直等一个永远不会来的仓位，而"为什么什么都没发生"的答案
 * （熔断：今日已实现亏损 $0.59，占权益 6.03%）恰恰是这一刻屏幕上最该有的东西。
 *
 * 现在**结果挂在决策自己那一行上**（`DecisionOutcome`），四种状态各自可辨：
 *
 * | 状态 | 含义 | 呈现 |
 * | --- | --- | --- |
 * | `ok` | 真的执行了 | 一个安静的 `✓ 已执行` + 成交金额 |
 * | `rejected` | 被风控引擎拦下 | `⚠ 被风控拒绝` + 原因 |
 * | `failed` | 试过，但失败了 | `✕ 执行失败` + 错误 |
 * | `skipped` | 运行时**决定不动手** | `⊘ 未执行` + 原因 |
 *
 * `skipped` 与 `failed` 必须看起来不一样：前者是"我们选择不下这一单"，
 * 后者是"我们下了，它炸了"。两者混在一起，操作者就没法判断该查配置还是查网络。
 *
 * ## 顶部那一条"正在请求模型"（`LiveCycleBlock`）
 *
 * 一轮要跑 6.8–18.3 秒，而服务器在**调用模型之前**就已经推了 `cycle_start`。
 * 这段时间里原来什么都不显示，界面看起来就像卡住了。现在周期一开始就把
 * 一个**明确不是成品**的条目钉在最上面：同一套元数据行（§2）+ 虚线盒子 + 秒数。
 * 它是**加在顶部的一条**，不改下面任何一个已完成周期的结构。
 * 它什么时候消失由 `store` 负责（`cycle_end` / `decision` / 断线 / 新一轮覆盖），
 * 这里只负责不显示一个已经被成品替代的条目。
 *
 * ## 高度：填满所在的那一栏，而不是自己算一个视口高度
 *
 * 这里曾经有一个 `height` 参数，交易页传的是 `max(380px, calc(100vh - 18rem))`。
 * 那个写法在"左指标栏 + 主内容"的旧骨架里是唯一可行的做法 —— 决策流是主内容区里
 * 的**第一块**，它上面的页头有多高只有页面自己知道，于是只能靠手算一个 `18rem`
 * 去凑。骨架改成两栏之后这个数就没法对了：右栏的顶边等于内容区顶边，要减多少
 * 完全由外壳（顶栏高度 + 页面内边距）决定，页面再算一次必然算错。
 *
 * 现在分成两件事：
 *
 * - **`xl` 及以上**：`PageShell` 的右栏在 `h-full` 的高度链上拿到了"可视区 − 顶栏"
 *   这份确定高度，所以面板 `h-full`、表头 `shrink-0`、卡片区 `flex-1 min-h-0
 *   overflow-y-auto` —— 决策流自己撑满整栏，滚动条只有一条（在卡片区），
 *   「最近决策」这一行钉在顶上不跟着滚走。
 * - **`xl` 以下**：两栏塌成一列，右栏落到主内容下面，父级高度是 `auto`，
 *   `h-full` 会解析成 `auto`。这时 `max-h-[calc(100dvh-16rem)]` 兜底 ——
 *   没有它，几十个周期会把整页撑成一条长条，正是 §2 要避免的。
 *   `xl:max-h-none` 把上限交还给上面那条 flex 高度链。
 *
 *   ⚠️ **这条兜底曾经被删掉过，而注释没跟着改**（2026-10-17 实测发现）：
 *   `c750fd3` 里它确实在决策滚动框的 `className` 里，`9ad1503` 把它删了
 *   （那次提交的目标是"团队工作流区改为占满主导高度"），**这句注释却一直说它还在**。
 *   后果不只是"页面变长"：箱体不可滚 ⇒ 哨兵永远在 root 内 ⇒ **打开页面就自动翻页**
 *   （实测 `/decisions` 2 次请求，`xl` 以上对照 1 次）。已由 `t89` 补回，
 *   并在下面那个观察器上加了一条结构性保险（root 不可滚就不创建观察器）。
 *   **教训**：注释描述"代码里有什么"时，它就是一个**会被静默证伪的断言** ——
 *   改代码时删掉那句注释，比留着它安全。
 *
 * ## 一次加载多少：默认 20 条，滚到最后一条再取下一页
 *
 * 这个面板原来一次向服务端要 50 条、并把 50 条**全部**渲染出来。而每条决策记录都
 * 带着完整提示词、思维链与原始响应（单条几十 KB）：轮数一多，一次请求就是一大片
 * 数据，面板也要一次性建出上千个 DOM 节点 —— 操作者的原话是"成千上万数据一次
 * 加载出来导致系统卡死"。
 *
 * 现在第一页只有 `FEED_PAGE_SIZE`（20）条，滚到列表底部（`IntersectionObserver`
 * 观察列表末尾的哨兵）才取下一页，一直翻到服务端返回不满一页为止。
 * 观察的根是**这个面板自己的滚动容器**，不是窗口 —— 见下面"高度"那一节：
 * 滚动条在卡片区里，用窗口做 root 会在 `xl` 以下（整页很长）提前或永不触发。
 *
 * ## 分页与轮询的相互作用（这里最容易做错）
 *
 * - 轮询只负责**最新的一页**：`usePolled` 每 20 秒重拉第一页，它并进"已经拿到的那些行"。
 *   已经翻出来的更早的页**原封不动** —— 决策记录落库之后不再修改，所以旧页永远不需要
 *   重拉，新周期到达也不会把已加载的历史丢掉。
 * - 把轮询的第一页当成一个"固定窗口"（每次替换掉旧的）是**错的**：新周期一插进来，
 *   窗口最旧的那一条就被挤出去，而它恰好是和已加载历史相接的那一条 ——
 *   列表中间会静默少一轮（长度还看不出来）。所以这里只做累加，见 `loaded` 的注释。
 * - 合并按 `record.id` 去重（见 `mergeFresh`），所以同一轮既在 REST 结果里、
 *   又在 WebSocket 推送里，或者同时落在两页的边界上，都只会渲染一次。
 * - 新周期插到**顶部**会把下面的内容整体往下推。操作者正往下翻着看历史时，
 *   屏幕上的字会因此跳一下 —— 组件里那个 `useLayoutEffect` 会量出锚点被推下去的
 *   像素数并等量补偿 `scrollTop`（停在顶部时不补偿：那时新周期就该出现在眼前）。
 * - 分页状态（已加载的页、游标、滚动位置）全是**组件自己的状态 + 真实 DOM 滚动位置**，
 *   轮询返回不会重置任何一个。
 * - 游标用 `before=id` 而不是 `offset`：新周期从顶部持续插入，偏移量会把页边界推歪
 *   （第二页的第一条会重复第一页的最后一条）。理由详写在服务端
 *   `repositories.ts` 的 `decisions.list()` 上。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Coins,
  LoaderCircle,
  Lock,
  Maximize2,
  Minimize2,
  RotateCw,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  calculateTokenCost,
  fmtCompactTokens,
  fmtTokenCostUsd,
  formatCycleCostTooltip,
  type DecisionRecord,
  type Decision,
  type ExecutionLogEntry,
  type TokenPricingPerMillion,
  type TraderMode,
  type TraderTokenBillingSummary,
} from '@aq/shared';
import { api, type MarketSymbol } from '../lib/api';
import { useLiveCycle, useEvents, type LiveCycle } from '../lib/store';
import { FeedErrorBoundary } from './FeedErrorBoundary';
import { parseTeamTrace } from '../lib/teamTrace';
/**
 * **团队看板**（2026-10-12 重做）。
 *
 * ⚠️ **只在 `mode === 'ai_team'` 时渲染** —— 另两种模式的界面必须逐字节不变。
 * 新组件放在 `./TeamBoard/` 下，与旧的 `TeamRoster` / `FirmRoster` 并存：
 * 旧两个仍在团队模式下用于「组织架构」等既有内容，
 * 而 `TeamBoard` 替换的是**实时工作流区**与**决策行**这两个主视图。
 *
 * 为什么另起一套而不是继续改旧组件：旧那些用了一整批**本项目 Tailwind
 * 配置里根本不存在**的类（`border-base-700` / `bg-base-850` / `bg-up`…），
 * 实测渲染出来没有边框、没有底色、状态灯没有颜色 —— 见 `TeamBoard/roster.ts`
 * 文件头的完整对照表。那是"改不动"的，只能重写。
 */
import { TeamBoard } from './TeamBoard/TeamBoard';
import { TeamCycleBlock } from './TeamBoard/TeamCycleBlock';
import { usePolled } from '../lib/hooks';
import { Badge, Empty, ErrorNote, Panel, Spinner3, cn } from './ui';
import { ActionBadge, STATUS_LABELS, actionLabel } from './DecisionAudit';
import { CoinIcon } from './CoinIcon';
import {
  FIGURE_PILL_STYLE,
  FIGURE_TITLE,
  figureParts,
  resolveFigureContext,
  type FigureContext,
} from '../lib/decisionFigures';
import {
  ManagedStageActionBar,
  isManagedTrajectoryEntry,
  resolveManagedStageChips,
} from './PowerlineTrajectory';
import { DecisionArchiveModal } from './DecisionArchiveModal';
import { humanizeToolNames } from '../lib/toolLabels';
import { summarizeMemberOutput } from '../lib/memberSummary';
import { plainText } from '../lib/plainText';
import {
  isActiveInFlightPending,
  isPendingDecisionRecord,
  preferCompletedDecision,
} from '../lib/decisionPending';
import { fmtInt, fmtLatency, fmtUsd, timeAgo } from '../lib/format';

export { figureParts };

/**
 * 一页多少轮。
 *
 * 这个面板原来一次要 50 条、并且把 50 条全渲染出来。每条记录都带着**完整提示词与
 * 思维链**（单条几十 KB），轮数一多，一次请求就是一大片数据、面板也要一次性建出
 * 上千个 DOM 节点 —— 操作者的原话是"成千上万数据一次加载出来导致系统卡死"。
 *
 * 现在默认只加载 20 条，滚到列表底部再取下一页（见组件顶部"一次加载多少"那一节）。
 * 20 这个数是"一屏多一点"：比一屏多，所以第一眼就能看出下面还有东西；又足够小，
 * 以至于一次请求和一次渲染都不可能有感知。
 */
const FEED_PAGE_SIZE = 20;

/**
 * 每页向服务端**多要一条**，只用来判断"还有没有更早的"。
 *
 * 响应体是 `DecisionRecord[]`（形状没变：老客户端、`docs/API.md`、"全部记录"页都照旧），
 * 数组里没有"还有下一页吗"这个字段，所以多要一条是最便宜的探针：
 * 拿到 21 条 = 还有更早的；拿到 ≤20 条 = 已经到最早一轮了。
 * 不这么做就只能靠"再请求一次、拿到空数组"来判断终点 —— 那时"加载中"会先多闪一下，
 * 而终点提示也总是迟一步。
 */
const FEED_PAGE_LIMIT = FEED_PAGE_SIZE + 1;

/**
 * 把一批新行并进"已经拿到"的那一份，**按 id 去重**。
 *
 * 没有新行时返回**原数组**（而不是一个新数组）：`useState` 的 setter 拿到同一个引用会
 * 直接跳过这次重渲染，而轮询每 20 秒都会调一次这里 —— 绝大多数时候一条新的都没有。
 *
 * 去重不是可选的：轮询的第一页与翻出来的页在边界上必然重叠一行（探针行那一行
 * 会作为下一页的第一条被取回来），WebSocket 推送又可能同一轮再来一份。
 */
function mergeFresh(prev: DecisionRecord[], rows: DecisionRecord[]): DecisionRecord[] {
  const indexById = new Map<number, number>();
  prev.forEach((record, idx) => indexById.set(record.id, idx));

  let next: DecisionRecord[] | null = null;
  for (const row of rows) {
    const existingIdx = indexById.get(row.id);
    if (existingIdx === undefined) {
      if (next === null) next = [...prev];
      indexById.set(row.id, next.length);
      next.push(row);
      continue;
    }
    // 服务端 begin() 先插 pending 占位行，finish() 用同一 id 原地补完终态：
    // 若旧缓存里存的是 pending 而新拉回的是终态，必须原地升级，不能永久停留在空白占位行。
    const current = (next ?? prev)[existingIdx]!;
    if (isPendingDecisionRecord(current) && !isPendingDecisionRecord(row)) {
      if (next === null) next = [...prev];
      next[existingIdx] = row;
    }
  }
  return next ?? prev;
}

/**
 * 超过多少秒才提示"慢是正常的"。
 *
 * 实测一轮 6.8–18.3 秒，所以 20 秒是**略高于日常观测上限**的一条线：在这个点之前
 * 提"可能会慢"只会制造焦虑，过了这个点操作者确实在问"是不是卡住了"。
 * `LAYOUT.md` §5 的教训用在这里：正常运行时永远成立的话不要常驻，
 * 只在越界时出现。
 */
const SLOW_CYCLE_SECONDS = 20;

/**
 * 已等待时长。`8 秒` / `1 分 12 秒`。
 *
 * 不用 `fmtDuration`（那个入参是**分钟**）：这里最短只等几秒，用分钟为单位会把 8 秒
 * 显示成 `0.1 分钟`，正好丢掉这个读数唯一的价值 —— 秒级的变化。
 */
function elapsedLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/**
 * 一轮"正在请求模型"的占位条。
 *
 * ## 它解决的问题
 *
 * 服务器在真正调用模型**之前**就推了 `cycle_start`，而一轮要跑 6.8–18.3 秒。
 * 这段时间里决策流原来什么都不显示，看起来就像界面卡住了 ——
 * 操作者的原话是："如果系统开始向 AI 模型请求了，应该直接体现到页面上
 * （而不是等结果完全出来了才显示）"。
 *
 * ## 形态上守的两条契约
 *
 * - **元数据行照 `DECISION-FEED.md` §2**：一行纯文字、`│` 分隔、无边框、无底色、
 *   无徽章。第三格换成 `正在请求模型…`（成品那一格是 `in N · out N`），
 *   相对时间那一格换成一个呼吸的圆点 —— "刚刚"在这个条目上永远成立，
 *   不如用圆点表达"进行中"。
 * - **盒子明确不是成品**：虚线边框 + 更弱的底色（**不是**成品的 `bg-base-850`）+
 *   整体降透明度 + 一个转圈。不能让它看起来像一轮已经出结果的决策。
 *
 * ## 为什么秒数在这里、而不在别处
 *
 * 它回答的是"卡住了还是只是慢"这个问题，只有在这个条目内部才读得通
 * （`LAYOUT.md` §5 禁止把诊断值放进状态区）。
 */
/**
 * 这一轮的**步骤流水** —— 默认折叠，点开看每一步。
 *
 * ## 用户的原话（2026-10-10）
 *
 * > 「智能模式下，每一期最近决策里面能展开（就像你 DSH 一样），能折叠实时显示当前步骤
 * >  （默认是缩起来的，用户可以手动展开），这样用户可以手动展开看系统到底在做什么，
 * >  也可以判断系统到底是否正常工作」
 * > 「如果不展开，就默认显示一条:关键的摘要，能大概看到在做什么，是否在做事，
 * >  如果想看详情，再手动展开查看，里面就完全展示这一轮具体再做什么」
 *
 * ## 两条形态约束
 *
 * · **折叠态只有一行**：`步数 │ 最新那一步 │ 已用时`。它要回答的就是
 *   "在做事吗、卡在哪一步"，所以取的必须是**最新一条**，不是第一条。
 * · **展开态是完整流水**（带每步的时刻），后端只给最近 60 条。
 *
 * 用 `<button>` + 条件渲染而不是 `<details>`：`<details>` 的展开态不进 React 状态，
 * 而这里要跟着 `steps` 增长自动滚到最新（列表本身在增长，不能用一次性快照）。
 */
function CycleSteps({ steps, elapsedSec }: { steps: LiveCycle['steps']; elapsedSec: number }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const last = steps[steps.length - 1]!;
  /*
   * ⚠️ **两个数必须是同一口径，否则屏幕上会出现两个对不上的时间（用户 2026-10-10 实测）。**
   *
   * 上一版这里算的是"首步→末步的跨度"，而下面那个盒子写的是"从开始等到现在" ——
   * 于是同一屏出现 `93s` 与 `已等待 2 分 39 秒`。用户的原话是「你自己看看你做的这个
   * 合理吗？……用了多少时间？」。
   *
   * 现在：`elapsedSec` 由父组件给（与盒子同一个来源），
   * `currentSec` 是**当前这一步**已经走了多久 —— 它们相减没有意义，因为回答的是两个问题。
   */
  const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return (
    <div className="mb-1.5 min-w-0 rounded-md border border-base-700 bg-base-850/60 px-2.5 py-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? '收起这一轮的步骤' : '展开这一轮在做的每一步'}
        className="group flex w-full min-w-0 items-center gap-2 text-left"
      >
        <span aria-hidden className="shrink-0 text-ink-lo transition group-hover:text-ink-hi">
          {open ? '▾' : '▸'}
        </span>
        {/*
          运行指示点：折叠时也要一眼看出"它还在动"。
          与元数据行那个点是同一个类名 —— 同一个含义用同一个标记
          （`animate-pulse-soft` 是 `tailwind.config.js` 里注册的名字）。
        */}
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-accent" />

        {/* 最新一步 —— 折叠时这一格就是"它现在在做什么"。**最亮的一档**：它是本体。 */}
        <span className="min-w-0 truncate text-ink-hi">{last.message}</span>
        {/*
          两个数回答两个问题，**同一口径**（见上面 `elapsedSec` 的说明）：
          · `mmss(elapsedSec)`   —— 这一轮一共跑了多久
          · `currentSec`         —— **当前这一步**已经卡了多久（它才是"是不是卡住"的答案）
        */}
        {/*
          ⚠️ **就一个计时器，别的都不写（2026-10-10）。**
          
          上一版这里是「已 1:53 · 这一步 1s」。用户的原话是
          「这表述我他妈看得一头雾水，你就直接显示计时不就好了吗？
            搞些什么奇奇怪怪得非主流语言在上面」。
          
          **他说得对**：`已` / `这一步` 是我自己发明的说法，一个读数不需要前缀；
          计时器本身就是"从开始到现在"，跳动的秒数已经回答了"它还在动吗"。
          每一步各花了多久，去展开视图里看（那里是表格，列本身有含义）。
          
          唯一保留的判断是**颜色**：超过 2 分钟转琥珀色 —— 那是"比平常久"的
          无声提示，不占字。
        */}
        <span
          className={
            'num ml-auto shrink-0 tabular-nums ' +
            (elapsedSec >= 120 ? 'text-accent' : 'text-ink-hi')
          }
        >
          {mmss(elapsedSec)}
        </span>
      </button>
      {open && (
        <ol className="mt-2 space-y-1 border-t border-base-700 pt-2">
          {steps.map((s, i) => {
            const at = Date.parse(s.at);
            const prevAt = i > 0 ? Date.parse(steps[i - 1]!.at) : at;
            /*
             * **这一步花了多久** = 它自己的时刻 − 上一步的时刻。
             * 这是"慢在哪一步"唯一的答案 —— 只给绝对时刻的话，
             * 人还得自己心算相邻两行的差。
             */
            const deltaSec =
              Number.isFinite(at) && Number.isFinite(prevAt)
                ? Math.max(0, Math.round((at - prevAt) / 1000))
                : 0;
            const isCurrent = i === steps.length - 1;
            return (
              <li key={`${s.at}-${i}`} className="flex min-w-0 items-start gap-2">
                {/* 时刻与耗时都是**读数**，用能看清的一档。 */}
                <span className="num shrink-0 text-ink-lo">
                  {new Date(s.at).toLocaleTimeString('en-GB', { hour12: false })}
                </span>
                {/*
                  ⚠️ **状态标记说的是实话，不编造成功/失败。**
                  服务端只给了"发生过"与日志级别，没给"这一步成没成" ——
                  所以：最后一条 = **正在这一步**（转圈），其余 = **已发生**（对勾）；
                  级别是 error/warn 时用红/黄把**那一条日志本身**的严重性标出来。
                  **不要**把"日志级别"伪装成"步骤成败"：那正是本项目反复在消灭的
                  "一个字段说做成了、另一个字段说什么都没有"。
                */}
                <span
                  aria-hidden
                  className={
                    'w-3 shrink-0 text-center ' +
                    (isCurrent ? 'animate-pulse-soft text-accent' : 'text-ink-faint')
                  }
                >
                  {isCurrent ? '⟳' : '✓'}
                </span>
                <span className="num w-11 shrink-0 text-right text-ink-lo">
                  {deltaSec === 0 ? '—' : `${deltaSec}s`}
                </span>
                <span
                  className={
                    'min-w-0 break-words ' +
                    /* 正文比读数更亮一档：它是主角，时刻与耗时是配角。 */
                    (s.level === 'error' ? 'text-down' : s.level === 'warn' ? 'text-accent' : 'text-ink-hi')
                  }
                >
                  {s.message}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
function LiveCycleBlock({ live }: { live: LiveCycle }) {
  const startedAt = live.startedAt;
  const [seconds, setSeconds] = useState(() => Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));

  useEffect(() => {
    // 先立刻对齐一次：从 `cycle_start` 进来到这一帧可能已经过了几百毫秒，
    // 而 0 秒和 1 秒对这个读数来说是两种不同的意思。
    setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    // 1 秒一跳就够了：显示的就是秒，再密只是白重渲染（一秒两次的转圈也不会更好看）。
    const timer = window.setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <article className="min-w-0 opacity-70">
      {/* 一行纯文字元数据（§2）：`呼吸圆点 │ 周期 #N │ 正在请求模型…` */}
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-0.5 text-xs text-ink-lo">
        <span
          className="flex items-center gap-1.5"
          title="这一轮的模型请求已经发出，结果还没回来。"
        >
          {/*
            用圆点而不是"刚刚"：这个条目一定是刚刚开始的，那两个字不带信息；
            圆点配 `@keyframes pulseSoft` 才是"还在动"的标记。
            ⚠️ `animate-pulse-soft`（带连字符）是 `tailwind.config.js` 里真正注册的
            动画名；写成 `animate-pulseSoft` 不会报错，只是**永远不生效** ——
            这个坑 `scripts/ui-smoke.mjs` 的注释里记着。
          */}
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-accent" />
          进行中
        </span>
        <span aria-hidden className="text-ink-faint">
          │
        </span>
        <span className="num">周期 #{live.cycleNumber}</span>
        {/*
          ⚠️ **这一格不再重复"当前步骤"（2026-10-10，用户实测）。**
          
          加了步骤流水之后，这里和下面折叠行的摘要显示的是**同一句话**，
          屏幕上连着两行一模一样的字 —— 用户的原话是「这 2 行重复了」。
          
          "现在在做什么"只该有一个出处：下面那一行（它同时还带步数与用时，
          并且是**可点的展开入口**）。这里保留状态与周期号即可。
        */}
      </div>

      {/*
        盒子：虚线边框 + 更弱的底色，**不是**成品的 `bg-base-850`。
        实线 + 抬升底色是"这一轮已经出结果"的语言，用在这里会被读成成品（§1）。
      */}
      {/* 步骤流水：默认折叠成一行摘要，点开看这一轮在做的每一步。 */}
      <CycleSteps steps={live.steps} elapsedSec={seconds} />

      <div className="min-w-0 rounded-lg border border-dashed border-base-600 bg-base-900/40 px-3 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <LoaderCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent" />
          <div className="min-w-0">
            <p className="text-xs leading-relaxed text-ink-mid" role="status">
              模型正在思考，已等待 <span className="num font-semibold text-ink-hi">{elapsedLabel(seconds)}</span>
            </p>
            {seconds >= SLOW_CYCLE_SECONDS && (
              // 越过 20 秒才说话，而且说的是"正常"而不是"出问题了"：这个系统
              // 见过 18.3 秒的一轮，在 20 秒就报警会让操作员去查一个不存在的事故。
              <p className="mt-1 text-xs leading-relaxed text-ink-faint">
                模型响应偏慢 —— 本系统单轮最长见过约 18 秒，等一会儿是正常的。
              </p>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * @param running 机器人是否正在运行。页面用 REST 的 `isRunning` 与推送到的实时状态
 *   合成后传进来；省略时退回到 store 里最后一次推送的状态 —— 页面忘了传也不会出现
 *   "停了还在转圈"。
 * @param actions 面板头里、刷新之前的那一组动作（交易页传的是「立即分析」）。
 *
 *   为什么是一个**元素**而不是 `onRunOnce` 之类的回调：那个动作依赖交易页自己的
 *   store 订阅与忙碌状态（`useRunOnce`），而这里的职责只是把它排在参考产品那一行的
 *   位置上（`DECISION-FEED.md` §1：`最近决策   ⚡立即分析   ↻`）。接收元素，这个面板
 *   就不必知道 run-once 调的是哪个接口、忙的是哪个机器人；省略时面板头只剩刷新与
 *   全部记录（见 §7：这两个入口必须保留）。
 */
/**
 * 「下一轮决策」倒计时。
 *
 * ## 为什么不由界面自己算
 *
 * 界面能拿到的只有"上一轮的时间"和配置里的周期，而**实际延迟还取决于两件界面看不到的事**：
 * 模型可以自己要求下次间隔（"这个突破正在形成，5 分钟后再叫我"），失败时系统会**短重试**
 * 而不是白等一整个周期。两者都只在服务端的 `scheduleNextCycle()` 里算得出来。
 *
 * 所以这个组件**只负责显示**：拿服务端给的 `nextCycleAt` 每秒刷新一次。
 * 自己推算会显示一个骗人的时间（模型说 5 分钟、界面显示 60 分钟），比没有更糟。
 */
function CycleCountdown({ nextCycleAt }: { nextCycleAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (nextCycleAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [nextCycleAt]);

  if (nextCycleAt === null) return null;
  const leftSec = Math.max(0, Math.round((nextCycleAt - now) / 1000));
  const m = Math.floor(leftSec / 60);
  const s = leftSec % 60;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-base-700/80 bg-base-850/90 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-ink-lo"
      title="下一轮决策的预定时刻（由服务端给出，已包含模型要求的间隔与失败后的短重试）"
    >
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-up/85" />
      <span>下一轮</span>
      <span className="font-semibold text-ink-hi">
        {m}:{String(s).padStart(2, '0')}
      </span>
    </span>
  );
}


export function DecisionFeed({
  traderId,
  running,
  actions,
  nextCycleAt = null,
  mode = 'strategy',
  exchange,
  focusMode = false,
  onToggleFocus,
  onSelectSymbol,
}: {
  traderId: number;
  running?: boolean;
  actions?: ReactNode;
  nextCycleAt?: number | null;
  /**
   * 机器人模式 —— **决定实时区显示什么**（用户 2026-10-12 要求三种模式看板分开）。
   *
   * · `ai_team` —— 显示**团队编制表**（谁在做什么、什么分工、并行还是串行）
   * · 其他 —— 显示原来的线性步骤列表
   *
   * ⚠️ 默认值是 `'strategy'`，所以**既有调用点（另两种模式）行为完全不变** ——
   * 不传 `mode` 就与改动前逐字节一致。
   */
  mode?: TraderMode;
  /** 机器人绑定账户所属交易所（透传给行情接口，确保 Gate 机器人读取 Gate 现价）。 */
  exchange?: import('@aq/shared').ExchangeId;
  /**
   * **是否处于"决策流占满整页"的聚焦模式**（2026-10-13 用户要求）。
   *
   * 用户原话：
   * > 「这一块UI展示区域太小了，根本显示不了这么多，**直接跳转把这块占用全部页面**」
   *
   * ⚠️ 默认 `false` —— 不传就与改动前完全一致（三种模式都不受影响）。
   */
  focusMode?: boolean;
  /** 退出聚焦模式（聚焦时在工具栏显示「返回」）。 */
  onToggleFocus?: () => void;
  /** 点击决策卡片上的币种时触发：切换到左侧行情图表并展示对应币种 K 线。 */
  onSelectSymbol?: (symbol: string) => void;
}) {
  const live = useEvents((s) => s.byTrader[traderId]?.decisions);
  const liveCycle = useLiveCycle(traderId);
  /*
   * 推送到的实时状态只是**兜底**：`stopped` / `error` 为假，`running` / `starting`
   * 为真。`safe_mode` 也留假 —— 那时循环虽然还在，但页头已经有一个专门的横幅在说
   * 这件事，让决策流再多一个"正在请求模型"的转圈会把一次降级说得像一切正常。
   */
  const liveStatus = useEvents((s) => s.byTrader[traderId]?.status ?? null);
  const isRunning = running ?? (liveStatus === 'running' || liveStatus === 'starting');
  const query = usePolled(
    (signal) => api.traderDecisions(traderId, { limit: FEED_PAGE_LIMIT, signal }),
    {
      intervalMs: 20_000,
      deps: [traderId],
    },
  );

  // 行情列表提供**当前价**，用来把"止损 74434.8"变成"离现价多远"，
  // 也是开仓那一行里 `开仓 <价>` 与风险回报比的来源。
  const symbolsQuery = usePolled((signal) => api.marketSymbols(signal, exchange), {
    intervalMs: 20_000,
    deps: [exchange],
  });

  // 全部周期累计 Token 计费统计与实时单价（随新周期落地自动刷新）
  const latestLiveDecisionId = live?.[0]?.id ?? 0;
  const billingQuery = usePolled((signal) => api.traderTokenBilling(traderId, signal), {
    intervalMs: 20_000,
    deps: [traderId, latestLiveDecisionId],
  });
  const billing = billingQuery.data ?? null;
  const tokenPricing = billing?.pricing ?? null;
  const [billingOpen, setBillingOpen] = useState(false);

  /* ------------------------------------------------------------------------ */
  /*  分页：第一页来自轮询，更早的页由滚到列表底部触发                          */
  /* ------------------------------------------------------------------------ */

  /**
   * 服务端给过的、**已经显示出来的**行（按 id 去重；轮询的第一页与翻出来的每一页都并进来）。
   *
   * 为什么要**累积**，而不是"保留轮询的第一页 + 更早的页"：轮询的第一页是一个固定窗口，
   * 新周期一插进来，窗口里最旧的那一条就被挤出去了 —— 而它恰好是和已加载历史相接的那一条。
   * 挤掉它就等于在列表中间挖掉一轮：浏览器里实测到过这种情形，46 条记录中间少了 #26，
   * 而列表长度看起来完全正常，肉眼根本发现不了。
   * 累积只有"新增"没有"移除"，接缝因此不可能裂开。
   *
   * 增长有界且很慢：轮询只在真的出现新周期时 +1（每个决策周期才一次），
   * 翻页每次 +20，而且只有操作者自己滚到底才会发生。
   */
  const [loaded, setLoaded] = useState<DecisionRecord[]>([]);
  const [moreState, setMoreState] = useState<'idle' | 'loading' | 'error' | 'done'>('idle');
  const [moreError, setMoreError] = useState<string | null>(null);
  /** 最近一次"下一页"是不是满页 —— 终点提示靠它判断。 */
  const [deeperFull, setDeeperFull] = useState(false);

  /**
   * ── **团队模式：两个视图二选一**（2026-10-17 用户要求）────────────────────
   *
   * 用户原话：
   * > 「现在这一块 **AI 工作流 和 最终决策挤在一起**，最终决策只占比到页面 10% 不到，
   * >  **根本不可读状态**。我的整改想法是，**改成标签栏方式，放到 2 个标签中，
   * >  用户切换标签来查看 2 个东西。原有功能样式保持不变，只是把他们分离开。**」
   *
   * ## 为什么是"二选一"，而不是继续调比例（**同一个病已发生三次**）
   *
   * 这块版面先后试过三种分配方式，全都失败了，原因**不是数值没调对**：
   * ```
   *   ① max-h-[38vh]      → 工作流 429px、决策区 123px（装不下一条）
   *   ② max-h-[45%]       → 决策区仍是"一条装饰"
   *   ③ min-h-[180px]     → 决策区 180px，而面板内容区 556px（32%）
   * ```
   * 根因是**结构性的**：两者是**同一个纵向 flex 里的兄弟节点**，
   * 一方多拿一分高度，另一方就少一分 —— **任何百分比都只是在该比例上挪动牺牲者**。
   *
   * 所以改成"同一时间只渲染一个"：各自拿**全部**可用高度，
   * 高度不再被分配，也就不再存在"谁挤谁"。
   *
   * ## 默认是「最终决策」
   *
   * 用户第一眼看的是**决策结果**（"这一轮决定了什么"）；
   * 工作流是"谁在干活"的**运行态**，属于按需查看。
   * 这也与用户更早那句一致：「上面固定展示各智能体工作状态和摘要，
   * 用户有需要可以**手动点击打开查看详情**」。
   *
   * ⚠️ **只有团队模式有标签栏**：另两种模式本来就没有工作流区，
   * 它们的决策流一直是独占全部高度 —— 给它们加一个只有一项的标签栏是纯噪音。
   */
  const [pane, setPane] = useState<'decisions' | 'workflow'>('decisions');
  const isTeamLike = mode === 'ai_team';

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /** 在途的"加载更多"请求：换机器人或卸载时要作废掉。 */
  const moreAbortRef = useRef<AbortController | null>(null);
  /** 当前机器人 id 的快照：异步回调里用它判断响应是不是已经属于上一个机器人了。 */
  const traderIdRef = useRef(traderId);
  traderIdRef.current = traderId;

  /**
   * **切标签页时记住的决策流滚动偏移量**（2026-10-17 · 回归 UI-T74-02）。
   *
   * 声明在这里（而不是挨着用它那个 `useLayoutEffect`）是因为**换机器人的清理
   * effect 就要清它** —— 两个地方都要用，而"属于上一个机器人的状态"与
   * `loaded` / `moreState` 是同一类东西，放在一起才不会漏。
   */
  const restoreScrollRef = useRef<number | null>(null);

  useEffect(() => {
    // 换机器人：已加载的旧页、错误与终点标记都属于上一个机器人，整套丢掉。
    // 清理函数把在途请求也 abort 掉 —— 否则它回来时会追加到新机器人的列表里。
    setLoaded([]);
    setMoreState('idle');
    setMoreError(null);
    setDeeperFull(false);
    /*
     * ⚠️ **记住的滚动位置也必须丢掉**（2026-10-17 · 台账回归 UI-T74-02 的第二半）。
     *
     * `restoreScrollRef` 是"切标签页时记住的偏移量"，它属于**上一个机器人**：A 机器人
     * 滚到 500px → 切到 B（`<DecisionFeed>` 没有被 `key` 住，组件是同一个实例）→
     * 切回决策页时那个 500px 会被还原到 **B 的列表**上，B 一进来就停在半空 ——
     * 而 B 的记录数、高度、甚至有没有那么多历史都和 A 不同。
     *
     * 这就是本仓库那条老纪律的又一次实例：**属于"上一个 X"的状态，在 X 变化时
     * 必须一起清掉**（同 `loaded` / `moreState` / `moreError` / `deeperFull`）。
     */
    restoreScrollRef.current = null;
    return () => moreAbortRef.current?.abort();
  }, [traderId]);

  /*
   * 轮询拿到的第一页并进来。
   *
   * 第一页同样是"多要一条"：最后那一条只是探针（回答"还有没有更早的"），不显示，
   * 所以这里切掉。
   *
   * ⚠️ **这里原来还有一个 `traderId` 过滤**（"换机器人时 `usePolled` 不会立刻清空
   * 旧数据，不挡一下，上一家的记录会被并进新列表"）。2026-10-17（台账 FRD-05）那个
   * **补丁已删**：`usePolled` 现在在 `deps` 变化时自己清 `data`，所以"上一家的记录"
   * 根本不会出现在这里 —— 补丁式过滤的存在本身就是协议层该清而未清的证据。
   */
  useEffect(() => {
    const page = query.data;
    if (!page) return;
    const rows = page.slice(0, FEED_PAGE_SIZE);
    if (rows.length === 0) return;
    setLoaded((prev) => mergeFresh(prev, rows));
  }, [query.data, traderId]);

  /**
   * 最新的一页（轮询）+ 更早的页 + 推送进来的实时记录 → 一个列表。
   *
   * **按 `record.id` 去重**：同一轮同时出现在两页边界上、或者既在 REST 结果里
   * 又在 WebSocket 推送里，都只会渲染一次（`Map` 的键就是 id）。
   * 决策记录写进库之后不再修改，所以旧行永远不需要重拉。
   *
   * 轮询刚拿到的第一页也**直接**并进来，不等上面那个 effect 落地：否则"数据到了"和
   * "列表挂上去了"会差一次重渲染，而挂在列表末尾的哨兵观察器只在这几个依赖变化时
   * 重新挂载 —— 它会永远挂不上，滚到底毫无反应（浏览器里实测到过这个情形）。
   */
  const { records, pendingLiveCycle } = useMemo(() => {
    const merged = new Map<number, DecisionRecord>();
    const upsert = (record: DecisionRecord) => {
      const prev = merged.get(record.id);
      merged.set(record.id, prev ? preferCompletedDecision(prev, record) : record);
    };
    for (const record of loaded) upsert(record);
    for (const record of (query.data ?? []).slice(0, FEED_PAGE_SIZE)) upsert(record);
    // 实时 WebSocket 推送的终态记录最后写入，配合 preferCompletedDecision 绝不被旧轮询 pending 覆盖。
    for (const record of live ?? []) upsert(record);

    const sorted = [...merged.values()].sort((a, b) => b.cycleNumber - a.cycleNumber || b.id - a.id);
    let activePending: DecisionRecord | null = null;
    const finished: DecisionRecord[] = [];
    for (const rec of sorted) {
      if (
        activePending === null &&
        isActiveInFlightPending(rec, { isRunning, liveCycleNumber: liveCycle?.cycleNumber })
      ) {
        activePending = rec;
        continue;
      }
      finished.push(rec);
    }

    const fallbackLive: LiveCycle | undefined = activePending
      ? {
          cycleNumber: activePending.cycleNumber,
          startedAt: Number.isFinite(Date.parse(activePending.timestamp))
            ? Date.parse(activePending.timestamp)
            : Date.now(),
          steps: [],
        }
      : undefined;

    return { records: finished, pendingLiveCycle: fallbackLive };
  }, [loaded, query.data, live, isRunning, liveCycle?.cycleNumber]);

  /*
   * 连续相同的轮次压成一段再渲染。
   *
   * ⚠️ **必须和上面那些 hook 放在一起，不能挪到条件 `return` 之后。**
   * 第一版就是写在下面的（紧挨着 `return`），于是加载态那一次渲染提前返回、
   * **少执行一个 hook**，数据到位后 hook 数量从 N 变成 N+1 —— React 直接抛
   * `error #310`，整个机器人详情页白屏（`typecheck` 完全不查这个）。
   */
  const runs = useMemo(() => groupCycles(records), [records]);

  /**
   * 下一页的游标 = **手里最小的 id**，也就是"比我现在有的都更早"。
   *
   * 用"最小 id"而不是"最后一条的 id"，是为了不依赖列表的排序：排序键（周期号）
   * 和游标键（id）是两回事，取最小值就不用担心两者哪天不一致。
   * 被切掉的那条探针行 id 比它更小，所以下一次翻页会把探针行当作新一页的第一条
   * 正常取回来 —— 不重不漏，代价只是每次多取一行。
   *
   * 只统计**服务端给过的行**（已加载的 + 本轮轮询的第一页），不含推送：
   * 推送来的行是"最新的那些"，服务端那一份才是连续的，游标必须锚在连续的那一段上。
   */
  const cursor = useMemo(() => {
    let min: number | null = null;
    for (const record of loaded) if (min === null || record.id < min) min = record.id;
    for (const record of (query.data ?? []).slice(0, FEED_PAGE_SIZE)) {
      if (min === null || record.id < min) min = record.id;
    }
    return min;
  }, [loaded, query.data]);

  /**
   * 还有没有更早的。
   *
   * - 服务端给过一个**不满一页**的下一页（`done`）→ 没有；
   * - 最近一次下一页是满页，或者轮询的第一页是满的（说明下面还有）→ 有；
   * - 第一页本来就不满 21 条 → 没有了，直接显示终点。
   */
  const hasMore = moreState !== 'done' && (deeperFull || (query.data?.length ?? 0) > FEED_PAGE_SIZE);

  /*
   * 要不要显示"正在请求模型"这一条。
   *
   * 三个条件缺一不可：
   *
   * 1. `isRunning` —— 机器人必须真的在跑。停了的机器人还转圈，就是在说一件假的
   *    事实（`LAYOUT.md` §7）。它来自页面传来的 `running`，或者（页面没传时）
   *    store 里最后一次推送的状态。
   * 2. 有在途周期 —— 由 `store` 的 `cycle_start` / `cycle_end` / `decision` 维护。
   * 3. 这一轮的成品**还没到**。正常情况下 store 会在 `decision` / `cycle_end` 时就把
   *    在途标记清掉，所以这里多数时候只是防御：万一标记和记录同时在（比如那一帧
   *    的处理顺序不如预期），宁可少显示一个占位条，也**绝不能**让同一轮出现两个条目。
   */
  const effectiveLiveCycle = liveCycle ?? pendingLiveCycle;
  const showLive =
    isRunning &&
    effectiveLiveCycle !== undefined &&
    !records.some((record) => record.cycleNumber === effectiveLiveCycle.cycleNumber);

  /** 列表（滚动容器与哨兵）有没有挂上去 —— 观察器要在它出现的那一次重新挂。 */
  const listMounted = records.length > 0 || showLive;


  /**
   * **最近一轮里各岗位的步骤** —— 没有在途轮次时，固定工作流区显示这个。
   *
   * ## 为什么需要它
   *
   * `liveCycle` 只在周期**进行中**存在。若工作流区只在那一刻显示，
   * 操作员在绝大部分时间里看到的是一个空白的头 —— 而那正是
   * 「**看不清 AI 运行状态**」的成因之一。
   *
   * ## 为什么从 `rawResponse` 解析、而不是读 `cycle_step`
   *
   * `cycle_step` **不落库**（见 `domain.ts` 的说明），所以页面刷新之后就没了。
   * 而每一轮的 `<team>` 块**已经落库**在 `decision_records.raw_response` 里，
   * 里面有每个角色的产出摘要与模型名（见 `deskOutput.ts` 的 `renderDeskOutcome`）。
   *
   * 所以"最近一轮谁做了什么"可以从**任意一条已落库的团队记录**里重建 ——
   * 不需要给数据库加列、不需要迁移（迁移要动挂着实盘的 `traders` 表，风险不值得）。
   *
   * ⚠️ **只取团队记录**：普通/智能托管模式的 `rawResponse` 里没有 `<team>` 块，
   * `parseTeamTrace` 返回 `null` → 跳过。不然会把别家模式的记录当成团队产出。
   */
  const latestTeamSteps = useMemo(() => {
    for (const record of records) {
      const trace = parseTeamTrace(record.rawResponse);
      if (trace === null || trace.members.length === 0) continue;
      return trace.members.map((member) => ({
        at: record.timestamp,
        level: 'info',
        /*
         * ══════════════════════════════════════════════════════════════════
         *  ⚠️⚠️ **`message` 是一段【可读的摘要】**（2026-10-14 两次用户反馈）
         * ══════════════════════════════════════════════════════════════════
         *
         * ## 第一次反馈：岗位行里显示出一段裸 JSON
         *
         * ```
         *   ● 裁决官  进行中  深度思考  汇总多空论证，给出**唯一**结论（有权决定"…
         *              ```json [ {"symbol":"BTWUSDT","action":"ski…  17:26:38
         * ```
         * 根因：`message` 被填成了**产出全文**（`member.text`）——
         * 而它可能是 JSON、可能是一篇长文。
         *
         * ## 第二次反馈：我改成"完成"之后，信息全没了
         *
         * ```
         *   用户：「全是完成，展开看到也是完成何意味？」
         * ```
         * **他说得对，我上一版修过头了**：把产出换成两个字，等于把那一行的
         * 信息量降到零 —— 用户看不到"它到底得出了什么"。
         *
         * ## 现在的做法：**提取**一段摘要（既不裸奔也不丢弃）
         *
         * ```
         *   ① 剥掉机器标签（`<reasoning>` 等）与 markdown 装饰（`**`、`##`）
         *   ② 跳过开场白（"让我…"、"我先…"、"以下是…"）—— 那不是结论
         *   ③ 取第一句有实质内容的话，截到 ~72 字
         *   ④ 实在提取不到 → 退回"完成"（而不是显示空）
         * ```
         * ⚠️ **摘要与全文的差别是"取舍"而不是"截断"**：
         * 直接 `slice(0, 60)` 会切出 `{"symbol":…` 或 `让我按决策流程走一遍。**第一步` ——
         * 那正是第一次反馈里的形态。所以必须先**跳过开场白**再取。
         *
         * ⚠️ 产出全文仍在「展开详情 → 各角色产出」（那里有「展开全文」按钮）——
         * 这一行只负责"扫一眼就知道它得出了什么"。
         */
        message: summarizeMemberOutput(member.text),
        role: member.role,
        /*
         * 阶段：`<team>` 块里没有记阶段，所以**不编造** ——
         * 传 `null`，界面上那一格就不显示。编一个"分析"出来会让
         * "这个岗位在哪个阶段"变成一个不可信的数。
         */
        phase: null,
      }));
    }
    return [];
  }, [records]);

  /**
   * 取下一页（更早的 20 条），追加到下面。
   *
   * 游标是"手里最小的 id"，不是偏移量，所以**不会**因为这会儿又跑完了一轮而错位：
   * 新记录的 id 一定更大，永远落在游标之上。
   */
  const loadMore = useCallback(async () => {
    if (moreState === 'loading' || moreState === 'done') return;
    if (cursor === null) {
      // 手里一行都没有 = 没有可翻的页（第一页还没到）。落一个终态而不只是 return：
      // 重试按钮走的是同一条路径，这里若不落终态，用户会停在一个点了没反应的"重试"上。
      setMoreState('done');
      return;
    }

    const requestedFor = traderId;
    moreAbortRef.current?.abort();
    const controller = new AbortController();
    moreAbortRef.current = controller;
    setMoreState('loading');
    setMoreError(null);

    try {
      const page = await api.traderDecisions(requestedFor, {
        limit: FEED_PAGE_LIMIT,
        before: cursor,
        signal: controller.signal,
      });
      // 机器人已经切走（或组件已卸载）：这一页属于上一个列表，直接丢掉。
      if (controller.signal.aborted || traderIdRef.current !== requestedFor) return;

      // 显示前 20 条，最后那条探针留给下一次翻页（它会成为新一页的第一条）。
      setLoaded((prev) => mergeFresh(prev, page.slice(0, FEED_PAGE_SIZE)));
      setDeeperFull(page.length > FEED_PAGE_SIZE);
      // 不满一页 = 已经到最早一轮。那条"多要一条"的探针就是为这一句存在的。
      setMoreState(page.length > FEED_PAGE_SIZE ? 'idle' : 'done');
    } catch (error) {
      if (controller.signal.aborted) return;
      // 失败**必须**看得见并且能重试：静默停下会让操作者以为"历史只有这么多"。
      setMoreError((error as Error).message);
      setMoreState('error');
    }
  }, [cursor, moreState, traderId]);

  /** 观察器回调里用的永远是**最新一次渲染**的 `loadMore`（否则会拿着旧游标再请求一次）。 */
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  /**
   * 滚到列表底部就取下一页。
   *
   * `root` 必须是这个面板**自己的滚动容器**：决策流的滚动条在卡片区里，不在窗口上
   * （见组件顶部"高度"那一节）。用默认的视口当 root，在 `xl` 以下——整页很长、
   * 卡片区被 `max-h` 截断——会提前触发（哨兵在视口里而没在容器底部）甚至永不触发。
   *
   * `rootMargin` 往下放 320px ≈ 提前一屏开始取：滚到最后一条时下一页往往已经
   * 拼在下面了，"正在加载…"不会先闪一下再被内容顶走。
   */
  useEffect(() => {
    /*
     * 只在"还有更早的、而且此刻既没在加载也没出错"时观察：
     * - 加载中不观察：哨兵还在视口里，重新观察会立刻再触发一次，打出重复请求；
     * - 出错后不观察：能失败一次的请求会一直失败，自动重试就变成打不停的循环。
     *   这时改由错误行里的"重试"按钮驱动，用户点一次才发一次。
     */
    if (!hasMore || moreState !== 'idle') return;
    const root = scrollerRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;

    /*
     * ══════════════════════════════════════════════════════════════════════
     *  ⚠️⚠️ **`root` 不可滚时【不要创建观察器】**（2026-10-17 实测缺陷的保险）
     * ══════════════════════════════════════════════════════════════════════
     *
     * ## 这条保险防的是什么（一次真实发生的 P1）
     *
     * 决策滚动框的高度上限（`max-h-[calc(100dvh-16rem)] xl:max-h-none`）在
     * `9ad1503` 那次改动里被从 `className` 删掉了 —— 于是 `xl` 宽度以下
     * （**含 150% 缩放**，那是本仓库 UI 验收的硬判据档位）这个框的高度
     * 等于**内容高度**（实测 `clientHeight === scrollHeight === 5559`）。
     *
     * 而 `root` 就是它自己 ⇒ 哨兵**永远落在 root 内** ⇒ 观察器一创建就立刻回调
     * ⇒ **用户还没滚动，页面打开就自动取下一页**（实测 `/decisions` 2 次请求：
     * `limit=21` 与 `limit=21&before=29`；`xl` 以上对照只有 1 次）。
     *
     * 这直接违反本文件上面写死的契约：「只有操作者读到最下面时才会触发」。
     *
     * ## 为什么"不可滚 ⇒ 不观察"是对的（而不是把合法行为也堵掉）
     *
     * 只有 `hasMore` 为真才会走到这里，而 `hasMore` 为真意味着服务端**给满了一页**
     * （`FEED_PAGE_SIZE` = 20 条，每条都带提示词与思维链，实测一屏 3–4 张卡）。
     * **满满一页绝不可能装进一个不可滚的框里** —— 所以"箱体不可滚"只有两种可能：
     * ```
     *   ① 高度上限丢了（就是上面那次 P1）→ 此时**不该**自动拉，修上限才是正解
     *   ② 内容真的很少              → 此时 hasMore 为假，根本走不到这里
     * ```
     * 换句话说：这条保险只在"出故障"的那一支上生效，**不改合法路径的分页语义**。
     *
     * ## 它为什么必须存在（而不是"把 max-h 加回去就够了"）
     *
     * `max-h` 是**一条 CSS 约定**，谁都能再删一次（事实上已经删过一次，且删它的
     * 那次提交并不知道自己删了什么）。而这条判断是**结构性的**：
     * 只要箱体不可滚，就没人能"滚到底"，也就不该有"滚到底才加载"。
     * 两条一起才叫修好 —— 上限管"看起来对不对"，这条管"故障时不雪崩"。
     */
    const scrollable = root.scrollHeight > root.clientHeight + 1;
    if (!scrollable) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMoreRef.current();
      },
      { root, rootMargin: '320px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    /*
     * `listMounted` 必须在依赖里：`hasMore` 变真的那一次提交里，列表可能还没挂上去
     * （数据先到、渲染列表用的状态后到），`scrollerRef.current` 还是 null，
     * 观察器就永远不会被创建。`traderId` 同理：换机器人之后要重新观察新的滚动容器。
     *
     * ⚠️ **`records.length` 也必须在**：上面那条"不可滚就返回"是**在这一次提交时**
     * 做的判断 —— 如果列表后来长高了（翻页 / 推送），箱体才变得可滚，
     * 而依赖没变的话这个 effect 不会再跑，观察器就永远不存在了
     * （症状：能滚，但滚到底没有任何反应）。加上它，箱体一变可滚就重新挂上。
     *
     * ⚠️⚠️ **`pane` 必须在**（2026-10-17 · 台账回归 F1，`t86` 报告）：切到
     * 「AI 工作流」时决策区**整块卸载**，`scrollerRef` / `sentinelRef` 的节点随之消失；
     * 切回来是**两个新节点**，而上面那几个依赖一个都没变 ⇒ 这个 effect 不会重跑
     * ⇒ **新哨兵没有观察者，「滚到底加载更早的周期」静默失效**。
     * 症状很坏：`records.length` 在依赖里，所以**下一个新周期落库时会自己好** ——
     * 操作者看到的是"切回来以后几分钟内滚到底没反应，然后自己恢复了"，
     * 而那几分钟恰好是他在翻历史的时候，**全程没有任何提示**。
     *
     * 这正是本仓库 `useTablePaging` 里 `remountKey` 那条注释写的同一件事
     * （`TraderTables.tsx:487`：「节点被换掉了而上面几个依赖都没变」）。
     * 这里不引入一个新的 `remountKey` 形参，是因为分页逻辑就写在本组件里、
     * 没有外部调用者能传 key 进来 —— **`pane` 本身就是那个 key**，直接进依赖最短。
     */
  }, [hasMore, moreState, traderId, listMounted, records.length, pane]);

  /*
   * 把视口钉住：新周期插到列表**顶部**时不把正在读的内容顶走。
   *
   * 为什么需要它：这个面板每 20 秒轮询一次，机器人每跑完一轮就会在最上面多一条。
   * 操作者正往下翻着看历史时，顶部插进来的那一条会把整列往下推 ——
   * 屏幕上的字会突然跳一下，"我正在看的那一轮"就跑掉了。
   *
   * 做法：拿上一次提交时的**第一条记录**当锚点（`data-record-id` 是它的 DOM 标记），
   * 量出它这次被推下去了多少像素，就把 `scrollTop` 加同样多。锚点于是原地不动，
   * 它下面的一切也就不用动。离开顶部才补偿 —— 停在顶部时新周期本来就该出现在眼前。
   *
   * 浏览器自带的滚动锚定（`overflow-anchor: auto`，默认开着）在做同一件事，
   * 两者**不会叠加**：这里设的 `scrollTop` 正是它算出来的那个值
   * （`scrollTopRef` 由滚动事件维护，读到的是本次提交**之前**的值，加同一个 delta
   * 得到同一个结果）。留着它是因为它对"在途周期那一条变高"这类
   * 不经过本组件提交的位移也有效。
   */
  const geomRef = useRef<{ id: number; top: number } | null>(null);
  const scrollTopRef = useRef(0);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const anchor = geomRef.current;
    if (anchor && scrollTopRef.current > 4) {
      const node = el.querySelector<HTMLElement>(`[data-record-id="${anchor.id}"]`);
      if (node) {
        const delta = node.offsetTop - anchor.top;
        if (delta > 0) el.scrollTop = scrollTopRef.current + delta;
      }
    }

    // 重新取锚点：第一条**记录**（在途那条不是记录，没有这个标记），
    // 它在下一次提交里依然存在（列表按 id 去重、记录不会消失）。
    const first = el.querySelector<HTMLElement>('[data-record-id]');
    geomRef.current = first ? { id: Number(first.dataset.recordId), top: first.offsetTop } : null;
    scrollTopRef.current = el.scrollTop;
  }, [records]);

  /**
   * ── **切标签页时保住决策流的滚动位置**（2026-10-17 · 台账回归 UI-T74-02）──
   *
   * ## 症状（t74 实测，三套模板全中）
   *
   * ```
   *   classic  可滚 59  → 切到「AI 工作流」→ 切回：scrollTop = 0
   *   console  可滚 159 → 同上              → 切回：scrollTop = 0
   *   quill    可滚 107 → 同上              → 切回：scrollTop = 0
   * ```
   * 滚到某一轮 → 去对面看一眼运行态 → 回来**回到顶部**，那一轮得重新找。
   * 用户对这个组件的要求是「**原有功能样式保持不变**，只是把他们分离开」——
   * 而"切走再切回原地不动"正是原有行为（改动前决策区一直在 DOM 里，`scrollTop` 自然还在）。
   *
   * ## 为什么不去改成 `hidden`
   *
   * `hidden`（`display:none`）能让节点留在 DOM 从而保住 `scrollTop`，但代价是
   * **推翻了这个标签栏设计的前提**：
   * ```
   *   ① t60 的目标就是"同一时间只渲染一个"——两块同时在 DOM 正是要消除的结构；
   *   ② 决策卡每张都带提示词与思维链（单条几十 KB），留着就是几十个重型节点
   *      常驻；这个组件顶部专门记过"成千上万数据一次加载出来导致系统卡死"；
   *   ③ `display:none` 的箱子 `clientHeight === 0`，哨兵几何变得没有意义 ——
   *      而本文件刚给观察器加了一条"不可滚就不观察"的判断，两者会互相打架。
   * ```
   * 所以选择**保持卸载语义，把偏移量记下来再还原**：卸载/挂载的行为一个字没变，
   * 只是"回来的时候站回原来的位置"。
   *
   * ⚠️ `geomRef` 必须清掉：锚定 effect（上面那个）会拿旧锚点再补偿一次，
   * 而 `scrollTop` 已经由这里设好了 —— 不清就会**补偿两遍**、滚过头。
   */
  /** 两个标签的统一切换入口：**离开决策页时先记住位置**。 */
  const switchPane = (next: 'decisions' | 'workflow') => {
    if (pane === 'decisions' && next !== 'decisions') {
      restoreScrollRef.current = scrollerRef.current?.scrollTop ?? null;
    }
    setPane(next);
  };

  const visibleTabs: ReadonlyArray<'decisions' | 'workflow'> = useMemo(
    () => (mode === 'ai_team' ? ['decisions', 'workflow'] : ['decisions']),
    [mode],
  );

  useEffect(() => {
    if (!visibleTabs.includes(pane)) setPane('decisions');
  }, [visibleTabs, pane]);

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    if (visibleTabs.length <= 1) return;
    event.preventDefault();
    const idx = Math.max(0, visibleTabs.indexOf(pane));
    let nextIdx = idx;
    if (event.key === 'ArrowLeft') nextIdx = (idx - 1 + visibleTabs.length) % visibleTabs.length;
    else if (event.key === 'ArrowRight') nextIdx = (idx + 1) % visibleTabs.length;
    else if (event.key === 'Home') nextIdx = 0;
    else if (event.key === 'End') nextIdx = visibleTabs.length - 1;
    const next = visibleTabs[nextIdx] ?? 'decisions';
    switchPane(next);
    /* 等 roving tabindex 落到新按钮上再聚焦（同一提交内 ref 还没换）。 */
    requestAnimationFrame(() => {
      document.getElementById(`feed-tab-${next}`)?.focus();
    });
  };

  useLayoutEffect(() => {
    if (pane !== 'decisions') return;
    const el = scrollerRef.current;
    const want = restoreScrollRef.current;
    if (!el || want === null) return;
    el.scrollTop = want;
    scrollTopRef.current = want;
    geomRef.current = null;
    restoreScrollRef.current = null;
  }, [pane]);

  /*
   * 面板头右侧那一行：**动作（立即分析）→ 刷新 → 全部记录**，顺序照参考产品的
   * `⚡立即分析   ↻`（`DECISION-FEED.md` §1）。抽成变量是为了加载态那张面板也用同一份 ——
   * 否则数据一到，这个按钮会先从页面上消失再出现，读起来像功能坏了。
   */
  const [archiveOpen, setArchiveOpen] = useState(false);

  const headerTitle = (
    <span className="inline-flex max-w-full min-w-0 flex-wrap items-center gap-1.5">
      <span className="shrink-0 whitespace-nowrap">最近决策</span>
      {mode !== 'ai_team' && <CycleCountdown nextCycleAt={nextCycleAt} />}
      {billing && billing.meteredCycles > 0 && (
        <TokenBillingHeaderBadge
          billing={billing}
          open={billingOpen}
          onToggle={() => setBillingOpen((v) => !v)}
        />
      )}
    </span>
  );

  const headerActions = (
    <span className="flex max-w-full flex-wrap items-center gap-1">
      {actions}
      {actions && <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-base-700/80" />}
      <button
        type="button"
        onClick={() => setArchiveOpen(true)}
        className="inline-flex h-[26px] shrink-0 items-center whitespace-nowrap rounded-[7px] px-1.5 text-xs text-ink-lo transition hover:bg-base-800/80 hover:text-ink-hi [[data-skin='light']_&]:text-ink-mid [[data-skin='light']_&]:hover:text-ink-strong"
        title="打开本机器人全量决策档案（支持按交易动作/币种检索、展开理由与翻阅历史）"
      >
        全部记录
      </button>
      {onToggleFocus !== undefined && (
        <button
          type="button"
          onClick={onToggleFocus}
          aria-label={focusMode ? '退出全屏' : '全屏查看决策流'}
          title={focusMode ? '返回常规视图（图表与账户卡）' : '让决策流占满整页，获得更宽阔的阅读视野'}
          className={cn(
            'inline-flex h-[26px] shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[7px] text-xs transition',
            focusMode
              ? 'bg-accent/12 px-2 font-medium text-accent hover:bg-accent/20'
              : "w-[26px] text-ink-lo hover:bg-base-800/80 hover:text-ink-hi [[data-skin='light']_&]:text-ink-mid",
          )}
        >
          {focusMode ? (
            <>
              <Minimize2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
              <span>退出全屏</span>
            </>
          ) : (
            <Maximize2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
          )}
        </button>
      )}
    </span>
  );

  /*
   * ⚠️ **加载态只在"还没有过任何数据、也没失败"时显示**（2026-10-17 · 台账 UI-04）。
   * 失败时走下面的错误条 —— 否则一次 500 会被显示成"正在加载"，然后跳到"暂无"。
   */
  if (query.loading && records.length === 0 && !showLive && query.error === null) {
    return (
      // 加载态也占满整栏：否则数据一到位，这一栏会突然从一小条跳成整屏高。
      <Panel
        title={headerTitle}
        padded={false}
        className="flex h-full min-h-0 flex-col"
        bodyClassName="flex min-h-0 flex-1 flex-col p-0"
        actions={headerActions}
      >
        <Spinner3 label="正在加载决策" />
      </Panel>
    );
  }

  /*
   * ── 三态分离：loading / **error（可重试）** / empty（台账 UI-04 / FRD-04）──
   *
   * 原来看的只有 `records.length === 0`，于是**一次读取失败被显示成"暂无决策记录。
   * 每个周期都会…运行一次后这里就会填满"** —— 那是把故障说成"这台还没跑过"，
   * 与本仓库明文禁止的「查不到 ≠ 没有」正相反。翻页路径（`moreState === 'error'`）
   * 早就写对了（失败可见 + 重试），这里只是把同一份纪律接到第一页上。
   */
  const feedError = query.error;

  return (
    <Panel
      padded={false}
      /* 填满右栏：面板 `h-full` + 一个 `min-h-0` 的纵向 flex，卡片区才能拿到
         "剩下的高度"并自己滚动（见组件顶部注释）。 */
      className="flex h-full min-h-0 flex-col"
      bodyClassName="flex min-h-0 flex-1 flex-col p-0"
      title={headerTitle}
      actions={headerActions}
    >
      {feedError !== null && (
        <div className="px-2.5 pt-2.5">
          <ErrorNote>
            {records.length > 0
              ? '最新周期读取失败，下面是上一次成功读到的数据'
              : '决策记录读取失败（这不等于"没有记录"）'}
            ：{feedError}
            <button
              type="button"
              onClick={query.reload}
              className="ml-1 shrink-0 text-accent hover:underline"
            >
              重试
            </button>
          </ErrorNote>
        </div>
      )}
      {billingOpen && billing && (
        <TokenBillingSummaryStrip billing={billing} onClose={() => setBillingOpen(false)} />
      )}
      <>
          {/*
            ══════════════════════════════════════════════════════════════════
             **AI 工作流（固定区）** —— 团队模式专属（2026-10-12 用户要求）
            ══════════════════════════════════════════════════════════════════

            用户原话：
            > 「在我想象中应该是**固定展示 AI 工作流**，一部分**滚动展示最终决策**
            >  等关键信息」
            > 「应该是上面固定展示**各智能体工作状态和摘要**，用户有需要可以手动点击
            >  打开查看详情」

            ## 为什么是"真正固定"，而不是 `sticky`

            上一版把编制表放在滚动容器**内部**、靠 `sticky top-0` 钉住。那不够：
            `sticky` 元素仍然是滚动内容的一部分，它参与 `space-y` 布局、
            会跟着容器一起被裁切，而且它的可用高度会随内容变化 ——
            工作流区越高，下面的决策区就越矮，而"最高的那一轮"恰好最该看得清。

            现在的工作流区是滚动容器**外面**的兄弟节点（`shrink-0`）：
            它有自己的高度，决策区拿**剩下**的高度自己滚。
            于是"上面固定、下面滚动"是布局事实，不是视觉巧合。

            ## 为什么没有在途轮次时**也显示**它

            `liveCycle` 只在周期进行中存在。如果只在那一会儿显示，操作员在
            绝大部分时间里看到的是一个**空白的头** —— 而这正是"看不清 AI 运行状态"
            的成因之一。所以：
              · 有在途轮次 → 显示这一轮的实时状态（谁在进行中/已完成/失败）；
              · 没有在途轮次 → 仍然显示**完整编制表**（谁在岗、谁规划中、
                以及最近一轮各岗位的产出摘要），只是时间轴停在最后一轮。

            这样"这家公司有哪些人、各自在干什么"是**常驻**信息，
            而不是"碰巧抓到了才有"。
          */}
          {/*
            ══════════════════════════════════════════════════════════════════
             **标签栏**：把「最终决策」与「AI 工作流」分开（2026-10-17 用户要求）
            ══════════════════════════════════════════════════════════════════

            用户原话：
            > 「现在这一块 **AI 工作流 和 最终决策挤在一起**，最终决策只占比到页面
            >  10% 不到，**根本不可读状态**。我的整改想法是，**改成标签栏方式，
            >  放到 2 个标签中，用户切换标签来查看 2 个东西**。
            >  原有功能样式保持不变，只是把他们分离开。」

            ## 它为什么放在两个分区的**外面**

            标签栏必须在 `pane` 分支**之外** —— 否则切到"工作流"那一页时标签栏
            自己也跟着消失，用户就没有路回到"最终决策"了（本仓库对"切过去回不来"
            这类问题有明确结论：`TemplateSwitcher` 那段注释写过，"等于用户被困住"）。

            ## 视觉语言照抄 `TraderTables` 的数据表标签

            `-mb-px border-b-2` + 选中 `border-accent` + `text-base`：
            同一个应用里"标签"只有一种长相。**没有引入新的设计语言**，
            这也正是用户那句"原有功能样式保持不变"的另一面。

            ## 高度

            它就是一行文字加下边框（实测 30px，见交付说明里的量测），
            与它替代掉的那个"工作流区最大 45%"完全不是一个量级。
          */}
          {isTeamLike && (
            <div
              role="tablist"
              aria-label="决策与工作流"
              onKeyDown={onTabKeyDown}
              className="flex shrink-0 items-center gap-0.5 border-b border-base-800 px-2.5"
            >
              {/*
                ⚠️ **顺序固定：最终决策在前**（默认页也是它）。
                标签顺序即重要性 —— 用户第一眼看的是"这一轮决定了什么"，
                而"谁在干活"属于按需查看的运行态。
              */}
              <button
                id="feed-tab-decisions"
                type="button"
                role="tab"
                aria-selected={pane === 'decisions'}
                aria-controls="feed-panel-decisions"
                /* roving tabindex：只有选中的那个进 Tab 键序列（WAI-ARIA tabs 的标准做法） */
                tabIndex={pane === 'decisions' ? 0 : -1}
                onClick={() => switchPane('decisions')}
                className={cn(
                  '-mb-px border-b-2 px-2.5 py-1 text-base transition',
                  pane === 'decisions'
                    ? 'border-accent font-semibold text-ink-hi'
                    : 'border-transparent text-ink-lo hover:text-ink-mid',
                )}
              >
                最终决策
              </button>
              {/*
                ⚠️ **「AI 工作流」只对团队模式出现**（2026-10-19 用户截图指出）

                ## 症状

                JEV 模式下这个标签**能点，但点进去一片空白**。

                ## 根因（我自己引入的）

                我把标签栏的整体条件从 `mode === 'ai_team'` 改成了 `isTeamLike`
                （团队 + JEV），于是**这个按钮跟着出现了**；但它的面板条件是
                `mode === 'ai_team' && pane === 'workflow'` —— JEV 模式不满足
                ⇒ **按钮在、面板没有** ⇒ 点进去空白。

                ## 为什么 JEV 模式确实不该有它

                「AI 工作流」显示的是**一支团队的分工与辩论**：调度官派活、
                分析师并行调研、多空对抗、风控把关、裁决官下结论。
                JEV 模式**只有一个模型**（Jev），没有分工、没有辩论、没有角色
                —— 所以它没有"工作流"可看。

                ⇒ 标签按钮与面板必须**同一个条件**，不能一个宽一个窄。
              */}
              {mode === 'ai_team' && (
              <button
                id="feed-tab-workflow"
                type="button"
                role="tab"
                aria-selected={pane === 'workflow'}
                aria-controls="feed-panel-workflow"
                tabIndex={pane === 'workflow' ? 0 : -1}
                onClick={() => switchPane('workflow')}
                className={cn(
                  '-mb-px border-b-2 px-2.5 py-1 text-base transition',
                  pane === 'workflow'
                    ? 'border-accent font-semibold text-ink-hi'
                    : 'border-transparent text-ink-lo hover:text-ink-mid',
                )}
              >
                AI 工作流
                {/*
                  ⚠️ **有在途轮次时给一个标记**。

                  没有它，用户停在"最终决策"页时**完全看不出对面有人在干活** ——
                  而"看不清 AI 运行状态"正是这个面板当初存在的理由
                  （见 `TeamBoard` 的文件头）。标记只用现成的 `liveCycle`，
                  不新增任何数据源。
                */}
                {liveCycle !== undefined && <span className="ml-1.5 text-xs text-accent">进行中</span>}
              </button>
              )}
            </div>
          )}

          {/*
            ══════════════════════════════════════════════════════════════════
             **AI 工作流（标签页之一）** —— 团队模式专属
            ══════════════════════════════════════════════════════════════════

            用户 2026-10-12 的原始要求（这条语义**在标签页里继续成立**）：
            > 「在我想象中应该是**固定展示 AI 工作流**，一部分**滚动展示最终决策**」
            > 「应该是上面固定展示**各智能体工作状态和摘要**，用户有需要可以
            >  手动点击打开查看详情」

            ## 2026-10-17：从"争高度"改成"二选一"

            ⚠️ **这里原来有一大段关于 `max-h-[38vh]` → `max-h-[45%]` → `flex-1`
            的注释**，记录的是一次真实的、反复发生的失败：

            ```
              ① max-h-[38vh]   → 工作流 429px、决策区 123px（装不下一轮）
              ② max-h-[45%]    → 决策区仍是"一条装饰"（用户说的"不到 10%"）
              ③ flex-1         → 工作流吃满剩余、决策区被压到 180px 上限
            ```
            **三次都失败，而原因不是数值没调对**：两者是同一个纵向 flex 里的
            **兄弟节点**，一方多拿一分高度另一方就少一分 ——
            **任何百分比都只是在该比例上挪动"谁是牺牲者"**。

            所以现在改成结构性的解法：**同一时间只渲染一个**（`pane === 'workflow'`）。
            它拿 `flex-1` = 面板内容区的**全部**高度，不再和任何人分。
          */}
          {mode === 'ai_team' && pane === 'workflow' && (
            <div
              /*
               * ⚠️ **`flex-1 min-h-0` 是这一段唯一需要的布局声明**。
               *
               * 之前那套 `max-h-[45%]` / `focusMode && 'lg:flex-row'` 的两栏逻辑
               * 全部删掉了 —— 它的存在前提是"两个分区并排/堆叠"，
               * 而现在是二选一，**没有第二个分区需要让位**。
               *
               * `min-h-0` 不能省：flex 子项默认 `min-height: auto`，
               * 那一项会让它不肯比内容矮，内部的滚动条就永远不会出现
               * （这条在本文件里被记录过两次，`TeamBoard` 也是同一个前提）。
               */
              className="flex min-h-0 flex-1 flex-col p-2.5"
              /* 与决策区配对的那一半（同一套 `aria-controls` / `aria-labelledby` 关系）。 */
              role="tabpanel"
              id="feed-panel-workflow"
              aria-labelledby="feed-tab-workflow"
            >
              <div className="flex min-h-0 flex-1 flex-col">
                <TeamBoard
                  steps={liveCycle?.steps ?? latestTeamSteps}
                  cycleNumber={liveCycle?.cycleNumber ?? records[0]?.cycleNumber ?? 0}
                  /*
                   * ⚠️ **没有在途轮次时传 `null`**，不传 `Date.now()`：
                   * 计时器从 0 开始跳会因为拿不到真实起点而显示一个编造的时长，
                   * 而"这一轮跑了 50000 秒"会把操作员引去查一个不存在的事故。
                   */
                  startedAt={liveCycle?.startedAt ?? null}
                  /*
                   * 历史轮的决策记录 —— "最近活跃于 X 分钟前"的数据源。
                   * 只取 `cotTrace` 与 `timestamp` 两个字段（`lastSeenOf` 只要这两样）。
                   */
                  history={records.map((r) => ({ cotTrace: r.cotTrace, timestamp: r.timestamp }))}
                  /*
                   * ── **回放态**（2026-10-17 · 台账 UI-01）────────────────────────
                   *
                   * `liveCycle` 为空 = 现在没有任何一轮在跑；这时看板渲染的是
                   * **最近一轮的历史产出**，而不是"正在干活的人"。两者必须分开说：
                   * 实测（t3）在没有在途轮次的页面上，看板写着「本轮在干 4 失败 1」、
                   * 4 个岗位显示「进行中」+ 呼吸动画、阶段轨 5 段全灰 ——
                   * 而那一轮 42 分钟前就结束了、机器人状态是"已停止"。
                   */
                  replay={liveCycle === undefined}
                  replayAt={liveCycle === undefined ? (records[0]?.timestamp ?? null) : null}
                  /*
                   * ⚠️ **`traderId` 必须往下传**（2026-10-17 · t111）。
                   *
                   * 用户报「很多岗位似乎从未真正运行过，页面上也没有显示他们最新运行时间」。
                   * 根因是看板的"最近活跃"只读 `cotTrace`，而 `supervisor` /
                   * `risk_officer` / `reporter` 的出勤记在 `runtime_logs`（scope='team'）——
                   * 拿不到 `traderId` 就去不了 `/api/traders/:id/agent/last-seen`，
                   * 那三个角色会永远显示"待命"（线上 supervisor 实际出现 31 次）。
                   *
                   * 它当初没传下去不是设计取舍，是**漏了**（见 t111 报告）。
                   */
                  traderId={traderId}
                />
              </div>
            </div>
          )}

          {/*
            ══════════════════════════════════════════════════════════════════
             **决策流水（滚动区）** —— 只有这一块滚
            ══════════════════════════════════════════════════════════════════

            `flex-1 min-h-0`：高度来自右栏（`h-full` 的确定高度）减去上面的标签栏，
            不是 `max-height`。
            `min-h-0` 不能省 —— flex 子项默认 `min-height: auto`，那一项会让滚动区
            永远不肯比内容矮，于是滚动条跑到整栏外面去。

            `space-y-2.5` 而不是相邻的 `border-b`：40 个周期用一条接一条的分隔线排下来，
            会连成一整片、分不清哪里是上一个周期的结尾。

            ## 2026-10-17：团队模式下它是**标签页之一**，不再是"被压到一条的兄弟节点"
          */}
          {/*
            ══════════════════════════════════════════════════════════════════
             ⚠️⚠️ **这个 `mode === 'ai_team' && pane !== 'decisions'` 是本条的核心**
             ══════════════════════════════════════════════════════════════════

            它把决策流从"永远渲染、但被压到 `max-h-[max(10%,180px)]`"改成
            "**只在选中那一页时渲染，并且拿全部高度**"。

            ## 为什么"不渲染"比"压低"更对

            压低只是把同一个结构里的另一份高度让出去 —— 而用户抱怨的正是
            "10% 不到、根本不可读"。只要两者同时在 DOM 里，
            **总有一方是牺牲者**（这条在本文件被记录过三次：
            `38vh` → `45%` → `180px`，每次都是换个比例重新吃亏）。

            ## ⚠️ 非团队模式**逐字节不变**

            `mode !== 'ai_team'` 时这个条件恒假 → 决策流照旧 `flex-1` 独占全部高度，
            与改动前完全相同。这条是硬约束：`#10`（ai_managed）曾经因为
            "只想着团队模式"被压成 10%、下面一大片空白（见 `max-h-[10%]` 那段事故）。
            **同一个坑不踩第二次。**
          */}
          {/*
            ⚠️ **`isTeamLike` 而不是 `mode === 'ai_team'`**（2026-10-19 加 JEV 模式时修正）。

            这个条件决定"决策流是否独占整块高度"。原来写的是
            `!(mode === 'ai_team' && pane !== 'decisions')` ——
            JEV 模式**不在那个判断里**，于是切到「JEV 模式」标签时
            决策流**照样渲染**，把配置面板挤到下面看不见。

            ⚠️ `strategy` / `ai_managed` **逐字节不变** —— `isTeamLike` 对它们恒假。
          */}
          {!(isTeamLike && pane !== 'decisions') && (
          <div
            /*
             * ⚠️ **`role="tabpanel"` 只在团队模式加**（2026-10-17 · 台账 F3）。
             *
             * 另两种模式**没有标签栏**（工作流区只属于团队模式）—— 那时给这一块挂
             * `role="tabpanel"` 就是一个**没有对应 tab 的 panel**，比不加更糟
             *（读屏用户会去找那个不存在的 tablist）。
             * 所以这里按模式给：有标签栏才有 tabpanel。
             */
            {...(isTeamLike
              ? { role: 'tabpanel', id: 'feed-panel-decisions', 'aria-labelledby': 'feed-tab-decisions' }
              : {})}
            /*
             * `ref` + `onScroll` 是**分页与滚动位置**要的两样东西：
             * 前者给 `IntersectionObserver` 当 `root`（哨兵必须在容器里比较，不能和窗口比），
             * 也给那个把视口钉住的 `useLayoutEffect` 当测量对象；
             * 后者维护"提交前"的 `scrollTop`（滚动不触发 React 重渲染，只能自己记）。
             */
            ref={scrollerRef}
            onScroll={(event) => {
              scrollTopRef.current = event.currentTarget.scrollTop;
            }}
            className={cn(
              'min-h-0 space-y-4 overflow-y-auto p-3',
              /*
               * ══════════════════════════════════════════════════════════════════
               *  ⚠️⚠️ **`max-h-[10%]` 只能对团队模式生效**（2026-10-13 实测回归）
               * ══════════════════════════════════════════════════════════════════
               *
               * ## 事故：`#10 赚大钱`（ai_managed）的决策区变成一大片空白
               *
               * 用户截图：右栏「最近决策」里只有一行 `NEARUSDT`，下面是**整屏空白**。
               *
               * ## 根因：我为团队模式压决策区，却压到了所有模式
               *
               * 上一轮为了让「AI 工作流」占主导，我把这个决策记录区改成了
               * ```
               *   max-h-[10%] + flex-none
               * ```
               * 而**工作流区只在 `ai_team` 渲染** —— 于是：
               * ```
               *   ai_team    : 工作流 flex-1（吃满）+ 决策区 10%   ✅ 符合预期
               *   ai_managed : 工作流【不存在】+ 决策区 10%        ❌ 90% 空白
               * ```
               * `#10` 正是 `ai_managed` —— 它**没有任何东西去填那 90%**。
               *
               * ## 修法：按模式分开
               *
               * ```
               *   ai_team    : flex-none + max-h-[10%]（工作流占主导，决策区留一条）
               *   其它模式   : flex-1（决策区自己吃掉全部高度 —— 和改动前一致）
               * ```
               * ⚠️ 这正是一条本项目反复记录过的教训：
               * **「只在某模式下存在的东西，不能让它在别的模式下产生副作用」**。
               * 我上一轮改的时候只想着团队模式，忘了这个面板是**三种模式共用**的。
               *
               * ## ⚠️⚠️ 2026-10-17 修正：`10%` 在 900px 视口上只剩 **56px**（台账 UI-02）
               *
               * t3 用真实浏览器量到：面板内容区 560px → 决策区 `h=56`，
               * 而**一轮决策卡高 82–300px**（展开一轮后内容 1040px）——
               * 用户要的"下面滚动展示最终决策"实际变成了"露出两个字"。
               * 而且被裁出滚动区的卡片，Playwright 连按钮都判成 `not visible`
               * （60 次重试后超时）——**真实用户也得先精确滚动才能点中**。
               *
               * 所以这里给了一个**内容下限**：`min-h-[180px]`。
               * 为什么是 180：足够显示"一条最简决策行（时间/动作/标的/置信度/结果，
               * 实测约 72px）+ 上一轮标题 + 一行提示"，也大于验收里的 168px。
               * `max-h` 仍然保留百分比：**面板再高的时候决策区跟着变高**，
               * 而不是把它钉死成一个数（那样在 4K 屏上又浪费掉了）。
               *
               * ## ⚠️⚠️⚠️ 2026-10-17（t60）**再次修正：那两个上限已经删掉了**
               *
               * `180px` 这一步同样是失败的：面板内容区 556px，决策区只有 180px（32%），
               * 而**一轮决策卡高 82–300px** —— 用户看到的仍然是"挤在一起"。
               *
               * 上面三种尝试（`38vh` / `45%` / `180px`）全都失败，**原因不是数值**：
               * 只要两者同时在 DOM 里、同一个纵向 flex 里，**总有一方是牺牲者**。
               *
               * 所以团队模式改成**标签页二选一**（见上面那个标签栏）：
               * 选中"最终决策"时这一块拿满 `flex-1`（**全部**可用高度），
               * 选中"AI 工作流"时它**根本不渲染**（`!(mode === 'ai_team' && pane !== 'decisions')`）。
               * 高度不再被分配，也就不再有牺牲者。
               *
               * ⚠️ 非团队模式仍然是 `flex-1` —— **逐字节不变**（见上面那个事故）。
               *
               * ## ⚠️⚠️⚠️ 2026-10-17（t89）**补回高度上限**：`flex-1` 单独不够
               *
               * `flex-1` 只在**父级有确定高度**时才有意义（`xl` 及以上：右栏在
               * `h-full` 的高度链上）。`xl` 以下两栏塌成一列、父级高度是 `auto`，
               * 那时 `flex-1` 解析出来的就是**内容高度** ——
               * t74 用真实浏览器量到：`clientHeight === scrollHeight === 5559px`。
               *
               * 后果不只是"整页变长"：
               * ```
               *   箱体不可滚 ⇒ 哨兵永远落在 root 内 ⇒ 观察器一创建就回调
               *   ⇒ 用户还没滚动，打开页面就自动取下一页（实测 2 次请求）
               * ```
               * 这违反本文件写死的「只有操作者读到最下面时才会触发」。
               *
               * **根因可溯源**：这段上限原来就在这行 className 里
               * （`c750fd3`：`… overflow-y-auto p-2.5 max-h-[calc(100dvh-16rem)] xl:max-h-none`），
               * `9ad1503` 把它删掉了（那次提交的目标是"团队工作流区改为占满主导高度"），
               * 而**组件顶部第 84 行的注释一直宣称它还在** —— 注释与代码分叉了两个月，
               * 于是没人发现。现在两者重新对齐（见顶部注释的补充）。
               *
               * ⚠️ `xl:max-h-none` 不能省：`xl` 以上要**把上限交还**给
               * `h-full` 那条 flex 高度链，否则 `calc(100dvh-16rem)` 会盖掉正确的高度，
               * 面板在矮视口上会比它该有的更矮。
               */
              'max-h-[max(260px,calc(100dvh-16rem))] flex-1 xl:max-h-none',
            )}
          >
          {/*
            非团队模式的在途周期条。
            团队模式**不再**渲染它 —— 那一轮的状态已经由上面的固定工作流区
            按岗位摊开了，再插一条线性步骤列表就是同一个事实说两遍
            （用户对重复信息的容忍度很低，见 `LiveCycleBlock` 里那段注释）。
          */}
          {showLive && effectiveLiveCycle && mode !== 'ai_team' && (
            <LiveCycleBlock key={effectiveLiveCycle.cycleNumber} live={effectiveLiveCycle} />
          )}

          {records.length === 0 && !showLive && feedError === null ? (
            <Empty
              message="暂无决策记录。"
              hint="每个周期都会连同完整提示词与原始响应一起持久化 — 运行一次后这里就会填满。"
            />
          ) : (
            <>
          {/*
            ══════════════════════════════════════════════════════════════════
             **组织架构** —— ⚠️ 团队模式下**已删除**（2026-10-12 重做）
            ══════════════════════════════════════════════════════════════════

            原来这里挂着一个 `FirmRoster`（20 个岗位按部门展开，默认收起）。

            现在它**合并进上面的固定工作流区**了 —— `TeamBoard` 的编制表已经
            把同一批岗位按部门摊开，并且**每个岗位都带实时状态**
            （进行中 / 已完成 / 失败 / 在岗未参与 / 规划中）。

            保留两份的后果是用户已经抱怨过的那种：
            > 「**为什么还原封不动保留**了…（这模式不是团队了吗？…）」
            同一个事实在屏幕上出现两次，操作员就要花时间判断"这两处说的是一回事吗"。
            而 `FirmRoster` 那份**没有实时状态**，它只会让"谁在干活"更难看清。

            ⚠️ 另两种模式本来就不渲染它（`mode === 'ai_team'` 才渲染），
            所以删掉这段对 `strategy` / `ai_managed` **没有任何影响**。
          */}

          {runs.map((run) => (
            <div key={run.record.id}>
              {/*
                ⚠️ **每一轮单独包错误边界**（本轮实测踩到）。

                一条字段不全的记录会让**整个页面白屏**（浏览器实测：
                `Cannot read properties of undefined (reading 'length')` → BODY 为空）。
                而决策记录是从模型输出解析来的，字段缺失/类型不对是**常态** ——
                模型不总是听话。

                包在"每一轮"而不是"整页"：这样一条坏记录只影响它自己那一块，
                其余决策与页面照常可用。
              */}
              <FeedErrorBoundary>
                {/*
                  ⚠️ **团队模式用另一套决策块**（2026-10-12 重做）。

                  差别不只是排版，而是"一轮的答案是什么"：
                  · `CycleBlock`（前两种模式）—— 一轮的元数据行是
                    `in/out token │ 缓存 │ 思考占比 │ 耗时`，点开看**一个模型的**
                    思考过程与提示词；
                  · `TeamCycleBlock`（团队模式）—— 元数据行是
                    `时刻 │ 周期 │ **结论**`（六个成本数字进悬停说明，一个都没丢），
                    点开看**风控官结论 → 各角色产出 → 原始材料**。

                  另两种模式**逐字节不变**（`mode === 'ai_team'` 才走新分支）。
                */}
                {mode === 'ai_team' ? (
                  <TeamCycleBlock record={run.record} symbols={symbolsQuery.data ?? []} />
                ) : (
                  <CycleBlock
                    record={run.record}
                    symbols={symbolsQuery.data ?? []}
                    mode={mode}
                    pricing={tokenPricing}
                    onSelectSymbol={onSelectSymbol}
                  />
                )}
                {run.repeats.length > 0 && <RepeatedCycles repeats={run.repeats} />}
              </FeedErrorBoundary>
            </div>
          ))}

          {/*
            哨兵：它进入滚动容器的视口（`rootMargin` 提前约一屏）就取下一页。
            放在列表**最后**，所以只有操作者读到最下面时才会触发 ——
            这正是"滚到最后一条以后才加载后面 20 条"。
            `h-px` 而不是 `h-0`：零高度的元素在部分浏览器里会被当成"没有盒子"、
            永远不产生交叉，给它 1px 就没有这个歧义（视觉上仍然看不见）。
          */}
          <div ref={sentinelRef} aria-hidden className="h-px w-full" />

          {moreState === 'loading' && (
            <p
              role="status"
              className="flex items-center justify-center gap-1.5 pt-1 text-xs text-ink-faint"
            >
              <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
              正在加载更早的周期…
            </p>
          )}

          {/*
            失败必须看得见、并且能重试：静默停下会让操作者以为"历史只有这么多"，
            而事实是刚才那次请求没成功。这里**不自动重试**（见上面观察器的注释），
            所以这个按钮是唯一的出口。
          */}
          {moreState === 'error' && (
            <p role="alert" className="pt-1 text-center text-xs text-down">
              加载更早的周期失败{moreError ? `：${moreError}` : ''}
              <button
                type="button"
                onClick={() => void loadMore()}
                className="ml-1 text-accent hover:underline"
              >
                重试
              </button>
            </p>
          )}

          {/*
            终点：明确说"没有了"，而不是留一个看起来还会加载的空当。

            这里原来是"只显示最近 50 个周期，共 M 个"那一段 —— 它**永远不可能**渲染
            （`shown` 就是 `records` 的同一个切片，`records.length > shown.length` 恒为假）。
            现在列表里就是"已经加载的全部"，所以这一行要说的是"到头了"。
          */}
          {records.length > 0 && !hasMore && (
            <p className="pt-1 text-center text-xs text-ink-faint">已到最早一轮</p>
          )}
            </>
          )}
          </div>
          )}
      </>
      <DecisionArchiveModal
        traderId={traderId}
        open={archiveOpen}
        pricing={tokenPricing}
        onClose={() => setArchiveOpen(false)}
      />
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/*  连续相同轮次的压缩                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 一轮的**内容签名** —— 只由"发生了什么"决定，**不含周期号与时间**。
 *
 * 返回 `null` 表示这一轮不参与合并。
 */
export function cycleSignature(record: DecisionRecord): string | null {
  // 失败的轮次永远单独显示：要读的是那一次具体的错误，不是"又失败了一次"。
  if (record.error !== null) return null;

  /*
   * ⚠️ **两个数组都要兜底**（2026-10-12 实测抓到的真 BUG）。
   *
   * 原来只有 `executionLog` 有 `?? []`，而 `decisions` 直接读 —— 于是
   * 一条**缺 `decisions` 的历史记录**会让这里抛
   * `Cannot read properties of undefined (reading 'length')`，
   * 而这发生在**渲染路径**上：`FeedErrorBoundary` 于是把**整块决策看板**
   * 换成一张错误卡（实测现象就是"最近决策"里出现"这一块渲染失败"，
   * 团队看板完全不显示）。
   *
   * 为什么历史记录会缺字段：决策记录是**跨版本累积**的，
   * 早先的写入路径/测试数据未必带全字段（实测本地库里就有一条
   * `[{"symbol":"BTCUSDT","action":"open_long"}]` —— 缺 `confidence`）。
   * **看板必须容忍旧数据**，否则一次版本升级就会让历史全部打不开。
   */
  const log = record.executionLog ?? [];
  const decisions = record.decisions ?? [];
  // 完全空白的一轮也不合并 —— 它本身信息就少，再折起来等于让它消失。
  if (decisions.length === 0 && log.length === 0) return null;

  return JSON.stringify([
    decisions.map((decision) => [decision.action, decision.symbol, decision.confidence]),
    log.map((entry) => [entry.status, entry.action, entry.symbol, entry.detail]),
  ]);
}

interface CycleRun {
  record: DecisionRecord;
  /** 紧随其后、内容**完全**相同的轮次（不含 `record` 自己），最近的在前。 */
  repeats: DecisionRecord[];
}

/**
 * 把列表里**连续且内容完全相同**的轮次压成一段。
 *
 * ## 为什么需要它
 *
 * 熔断、冷却、安全模式这类**持续状态**每一轮都会写一条决策记录，而记录的内容
 * 一字不差。实测 AI 托管机器人 #8 的右栏连着 5 条都是同一句
 * 「总回撤熔断…本轮没有向模型提问，也没有下单」—— 操作者翻多少屏都是同一句话，
 * **真正有信息量的那一轮反而被淹掉**。这是评估报告里标为"最影响可用性"的一条，
 * 而它对 AI 托管模式尤其要紧：那一栏正是操作员看"它在想什么"的唯一窗口。
 *
 * ## 为什么折叠是安全的
 *
 * 判据是**内容签名完全相同**，不是"看起来差不多"：被折起来的轮次没有携带
 * 任何这一条没有的信息。周期号范围仍然显示出来，因为"从第几轮开始变成这样"
 * 本身就是信息。
 *
 * ## 为什么不合并到数据层
 *
 * `decision_records` 是**审计记录**：每一轮都必须落库，那是可复现的凭证链
 * （`AGENTS.md` §2）。压缩只发生在**展示**这一层 —— 数据一条都不能少。
 */
function groupCycles(records: DecisionRecord[]): CycleRun[] {
  const runs: Array<CycleRun & { signature: string | null }> = [];
  for (const record of records) {
    const signature = cycleSignature(record);
    const last = runs[runs.length - 1];
    if (last && signature !== null && last.signature === signature) {
      last.repeats.push(record);
      continue;
    }
    runs.push({ record, signature, repeats: [] });
  }
  return runs;
}

/**
 * 「同样的内容还有 N 轮」。
 *
 * 缩进一格、灰字、一行 —— 它是**注解**而不是内容，不该和决策本身抢注意力。
 */
function RepeatedCycles({ repeats }: { repeats: DecisionRecord[] }) {
  const numbers = repeats.map((row) => row.cycleNumber);
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  const range = low === high ? `#${low}` : `#${low}–#${high}`;
  return (
    <p className="pl-2 pt-1 text-xs text-ink-faint">
      ⤷ 同样的内容还有 {repeats.length} 轮（周期 {range}）
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/*  One cycle module                                                           */
/* -------------------------------------------------------------------------- */

function priceOf(symbols: MarketSymbol[], symbol: string): number | null {
  const row = symbols.find((item) => item.symbol === symbol);
  return row ? row.price : null;
}

/**
 * 一轮周期：**一行纯文字元数据 + 一个盒子 + 两个纯文字按钮**。
 *
 * 盒子里按顺序排这一轮的每一条决策（扁平行，不再给每条决策套卡片），
 * **每条决策都带着它自己的执行结果**（见 `DecisionOutcome`）—— 被风控拒绝、
 * 执行失败、运行时跳过、已执行，四种状态全部落在决策那一行上，一条都不会消失
 * （`DECISION-FEED.md` §7：拒绝与失败必须仍然可见，并说明原因）。
 *
 * `export` 只是为了 SSR 验证脚本能够直接渲染它（`scripts/ssr-decision-feed.tsx`）。
 * 它在页面里的唯一调用点是下面的 `DecisionFeed`。
 */
export function CycleBlock({
  record,
  symbols,
  mode = 'strategy',
  pricing = null,
  onSelectSymbol,
}: {
  record: DecisionRecord;
  symbols: MarketSymbol[];
  mode?: TraderMode;
  pricing?: TokenPricingPerMillion | null;
  onSelectSymbol?: (symbol: string) => void;
}) {
  /*
   * ⚠️ **这两个字段要在这里兜一次底，不能假设它们一定存在。**
   *
   * 数据有两个来源，形状**不一样**：
   *
   *   · **库里的记录**（`GET /traders/:id/decisions`）—— `decisions` 与
   *     `executionLog` 一定存在（服务端把 `NULL` 归一成了 `[]`）；
   *   · **WebSocket 实时推送**的周期 —— 它由服务端在周期进行中逐段发出，
   *     尚未落库，所以这两个字段都可能**还没有**。
   *
   * 实测（示例数据 + `/traders/:id`）：`undefined` 在这里抛
   * `Cannot read properties of undefined`，而它抛在**渲染期** ——
   * 整页白屏（`#root` 变空），连外壳都不剩，三套模板全部复现。
   */
  const decisions = record.decisions ?? [];
  const executionLog = record.executionLog ?? [];

  /*
   * 把执行日志按 `action` + `symbol` 配到各自的决策上。
   *
   * 为什么不是 `filter(status === 'skipped')` 那种写法：那样的结果是"结果"与"决策"
   * 分居盒子上下两处，操作者要把上面的提案和下面的小字自己对起来 ——
   * 而熔断真正拦下的是**那一条**提案，答案必须写在那一条旁边。
   */
  const plan = planExecution(executionLog, decisions);
  const skipped = plan.counts.skipped;
  const rejected = plan.counts.rejected;
  const failed = plan.counts.failed;

  /*
   * ── `skip` 折叠 ────────────────────────────────────────────────────────
   *
   * 提示词现在要求模型对**每一个候选标的**都留一条决策（不做的用 `skip`，带
   * `setup_score`，见 `decision.ts` 里那段）—— 那是为了让它能校准自己的入场门槛。
   * 但一轮有二十个候选，**决策流于是被十几条"跳过"刷满**，真正该看的那一两条
   * 被挤到看不见的地方。用户的原话：「显示太多币种（把那些置信度低的或者你看看
   * 用什么做参考把不重要的隐藏了，只保留重要的）」。
   *
   * 所以：**有动作的照旧逐张显示；`skip` 收进一个可展开的折叠块**。
   * 信息一条没丢（展开就在，而且每条的评分与理由都在），首屏只剩需要看的东西。
   *
   * ⚠️ **必须带着原下标一起过滤。** `plan.outcomes` 是**按 `record.decisions`
   * 的下标对齐**的（见 `planExecution` 的说明），过滤之后下标会错位 ——
   * 那样"这张卡片的结果"就会挂到别的决策上去。折叠块里那批也一样要带。
   */
  const visible = decisions
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => decision.action !== 'skip');

  /*
   * ## 同一标的出现多条时，标出"第几条 / 共几条"
   *
   * 用户 2026-10-03 的反馈（附截图）：「ETHUSDT 为什么一周期出现 2 次？」
   *
   * 核实：**那两条都是模型的真实输出** —— 一轮里它对 ETHUSDT 给了两条 `hold`
   * （一条讲"止损离现价太近"、一条讲"持仓名额已满"）。渲染层如实显示了两条，
   * 那是审计该有的行为，**不该被去重掉**：隐藏它等于替模型改写记录。
   *
   * 但"同一个币突然出现两行"确实让人以为界面出了 bug。所以补一个**计数标注** ——
   * 一行解释成本，换来"这是模型给了两条，不是界面重复"。
   */
  const totalBySymbol = new Map<string, number>();
  for (const { decision } of visible) {
    totalBySymbol.set(decision.symbol, (totalBySymbol.get(decision.symbol) ?? 0) + 1);
  }
  const seenOrder = new Map<string, number>();
  const visibleRows = visible.map(({ decision, index }) => {
    const nth = (seenOrder.get(decision.symbol) ?? 0) + 1;
    seenOrder.set(decision.symbol, nth);
    return { decision, index, nth, total: totalBySymbol.get(decision.symbol) ?? 1 };
  });

  const skippedRows = decisions
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => decision.action === 'skip');
  /** 被跳过的那批里分最高的一个 —— 折叠标题上给一个可比较的数，省得非展开不可。 */
  const topSkippedScore = skippedRows.reduce<number | null>(
    (best, { decision }) =>
      typeof decision.setupScore === 'number' && (best === null || decision.setupScore > best)
        ? decision.setupScore
        : best,
    null,
  );

  return (
    /*
     * `data-record-id` 是**给滚动锚点用的 DOM 标记**（见 `DecisionFeed` 里那个
     * `useLayoutEffect`）：新周期插到顶部时，要靠它认出"上一次的第一条"这一个元素、
     * 量出它被推下去多少像素，才能把 `scrollTop` 补偿回去。它不是样式钩子，
     * 不要用它写 CSS。
     */
    <article className="min-w-0" data-record-id={record.id}>
      <CycleMeta record={record} pricing={pricing} />

      {/*
        ══════════════════════════════════════════════════════════════════════
         ⚠️ **团队模式不再走 `CycleBlock`**（2026-10-12 重做）
         ══════════════════════════════════════════════════════════════════════

         `DecisionFeed` 里那个分支是
         `mode === 'ai_team' ? <TeamCycleBlock/> : <CycleBlock/>` ——
         所以团队模式下下面那对「思考过程 · 提示词」按钮**不会被渲染**。

         它的职责没有丢，被 `TeamCycleBlock` + `TeamDecisionRow` 接过去了，
         而且**换了位置**：
         · `<team>` 块的各角色产出 → 团队决策行展开后的「各角色产出」
           （带中文角色名与模型名，比这里原来显示 role id 更可读）；
         · 多空辩论 → 同上（多头/空头/裁决就是三个角色）；
         · 思考过程 / 提示词 → 团队决策行展开后的「原始材料」，
           而且要**再点一次**才取（懒加载）—— 它们是排查用的原料，不是主视图。

         留在 `CycleBlock` 里是因为**另两种模式仍然用它**，
         删掉会破坏 `strategy` / `ai_managed` 的现有界面（用户要求旧模式完全不变）。
      */}

      {/*
        决策盒子：**一轮只有这一个**边框。每条决策只是里面的一段，没有自己的边框。

        ⚠️ 底色必须是 `bg-base-850` 而不是 `bg-base-900`。
        面板（Panel）本身就是 `bg-base-900` —— 盒子用同色等于**没有边界**，
        几十轮决策连成一片，分不清哪一条属于哪一轮（操作者原话：
        "肉眼看不出来每一期决策"）。

        `base-850` 比面板抬升一层，盒子就浮出来了；配合边框，
        一眼能看出"这一轮到这里结束"。
      */}
      <div className="min-w-0 rounded-xl border border-base-700/90 bg-base-850/95 px-3.5 py-3 transition-colors hover:border-base-600/80">
        {record.error && (
          <p
            className={`mb-2 flex items-start gap-1.5 rounded-lg px-2.5 py-2 text-xs leading-relaxed ${
              record.error.startsWith('本轮被中断')
                ? 'bg-base-900/60 text-ink-faint'
                : 'border border-down/25 bg-down/10 text-down'
            }`}
          >
            {record.error.startsWith('本轮被中断') ? (
              <span aria-hidden className="mt-0.5 shrink-0">⏸</span>
            ) : (
              <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span className="min-w-0 break-words">{record.error}</span>
          </p>
        )}

        {record.error === null && decisions.length === 0 && executionLog.length === 0 && (
          <p className="text-xs text-ink-faint">本周期模型没有给出任何决策。</p>
        )}

        {decisions.length > 0 && (
          <div className="divide-y divide-base-750/80">
            {visibleRows.map(({ decision, index, nth, total }) => {
              const rowOutcome = plan.outcomes[index] ?? null;
              return (
                <div key={`${decision.symbol}-${index}`} className="py-2.5 first:pt-0 last:pb-0">
                  <DecisionRow
                    decision={decision}
                    price={priceOf(symbols, decision.symbol)}
                    outcome={rowOutcome}
                    figureContext={resolveFigureContext(record.userPrompt, decision.symbol, rowOutcome)}
                    duplicate={{ nth, total }}
                    onSelectSymbol={onSelectSymbol}
                  />
                </div>
              );
            })}
            {skippedRows.length > 0 && (
              <div className="pt-2.5 first:pt-0">
                <details className="group rounded-lg border border-base-750/90 bg-base-900/55 px-2.5 py-2 transition-colors hover:border-base-600/70">
                  <summary className="flex cursor-pointer list-none select-none flex-wrap items-center gap-1.5 text-xs text-ink-lo [&::-webkit-details-marker]:hidden">
                    <ChevronRight
                      aria-hidden
                      className="h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-150 group-open:rotate-90"
                    />
                    <span className="shrink-0 font-medium text-ink-mid">
                      跳过 {skippedRows.length} 个标的
                    </span>
                    {topSkippedScore !== null && (
                      <span className="num shrink-0 rounded bg-base-800 px-1.5 py-0.5 text-[11px] text-ink-lo">
                        最高 {topSkippedScore} 分
                      </span>
                    )}
                    <span className="flex flex-wrap items-center gap-1">
                      {skippedRows.slice(0, 8).map(({ decision }, i) => (
                        <span
                          key={`${decision.symbol}-${i}`}
                          className="rounded bg-base-800/90 px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink-mid"
                        >
                          {decision.symbol}
                        </span>
                      ))}
                      {skippedRows.length > 8 && (
                        <span className="text-[11px] text-ink-faint">
                          +{skippedRows.length - 8}
                        </span>
                      )}
                    </span>
                    <span className="ml-auto hidden text-[11px] text-ink-faint group-open:hidden sm:inline">
                      展开理由
                    </span>
                    <span className="ml-auto hidden text-[11px] text-ink-faint sm:group-open:inline">
                      收起理由
                    </span>
                  </summary>
                  <div className="mt-2.5 divide-y divide-base-750/70 border-t border-base-750/70 pt-2.5">
                    {skippedRows.map(({ decision, index }) => {
                      const rowOutcome = plan.outcomes[index] ?? null;
                      return (
                        <div key={`skip-${decision.symbol}-${index}`} className="py-2 first:pt-0 last:pb-0">
                          <DecisionRow
                            decision={decision}
                            price={priceOf(symbols, decision.symbol)}
                            outcome={rowOutcome}
                            figureContext={resolveFigureContext(record.userPrompt, decision.symbol, rowOutcome)}
                            onSelectSymbol={onSelectSymbol}
                          />
                        </div>
                      );
                    })}
                  </div>
                </details>
              </div>
            )}
          </div>
        )}

        {(() => {
          const visibleLeftover = plan.leftover.filter(
            (entry) => !isManagedTrajectoryEntry(entry) || resolveManagedStageChips(entry).length > 0,
          );
          if (visibleLeftover.length === 0) return null;
          return (
            <ul className="mt-2.5 space-y-1.5 border-t border-base-750/80 pt-2">
              {visibleLeftover.map((entry, index) => (
                <LogLine key={`leftover-${index}`} entry={entry} onSelectSymbol={onSelectSymbol} />
              ))}
            </ul>
          );
        })()}
      </div>

      {/*
        ⚠️ **团队模式不显示这两个按钮**（用户 2026-10-12 的反馈）。

        用户的原话：
        > 「为什么还原封不动保留了**思考过程、提示词查看功能**（这模式不是团队了吗？
        >  这个就很莫名其妙，如之前我所说应该是**上面固定展示各智能体工作状态和摘要**，
        >  用户**有需要可以手动点击打开查看详情**）」

        **他说得对**：团队模式该看的是"谁在干什么、结论是什么"，
        而"某个模型这一轮的思维链"是**排查用的原料**，不是主视图。

        它并没有丢 —— 团队的 `<team>` 审计块里**每个角色都有自己的产出**
        （见 `TeamTraceBlock`），那才是团队模式下"打开详情"该看到的东西。
        融合两种模式的原料视图会让主视图永远停在"怎么做出来的"而不是"做了什么"。
      */}
      {mode !== 'ai_team' && (
        <CycleDetails
          record={record}
          counts={{ failed, rejected, skipped }}
        />
      )}
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/*  执行日志 → 决策 的配对                                                      */
/* -------------------------------------------------------------------------- */

/** 一条执行日志配到哪条决策上（`null` = 这条决策在运行时没有任何记录）。 */
interface ExecutionPlan {
  /** 与 `decisions` **同下标**：第 i 条决策的结果，`null` 表示没有对应记录。 */
  outcomes: Array<ExecutionLogEntry | null>;
  /** 没有配上任何决策的日志条目（防御性兜底，正常为空）。 */
  leftover: ExecutionLogEntry[];
  counts: Record<ExecutionLogEntry['status'], number>;
}

/** 决策与执行日志的配对键。用 `\u0000`：币种符号与动作里都不可能含这个字符。 */
function pairKey(action: string, symbol: string): string {
  return `${action}\u0000${symbol}`;
}

/**
 * 把执行日志配到决策上。
 *
 * ## 为什么需要一个函数、而不是两个 `filter`
 *
 * 契约要求"每条决策都写出结果"，而 `executionLog` 是一个**扁平数组**：
 * 它既没有决策下标，也没有决策 id。唯一稳的对应关系是 `action` + `symbol`。
 *
 * ## 同一个币种出现多条决策时怎么办（这是最容易做错的地方）
 *
 * 用**队列**而不是查找：策略允许一轮里对同一个币种给出多条决策
 * （平多之后立刻开空是很常见的组合）。队列的规则是"**先提出的先配上**" ——
 * 这正是服务端的行为：`rejected` 按 `sortDecisions()` 的顺序推、执行按
 * `verdict.approved` 的顺序推，两者与 `record.decisions` 是同一个顺序。
 *
 * 队列只能一对一占用：同符号的两条决策**不可能**都拿到同一条日志
 * （那会让一条"被拒"同时写给两条决策，等于凭空多出一次拒绝）。
 *
 * 配不上的决策拿到 `null`（界面会明说"运行时没有留下执行记录"），
 * 配不上的日志进 `leftover`（界面照旧列出来，一条都不丢）。
 */
function planExecution(log: ExecutionLogEntry[], decisions: Decision[]): ExecutionPlan {
  /*
   * ⚠️ **两个参数都要防 `undefined`，不能只防一个。**
   *
   * 调用方在 826 行已经写了 `record.executionLog ?? []`，但那只保护了
   * **库里读出来的记录**。而 `DecisionFeed` 还有第二条数据来源：
   * **WebSocket 实时推送**的记录（`useEvents` 的 `byTrader[].decisions`）——
   * 它由服务端在周期进行中逐段发出，**形状与库里那条不同**（尚未落库，
   * 所以 `executionLog` / `decisions` 都可能还没填）。
   *
   * 实测（用示例数据打开 `/traders/:id`）：这里读到 `undefined` 就抛
   * `Cannot read properties of undefined (reading 'length')`，而它在
   * **渲染期**抛出 —— 整页白屏（`<div id="root">` 变空），连外壳都不剩。
   * 三套模板**全都**复现，所以它不是某个模板的问题。
   *
   * 修在这里而不是调用处：`planExecution` 是一个纯函数，它的契约就该是
   * "给什么都能算出结果"，而不是"调用方必须保证参数完整" ——
   * 后者每加一条数据来源就要重新检查一遍。
   */
  const safeLog = log ?? [];
  const safeDecisions = decisions ?? [];

  /** 每个配对键下**还没被认领**的日志下标，按出现顺序排队。 */
  const queue = new Map<string, number[]>();
  for (let index = 0; index < safeLog.length; index += 1) {
    const entry = safeLog[index];
    if (!entry) continue;
    const key = pairKey(entry.action, entry.symbol);
    const bucket = queue.get(key);
    if (bucket) bucket.push(index);
    else queue.set(key, [index]);
  }

  const outcomes: Array<ExecutionLogEntry | null> = [];
  const claimed = new Set<number>();
  for (const decision of safeDecisions) {
    const bucket = queue.get(pairKey(decision.action, decision.symbol));
    // 每认领一条就把它从队列头移走：同一个币种的第二条决策因此拿到**下一条**日志。
    const index = bucket?.shift();
    if (index === undefined) {
      outcomes.push(null);
      continue;
    }
    claimed.add(index);
    outcomes.push(safeLog[index] ?? null);
  }

  const counts: Record<ExecutionLogEntry['status'], number> = {
    ok: 0,
    submitted: 0,
    rejected: 0,
    failed: 0,
    skipped: 0,
    data: 0,
  };
  for (const entry of safeLog) counts[entry.status] += 1;

  return {
    outcomes,
    leftover: safeLog.filter((_, index) => !claimed.has(index)),
    counts,
  };
}

/**
 * 周期头：一行纯文字。
 *
 * 内容与顺序照参考：`相对时间 │ 周期 #N │ in N · out N`。
 * **没有**边框、底色、`成功` 徽章、`N 个候选`、`N 条决策` —— 那些都要读第二眼
 * 才明白在说什么，而这一行的作用是让操作者扫过去就知道"这是第几轮、多久以前"。
 *
 * 失败的周期在这一行末尾多一小段 `⚠ 失败 · <类别>`：`§2` 要求失败"能被看见"，但用
 * **一行小字**表达，不做徽章行 —— 参考产品那一行也是 `失败 · AI 决策` 这个样子。
 * 类别取自服务端写在错误文案第一个全角冒号之前的那一段（见 `failureCategory`）。
 *
 * 完整时间戳放在 `title` 里：相对时间适合扫读，但对账时需要精确时刻。
 */
function TokenBillingHeaderBadge({
  billing,
  open,
  onToggle,
}: {
  billing: TraderTokenBillingSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const totalTok = billing.promptTokens + billing.completionTokens;
  const label = billing.pricing?.free
    ? 'Token 免费'
    : billing.totalCostUsd !== null
      ? `累计 ${fmtTokenCostUsd(billing.totalCostUsd, { approx: true })}`
      : `累计 ${fmtCompactTokens(totalTok)}`;

  const cycleNote =
    billing.meteredCycles === billing.totalCycles
      ? `共 ${billing.totalCycles} 轮 · 点击${open ? '收起' : '展开'}明细条`
      : `共 ${billing.totalCycles} 轮 / ${billing.meteredCycles} 轮已计费 · 点击${open ? '收起' : '展开'}明细条`;

  const tooltipLines = [
    billing.pricing?.free
      ? `累计 Token 估算费用：免费（${cycleNote}）`
      : billing.totalCostUsd !== null
        ? `累计 Token 估算费用：${fmtTokenCostUsd(billing.totalCostUsd)}（${cycleNote}）`
        : `累计 Token 用量：${fmtCompactTokens(totalTok)}（${cycleNote}）`,
    billing.totalCostUsd !== null
      ? `· 今日估算：${fmtTokenCostUsd(billing.todayCostUsd)}（${billing.todayCycles} 轮）`
      : '· 单价状态：当前模型暂无公开单价',
    `· 累计输入：${fmtCompactTokens(billing.promptTokens)}（缓存 ${fmtCompactTokens(billing.cachedTokens)}）`,
    `· 累计输出：${fmtCompactTokens(billing.completionTokens)}${billing.reasoningTokens > 0 ? `（思考 ${fmtCompactTokens(billing.reasoningTokens)}）` : ''}`,
    ...(billing.savedByCacheUsd != null && billing.savedByCacheUsd > 0
      ? [`· 缓存已省：${fmtTokenCostUsd(billing.savedByCacheUsd, { approx: true })}`]
      : []),
  ];

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      data-aq-tip={tooltipLines.join('\n')}
      className={cn(
        'num inline-flex h-[22px] shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium leading-none transition',
        open
          ? "border-amber-400/60 bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/30 [[data-skin='light']_&]:border-amber-700/55 [[data-skin='light']_&]:bg-amber-500/20 [[data-skin='light']_&]:text-amber-950"
          : "border-amber-400/30 bg-amber-500/10 text-amber-300/95 hover:border-amber-400/55 hover:bg-amber-500/16 [[data-skin='light']_&]:border-amber-700/40 [[data-skin='light']_&]:bg-amber-500/15 [[data-skin='light']_&]:text-amber-900",
      )}
    >
      <Coins aria-hidden className="h-3 w-3 shrink-0 opacity-85" />
      <span>{label}</span>
      <ChevronDown
        aria-hidden
        className={cn('h-2.5 w-2.5 shrink-0 opacity-70 transition-transform', open && 'rotate-180')}
      />
    </button>
  );
}

function TokenBillingSummaryStrip({
  billing,
  onClose,
}: {
  billing: TraderTokenBillingSummary;
  onClose: () => void;
}) {
  const cacheRate =
    billing.promptTokens > 0 ? Math.round((billing.cachedTokens / billing.promptTokens) * 100) : null;
  const pricing = billing.pricing;

  return (
    <div className="shrink-0 border-b border-base-800 bg-base-900/75 px-3 py-2 text-[11.5px] leading-relaxed">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="num flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            <span className="text-ink-faint">累计({billing.totalCycles}轮) </span>
            <span className="font-semibold text-amber-300 [[data-skin='light']_&]:text-amber-800">
              {pricing?.free
                ? '$0.00 (免费)'
                : billing.totalCostUsd !== null
                  ? fmtTokenCostUsd(billing.totalCostUsd, { approx: true })
                  : '单价未知'}
            </span>
          </span>
          <span>
            <span className="text-ink-faint">今日({billing.todayCycles}轮) </span>
            <span className="font-medium text-ink-hi">
              {pricing?.free
                ? '$0.00'
                : billing.todayCostUsd !== null
                  ? fmtTokenCostUsd(billing.todayCostUsd, { approx: true })
                  : '—'}
            </span>
          </span>
          {billing.savedByCacheUsd != null && billing.savedByCacheUsd > 0 && (
            <span className="text-up">
              缓存已省 {fmtTokenCostUsd(billing.savedByCacheUsd, { approx: true })}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="收起 Token 计费统计"
          className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-ink-faint transition hover:bg-base-800 hover:text-ink-hi"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
      <div className="num mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-ink-lo">
        <span>
          入 <span className="text-ink-mid">{fmtCompactTokens(billing.promptTokens)}</span>
          {cacheRate !== null && (
            <span className="text-up">（缓存 {cacheRate}%）</span>
          )}
        </span>
        <span>
          出{' '}
          <span className="text-sky-300 [[data-skin='light']_&]:text-sky-700">
            {fmtCompactTokens(billing.completionTokens)}
          </span>
          {billing.reasoningTokens > 0 && (
            <span className="text-violet-300 [[data-skin='light']_&]:text-violet-700">
              （思考 {fmtCompactTokens(billing.reasoningTokens)}）
            </span>
          )}
        </span>
        {pricing ? (
          <span className="text-ink-faint">
            · 单价/1M：入 ${pricing.input} / 缓存 ${pricing.cacheRead} / 出 ${pricing.output}（{pricing.source}）
          </span>
        ) : (
          <span className="text-ink-faint">· 暂无 {billing.model || '当前模型'} 公开单价</span>
        )}
      </div>
    </div>
  );
}

function CycleMeta({
  record,
  pricing = null,
}: {
  record: DecisionRecord;
  pricing?: TokenPricingPerMillion | null;
}) {
  /*
   * token 数与耗时**各自独立**显示。
   *
   * 原来它们是「二选一」的兜底关系 —— 有 token 计数就不显示耗时。
   * 但这两个数字回答的是不同问题：
   *
   *   · token 数 = 这一轮**花了多少钱**
   *   · 耗时      = 这一轮**等了多久**
   *
   * 3 分钟周期下后者尤其重要：一次 15 秒的调用吃掉周期的 8%，
   * 连续几轮变慢意味着模型服务在恶化 —— 那是要提前发现的事。
   * 合并成"有 A 就不显示 B"，等于逼操作者在两个都关心的数字里挑一个。
   */
  const hasTokens = record.promptTokens !== null || record.completionTokens !== null;
  /*
   * **用量那一格要带上缓存命中率。**
   *
   * 「in N · out N」只说了"花了多少"，没说"花得值不值"。而这个项目
   * 实测缓存命中 99.6%、成本 93.5% 来自输出 —— 两个数字都不是从
   * token 总量能看出来的。
   *
   * 命中率**只在服务商报了 `cachedTokens` 时才显示**：
   * `null` 是"不知道"（这个供应商没上报），`0` 是"确实没命中"。
   * 把前者显示成 0% 会让人去查一个根本不存在的问题。
   */
  const cachePct =
    record.cachedTokens != null && record.promptTokens != null && record.promptTokens > 0
      ? Math.round((record.cachedTokens / record.promptTokens) * 100)
      : null;
  /*
   * 思考占比同理：输出价是缓存命中输入价的 200 倍，
   * 所以"这一轮 4,439 个输出里有多少是在想"直接决定这一轮值不值。
   */
  const thinkPct =
    record.reasoningTokens != null && record.completionTokens != null && record.completionTokens > 0
      ? Math.round((record.reasoningTokens / record.completionTokens) * 100)
      : null;

  const cycleCost =
    hasTokens && pricing
      ? calculateTokenCost(
          {
            promptTokens: record.promptTokens,
            completionTokens: record.completionTokens,
            cachedTokens: record.cachedTokens,
            reasoningTokens: record.reasoningTokens,
          },
          pricing,
        )
      : null;

  const latencyTone =
    record.aiLatencyMs > 75_000
      ? 'text-down bg-down/12'
      : record.aiLatencyMs > 45_000
        ? "text-orange-300 bg-orange-500/14 [[data-skin='light']_&]:text-orange-700 [[data-skin='light']_&]:bg-orange-500/12"
        : 'text-ink-hi bg-base-800/85';

  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-0.5 text-[11.5px] leading-none text-ink-lo">
      <span
        className="num inline-flex items-center rounded-md bg-accent/12 px-1.5 py-0.5 font-semibold text-accent"
        title={`第 ${record.cycleNumber} 轮决策周期`}
      >
        #{record.cycleNumber}
      </span>

      <span className="font-medium text-ink-mid" title={new Date(record.timestamp).toLocaleString()}>
        {timeAgo(record.timestamp)}
      </span>

      <span aria-hidden className="text-ink-faint/60">
        ·
      </span>

      {hasTokens ? (
        <span
          className="num inline-flex items-center gap-1 rounded-md bg-base-850/90 px-1.5 py-0.5 text-[11px]"
          title={`输入 ${fmtInt(record.promptTokens ?? 0)} tokens · 输出 ${fmtInt(record.completionTokens ?? 0)} tokens`}
        >
          <span className="text-ink-faint">in</span>
          <span className="font-medium text-ink-mid">{fmtInt(record.promptTokens ?? 0)}</span>
          <span className="text-ink-faint/60">/</span>
          <span className="text-ink-faint">out</span>
          <span className="font-medium text-sky-300 [[data-skin='light']_&]:text-sky-700">
            {fmtInt(record.completionTokens ?? 0)}
          </span>
        </span>
      ) : (
        <span className="text-[11px] text-ink-faint">用量未回传</span>
      )}

      {cachePct !== null && (
        <span
          className={cn(
            'num inline-flex cursor-help items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium',
            cachePct >= 50 ? 'bg-up/10 text-up' : 'bg-warn/12 text-warn',
          )}
          data-aq-tip={
            `输入里有 ${fmtInt(record.cachedTokens ?? 0)} 个 token 命中了上下文缓存` +
            `（占 ${cachePct}%）。\n` +
            '缓存命中的输入价比未命中便宜约 50 倍，所以这个数字直接决定输入成本。'
          }
        >
          缓存 {cachePct}%
        </span>
      )}

      {thinkPct !== null && (
        <span
          className="num inline-flex cursor-help items-center rounded-md bg-violet-500/12 px-1.5 py-0.5 text-[11px] font-medium text-violet-300 [[data-skin='light']_&]:bg-violet-500/10 [[data-skin='light']_&]:text-violet-700"
          data-aq-tip={
            `输出里有 ${fmtInt(record.reasoningTokens ?? 0)} 个 token 花在思考上` +
            `（占 ${thinkPct}%）。\n` +
            '输出价比缓存命中的输入价贵约 200 倍，所以这是本轮成本的主要部分。'
          }
        >
          思考 {thinkPct}%
        </span>
      )}

      {cycleCost && pricing && (
        <span
          className="num inline-flex cursor-help items-center rounded-md border border-amber-400/25 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-300 [[data-skin='light']_&]:border-amber-700/40 [[data-skin='light']_&]:bg-amber-500/15 [[data-skin='light']_&]:text-amber-900"
          data-aq-tip={formatCycleCostTooltip(cycleCost, pricing)}
        >
          {pricing.free ? '免费' : fmtTokenCostUsd(cycleCost.totalCostUsd, { approx: true })}
        </span>
      )}

      {record.aiTtftMs != null && record.aiTtftMs > 0 && (
        <span
          className={cn(
            'num inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium',
            record.aiTtftMs > 15_000
              ? 'bg-down/12 text-down'
              : "bg-cyan-500/10 text-cyan-300 [[data-skin='light']_&]:bg-cyan-500/10 [[data-skin='light']_&]:text-cyan-700",
          )}
          title={`LLM 首字延迟（TTFT）：${fmtLatency(record.aiTtftMs)}（若本周期内部有多轮调用，则取各轮首字延迟平均值）`}
        >
          首字 {fmtLatency(record.aiTtftMs)}
        </span>
      )}

      {(record.aiLatencyMs > 0 || record.success) && (
        <span
          className={cn(
            'num inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium',
            latencyTone,
          )}
          title={`本周期全部 LLM 调用累计耗时：${fmtLatency(record.aiLatencyMs)}（含多轮工具交互与执行回执追问）`}
        >
          {fmtLatency(record.aiLatencyMs)}
        </span>
      )}

      {!record.success && (
        record.error?.startsWith('本轮被中断') ? (
          <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-base-800 px-1.5 py-0.5 text-[11px] font-medium text-ink-faint">
            <span aria-hidden>⏸</span>
            <span className="min-w-0 truncate">已中断</span>
          </span>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-down/12 px-1.5 py-0.5 text-[11px] font-medium text-down">
            <TriangleAlert aria-hidden className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">失败{failureCategory(record.error)}</span>
          </span>
        )
      )}
    </div>
  );
}

/**
 * 失败类别：服务端把类别写在错误文案的**第一个全角冒号之前**，冒号之后是给操作员的
 * 具体说明（见 `packages/server/src/trader/autoTrader.ts` 的 `describeCycleFailure()`）。
 *
 * 元数据行只放类别，完整说明留在下面的盒子里 —— 这一行的作用是让人扫一眼就知道
 * "这一轮是哪种失败"，而不是把整段话挤进一行小字。
 *
 * 没有冒号、或者冒号前那一段长得不像类别（老记录、别的写入方）时只显示 `失败`：
 * 截一半的句子比不截更糟。
 */
function failureCategory(error: string | null): string {
  if (!error) return '';
  const head = error.split('：')[0]?.trim() ?? '';
  return head !== '' && head.length <= 12 && !head.includes('\n') ? ` · ${head}` : '';
}

/**
 * 一条决策 = 三行，左对齐在同一条缩进线上。
 *
 * 图标固定 `h-5 w-5`（20px），第二、三行用 `pl-5` 对齐到符号下方 —— 缩进宽度就是
 * 图标宽度，两处改动必须一起改，否则三行会错开。
 *
 * 行 1 用 `flex` 而不是 grid：符号与右侧动作徽章分别 `shrink-0`，中间没有需要
 * 分配的空间，`ml-auto` 就够了。徽章必须 `shrink-0` —— `chip` 自带 `whitespace`
 * 无关的 `font-mono`，一旦被压窄，`开多` 两个字会折成两行、把行高顶起来。
 *
 * 第四段（`outcome`）是**这一条决策的执行结果**：`null` 表示运行时一条记录都没留下。
 * 它由 `planExecution` 从 `executionLog` 里配出来，见上面的说明。
 */
function isClickableSymbol(symbol: string | null | undefined): boolean {
  const s = (symbol ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{2,24}$/.test(s) && s !== 'ALL' && s !== 'NONE';
}

/** 动作对应的左侧色条，用于一秒区分开仓 / 平仓 / 持有 / 等待 / 跳过。 */
function actionRailClass(action: Decision['action']): string {
  switch (action) {
    case 'open_long':
      return 'border-l-up/85';
    case 'open_short':
      return 'border-l-down/85';
    case 'close_long':
    case 'close_short':
      return 'border-l-warn/85';
    case 'hold':
      return 'border-l-sky-400/75';
    case 'wait':
      return 'border-l-violet-400/55';
    case 'skip':
      return 'border-l-base-600/60';
    default:
      return 'border-l-accent/70';
  }
}

/** 置信度微胶囊配色（深浅主题均可读）。 */
function confidenceChipClass(confidence: number): string {
  if (confidence >= 70) {
    return 'bg-up/12 text-up';
  }
  if (confidence >= 50) {
    return "bg-sky-500/12 text-sky-300 [[data-skin='light']_&]:bg-sky-500/10 [[data-skin='light']_&]:text-sky-700";
  }
  return 'bg-warn/12 text-warn';
}

/**
 * 轻量量化文本语义高亮：不改写模型原话，只把涨跌百分比（+X% / -X%）、AI500 评分、
 * ATR / 净RR / 量比等关键量化锚点柔和提亮，消除大段纯灰文字墙的阅读疲劳。
 */
const REASONING_HIGHLIGHT_RE =
  /([+-]\d+(?:\.\d+)?%|\b\d{2,3}\s*分(?!钟)|(?:\d+(?:\.\d+)?×ATR)|(?:ATR15m\s*\d+(?:\.\d+)?%)|(?:净?RR\s*[≈<>≤≥]=?\s*\d+(?:\.\d+)?(?::\d+(?:\.\d+)?)?)|(?:量比\s*(?:仅|约)?\s*\d+(?:\.\d+)?x))/g;

function FormattedReasoning({ text }: { text: string }) {
  const cleaned = plainText(text);
  const parts = cleaned.split(REASONING_HIGHLIGHT_RE);
  return (
    <p className="mt-1.5 min-w-0 break-words text-[12.5px] leading-[1.68] tracking-[0.005em] text-ink-mid">
      {parts.map((part, idx) => {
        if (!part) return null;
        if (/^\+\d+(?:\.\d+)?%$/.test(part)) {
          return (
            <span key={idx} className="num font-medium text-up">
              {part}
            </span>
          );
        }
        if (/^-\d+(?:\.\d+)?%$/.test(part)) {
          return (
            <span key={idx} className="num font-medium text-down">
              {part}
            </span>
          );
        }
        if (/^\d{2,3}\s*分$/.test(part)) {
          const score = Number.parseInt(part, 10);
          const tone =
            score >= 75
              ? 'bg-up/12 text-up'
              : score >= 65
                ? 'bg-warn/12 text-warn'
                : 'bg-base-800 text-ink-hi';
          return (
            <span
              key={idx}
              className={cn('num mx-0.5 inline-block rounded px-1 py-px text-[11.5px] font-semibold leading-tight', tone)}
            >
              {part}
            </span>
          );
        }
        if (
          /×ATR$/.test(part) ||
          /^ATR15m/.test(part) ||
          /^净?RR/.test(part) ||
          /^量比/.test(part)
        ) {
          return (
            <span key={idx} className="num font-medium text-ink-hi/95">
              {part}
            </span>
          );
        }
        return <span key={idx}>{part}</span>;
      })}
    </p>
  );
}

function DecisionRow({
  decision,
  price,
  outcome,
  figureContext,
  duplicate,
  onSelectSymbol,
}: {
  decision: Decision;
  price: number | null;
  outcome: ExecutionLogEntry | null;
  figureContext?: FigureContext | null;
  duplicate?: { nth: number; total: number };
  onSelectSymbol?: (symbol: string) => void;
}) {
  const figures = figureParts(decision, price, figureContext);
  const canSelect = Boolean(onSelectSymbol && isClickableSymbol(decision.symbol));

  return (
    <div className={cn('min-w-0 border-l-2 pl-2.5', actionRailClass(decision.action))}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {canSelect ? (
          <button
            type="button"
            onClick={() => onSelectSymbol!(decision.symbol.trim().toUpperCase())}
            title={`点击在左侧行情图表查看 ${decision.symbol}`}
            className="group -mx-1 inline-flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left transition hover:bg-base-800/80"
          >
            <CoinIcon symbol={decision.symbol} />
            <span className="min-w-0 truncate font-mono text-[14px] font-bold tracking-tight text-ink-hi underline-offset-2 transition-colors group-hover:text-accent group-hover:underline">
              {decision.symbol}
            </span>
          </button>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-2">
            <CoinIcon symbol={decision.symbol} />
            <span className="min-w-0 truncate font-mono text-[14px] font-bold tracking-tight text-ink-hi">
              {decision.symbol}
            </span>
          </span>
        )}

        {decision.confidence == null ? (
          <span
            className="shrink-0 text-[11px] text-ink-faint/80"
            title="模型这一条决策里没有给出 confidence 字段。"
          >
            置信度 未给出
          </span>
        ) : (
          <span
            className={cn(
              'num shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none',
              confidenceChipClass(decision.confidence),
            )}
            title={`模型对本条决策的置信度评估：${decision.confidence}%`}
          >
            置信度 {decision.confidence}%
          </span>
        )}

        {duplicate && duplicate.total > 1 && (
          <span
            className="shrink-0 rounded bg-base-800 px-1.5 py-0.5 text-[10px] text-ink-lo"
            title={
              `模型这一轮对 ${decision.symbol} 给了 ${duplicate.total} 条决策 —— ` +
              '下面这些是它的原话，没有被去重（去重等于替模型改写记录）。'
            }
          >
            第 {duplicate.nth}/{duplicate.total} 条
          </span>
        )}

        <ActionBadge action={decision.action} reasoning={decision.reasoning} className="ml-auto shrink-0" />
      </div>

      {decision.reasoning && <FormattedReasoning text={decision.reasoning} />}

      {figures.length > 0 && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs leading-relaxed text-ink-lo">
          {figures.map((part, index) => {
            const style = FIGURE_PILL_STYLE[part.key];
            return (
              <span
                key={`${part.label}-${part.value}-${index}`}
                className={cn(
                  'inline-flex items-baseline gap-1 rounded-md border px-1.5 py-0.5',
                  style.box,
                )}
                data-aq-tip={part.tooltip ?? FIGURE_TITLE[part.key]}
              >
                {part.label && <span className={cn('text-[11px]', style.label)}>{part.label}</span>}
                <span className={cn('num break-all text-[13px] font-semibold', style.value)}>
                  {part.value}
                </span>
                {part.sub && (
                  <span className={cn('num text-[11px] font-medium', style.label)}>
                    {part.sub}
                  </span>
                )}
              </span>
            );
          })}
        </p>
      )}

      {/* 这一条决策在运行时到底发生了什么（含风控干预与命中熔断的原因）。 */}
      <DecisionOutcome decision={decision} entry={outcome} />
    </div>
  );
}

/**
 * 一条决策的**执行结果**。
 *
 * ## 为什么它必须长在决策行上
 *
 * "为什么什么都没发生？"是操作者最常问的问题，而答案几乎总是这条决策被执行阶段
 * 拦住了 —— 熔断、冷却、安全模式、没有行情、没有持仓可平。这些原因以前一条都
 * 不显示（只过滤了 `rejected` / `failed`），于是屏幕上只剩一行像是在下单的提案。
 *
 * ## 四种状态刻意长得不一样
 *
 * - `ok`：安静的 `✓ 已执行` + 成交金额。**不需要抢注意力** —— 真正成交了，
 *   下面的持仓与成交表会说得更详细。
 * - `rejected`：`⚠ 被风控拒绝`，黄色。风控引擎在读模型之前的裁决。
 * - `failed`：`✕ 执行失败`，红色。**试过了**，订单/网络/交易所出了问题，
 *   这是要人去查的事故。
 * - `skipped`：`⊘ 未执行`，中性灰。**没有失败，是我们选择不动手** ——
 *   把它们染成红色会在一次正常的熔断上拉响一次假警报
 *   （`DESIGN.md`：状态不能只靠颜色表达，图标与文字同样要能区分）。
 *
 * ## 没有执行记录时也要说话
 *
 * "运行时没有留下执行记录"本身就是一条信息：它意味着这一条决策**没走到执行那一步**
 * （在解析、风控之前就被丢掉了，或者记录不完整）。留白会让操作者以为"大概是
 * 在排队执行" —— 而这恰恰是这次要修的那类误读。
 */
function DecisionOutcome({
  decision,
  entry,
}: {
  decision: Decision;
  entry: ExecutionLogEntry | null;
}) {
  /*
   * 风控对这条决策做过的每一次干预。
   *
   * 优先用**执行记录上**的那一份：`ok` 条目才带 `adjustments`
   * （见 `autoTrader.executeOpen`），它记的是策略真正采用的那组参数。
   * 记录上没有时退回决策自己带的那一份，这样任何一条现在能看见的干预
   * 都不会因为这次改动而消失。
   */
  const [expanded, setExpanded] = useState(false);
  /*
   * ⚠️ **回落到的那一份也要兜底**（两处独立修复合并后的版本）。
   *
   * 这一行的意图是"执行记录上那份优先，没有就用决策自己带的那份"。但两份
   * **都可能没有**：WebSocket 实时推送的决策与执行条目尚未落库，字段是缺的。
   *
   * ## 为什么这是真 BUG（不是"测试数据的问题"）
   *
   * 原来写的是 `entry?.adjustments?.length ? entry.adjustments : decision.adjustments`：
   * 前半段对 `entry` 用了可选链，**但兜底那一侧直接读 `decision.adjustments`** ——
   * 而 `decision` 缺这个字段时它就是 `undefined`。
   *
   * 下一个表达式（`notes.length`）于是抛
   * `Cannot read properties of undefined (reading 'length')`。
   *
   * 而决策记录**跨版本累积**，`adjustments` 是后来才加上的字段 ——
   * 本地库里实测就有 `[{"symbol":"BTCUSDT","action":"open_long"}]` 这种旧记录。
   * 崩溃发生在**渲染路径**：`FeedErrorBoundary` 会把**整块决策看板**
   * 换成一张错误卡（实测现象：团队看板完全不显示）。**一条旧记录足以让整个看板打不开。**
   *
   * ⚠️ `?.length ?` 这个写法本身是对的（它要区分"空数组"与"有内容"），
   * 缺的是最后那一层 `?? []`。
   */
  const notes = (entry?.adjustments?.length ? entry.adjustments : decision.adjustments) ?? [];

  if (!entry) {
    // 观望 / 跳过本身就不会进入下单执行阶段，无需在每张卡片底部刷屏重复一句废话；
    // 只有真正的可执行动作（开仓/平仓/加减仓/调保护/撤单/持仓）缺少执行记录时才显式提醒。
    if (decision.action === 'wait' || decision.action === 'skip') {
      return null;
    }
    return (
      <div className="mt-1.5 text-xs leading-relaxed text-ink-faint">
        运行时没有留下这条决策的执行记录 —— 它没有进入执行阶段。
      </div>
    );
  }

  const { key, label, tone } = outcomeBadge(entry.status);
  /*
   * 图标与文字一起区分四种状态（`DESIGN.md` §2：不能只靠颜色）。
   * `rejected` 与 `failed` 刻意用**不同**的图标：两者都是"没成交"，但一个是
   * 风控的裁决、一个是事故，混用同一个三角感叹号等于把这两件事又合并回去。
   */
  const Icon =
    key === 'ok' ? Check : key === 'rejected' ? TriangleAlert : key === 'failed' ? X : Ban;

  /*
   * 「第一句」与「其余」。
   *
   * 断句用中文句号与分号 —— 服务端写的这些句子本身就以此断句
   * （`单日亏损熔断：今日已实现亏损 $0.59，占权益 6.03%（上限 5%）。`）。
   * 一个断句符都找不到时整段都算第一句：短消息本来就不需要折叠。
   */
  /* ⚠️ `plainText`：理由里的 `**` 是写给模型/维护者的强调符，不该露给用户（见 `lib/plainText.ts`）。 */
  const detail = plainText(humanizeToolNames(entry.detail ?? ''));
  const cut = detail.search(/[。；]/);
  const lead = cut >= 0 ? detail.slice(0, cut + 1) : detail;
  const rest = cut >= 0 ? detail.slice(cut + 1).trim() : '';
  /*
   * 折叠开关**只看 `rest`**。
   *
   * `notes`（风控干预）不参与折叠 —— 原因见下面那段说明。
   */
  const hasMore = rest.length > 0;

  return (
    <div className="mt-1.5 min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Badge tone={tone} className="inline-flex shrink-0 items-center gap-1">
          <Icon aria-hidden className="h-3 w-3 shrink-0" />
          {label}
        </Badge>
        {entry.notionalUsd !== undefined && (
          <span className="num text-xs text-ink-lo" title="名义价值（USDT）">
            {fmtUsd(entry.notionalUsd, 2)}
          </span>
        )}
        {entry.orderId && (
          <span className="num text-xs text-ink-faint" title={`交易所委托号 ${entry.orderId}`}>
            委托 {entry.orderId}
          </span>
        )}
        {/*
          折叠开关只在**真的有后续内容**时出现 —— 每条决策都挂一个点开是空的
          "详情"比没有更让人困惑（同一个教训见 `CycleDetails` 里那两个死按钮）。
        */}
        {hasMore && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="shrink-0 rounded px-1 text-xs text-ink-lo transition hover:text-ink-hi"
            title={expanded ? '收起剩余说明' : '展开剩余说明'}
          >
            {expanded ? '收起' : '详情'}
          </button>
        )}
      </div>

      {/*
        原因 / 错误：**原样显示服务端写的那句话**（`entry.detail`）—— 但只显示**第一句**。
        改写它会把数字弄丢（数字才是重点），所以一个字都不动，只是把后半段折起来。

        ## 为什么要折

        实测熔断那条 `detail` 是一整段四行：

          总回撤熔断：权益较最高水位 $9.54 回撤了 21.00%（上限 20%）。注意：总回撤
          熔断不按日重置 —— 它要等权益回到最高水位以下 20% 以内才会解除，而空仓时
          权益不会自己变化，所以它不会自行恢复。要不要继续交易需要操作员决定
          （例如入金，或调整这一上限）。

        它**每一轮都出现**，而连续 32 轮的内容一字不差（`groupCycles` 折叠了重复的
        轮次，但单条内部这四行仍然照渲）。参考产品一条决策只占一行多一点 ——
        差别不在骨架（币种图标 + 符号 + 动作徽章 + 置信度 + 理由，我们与它一致），
        而在**我们额外挂了两段**：执行结果与风控注意事项。

        这两段**不能删**（`AGENTS.md` §2.7：界面不能对"发生了什么"说谎），
        但可以**默认收起**。分界线是「第一句」：它是"为什么"的答案
        （熔断、被拒、失败的**具体**原因），必须始终可见；其后的补充与建议按需展开。
      */}
      {lead && <p className="mt-0.5 break-words text-xs leading-relaxed text-ink-mid">{lead}</p>}

      {/*
        ⚠️ **风控干预始终可见，不跟着"详情"一起折。**

        折叠是为了少几行字，但这两类文字的性质不同：

        · `detail` 的**后半段**是补充说明与建议（"要不要继续交易需要操作员决定…"）——
          它可以在你需要时再展开；
        · `adjustments` 是**风控推翻模型的地方**（"杠杆已从 20x 压到上限 5x。"）。
          `AGENTS.md` §2.1 要求每一次运行时推翻都留下痕迹，那是这个产品可被信任的
          前提 —— **一眼扫过时它必须在场**。

        第一版把两类一起折了，`test:feed` 里那条「风控干预仍然显示」立刻失败。
        那是对的：**当一条检查说"屏幕上少了一句话"，先怀疑自己减少了什么。**
      */}
      {notes.length > 0 && (
        <ul className="mt-0.5 space-y-0.5">
          {notes.map((note, index) => (
            <li key={index} className="break-words text-xs leading-relaxed text-warn/90">
              • {note}
            </li>
          ))}
        </ul>
      )}

      {expanded && rest && (
        <p className="mt-0.5 break-words text-xs leading-relaxed text-ink-mid">{rest}</p>
      )}
    </div>
  );
}

/**
 * 执行状态 → 徽章。**四种状态都必须在这里有名字**。
 *
 * 这里的 `switch` 而不是一张 `Record` 表：`executionLog[].status` 是服务端与
 * `@aq/shared` 共有的四值联合，将来加第五种状态时，`switch` 的穷尽性检查
 * （`never` 那一支）会直接编译不过 —— 而一张表只会静默地少一个键，
 * 然后那个状态又会像 `skipped` 这次一样从界面上消失。
 *
 * 文案对得上 `DecisionAudit` 的 `STATUS_LABELS`（那三个字是状态码的中文名），
 * 但**语气是决策流自己的**：`skipped` 在这里叫"未执行"而不是"已跳过" ——
 * 操作者要判断的是"这一单有没有下出去"，而"跳过"听起来像一件已经发生过的事，
 * 于是被跳过的那一单看起来就像已经处理完了。
 */
function outcomeBadge(status: ExecutionLogEntry['status']): {
  key: ExecutionLogEntry['status'];
  label: string;
  tone: 'up' | 'warn' | 'down' | 'muted';
} {
  switch (status) {
    case 'ok':
      return { key: status, label: `✓ ${STATUS_LABELS.ok}`, tone: 'up' };
    /*
     * 已挂单、尚未成交（限价入场）。
     *
     * ⚠️ **不能显示成"已执行"** —— 这一轮**没有产生持仓**，而执行摘要里
     * "开仓 N" 数的是 `ok`。说"已执行"会让人去持仓列表找一个不存在的仓位。
     */
    case 'submitted':
      return { key: status, label: `⧗ ${STATUS_LABELS.submitted}（等成交）`, tone: 'muted' };
    case 'rejected':
      return { key: status, label: `⚠ 被风控拒绝`, tone: 'warn' };
    case 'failed':
      return { key: status, label: `✕ 执行失败`, tone: 'down' };
    case 'skipped':
      return { key: status, label: `⊘ 未执行（${STATUS_LABELS.skipped}）`, tone: 'muted' };
    /*
     * ⚠️ **模型主动要了数据 —— 这是"它在主动工作"最直接的可见证据。**
     *
     * 用户 2026-10-02：「我打开网页，就能方便快捷**看到模型在做什么**」。
     * 而在这之前，"它去要了 K 线"只活在实时事件流里，**翻历史一条都查不到** ——
     * 于是操作员无法分辨"这一轮它只是把系统给的候选看了一遍"与
     * "它自己动手去挖了数据"。
     */
    case 'data':
      return { key: status, label: `⇣ ${STATUS_LABELS.data}`, tone: 'muted' };
    default: {
      // 穷尽性检查：`status` 只能是上面六种。少写一种，这一行会编译报错。
      const exhaustive: never = status;
      return { key: exhaustive, label: status, tone: 'muted' };
    }
  }
}

/* `figureParts` / `FIGURE_TITLE` / `FIGURE_PILL_STYLE` 已抽出至 `../lib/decisionFigures.ts`（供决策流与单轮审计详情页共用）。 */

/**
 * 一条**没有配上决策**的执行记录，一行小字。
 *
 * 正常路径上这个组件不会被调用（见 `CycleBlock` 里 `plan.leftover` 的说明）：
 * 每一条执行记录现在都挂在它对应的决策行上，连同原因一起。这里保留它，
 * 是为了让"配不上决策的条目"仍然可见 —— 丢掉它们就等于又一次让界面
 * 对已经发生过的事情沉默。
 *
 * 四种状态全在这里有名字：`skipped` 以前会和 `failed` 一起被当成"执行失败"，
 * 那是两种完全不同的事件。
 */
function LogLine({
  entry,
  onSelectSymbol,
}: {
  entry: ExecutionLogEntry;
  onSelectSymbol?: (symbol: string) => void;
}) {
  const { label, tone } = logLineStyle(entry.status);
  const [expanded, setExpanded] = useState(false);

  /*
   * `skip_cycle` 是**整轮被跳过**的通知，不属于任何标的。
   *
   * 它没有真实的 action / symbol 可显示 —— 硬拼出来只会得到
   * `skip_cycle — — <说明>`：一个没登记标签的机器码、一个占位破折号，
   * 再加一个分隔符破折号。而 `detail` 已经把话说完（为什么跳过、什么时候恢复），
   * 所以这类条目直接给说明。见 `AGENTS.md` §5.2：机器码可以是英文，
   * **但面向操作员的文本必须走中文标签**，不能把机器码原样显示出来。
   */
  const isCycleNotice =
    entry.action === 'skip_cycle' ||
    (entry.status === 'data' && (!entry.symbol || entry.symbol === '-'));

  /*
   * ⚠️ **折叠规则与 `DecisionOutcome` 相同：第一句始终可见，其余收起。**
   *
   * 这里是**文字墙真正的来源**，不是 `DecisionOutcome`。整轮被跳过时
   * `decisions` 是空数组，于是这条记录配不到任何决策，落到 `plan.leftover`
   * 走这个组件；而它的 `detail` 实测有四行：
   *
   *   总回撤熔断：权益较最高水位 $9.54 回撤了 21.00%（上限 20%）。注意：总回撤熔断
   *   不按日重置 —— …（例如入金，或调整这一上限）。且当前没有任何持仓。本轮没有向
   *   模型提问、也没有下单 —— …跳过请求是为了不产生无谓的 token 开销。
   *
   * 而它**每一轮都出现**，连续几十轮一字不差。第一句就是操作者要的答案
   * （"这一轮为什么什么都没做"），后面全是补充说明与建议。
   *
   * 改这里之前先在那台跑着的控制台上看一眼右栏 —— 那次我改了 `DecisionOutcome`
   * 就以为完事了，而屏幕上的文字墙一行都没少。
   */
  /* ⚠️ `plainText`：理由里的 `**` 是写给模型/维护者的强调符，不该露给用户（见 `lib/plainText.ts`）。 */
  const detail = plainText(humanizeToolNames(entry.detail ?? ''));
  if (isManagedTrajectoryEntry(entry)) {
    const chips = resolveManagedStageChips(entry);
    if (chips.length === 0) return null;
    return (
      <li className="min-w-0">
        <ManagedStageActionBar chips={chips} onSelectSymbol={onSelectSymbol} />
      </li>
    );
  }

  const cut = detail.search(/[。；]/);
  const lead = cut >= 0 ? detail.slice(0, cut + 1) : detail;
  const rest = cut >= 0 ? detail.slice(cut + 1).trim() : '';

  return (
    <li className="min-w-0 text-xs leading-relaxed">
      <div className="flex min-w-0 items-start gap-1.5">
        <span className={cn('shrink-0', tone)}>{label}</span>
        <span className="min-w-0 break-words text-ink-lo">
          {!isCycleNotice && (
            <span className="num text-ink-mid">
              {actionLabel(entry.action)} {entry.symbol}
            </span>
          )}
          {lead ? `${isCycleNotice ? '' : ' — '}${lead}` : ''}
          {rest && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              title={expanded ? '收起剩余说明' : '展开剩余说明'}
              className="ml-1 shrink-0 text-ink-faint transition hover:text-ink-hi"
            >
              {expanded ? '收起' : '详情'}
            </button>
          )}
        </span>
      </div>
      {expanded && rest && (
        <p className="mt-0.5 min-w-0 break-words pl-1 text-ink-mid">{rest}</p>
      )}
    </li>
  );
}

/** `LogLine` 的标记与颜色。五种状态各自可辨，见 `outcomeBadge` 的同一条理由。 */
function logLineStyle(status: ExecutionLogEntry['status']): { label: string; tone: string } {
  switch (status) {
    case 'ok':
      return { label: `✓ ${STATUS_LABELS.ok}`, tone: 'text-up' };
    case 'submitted':
      return { label: `⧗ ${STATUS_LABELS.submitted}`, tone: 'text-ink-lo' };
    case 'rejected':
      return { label: `⚠ 被风控拒绝`, tone: 'text-warn' };
    case 'failed':
      return { label: `✕ 执行失败`, tone: 'text-down' };
    case 'skipped':
      return { label: `⊘ 未执行`, tone: 'text-ink-lo' };
    /* 模型主动取数 —— 它在主动工作，而不是只把系统给的候选看了一遍。 */
    case 'data':
      return { label: `⇣ ${STATUS_LABELS.data}`, tone: 'text-ink-lo' };
    default: {
      const exhaustive: never = status;
      return { label: exhaustive, tone: 'text-ink-lo' };
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  底部：两个纯文字按钮 + 展开内容                                             */
/* -------------------------------------------------------------------------- */

type DetailTab = 'cot' | 'prompt';

/**
 * 一轮的底部：`✨ 思考过程 │ 🔒 提示词` 两个**纯文字按钮**。
 *
 * 它们是文字 + 图标，不是带边框的按钮、也不是标签页控件（§4）。展开状态用
 * **勾选标记 + 强调色**表示 —— 参考里展开的那一项是绿的带 ✓。用颜色 + 符号双重
 * 表达而不是只用颜色：`DESIGN.md` §2 要求不能只靠颜色传递状态。
 *
 * 这两个按钮**只管推理内容**，上面的决策永远可见 —— 折叠了决策，面板就会在
 * 没人点的时候什么都不显示，而"它到底决定了什么"才是操作者一直要看的东西。
 */
/**
 * 兼容被 JSON 二次转义的字面量换行（`\r\n` / `\n` / `\t`），还原为真实换行，
 * 避免长思考过程里出现成串 `\n\n` 不换行。
 */
function unescapeReasoningText(text: string): string {
  if (!text) return '';
  if (!text.includes('\\n') && !text.includes('\\r') && !text.includes('\\t')) return text;
  return text.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '  ');
}

function CycleDetails({
  record,
  counts,
}: {
  record: DecisionRecord;
  counts: { failed: number; rejected: number; skipped: number };
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DetailTab>('cot');

  const cotTrace = unescapeReasoningText(record.cotTrace ?? '');
  const inlineSystem = record.systemPrompt ?? '';
  const inlineUser = record.userPrompt ?? '';
  const hasInlinePrompt = inlineSystem.trim() !== '' || inlineUser.trim() !== '';

  /*
   * 提示词懒加载提升到 `CycleDetails`：服务端列表接口为了避免单页数 MB 载荷会剥离
   * `systemPrompt` / `userPrompt`，因此一次 `traderDecision` 请求同时填充两段提示词，
   * 避免两个 `PromptSection` 各自发重复双请求。
   */
  const [loadedPrompt, setLoadedPrompt] = useState<{
    recordId: number;
    systemPrompt: string;
    userPrompt: string;
  } | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const fetchedForThis = loadedPrompt !== null && loadedPrompt.recordId === record.id;

  useEffect(() => {
    if (!open || tab !== 'prompt') return;
    if (hasInlinePrompt || fetchedForThis || record.id <= 0) return;
    let alive = true;
    const controller = new AbortController();
    setPromptLoading(true);
    api
      .traderDecision(record.traderId, record.id, controller.signal)
      .then((full) => {
        if (!alive) return;
        setLoadedPrompt({
          recordId: record.id,
          systemPrompt: full.systemPrompt ?? '',
          userPrompt: full.userPrompt ?? '',
        });
      })
      .catch(() => {
        if (!alive) return;
        setLoadedPrompt({ recordId: record.id, systemPrompt: '', userPrompt: '' });
      })
      .finally(() => {
        if (alive) setPromptLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [open, tab, hasInlinePrompt, fetchedForThis, record.traderId, record.id]);

  /**
   * 点一个按钮既切换内容也展开（§4）。
   *
   * 再点**同一个**按钮才收起 —— 两个按钮各管自己那一份内容，所以它们是"看什么"
   * 的切换，而不是一个全局的开/关。第一次点击必须能打开：只切不展，用户会以为
   * 按钮没反应。
   */
  const toggle = (next: DetailTab): void => {
    const collapse = open && tab === next;
    setTab(next);
    setOpen(!collapse);
  };

  const notes: string[] = [];
  if (counts.failed > 0) notes.push(`${counts.failed} 条执行失败`);
  if (counts.skipped > 0) notes.push(`${counts.skipped} 条未执行`);
  if (counts.rejected > 0) notes.push(`${counts.rejected} 条被风控拒绝`);

  /*
   * 列表响应已剥离提示词原文 —— 对已持久化记录（`record.id > 0`）允许点击展开懒加载，
   * 不再因列表里 `systemPrompt`/`userPrompt` 为空且无思考过程而把按钮整体隐藏。
   */
  const hasDetail = cotTrace.trim() !== '' || hasInlinePrompt || record.id > 0;
  if (!hasDetail && notes.length === 0) return null;

  const systemBody = hasInlinePrompt
    ? inlineSystem
    : fetchedForThis
      ? loadedPrompt.systemPrompt
      : promptLoading
        ? '正在加载提示词…'
        : '';
  const userBody = hasInlinePrompt
    ? inlineUser
    : fetchedForThis
      ? loadedPrompt.userPrompt
      : promptLoading
        ? '正在加载提示词…'
        : '';

  const tabClass = (active: boolean): string =>
    cn(
      'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11.5px] transition',
      active
        ? 'border-up/40 bg-up/10 font-semibold text-up'
        : "border-transparent text-ink-lo hover:border-base-700 hover:bg-base-850 hover:text-ink-hi [[data-skin='light']_&]:text-ink-mid [[data-skin='light']_&]:hover:text-ink-strong",
    );

  return (
    <div className="min-w-0">
      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-0.5">
        {hasDetail && (
          <>
            <button
              type="button"
              onClick={() => toggle('cot')}
              aria-expanded={open && tab === 'cot'}
              title={open && tab === 'cot' ? '收起思考过程' : '展开思考过程'}
              className={tabClass(open && tab === 'cot')}
            >
              <Sparkles
                aria-hidden
                className={cn(
                  'h-3 w-3 shrink-0',
                  open && tab === 'cot' ? 'text-up' : "text-violet-300/80 [[data-skin='light']_&]:text-violet-700",
                )}
              />
              思考过程
              {open && tab === 'cot' && <Check aria-hidden className="h-3 w-3 shrink-0" />}
            </button>

            <button
              type="button"
              onClick={() => toggle('prompt')}
              aria-expanded={open && tab === 'prompt'}
              title={open && tab === 'prompt' ? '收起提示词' : '展开提示词'}
              className={tabClass(open && tab === 'prompt')}
            >
              <Lock
                aria-hidden
                className={cn(
                  'h-3 w-3 shrink-0',
                  open && tab === 'prompt' ? 'text-up' : "text-sky-300/80 [[data-skin='light']_&]:text-sky-700",
                )}
              />
              提示词
              {open && tab === 'prompt' && <Check aria-hidden className="h-3 w-3 shrink-0" />}
            </button>
          </>
        )}

        {notes.length > 0 && (
          <span className="ml-auto flex items-center gap-1 rounded-md bg-warn/10 px-1.5 py-0.5 text-[11px] font-medium text-warn">
            <TriangleAlert aria-hidden className="h-3 w-3 shrink-0" />
            {notes.join(' · ')}
          </span>
        )}
      </div>

      {/* 展开的内容留在同一个盒子的语义范围内、按钮下方，并且**可滚动**（§5）。 */}
      {open && (
        <div className="mt-2 min-w-0">
          {tab === 'cot' ? (
            <ScrollArea
              body={cotTrace}
              empty="本周期模型未返回 <reasoning> 块。"
              onCollapse={() => setOpen(false)}
            />
          ) : (
            <div className="space-y-2">
              <PromptSection title="系统提示词" body={systemBody} defaultOpen={false} />
              <PromptSection title="用户提示词" body={userBody} defaultOpen={true} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PromptSection({
  title,
  body,
  defaultOpen = false,
}: {
  title: string;
  body: string;
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const charCount = (body ?? '').trim().length;
  const sizeHint =
    charCount >= 1000 ? `${(charCount / 1000).toFixed(1)}K 字` : charCount > 0 ? `${charCount} 字` : '空';

  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-base-750 bg-base-900/50">
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-semibold text-ink-mid transition hover:text-ink-hi"
        >
          {expanded ? (
            <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          ) : (
            <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          )}
          <span className="truncate">{title}</span>
          <span className="num shrink-0 text-[11px] font-normal text-ink-faint">({sizeHint})</span>
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded-md border border-base-700 bg-base-850 px-2 py-0.5 text-[11px] text-ink-lo transition hover:border-base-600 hover:text-ink-hi"
        >
          {expanded ? '收起' : '展开'}
        </button>
      </div>
      {expanded && (
        <div className="border-t border-base-750/80 p-2">
          <ScrollArea body={body} empty="（空）" onCollapse={() => setExpanded(false)} />
        </div>
      )}
    </section>
  );
}

/**
 * 可滚动的等宽文本块（附底部快捷收起按钮，避免鼠标滚轮陷进长篇文本难以下滚页面）。
 */
function ScrollArea({
  body,
  empty,
  onCollapse,
}: {
  body: string;
  empty: string;
  onCollapse?: () => void;
}) {
  const safe = body ?? '';
  if (!safe.trim()) return <p className="px-1 py-2 text-xs text-ink-faint">{empty}</p>;
  return (
    <div className="min-w-0">
      <pre className="max-h-60 min-w-0 overflow-auto overscroll-auto whitespace-pre-wrap break-words rounded-md border border-base-800 bg-base-950 px-2.5 py-2 font-mono text-xs leading-relaxed text-ink-mid">
        {safe}
      </pre>
      {onCollapse && (
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={onCollapse}
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-faint transition hover:bg-base-800 hover:text-ink-hi"
          >
            收起此段
          </button>
        </div>
      )}
    </div>
  );
}
