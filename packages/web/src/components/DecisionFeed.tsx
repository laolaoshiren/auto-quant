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
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import {
  Ban,
  Check,
  FileText,
  LoaderCircle,
  Lock,
  RotateCw,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import { exchangeErrorLabel, type DecisionRecord, type Decision, type ExecutionLogEntry } from '@aq/shared';
import { api, type MarketSymbol } from '../lib/api';
import { selectLiveCycle, useEvents, type LiveCycle } from '../lib/store';
import { usePolled } from '../lib/hooks';
import { Badge, Empty, Panel, Spinner3, cn } from './ui';
import { ActionBadge, STATUS_LABELS, actionLabel, isOpenAction } from './DecisionAudit';
import { fmtInt, fmtLatency, fmtPriceUsd, fmtUsd, timeAgo } from '../lib/format';

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
  const seen = new Set(prev.map((record) => record.id));
  const fresh = rows.filter((record) => !seen.has(record.id));
  return fresh.length > 0 ? [...prev, ...fresh] : prev;
}

/**
 * 币种图标的底色。
 *
 * 参考产品给每个币一个彩色圆点，而**这里不引入图标库**（`package.json` 里没有
 * 币种图标依赖，为几个圆点加一个依赖不划算）。用币种符号哈希出一个色相：
 * 同一个币**永远**是同一个颜色，刷新、跨周期、跨机器人都不变 ——
 * 颜色是给眼睛当锚点用的，随机变一次就废了。
 *
 * 固定 `42% 40%` 的饱和度与明度，只让**色相**变：深色界面上一排圆点如果明度
 * 也各不相同，最亮的那几个会抢走数字的注意力（`DESIGN.md` §1：装饰不能挤压数据）。
 */
function coinColor(symbol: string): string {
  let hash = 0;
  for (let index = 0; index < symbol.length; index += 1) {
    hash = (hash * 31 + symbol.charCodeAt(index)) % 100_000;
  }
  // 乘 47 再取模：让相邻的符号（`BTCUSDT` / `BTUSDT`）落到**相隔很远**的色相上，
  // 而不是相邻的、肉眼分不出来的两档。
  return `hsl(${(hash * 47) % 360} 42% 40%)`;
}

function coinInitial(symbol: string): string {
  return symbol.slice(0, 1).toUpperCase() || '?';
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
        <span aria-hidden className="text-ink-faint">
          │
        </span>
        <span className="animate-pulse-soft">正在请求模型…</span>
      </div>

      {/*
        盒子：虚线边框 + 更弱的底色，**不是**成品的 `bg-base-850`。
        实线 + 抬升底色是"这一轮已经出结果"的语言，用在这里会被读成成品（§1）。
      */}
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
export function DecisionFeed({
  traderId,
  running,
  actions,
}: {
  traderId: number;
  running?: boolean;
  actions?: ReactNode;
}) {
  const live = useEvents((s) => s.byTrader[traderId]?.decisions);
  const liveCycle = selectLiveCycle(traderId);
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
  const symbolsQuery = usePolled((signal) => api.marketSymbols(signal), { intervalMs: 20_000 });

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

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /** 在途的"加载更多"请求：换机器人或卸载时要作废掉。 */
  const moreAbortRef = useRef<AbortController | null>(null);
  /** 当前机器人 id 的快照：异步回调里用它判断响应是不是已经属于上一个机器人了。 */
  const traderIdRef = useRef(traderId);
  traderIdRef.current = traderId;

  useEffect(() => {
    // 换机器人：已加载的旧页、错误与终点标记都属于上一个机器人，整套丢掉。
    // 清理函数把在途请求也 abort 掉 —— 否则它回来时会追加到新机器人的列表里。
    setLoaded([]);
    setMoreState('idle');
    setMoreError(null);
    setDeeperFull(false);
    return () => moreAbortRef.current?.abort();
  }, [traderId]);

  /*
   * 轮询拿到的第一页并进来。
   *
   * 第一页同样是"多要一条"：最后那一条只是探针（回答"还有没有更早的"），不显示，
   * 所以这里切掉。`traderId` 过滤不是多余的：换机器人时 `usePolled` 不会立刻清空
   * 旧数据，不挡一下，上一家的记录会被并进新列表（它自己不知道换了人）。
   */
  useEffect(() => {
    const page = query.data;
    if (!page) return;
    const rows = page.slice(0, FEED_PAGE_SIZE).filter((record) => record.traderId === traderId);
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
  const records = useMemo(() => {
    const merged = new Map<number, DecisionRecord>();
    for (const record of loaded) merged.set(record.id, record);
    for (const record of live ?? []) merged.set(record.id, record);
    for (const record of (query.data ?? []).slice(0, FEED_PAGE_SIZE)) merged.set(record.id, record);
    // 最新的一轮在最上面。第二关键字用 `id`：周期号理论上不会重复，
    // 一旦重复（比如某一轮重试后写了两行），没有它列表顺序会随插入顺序抖动。
    return [...merged.values()].sort((a, b) => b.cycleNumber - a.cycleNumber || b.id - a.id);
  }, [loaded, query.data, live]);

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
  const showLive =
    isRunning && liveCycle !== undefined && !records.some((record) => record.cycleNumber === liveCycle.cycleNumber);

  /** 列表（滚动容器与哨兵）有没有挂上去 —— 观察器要在它出现的那一次重新挂。 */
  const listMounted = records.length > 0 || showLive;

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
     */
  }, [hasMore, moreState, traderId, listMounted]);

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

  /*
   * 面板头右侧那一行：**动作（立即分析）→ 刷新 → 全部记录**，顺序照参考产品的
   * `⚡立即分析   ↻`（`DECISION-FEED.md` §1）。抽成变量是为了加载态那张面板也用同一份 ——
   * 否则数据一到，这个按钮会先从页面上消失再出现，读起来像功能坏了。
   */
  const headerActions = (
    <span className="flex items-center gap-1.5">
      {actions}
      <button
        type="button"
        onClick={() => query.reload()}
        title="重新拉取决策记录"
        className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-ink-lo transition hover:text-ink-hi disabled:opacity-50"
        disabled={query.loading}
      >
        <RotateCw aria-hidden className={cn('h-3.5 w-3.5', query.loading && 'animate-spin')} />
        刷新
      </button>
      <Link to="/data" className="text-xs text-ink-lo transition hover:text-accent">
        全部记录
      </Link>
    </span>
  );

  if (query.loading && records.length === 0 && !showLive) {
    return (
      // 加载态也占满整栏：否则数据一到位，这一栏会突然从一小条跳成整屏高。
      <Panel
        title="最近决策"
        padded={false}
        className="flex h-full min-h-0 flex-col"
        bodyClassName="flex min-h-0 flex-1 flex-col p-0"
        actions={headerActions}
      >
        <Spinner3 label="正在加载决策" />
      </Panel>
    );
  }

  return (
    <Panel
      padded={false}
      /* 填满右栏：面板 `h-full` + 一个 `min-h-0` 的纵向 flex，卡片区才能拿到
         "剩下的高度"并自己滚动（见组件顶部注释）。 */
      className="flex h-full min-h-0 flex-col"
      bodyClassName="flex min-h-0 flex-1 flex-col p-0"
      title="最近决策"
      actions={headerActions}
    >
      {records.length === 0 && !showLive ? (
        <Empty
          message="暂无决策记录。"
          hint="每个周期都会连同完整提示词与原始响应一起持久化 — 运行一次后这里就会填满。"
        />
      ) : (
        // One scroll container. 每轮 = 元数据行 + 盒子 + 两个文字按钮。
        //
        // `flex-1 min-h-0`：高度来自右栏（`h-full` 的确定高度），不是 `max-height`。
        // `min-h-0` 不能省 —— flex 子项默认 `min-height: auto`，那一项会让滚动区
        // 永远不肯比内容矮，于是滚动条跑到整栏外面去。
        //
        // `max-h-[calc(100dvh-16rem)]` 只在 `xl` 以下生效：那时右栏塌到主内容下面，
        // 高度是内容高度，没有这个上限就会把整页撑长。
        //
        // `space-y-2.5` 而不是相邻的 `border-b`：40 个周期用一条接一条的分隔线排下来，
        // 会连成一整片、分不清哪里是上一个周期的结尾。
        <div
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
          className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-2.5 max-h-[calc(100dvh-16rem)] xl:max-h-none"
        >
          {/*
            在途周期钉在**最上面**，早于最新的成品（列表是按周期号倒序的）。
            它是"现在正在发生的事"，扫视时的第一落点必须是它 ——
            放在下面等于要操作者先划过一整盒已经结束的决策才看见"它在动"。
            它不受分页影响：它不属于任何一页，只是钉在这个列表的顶部。
          */}
          {showLive && liveCycle && <LiveCycleBlock key={liveCycle.cycleNumber} live={liveCycle} />}

          {records.map((record) => (
            <CycleBlock
              key={record.id}
              record={record}
              symbols={symbolsQuery.data ?? []}
            />
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
        </div>
      )}
    </Panel>
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
export function CycleBlock({ record, symbols }: { record: DecisionRecord; symbols: MarketSymbol[] }) {
  /*
   * 把执行日志按 `action` + `symbol` 配到各自的决策上。
   *
   * 为什么不是 `filter(status === 'skipped')` 那种写法：那样的结果是"结果"与"决策"
   * 分居盒子上下两处，操作者要把上面的提案和下面的小字自己对起来 ——
   * 而熔断真正拦下的是**那一条**提案，答案必须写在那一条旁边。
   */
  const plan = planExecution(record.executionLog, record.decisions);
  const skipped = plan.counts.skipped;
  const rejected = plan.counts.rejected;
  const failed = plan.counts.failed;

  return (
    /*
     * `data-record-id` 是**给滚动锚点用的 DOM 标记**（见 `DecisionFeed` 里那个
     * `useLayoutEffect`）：新周期插到顶部时，要靠它认出"上一次的第一条"这一个元素、
     * 量出它被推下去多少像素，才能把 `scrollTop` 补偿回去。它不是样式钩子，
     * 不要用它写 CSS。
     */
    <article className="min-w-0" data-record-id={record.id}>
      <CycleMeta record={record} />

      {/*
        决策盒子：**一轮只有这一个**边框。每条决策只是里面的一段，没有自己的边框。

        ⚠️ 底色必须是 `bg-base-850` 而不是 `bg-base-900`。
        面板（Panel）本身就是 `bg-base-900` —— 盒子用同色等于**没有边界**，
        几十轮决策连成一片，分不清哪一条属于哪一轮（操作者原话：
        "肉眼看不出来每一期决策"）。

        `base-850` 比面板抬升一层，盒子就浮出来了；配合边框，
        一眼能看出"这一轮到这里结束"。
      */}
      <div className="min-w-0 rounded-lg border border-base-700 bg-base-850 px-3 py-2.5">
        {/*
          周期级失败：整段中文说明原样显示。**不加 `周期错误：` 前缀** —— 元数据行
          已经写着 `失败 · <类别>`，再套一层前缀就会变成一句两个冒号的怪话，而这里
          要的是让操作员直接读到"出了什么事、该做什么"。
        */}
        {record.error && (
          <p className="mb-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-down">
            <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{record.error}</span>
          </p>
        )}

        {/*
          `record.error === null` 这个条件是必要的：模型调用失败时决策当然是空的，
          但"本周期模型没有给出任何决策"会把一次**失败**说成模型的一次选择（观望），
          而上面那行红字已经说明了真正的原因。

          执行日志也必须为空：一轮可能模型没给出任何决策，却仍然执行了动作
          （回撤守卫平仓、失败重试），此时说"没有给出任何决策"是把一次**执行**
          说成了模型的沉默。
        */}
        {record.error === null &&
          record.decisions.length === 0 &&
          record.executionLog.length === 0 && (
            <p className="text-xs text-ink-faint">本周期模型没有给出任何决策。</p>
          )}

        {record.decisions.length > 0 && (
          // 决策之间只用**间距**分隔（§3），不加分隔线：一条细线在深色底上会
          // 变成第二层边框，而这个盒子里只该有一层。
          <div className="space-y-2.5">
            {record.decisions.map((decision, index) => (
              <DecisionRow
                key={`${decision.symbol}-${index}`}
                decision={decision}
                price={priceOf(symbols, decision.symbol)}
                outcome={plan.outcomes[index] ?? null}
              />
            ))}
          </div>
        )}

        {/*
          没有配上任何决策的执行条目。

          正常情况下这里是空的：服务端的每一条执行日志都是**从决策列表里长出来的**
          （拒绝来自风控对同一批决策的裁决，跳过与执行来自被批准的那几条），
          所以 `action` + `symbol` 一定能配到一条决策上。

          但"配不上"这件事不能因此就丢掉：老记录、字段被截断的记录、或者别的写入方
          都有可能留下孤立条目 —— 那正是最需要被看见的一类（静默丢弃 = 又一次
          让界面说"什么都没发生"）。
        */}
        {plan.leftover.length > 0 && (
          <ul className="mt-2 space-y-1 border-t border-base-800 pt-2">
            {plan.leftover.map((entry, index) => (
              <LogLine key={`leftover-${index}`} entry={entry} />
            ))}
          </ul>
        )}
      </div>

      <CycleDetails
        record={record}
        counts={{ failed, rejected, skipped }}
      />
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
  /** 每个配对键下**还没被认领**的日志下标，按出现顺序排队。 */
  const queue = new Map<string, number[]>();
  for (let index = 0; index < log.length; index += 1) {
    const entry = log[index];
    if (!entry) continue;
    const key = pairKey(entry.action, entry.symbol);
    const bucket = queue.get(key);
    if (bucket) bucket.push(index);
    else queue.set(key, [index]);
  }

  const outcomes: Array<ExecutionLogEntry | null> = [];
  const claimed = new Set<number>();
  for (const decision of decisions) {
    const bucket = queue.get(pairKey(decision.action, decision.symbol));
    // 每认领一条就把它从队列头移走：同一个币种的第二条决策因此拿到**下一条**日志。
    const index = bucket?.shift();
    if (index === undefined) {
      outcomes.push(null);
      continue;
    }
    claimed.add(index);
    outcomes.push(log[index] ?? null);
  }

  const counts: Record<ExecutionLogEntry['status'], number> = {
    ok: 0,
    rejected: 0,
    failed: 0,
    skipped: 0,
  };
  for (const entry of log) counts[entry.status] += 1;

  return {
    outcomes,
    leftover: log.filter((_, index) => !claimed.has(index)),
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
function CycleMeta({ record }: { record: DecisionRecord }) {
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
  const tokens = hasTokens
    ? `in ${fmtInt(record.promptTokens ?? 0)} · out ${fmtInt(record.completionTokens ?? 0)}`
    : // 不写 `in 0 · out 0`：那会让人以为模型一个 token 都没花。
      '用量未回传';

  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-0.5 text-xs text-ink-lo">
      <span>{timeAgo(record.timestamp)}</span>
      <span aria-hidden className="text-ink-faint">
        │
      </span>
      <span className="num">周期 #{record.cycleNumber}</span>
      <span aria-hidden className="text-ink-faint">
        │
      </span>
      <span className="num">{tokens}</span>

      {/*
        耗时。失败的周期常常在拿到响应之前就抛了（延迟为 0），
        此时写 `0 ms` 会被读成"模型 0 毫秒就答完了"，所以留 `—`。
      */}
      {(record.aiLatencyMs > 0 || record.success) && (
        <>
          <span aria-hidden className="text-ink-faint">
            │
          </span>
          <span className="num" title="本轮向模型发起请求到收到完整响应的时间。">
            {fmtLatency(record.aiLatencyMs)}
          </span>
        </>
      )}

      {!record.success && (
        <>
          <span aria-hidden className="text-ink-faint">
            │
          </span>
          {/* 颜色 + `⚠` 双重表达：`DESIGN.md` 要求状态不能只靠颜色传递。 */}
          <span className="flex min-w-0 items-center gap-1 font-medium text-down">
            <TriangleAlert aria-hidden className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">失败{failureCategory(record.error)}</span>
          </span>
        </>
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
function DecisionRow({
  decision,
  price,
  outcome,
}: {
  decision: Decision;
  price: number | null;
  outcome: ExecutionLogEntry | null;
}) {
  const figures = figureParts(decision, price);

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <CoinIcon symbol={decision.symbol} />
        <span className="min-w-0 truncate text-base font-semibold text-ink-hi">{decision.symbol}</span>
        <ActionBadge action={decision.action} className="ml-auto shrink-0" />
      </div>

      {/* 置信度：缩进对齐到符号下方，强调色小字。 */}
      <div className="mt-0.5 pl-5 text-xs text-accent">
        置信度: <span className="num">{decision.confidence}%</span>
      </div>

      {decision.reasoning && (
        <div className="mt-0.5 flex min-w-0 items-start gap-1.5 pl-5">
          {/* `shrink-0` + `mt-[3px]`：图标不能被文字挤扁，也要和第一行文字的视觉中线对齐。 */}
          <FileText aria-hidden className="mt-[3px] h-3.5 w-3.5 shrink-0 text-ink-lo" />
          <p className="min-w-0 break-words text-xs leading-relaxed text-ink-mid">{decision.reasoning}</p>
        </div>
      )}

      {/*
        实际开仓的关键数字：**一行小字**，不是表格。
        见 `figureParts` 的说明 —— 这是三轮溢出 bug 的修复方式。
      */}
      {figures.length > 0 && (
        <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 pl-5 text-xs leading-relaxed text-ink-lo">
          {figures.map((part, index) => (
            <span key={`${part.label}-${part.value}-${index}`} className="flex items-baseline gap-1">
              {index > 0 && (
                <span aria-hidden className="text-ink-faint">
                  ·
                </span>
              )}
              {part.label && <span className="text-ink-faint">{part.label}</span>}
              {/*
                折行由**外层** `flex-wrap` 负责（在片段之间断），这是正常路径 ——
                不要给这个数字加 `whitespace-nowrap`：`0.171900` 一旦被折成两行，
                看起来就是两个数。

                但也不能指望"片段足够窄"：所以保留 `break-all` 作为**最后一道防线**。
                决策流在 `xl` 以下是整页宽（≥600px），在 `xl` 以上是右栏的 40%
                （≥500px），而这一行最长的片段（`止损 0.174000`）约 90px，
                正常永远用不到它；万一真的窄到放不下，`break-all` 保证数字在
                **自己的盒子内**折行，而不是撑破容器跑出去
                （`DECISION-FEED.md` 里那三轮溢出 bug 就是这么来的）。
              */}
              <span className="num break-all" title={FIGURE_TITLE[part.key]}>
                {part.value}
              </span>
            </span>
          ))}
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
  const notes = entry?.adjustments?.length ? entry.adjustments : decision.adjustments;

  if (!entry) {
    return (
      <div className="mt-1 pl-5 text-xs leading-relaxed text-ink-faint">
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

  return (
    <div className="mt-1 min-w-0 pl-5">
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
      </div>

      {/*
        原因 / 错误：**原样显示服务端写的那句话**（`entry.detail`）。
        熔断那条本身就是一句完整的中文（`单日亏损熔断：今日已实现亏损 $0.59，
        占权益 6.03%（上限 5%）。`），改写它只会把数字弄丢 —— 而数字才是重点。
      */}
      {entry.detail && (
        <p className="mt-0.5 break-words text-xs leading-relaxed text-ink-mid">{entry.detail}</p>
      )}

      {notes.length > 0 && (
        <ul className="mt-0.5 space-y-0.5">
          {notes.map((note, index) => (
            <li key={index} className="break-words text-xs leading-relaxed text-warn/90">
              • {note}
            </li>
          ))}
        </ul>
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
    case 'rejected':
      return { key: status, label: `⚠ 被风控拒绝`, tone: 'warn' };
    case 'failed':
      return { key: status, label: `✕ 执行失败`, tone: 'down' };
    case 'skipped':
      return { key: status, label: `⊘ 未执行（${STATUS_LABELS.skipped}）`, tone: 'muted' };
    default: {
      // 穷尽性检查：`status` 只能是上面四种。少写一种，这一行会编译报错。
      const exhaustive: never = status;
      return { key: exhaustive, label: status, tone: 'muted' };
    }
  }
}

type FigureKey = 'size' | 'entry' | 'stop' | 'target' | 'reward' | 'leverage';

/** 关键数字里的一个片段：`{ label: '止损', value: '0.174000' }`。 */
interface Figure {
  key: FigureKey;
  /** 短标签；数量、风险回报比、杠杆没有标签，靠悬停说明解释。 */
  label: string;
  value: string;
}

/**
 * 开仓关键数字里每一项的悬停说明。
 *
 * 这一行的标签很短（`$30.00 · 开仓 0.171900 · … · 1:8.62 · 5x`），
 * 悬停时给出**带单位的全称** —— `DESIGN.md` §7：单位要写出来，
 * 不能让人猜 `1:8.62` 和 `5x` 各是什么。
 */
const FIGURE_TITLE: Record<FigureKey, string> = {
  size: '名义价值（USDT）',
  entry: '当前价格，即开仓参考价',
  stop: '止损价',
  target: '止盈价',
  reward: '风险回报比 = 到止盈的距离 ÷ 到止损的距离',
  leverage: '杠杆倍数',
};

/**
 * 开仓的关键数字，拆成**若干可以整体折行的片段**。
 *
 * ## 为什么不是表格（这是这个文件里最重要的一条注释）
 *
 * 这里原来是 6 个格子的 grid（数量 / 开仓价 / 止损 / 止盈 / 风险回报 / 杠杆），
 * 还用了容器查询按卡片宽度切 2/3 列。它连续三轮出溢出 bug：grid 的列有最小内容
 * 宽度，而决策流在右栏里只有约 40% 宽、卡片还得再分两三列，于是一个
 * `0.176800` 加一个 `+26.67%` 就撑破格子，文字挤进相邻列（截图里那个飘出去的
 * `率.47%` 就是这么来的）。
 *
 * 现在返回**结构化片段**而不是一整条字符串：调用处把每一项的标签与数字分开渲染，
 * 由外层的 `flex-wrap` 在片段之间折行（正常路径），数字上再加 `break-all` 兜底。
 * 两条加起来的结果是：**横向不可能撑破容器**，这正是三轮 bug 的根因所在。
 *
 * 顺序照 `DECISION-FEED.md` §6 的示例：
 * `$30.00 · 开仓 0.171900 · 止损 0.174000 · 止盈 0.190000 · 1:8.62 · 5x`。
 * 最后一个 `5x` 是杠杆，`1:8.62` 是风险回报比 —— 两者都在悬停说明里写清楚。
 *
 * 只在实际开仓（`open_*`）时出现。观望 / 等待没有仓位可谈；平仓的数字属于成交
 * 记录，硬凑在理由下面只会让这一行变长而不增加信息。
 */
function figureParts(decision: Decision, price: number | null): Figure[] {
  if (!isOpenAction(decision.action)) return [];

  const parts: Figure[] = [{ key: 'size', label: '', value: fmtUsd(decision.positionSizeUsd, 2) }];
  if (price !== null) parts.push({ key: 'entry', label: '开仓', value: fmtPriceUsd(price) });
  if (decision.stopLoss !== null) parts.push({ key: 'stop', label: '止损', value: fmtPriceUsd(decision.stopLoss) });
  if (decision.takeProfit !== null)
    parts.push({ key: 'target', label: '止盈', value: fmtPriceUsd(decision.takeProfit) });
  if (price !== null && decision.stopLoss !== null && decision.takeProfit !== null) {
    // `Math.abs` 两侧：做空时价格在止损之上、止盈之下，直接相减会得到一个**负数**
    // 的风险回报比 —— 那是一个不存在的比例，看起来像算错了。
    const risk = Math.abs(price - decision.stopLoss);
    const reward = Math.abs(decision.takeProfit - price);
    if (risk > 0) parts.push({ key: 'reward', label: '', value: `1:${(reward / risk).toFixed(2)}` });
  }
  parts.push({ key: 'leverage', label: '', value: `${decision.leverage}x` });

  return parts;
}

/**
 * 币种图标：一个彩色圆点，里面是符号首字母。
 *
 * 不引图标库（见 `coinColor`）。`aria-hidden` + 文本缩进对齐：这一列纯粹是视觉锚点，
 * 屏幕阅读器读出来是噪音 —— 旁边的符号本身才是内容。
 */
function CoinIcon({ symbol }: { symbol: string }) {
  const style: CSSProperties = { backgroundColor: coinColor(symbol) };
  return (
    <span
      aria-hidden
      style={style}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none text-white/90"
    >
      {coinInitial(symbol)}
    </span>
  );
}

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
function LogLine({ entry }: { entry: ExecutionLogEntry }) {
  const { label, tone } = logLineStyle(entry.status);

  /*
   * `skip_cycle` 是**整轮被跳过**的通知，不属于任何标的。
   *
   * 它没有真实的 action / symbol 可显示 —— 硬拼出来只会得到
   * `skip_cycle — — <说明>`：一个没登记标签的机器码、一个占位破折号，
   * 再加一个分隔符破折号。而 `detail` 已经把话说完（为什么跳过、什么时候恢复），
   * 所以这类条目直接给说明。见 `AGENTS.md` §5.2：机器码可以是英文，
   * **但面向操作员的文本必须走中文标签**，不能把机器码原样显示出来。
   */
  const isCycleNotice = entry.action === 'skip_cycle';

  return (
    <li className="flex min-w-0 items-start gap-1.5 text-xs leading-relaxed">
      <span className={cn('shrink-0', tone)}>{label}</span>
      <span className="min-w-0 break-words text-ink-lo">
        {!isCycleNotice && (
          <span className="num text-ink-mid">
            {actionLabel(entry.action)} {entry.symbol}
          </span>
        )}
        {entry.detail ? `${isCycleNotice ? '' : ' — '}${entry.detail}` : ''}
      </span>
    </li>
  );
}

/** `LogLine` 的标记与颜色。四种状态各自可辨，见 `outcomeBadge` 的同一条理由。 */
function logLineStyle(status: ExecutionLogEntry['status']): { label: string; tone: string } {
  switch (status) {
    case 'ok':
      return { label: `✓ ${STATUS_LABELS.ok}`, tone: 'text-up' };
    case 'rejected':
      return { label: `⚠ 被风控拒绝`, tone: 'text-warn' };
    case 'failed':
      return { label: `✕ 执行失败`, tone: 'text-down' };
    case 'skipped':
      return { label: `⊘ 未执行`, tone: 'text-ink-lo' };
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
function CycleDetails({
  record,
  counts,
}: {
  record: DecisionRecord;
  counts: { failed: number; rejected: number; skipped: number };
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DetailTab>('cot');

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
  /*
   * `skipped` 也要进这一行。
   *
   * 一轮里**全部**决策都被跳过时（`success: true`，熔断或冷却把每一条都拦下），
   * 周期头那一行看起来和一次正常执行完全一样：`周期 #38 │ in 4,980 · out 210 │ 12.3s`。
   * 这一行小字是操作者扫视整列时唯一能一眼看出"这一轮什么都没执行"的地方
   * （§2：这类信息用一行小字表达，不要做成徽章行）。
   */
  if (counts.skipped > 0) notes.push(`${counts.skipped} 条未执行`);
  if (counts.rejected > 0) notes.push(`${counts.rejected} 条被风控拒绝`);

  /*
   * 有没有可展开的东西。
   *
   * 一个在模型调用**之前**就失败的周期（欠费、行情为空、账户读取失败）三条都是空的，
   * 那两个按钮点开只会显示"（空）"和"本周期模型未返回 <reasoning> 块。" —— 两个死
   * 按钮比没有按钮更让人困惑。整个底部行因此只在真的有内容、或者有失败/被拒条目时
   * 才出现（后者仍然必须可见，见 §7）。
   */
  const hasDetail =
    record.cotTrace.trim() !== '' ||
    record.systemPrompt.trim() !== '' ||
    record.userPrompt.trim() !== '';
  if (!hasDetail && notes.length === 0) return null;

  const tabClass = (active: boolean): string =>
    cn(
      'inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs transition',
      active ? 'font-semibold text-up' : 'text-ink-lo hover:text-ink-hi',
    );

  return (
    <div className="min-w-0">
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
        {hasDetail && (
          <>
            <button
              type="button"
              onClick={() => toggle('cot')}
              aria-expanded={open && tab === 'cot'}
              title={open && tab === 'cot' ? '收起思考过程' : '展开思考过程'}
              className={tabClass(open && tab === 'cot')}
            >
              <Sparkles aria-hidden className="h-3.5 w-3.5 shrink-0" />
              思考过程
              {open && tab === 'cot' && <Check aria-hidden className="h-3.5 w-3.5 shrink-0" />}
            </button>

            <span aria-hidden className="text-ink-faint">
              │
            </span>

            <button
              type="button"
              onClick={() => toggle('prompt')}
              aria-expanded={open && tab === 'prompt'}
              title={open && tab === 'prompt' ? '收起提示词' : '展开提示词'}
              className={tabClass(open && tab === 'prompt')}
            >
              <Lock aria-hidden className="h-3.5 w-3.5 shrink-0" />
              提示词
              {open && tab === 'prompt' && <Check aria-hidden className="h-3.5 w-3.5 shrink-0" />}
            </button>
          </>
        )}

        {/*
          被拒 / 未执行 / 失败在底部也要有一行小字（§2）：按钮这一行是操作者扫视时的落点，
          而"这一轮被风控拦了 2 条"是必须看见的信息 —— 具体的**原因**在每条决策
          自己的行上（`DecisionOutcome`），这里只报数量。
        */}
        {notes.length > 0 && (
          <span className="flex items-center gap-1 text-xs text-warn">
            <TriangleAlert aria-hidden className="h-3.5 w-3.5 shrink-0" />
            {notes.join(' · ')}
          </span>
        )}
      </div>

      {/* 展开的内容留在同一个盒子的语义范围内、按钮下方，并且**可滚动**（§5）。 */}
      {open && (
        <div className="mt-2 min-w-0">
          {tab === 'cot' ? (
            <ScrollArea
              body={record.cotTrace}
              empty="本周期模型未返回 <reasoning> 块。"
            />
          ) : (
            <div className="space-y-2">
              <PromptSection title="系统提示词" body={record.systemPrompt} />
              <PromptSection title="用户提示词" body={record.userPrompt} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PromptSection({ title, body }: { title: string; body: string }) {
  return (
    <section className="min-w-0">
      <h4 className="mb-1 text-xs font-semibold text-ink-lo">{title}</h4>
      <ScrollArea body={body} empty="（空）" />
    </section>
  );
}

/**
 * 可滚动的等宽文本块。
 *
 * `max-h` 而不是固定 `height`：短内容不该留一大片空白。
 * `break-words` + `whitespace-pre-wrap`：提示词里有超长 JSON 行，不折行就会
 * 把这一栏顶出横向滚动条。
 */
function ScrollArea({ body, empty }: { body: string; empty: string }) {
  if (!body.trim()) return <p className="px-1 py-2 text-xs text-ink-faint">{empty}</p>;
  return (
    <pre className="max-h-80 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-base-800 bg-base-950 px-2.5 py-2 font-mono text-xs leading-relaxed text-ink-mid">
      {body}
    </pre>
  );
}
