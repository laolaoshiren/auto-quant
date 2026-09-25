/**
 * Trader dashboard tables: 当前持仓 / 当前委托 / 历史成交 / 订单记录.
 *
 * Two rules hold for every table in this file, and both come from DESIGN.md §6:
 *
 * 1. **Never render an unbounded list.** 当前持仓受 `maxPositions` 天然约束，
 *    所以最多渲染 `MAX_ROWS` 行、并在页脚说明被截断了。历史成交与订单记录**没有**
 *    天然上界（每下一次单、每平一次仓就多一行），所以它们改成**游标分页**：
 *    第一页 25 行，滚到表格底部才取下一页，一直翻到服务端返回不满一页为止 ——
 *    见 `useTablePaging`。这两张表以前每 15 秒无条件向服务端要 200 行并全部渲染。
 * 2. **Horizontal scrolling stays inside the table.** Every table sits in a
 *    `.scroll-x` box, so a 14-column order table never pushes the page wide
 *    (the shell has `overflow-x-hidden` and would otherwise clip it).
 *
 * The close controls are deliberately *not* wired to an API call — the backend
 * has no manual-close endpoint. Pressing one opens an explanation of how the
 * bot actually closes positions rather than pretending a request was sent.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import { LoaderCircle } from 'lucide-react';
import { exchangeErrorLabel, type MarginMode, type OrderRecord, type PositionView, type TradeRecord } from '@aq/shared';
import { orderPurposeLabel, orderStatusLabel, orderTypeLabel } from '@aq/shared';
import { api } from '../lib/api';
import { needsReconcileFlag } from '../lib/orderFlags';
import { useEvents } from '../lib/store';
import { usePolled } from '../lib/hooks';
import { Badge, Button, ErrorNote, Modal, Panel, Spinner3 } from './ui';
import { SideBadge } from './Badges';
import { closeReasonLabel } from '../lib/summaries';
import {
  NET_PNL_FORMULA,
  PnlBreakdown,
  pnlFormulaText,
  tradeCosts,
  type PnlCosts,
} from './PnlBreakdown';
import { BALANCE_LABEL, fmtDateTime, fmtDuration, fmtPercent, fmtPrice, fmtQty, fmtSigned, fmtUsd, fmtUsdSigned, marginModeLabel, orderMarginMode, pnlColor, symbolTone } from '../lib/format';

/* -------------------------------------------------------------------------- */
/*  Row caps                                                                   */
/* -------------------------------------------------------------------------- */

/** 当前持仓表渲染多少行。持仓数受 `maxPositions` 约束，不需要分页。 */
const MAX_ROWS = 100;

/**
 * 历史成交 / 订单记录第一页多少行，以及"滚到底再取下一页"的页大小。
 *
 * 25 是"一屏左右"：比一屏多一点，所以第一眼就能看出下面还有东西；又足够小，
 * 一次请求与一次渲染都不可能有感知。这两张表以前一次要 200 行 ——
 * 操作者的原话是"成千上万数据一次加载出来导致系统卡死"。
 */
const PAGE_SIZE = 25;

/**
 * 每页向服务端**多要一条**，只用来判断"还有没有更早的"。
 *
 * 响应体是 `OrderRecord[]` / `TradeRecord[]`（形状没变：老客户端与 `docs/API.md`
 * 都照旧），数组里没有"还有下一页吗"这个字段，所以多要一条是最便宜的探针：
 * 拿到 26 条 = 还有更早的；拿到 ≤25 条 = 已经到最早一笔了。
 * 不这么做就只能靠"再请求一次、拿到空数组"来判断终点 —— 那时"加载中"会先多闪一下，
 * 而终点提示也总是迟一步。决策流（`DecisionFeed`）用的是同一套办法。
 */
const PAGE_LIMIT = PAGE_SIZE + 1;

/* -------------------------------------------------------------------------- */
/*  Cursor pagination shared by the two history tables                         */
/* -------------------------------------------------------------------------- */

/** 「加载更多」的状态机：与决策流一致（idle / loading / error / done）。 */
type MoreState = 'idle' | 'loading' | 'error' | 'done';

/** `usePolled` 那一份数据里，这个组件关心的三个字段。 */
interface PolledPage<T> {
  data: T[] | null;
  loading: boolean;
  error: string | null;
  /**
   * 这个 hook **成功拿到过数据**的时刻（`usePolled` 里 `updatedAt`）。
   * `null` = 从没成功过。用来区分"还没有数据"与"有数据但正在刷新"。
   */
  updatedAt: number | null;
}

/**
 * 延迟显示加载转圈。
 *
 * ## 为什么需要它：**转圈"出现又消失"本身就是一种闪烁**
 *
 * 用户报的现象是「点进当前委托会闪一下，太快看不清」。逐帧实测量到的真实序列是：
 *
 *     2781ms  行=-1   ← 出现「正在加载委托…」
 *     3575ms  行= 4   ← 800ms 后被真实的行替换
 *
 * 也就是说：转圈本身**没有错**（那一刻数据确实还没到），但**它存在过再消失**，
 * 眼睛就会捕捉到这次跳变。而"加载很快"的场景里，这个转圈提供的信息远小于它造成的干扰。
 *
 * 做法：**只有加载真的超过阈值才显示它**。快的时候表格区域短暂空白 —— 人眼感知不到；
 * 慢的时候才给出"正在加载"的反馈，否则用户会以为界面卡住了。
 *
 * 阈值 350ms 的取法：低于它，人会把"空白 → 内容"当成一次性出现；高于它，就该有反馈。
 */
function useDelayedSpinner(active: boolean, delayMs = 350): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!active) {
      setShow(false);
      return;
    }
    const timer = window.setTimeout(() => setShow(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return show;
}

/** 一页怎么取。两张表的差别只有一个 API 函数，所以做成参数。 */
type PageFetcher<T> = (

  traderId: number,
  options: {
    limit: number;
    before?: number | null;
    /**
     * **时间游标**：只看成交表。它的 `id` 是插入顺序，而**对账补录的行 id 更大、
     * 成交时刻更早** —— 按 id 排序会让日期看起来错乱（用户报过），所以服务端
     * 改成按 `closed_at` 排序，而按时间排序之后只用 id 做游标会漏行。
     * 订单表不传它，行为与以前完全一致。
     */
    beforeClosedAt?: string | null;
    signal?: AbortSignal;
  },
) => Promise<T[]>;

interface TablePaging<T> {
  /** 屏幕上要渲染的全部行：轮询的第一页 + 翻出来的每一页 + 推送进来的实时行，按 id 倒序去重。 */
  rows: T[];
  loading: boolean;
  /**
   * **是否曾经成功拿到过数据**（一旦为 true 就永远是 true）。
   *
   * ⚠️ **它和 `loading` 是两件事，用途也不同。**
   *
   * `loading` 来自 `usePolled`，语义是"**本次请求还在飞**"—— 组件重新挂载时它会
   * 从 `true` 重新开始。**拿它单独决定"要不要显示转圈"会闪**：
   *
   *   实测（刷新页面后在 150ms 内点「当前委托」）：转圈持续了 **8 帧（约 400ms）**
   *   才被 3 行数据替代。用户的原话是「会错误、闪烁出现一些数据（闪太快看不清）」；
   *   而在标签之间来回切时**不会**出现 —— 因为那时组件不重挂、`loading` 早已是 false。
   *
   * 有它之后，加载态只在**真的什么都没有**时出现：数据一旦到过手上，就算下一轮
   * 轮询在飞，表格也照旧显示手里的行，而不是退回一个转圈。
   */
  hasLoadedOnce: boolean;
  error: string | null;
  /** 还有没有更早的行（决定要不要挂观察器、要不要显示「已到最早一笔」）。 */
  hasMore: boolean;
  moreState: MoreState;
  moreError: string | null;
  /** 错误行里的「重试」按钮走它。 */
  retry: () => void;
  /** 表格**自己的**滚动框，给 `IntersectionObserver` 当 `root`。 */
  scrollerRef: MutableRefObject<HTMLDivElement | null>;
  /** 观察哨兵：列表末尾 1px 高的元素。 */
  sentinelRef: MutableRefObject<HTMLDivElement | null>;
}

/**
 * 把一批新行并进"已经拿到"的那一份，**按 id 去重**。
 *
 * 没有新行时返回**原数组**（而不是一个新数组）：`useState` 的 setter 拿到同一个引用会
 * 直接跳过这次重渲染，而轮询每 15 秒都会调一次这里 —— 绝大多数时候一条新的都没有。
 *
 * 去重不是可选的：轮询的第一页与翻出来的页在边界上必然重叠一行（探针行那一行
 * 会作为下一页的第一条被取回来），WebSocket 推送又可能同一行再来一份。
 */
function mergeById<T extends { id: number }>(prev: T[], rows: T[]): T[] {
  const seen = new Set(prev.map((row) => row.id));
  const fresh = rows.filter((row) => !seen.has(row.id));
  return fresh.length > 0 ? [...prev, ...fresh] : prev;
}

/**
 * 历史成交 / 订单记录的**游标分页**，两张表共用。
 *
 * ## 游标是 `before=id`，不是 `offset`
 *
 * 这两张表都是**在顶部持续插入**的（每下一单、每平一仓就多一行）。用偏移量翻页时，
 * 只要两次请求之间又落了一行，第二页的起点就整体后移一格 —— 第二页的第一条会和
 * 第一页的最后一条**重复**（同一笔成交在表格里出现两次，而这张表的数字是钱）。
 * 游标锚在一条具体行上：新行的 `id` 一定更大、永远落在游标之上。
 * 理由的完整版写在服务端 `repositories.ts` 的 `orders.list()` / `trades.list()` 上。
 *
 * ## `root` 是**表格自己的滚动框**，不是窗口
 *
 * 这两张表的滚动条在 `<div class="scroll-x max-h-[34vh] overflow-y-auto">` 里
 * （见下面两张表的 JSX）：内容超过 60vh 之后由**它**滚，而不是页面滚
 * （`Layout.tsx` 的内容区虽然在 `xl` 以上也让主栏自己滚，但表格自己有 `max-h`，
 * 永远轮不到主栏去滚表格里的行）。用默认的视口当 `root` 会比错对象：
 * 表格中段的哨兵在视口里而没在容器底部，于是"没滚到底就开始加载下一页"，
 * 甚至一次把整段历史都拉进来。所以这里必须显式传 `root`。
 *
 * 若表格内容还不足 60vh（一开始只有 25 行时常常如此），容器没有可滚的余量、
 * 哨兵本来就落在容器的可视区里，于是会**自动接着取下一页**，直到内容撑满
 * 那个高度为止 —— 这是想要的：先把盒子填满，再等操作者滚动。
 *
 * ## 轮询与分页的相互作用（这里最容易做错）
 *
 * - 轮询只负责**最新的一页**：`usePolled` 每 15 秒重拉第一页，它并进"已经拿到的那些行"。
 *   已经翻出来的更早的页**原封不动** —— 把轮询结果直接替换掉列表，等于每 15 秒丢掉
 *   操作者翻出来的全部历史（他正读到第 60 行，一眨眼又回到 25 行）。
 * - 把轮询的第一页当成一个"固定窗口"（每次替换掉旧的）同样是**错的**：新行一插进来，
 *   窗口里最旧的那一条就被挤出去，而它恰好是和已加载历史相接的那一条 ——
 *   列表中间会静默少一行（长度还看不出来）。所以这里只做累加，见 `mergeById`。
 * - 合并按 `row.id` 去重，所以同一行既在 REST 结果里、又在 WebSocket 推送里，
 *   或者同时落在两页的边界上，都只会渲染一次。
 * - 分页状态（已加载的页、游标、滚动位置）全是**组件自己的状态 + 真实 DOM 滚动位置**，
 *   轮询返回不会重置任何一个。换机器人时整套丢掉（见下面的 `useEffect`）。
 */
function useTablePaging<T extends { id: number; traderId: number }>(
  traderId: number,
  fetchPage: PageFetcher<T>,
  polled: PolledPage<T>,
  live: T[] | undefined,
  /**
   * 这一行在**时间轴**上的位置。省略 = 按 `id` 排序（订单表就是对的：
   * 订单的 id 顺序与创建顺序一致）。
   *
   * ⚠️ **成交表必须传**（`(row) => row.closedAt`）：成交的 `id` 是插入顺序，
   * 而**对账补录的行 id 更大、成交时刻却更早** —— 实测 18 行里 4 处乱序，
   * 界面上就是"日期显示错乱"（用户的原话）。
   */
  timeOf?: (row: T) => string,
  /**
   * 「这张表的 DOM 会被**原样重挂**」的信号：值一变，观察器就重新挂一次。
   *
   * ⚠️ **为什么必须有它**（订单表就是这么坏的）：`TraderTables` 里两处 `OrdersTable`
   * 写在 JSX 的两个不同位置上（「当前委托」与「订单记录」各一个），`tab` 一变，
   * React 把其中一个**卸载**、另一个**新挂**—— 而 `paging` 状态在容器里，所以这件事
   * 对容器是无声的：`scrollerRef` / `sentinelRef` 悄悄指到了新节点上，可观察器 effect
   * 的依赖（`hasMore` / `moreState` / `traderId` / `listMounted`）一个都没变，
   * **effect 不会重跑** → 新哨兵没有任何观察者 → 切一次标签，"滚到底加载更早的记录"
   * 就静默失效（而它看起来只是"下面没有了"）。
   *
   * 同一个道理的另一面正是这次加收起交互时要躲开的坑：**任何让 ref 与观察器分家的改动，
   * 都会让哨兵要么没人看，要么被误判成可见、一次把整段历史拉进来**。
   */
  remountKey?: unknown,
): TablePaging<T> {
  /**
   * 服务端给过的、**已经显示出来的**行（按 id 去重；轮询的第一页与翻出来的每一页都并进来）。
   *
   * 增长有界且很慢：轮询只在真的出现新行时 +1，翻页每次 +25，而且只有操作者
   * 自己滚到底（或盒子还没被填满）才会发生。
   */
  const [loaded, setLoaded] = useState<T[]>([]);
  const [moreState, setMoreState] = useState<MoreState>('idle');
  const [moreError, setMoreError] = useState<string | null>(null);
  /** 最近一次"下一页"是不是满页 —— 终点提示靠它判断。 */
  const [deeperFull, setDeeperFull] = useState(false);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /** 在途的"加载更多"请求：换机器人或卸载时要作废掉。 */
  const moreAbortRef = useRef<AbortController | null>(null);
  /** 取页函数的引用：让它不进 `loadMore` 的依赖，避免每次渲染都换一个新的回调。 */
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
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
   * 旧数据，不挡一下，上一家的订单会被并进新列表（它自己不知道换了人）。
   */
  useEffect(() => {
    const page = polled.data;
    if (!page) return;
    const rows = page.slice(0, PAGE_SIZE).filter((row) => row.traderId === traderId);
    if (rows.length === 0) return;
    setLoaded((prev) => mergeById(prev, rows));
  }, [polled.data, traderId]);

  /**
   * 轮询的第一页 + 更早的页 + 推送进来的实时行 → 一个列表，**按 id 倒序**。
   *
   * 去重靠 `Map` 的键（就是 id）：同一行同时出现在两页边界上、或者既在 REST
   * 结果里又在 WebSocket 推送里，都只会渲染一次。订单与成交写入后不再修改
   * （`status` 变化会由下一次轮询覆盖同一 id 的那一份），所以旧行永远不需要重拉。
   *
   * 轮询刚拿到的第一页也**直接**并进来，不等上面那个 effect 落地：否则"数据到了"和
   * "列表挂上去了"会差一次重渲染，而挂在列表末尾的哨兵观察器只在这几个依赖变化时
   * 重新挂载 —— 它会永远挂不上，滚到底毫无反应（决策流那侧实测到过这个情形）。
   */
  const rows = useMemo(() => {
    const merged = new Map<number, T>();
    for (const row of loaded) merged.set(row.id, row);
    for (const row of live ?? []) if (row.traderId === traderId) merged.set(row.id, row);
    for (const row of (polled.data ?? []).slice(0, PAGE_SIZE)) merged.set(row.id, row);
    const all = [...merged.values()];
    /*
     * ⚠️ **成交表按时间排，订单表按 id 排。**
     *
     * 成交的 `id` 是插入顺序，而**对账补录的行 id 更大、成交时刻更早** ——
     * 按 id 排会让界面上的日期跳来跳去（用户原话：「历史成交里面日期显示错乱」）。
     * 订单没有这个问题：它的 id 顺序与创建顺序一致，补录也不改顺序。
     */
    return timeOf
      ? all.sort((a, b) => {
          const ta = timeOf(a);
          const tb = timeOf(b);
          return ta === tb ? b.id - a.id : tb.localeCompare(ta);
        })
      : all.sort((a, b) => b.id - a.id);
  }, [loaded, polled.data, live, traderId, timeOf]);

  /**
   * 下一页的游标 = **手里最小的 id**，也就是"比我现在有的都更早"。
   *
   * 只统计**服务端给过的行**（已加载的 + 本轮轮询的第一页），不含推送：
   * 推送来的行是"最新的那些"，服务端那一份才是连续的，游标必须锚在连续的那一段上。
   * 被切掉的那条探针行 id 比游标更小，所以下一次翻页会把探针行当作新一页的第一条
   * 正常取回来 —— 不重不漏，代价只是每次多取一行。
   */
  const cursor = useMemo(() => {
    /*
     * 游标 = **手里最早的那一行**。按 id 排时取最小 id；按时间排时取最早的时刻
     * （两者都要带上 id：同一毫秒上可能有多行，服务端的复合游标靠 id 破平）。
     */
    let earliest: T | null = null;
    const consider = (row: T): void => {
      if (earliest === null) {
        earliest = row;
        return;
      }
      const older = timeOf ? timeOf(row) < timeOf(earliest) : row.id < earliest.id;
      if (older) earliest = row;
    };
    for (const row of loaded) consider(row);
    for (const row of (polled.data ?? []).slice(0, PAGE_SIZE)) consider(row);
    return earliest as T | null;
  }, [loaded, polled.data, timeOf]);

  /**
   * 还有没有更早的。
   *
   * - 服务端给过一个**不满一页**的下一页（`done`）→ 没有；
   * - 最近一次下一页是满页，或者轮询的第一页是满的（说明下面还有）→ 有；
   * - 第一页本来就不满 26 条 → 没有了，直接显示终点。
   */
  const hasMore = moreState !== 'done' && (deeperFull || (polled.data?.length ?? 0) > PAGE_SIZE);

  /**
   * 取下一页（更早的 25 行），追加到下面。
   *
   * 游标是"手里**最旧的那一行**"，不是偏移量，所以**不会**因为这会儿又落了一单而错位：
   * 新行一定落在游标**之上**（id 更大、时间更新）。
   *
   * ⚠️ **成交表要同时给 `beforeClosedAt`**：服务端按 `closed_at` 排序，
   * 而补录行的 id 更大、时间更早 —— 只用 id 做游标会把它们整个跳过（页边界漏行）。
   */
  const loadMore = useCallback(async (opts?: { silent?: boolean }) => {
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
    /*
     * ⚠️ **自动填充视口时不进入 `loading` 状态**（`silent`）。
     *
     * 这是用户报的那个"不停闪烁"的根因。表格刚挂上时只有 3 行、视口远没填满，
     * 哨兵一直在观察范围内，于是：
     *
     *     观察器挂上 → 立刻 loadMore → moreState: idle→loading→idle
     *       → effect 重跑 → 观察器又挂 → 又立刻 loadMore → …… 直到「已到最早一笔」
     *
     * 每循环一轮，底部那句「正在加载更早的订单…」就出现又消失一次 —— 用户的原话是
     * 「页面不停闪烁／加载」。而他并没有滚，这个提示本来就不该出现。
     *
     * `silent` 只跳过 `loading` 这个**可见状态**，请求照发、防重入照旧
     * （`moreAbortRef` 与下面的 abort 判断都不受影响）。
     */
    if (!opts?.silent) setMoreState('loading');
    setMoreError(null);

    try {
      const page = await fetchRef.current(requestedFor, {
        limit: PAGE_LIMIT,
        before: cursor.id,
        ...(timeOf ? { beforeClosedAt: timeOf(cursor) } : {}),
        signal: controller.signal,
      });
      // 机器人已经切走（或组件已卸载）：这一页属于上一个列表，直接丢掉。
      if (controller.signal.aborted || traderIdRef.current !== requestedFor) return;

      // 显示前 25 条，最后那条探针留给下一次翻页（它会成为新一页的第一条）。
      setLoaded((prev) => mergeById(prev, page.slice(0, PAGE_SIZE)));
      setDeeperFull(page.length > PAGE_SIZE);
      // 不满一页 = 已经到最早一笔。那条"多要一条"的探针就是为这一句存在的。
      setMoreState(page.length > PAGE_SIZE ? 'idle' : 'done');
    } catch (error) {
      if (controller.signal.aborted) return;
      // 失败**必须**看得见并且能重试：静默停下会让操作者以为"历史只有这么多"。
      setMoreError((error as Error).message);
      setMoreState('error');
    }
  }, [cursor, moreState, traderId, timeOf]);

  /** 观察器回调里用的永远是**最新一次渲染**的 `loadMore`（否则会拿着旧游标再请求一次）。 */
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  /** 表格（滚动框与哨兵）有没有挂上去 —— 观察器要在它出现的那一次重新挂。 */
  const listMounted = rows.length > 0;

  /**
   * 滚到表格底部就取下一页。
   *
   * `root` 必须是表格**自己的滚动框**（理由见 `useTablePaging` 顶部"root"那一节）。
   * `rootMargin` 往下放 240px ≈ 提前几行开始取：滚到最后一行时下一页往往已经拼在
   * 下面了，"正在加载…"不会先闪一下再被内容顶走。
   */
  useEffect(() => {
    /*
     * 只在"还有更早的、而且此刻既没在加载也没出错"时观察：
     * - 加载中不观察：哨兵还在容器视口里，重新观察会立刻再触发一次，打出重复请求；
     * - 出错后不观察：能失败一次的请求会一直失败，自动重试就变成打不停的循环。
     *   这时改由错误行里的"重试"按钮驱动，用户点一次才发一次。
     */
    if (!hasMore || moreState !== 'idle') return;
    const root = scrollerRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        /*
         * 滚动框**还没被填满**（`scrollHeight <= clientHeight`）说明这不是"用户滚到底"，
         * 而是"表格太短、哨兵一开始就可见"。那种情况下静默加载 —— 否则每轮都会让底部
         * 那句「正在加载更早的订单…」闪一次（用户报的闪烁就是这么来的）。
         */
        const notScrollable = root.scrollHeight <= root.clientHeight + 2;
        void loadMoreRef.current({ silent: notScrollable });
      },
      { root, rootMargin: '240px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    /*
     * `listMounted` 必须在依赖里：`hasMore` 变真的那一次提交里，表格可能还没挂上去
     * （数据先到、渲染列表用的状态后到），`scrollerRef.current` 还是 null，
     * 观察器就永远不会被创建。`traderId` 同理：换机器人之后要重新观察新的滚动框。
     *
     * `remountKey` 解决的是第三种情形：节点**被换掉了**而上面几个依赖都没变
     * （切「当前委托」/「订单记录」标签）。见该参数上的说明。
     */
  }, [hasMore, moreState, traderId, listMounted, remountKey]);

  /*
   * 把视口钉住：新行插到表格**顶部**时不把正在读的内容顶走。
   *
   * 这两张表每 15 秒轮询一次，机器人每下一单 / 每平一仓就会在最上面多一行。
   * 操作者正往下翻着看历史时，顶部插进来的那一行会把整张表往下推 ——
   * 屏幕上的字会突然跳一下，"我正在看的那一单"就跑掉了。
   *
   * 做法：拿上一次提交时的**第一行**当锚点（`data-row-id` 是它的 DOM 标记），
   * 量出它这次被推下去了多少像素，就把 `scrollTop` 加同样多。离开顶部才补偿 ——
   * 停在顶部时新行本来就该出现在眼前。
   *
   * 用 `getBoundingClientRect()` 而不是 `offsetTop`：`<tr>` 的 offsetParent 在表格里
   * 并不一定是滚动框，rect 是相对视口的，做差之后与是哪个 offsetParent 无关。
   */
  const geomRef = useRef<{ id: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const anchor = geomRef.current;
    if (anchor && el.scrollTop > 4) {
      const node = el.querySelector<HTMLElement>(`[data-row-id="${anchor.id}"]`);
      if (node) {
        const delta = node.getBoundingClientRect().top - anchor.top;
        if (delta > 0) el.scrollTop += delta;
      }
    }

    // 重新取锚点：第一**行**（表头不是行，没有这个标记），它在下一次提交里依然存在
    // （列表按 id 去重、已加载的行不会消失）。
    const first = el.querySelector<HTMLElement>('[data-row-id]');
    geomRef.current = first ? { id: Number(first.dataset.rowId), top: first.getBoundingClientRect().top } : null;
  }, [rows]);

  return {
    rows,
    loading: polled.loading,
    hasLoadedOnce: polled.updatedAt !== null,
    error: polled.error,
    hasMore,
    moreState,
    moreError,
    /* 重试是**用户明确点的**，所以不静默 —— 他要看到"正在加载"。包一层是因为
       `loadMore` 现在收 `opts`，直接传引用会把点击事件当成参数塞进去。 */
    retry: () => void loadMore(),
    scrollerRef,
    sentinelRef,
  };
}

/**
 * 表格末尾那几行状态：哨兵 + 加载中 + 失败可重试 + 终点。
 *
 * 三件都要看得见。一个"滚到底就没反应了"的加载更多比没有加载更多更糟 ——
 * 操作者会以为历史只有这么多，而事实是刚才那次请求没成功。
 */
function PageTail({
  sentinelRef,
  hasMore,
  moreState,
  moreError,
  onRetry,
  noun,
}: {
  sentinelRef: MutableRefObject<HTMLDivElement | null>;
  hasMore: boolean;
  moreState: MoreState;
  moreError: string | null;
  onRetry: () => void;
  /** 加载文案里的名词：`订单` / `成交`。 */
  noun: string;
}) {
  return (
    <>
      {/*
        哨兵：它进入滚动框的视口（`rootMargin` 提前约 240px）就取下一页。
        放在表格**最后**，所以只有操作者读到最下面时才会触发。
        `h-px` 而不是 `h-0`：零高度的元素在部分浏览器里会被当成"没有盒子"、
        永远不产生交叉，给它 1px 就没有这个歧义（视觉上仍然看不见）。
      */}
      <div ref={sentinelRef} aria-hidden className="h-px w-full" />

      {moreState === 'loading' && (
        <p
          role="status"
          className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-ink-faint"
        >
          <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
          正在加载更早的{noun}…
        </p>
      )}

      {moreState === 'error' && (
        <p role="alert" className="px-3 py-2 text-center text-xs text-down">
          加载更早的{noun}失败{moreError ? `：${moreError}` : ''}
          <button type="button" onClick={onRetry} className="ml-1 text-accent hover:underline">
            重试
          </button>
        </p>
      )}

      {/* 终点：明确说"没有了"，而不是留一个看起来还会加载的空当。 */}
      {!hasMore && <p className="px-3 py-2 text-center text-xs text-ink-faint">已到最早一笔</p>}
    </>
  );
}

/**
 * What a capped table says instead of quietly losing rows.
 *
 * 现在只有**当前持仓**用得到它：持仓数受 `maxPositions` 约束，所以整表拿过来再截断是
 * 安全的。历史成交与订单记录不再截断渲染 —— 它们按游标分页，屏幕上就是"已经加载的全部"，
 * 页脚改由 `PageTail` 说"还有更多 / 已到最早一笔"。
 *
 * The count is stated because "100 of 200" is itself information — the operator
 * learns a cap is in play, rather than assuming the list ends here.
 */
function CapNote({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <p className="border-t border-base-800 px-3 py-2 text-xs text-ink-faint">
      只渲染最近 {shown} 行，共 {total} 行 — 更早的记录请在交易所或导出接口查询，避免一次渲染上千行拖慢页面。
    </p>
  );
}

/**
 * 空表格只留一行。
 *
 * 不用 `ui.Empty`：它的 `py-10` 是给整页空状态用的，放进表格里会在面板中间
 * 留出半屏空白 —— 那正是这次改造要修的东西。空表要说的只有"现在没有"，
 * 以及一句"什么情况下会有"。
 */
function TableEmpty({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3.5 py-2.5">
      <span className="text-base text-ink-lo">{message}</span>
      {hint && <span className="text-xs text-ink-faint">{hint}</span>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Manual-close notice                                                        */
/* -------------------------------------------------------------------------- */


/**
 * 确认并执行手工平仓（单个或全部）。
 *
 * ## 它替换掉了什么
 *
 * 原来这里是一个 `CloseNoticeModal`，标题写着「平仓不可用」、
 * 正文第一句是「该按钮不会下任何订单」。
 *
 * **那比"按钮不响应"更糟** —— 它是一个明确告诉你"这个按钮没用"的按钮。
 *
 * ## `__all__` 是一个内部哨兵，**绝不该出现在界面上**
 *
 * 第一版我把 `'__all__'` 直接当成"目标"存进 state，于是界面上出现了
 * 「以市价平掉 __all__ 的全部仓位」和「本地没有 __ALL__ 的持仓」——
 * **内部标记漏进了给操作员看的文案**，而且后者还把服务端的错误原样透出来了。
 *
 * 现在哨兵只用于**分支判断**：文案说"全部 N 个持仓"，请求走 `closeAllPositions`。
 *
 * ## 二次确认，但不啰嗦
 *
 * 平仓是破坏性操作，要确认；但确认框只说清"平什么、会怎样"——
 * 操作员按这个按钮时通常正在亏钱，那是他们最不需要读长文的时刻。
 */
function ClosePositionModal({
  traderId,
  target,
  symbols,
  onClose,
  onDone,
}: {
  traderId: number;
  /** `null` = 关闭；`'__all__'` = 全部；其他 = 该币种。**只在内部用，不显示。** */
  target: string | null;
  /** 当前持仓的币种列表 —— 用来把"全部"说成"全部 2 个持仓"而不是一个哨兵。 */
  symbols: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ closed: string[]; stillRunning: boolean } | null>(null);

  // 每次打开都清掉上一次的结果 —— 否则会看到上一次的成交结果。
  useEffect(() => {
    if (target !== null) {
      setError(null);
      setResult(null);
    }
  }, [target]);

  if (target === null) return null;

  const isAll = target === '__all__';
  /** 给操作员看的名字。**哨兵到这里就结束了。** */
  const label = isAll ? `全部 ${symbols.length} 个持仓` : target;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isAll) {
        const response = await api.closeAllPositions(traderId);
        setResult({ closed: response.closed, stillRunning: response.stillRunning });
      } else {
        const response = await api.closePosition(traderId, target);
        setResult({ closed: [target], stillRunning: response.stillRunning });
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isAll ? '全部平仓' : '手工平仓'}
      width="max-w-md"
      footer={
        result ? (
          <Button onClick={onClose}>关闭</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button variant="danger" onClick={submit} disabled={busy}>
              {busy ? '正在平仓…' : '确认平仓'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3">
        {result ? (
          <>
            <div className="rounded-md border border-up/50 bg-up/10 px-3 py-2 text-base font-semibold text-up">
              {result.closed.length === 0
                ? '没有需要平掉的持仓。'
                : `已平仓：${result.closed.join('、')}。`}
            </div>
            {result.stillRunning && (
              /*
               * 机器人还在跑，它下一个周期可能重新开仓。
               * **那不是 bug、是它的工作** —— 但操作员需要知道，
               * 否则会以为自己的平仓没生效。
               */
              <p className="text-base leading-relaxed text-warn">
                机器人<strong>仍在运行</strong>，它可能在下一个决策周期重新开出仓位。
                如果不想让它再开，请先「停止」机器人。
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-base leading-relaxed text-ink-hi">
              以<strong>市价</strong>平掉 <span className="font-semibold">{label}</span>
              的全部仓位，并撤掉对应的止损与止盈单。
            </p>
            {isAll && symbols.length > 0 && (
              <p className="text-xs leading-relaxed text-ink-mid">
                将依次平掉：{symbols.join('、')}
              </p>
            )}
            <p className="text-xs leading-relaxed text-ink-faint">
              成交价以交易所实际回报为准，这里无法预知滑点。
            </p>
            {error && <ErrorNote>{error}</ErrorNote>}
          </>
        )}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Positions                                                                  */
/* -------------------------------------------------------------------------- */

function distancePercent(entry: number, level: number | null): string | null {
  if (level === null || entry === 0) return null;
  const percent = ((level - entry) / entry) * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
}

export function PositionsTable({
  traderId,
  onCloseRequest,
  onSelectSymbol,
}: {
  traderId: number;
  onCloseRequest: (symbol: string) => void;
  /** 点击币种名时把它送到上面的行情图表（可选；不传就是纯文本）。 */
  onSelectSymbol?: (symbol: string) => void;
}) {
  const live = useEvents((s) => s.byTrader[traderId]?.positions);
  const query = usePolled((signal) => api.traderPositions(traderId, signal), {
    intervalMs: 5000,
    deps: [traderId],
  });

  const positions: PositionView[] = live ?? query.data ?? [];

  /*
   * 同 `OrdersTable` 的理由：**光看 `loading` 会闪**。
   * `usePolled` 在组件重挂载时把 `loading` 从 true 重新开始，而 `updatedAt` 一旦
   * 有值就说明"这个 hook 成功拿到过数据"——用后者当"从没加载过"的判据。
   * 外面再套一层延迟：快的时候不显示转圈，避免"出现又消失"的跳变。
   */
  const showSpinner = useDelayedSpinner(query.loading && query.updatedAt === null && positions.length === 0);

  /* 同 `OrdersTable`：**没成功拿到过数据时不能断言"暂无"** —— 那是一个结论。 */
  if (query.updatedAt === null && positions.length === 0) {
    if (showSpinner) return <Spinner3 label="正在加载持仓" />;
    return <div className="py-8" aria-hidden />;
  }

  if (positions.length === 0) {
    return <TableEmpty message="暂无持仓。" hint="模型选择空仓 — 没有符合条件的标时不会下任何订单。" />;
  }

  const shown = positions.slice(0, MAX_ROWS);

  return (
    <div>
      {/* max-h as well as the cap: 100 position rows is still taller than any
          screen, and the tab bar above must stay reachable. */}
      <div className="scroll-x max-h-[34vh] overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
            <tr>
              <th className="th">合约 / 方向</th>
              <th className="th">保证金模式</th>
              <th className="th text-right">数量</th>
              <th className="th text-right">名义</th>
              <th className="th text-right">保证金</th>
              <th className="th text-right">开仓价</th>
              <th className="th text-right">标记价</th>
              <th className="th text-right">止盈</th>
              <th className="th text-right">止损</th>
              <th className="th text-right">强平价</th>
              <th className="th text-right">未实现盈亏</th>
              <th className="th text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((position) => {
              const missingStop = position.stopLoss === null || position.stopLoss === undefined;
              const stopDistance = position.stopLoss ? distancePercent(position.entryPrice, position.stopLoss) : null;
              const targetDistance = position.takeProfit ? distancePercent(position.entryPrice, position.takeProfit) : null;

              return (
                <tr key={position.id} className="row-hover align-top">
                  <td className="td">
                    <div className="flex items-center gap-2">
                  <SymbolCell symbol={position.symbol} onSelect={onSelectSymbol} />
                      <SideBadge side={position.side} />
                      <Badge tone="muted" title="该持仓在交易所使用的杠杆倍数。">
                        {position.leverage}x
                      </Badge>
                      {missingStop && (
                        <Badge tone="down" title="该持仓没有交易所侧止损。">
                          无止损
                        </Badge>
                      )}
                    </div>
                    <div className="num mt-0.5 text-xs text-ink-faint">
                      持仓 {fmtDuration((Date.now() - new Date(position.openedAt).getTime()) / 60_000)}
                    </div>
                  </td>

                  {/*
                    ⚠️ **这一列原来是「数量 / 名义 / 保证金」三行挤一格。**
                    
                    用户的原话：「不要弄成三列，每个类目**单独弄成一个项目（列）**。
                    因为页面很空旷（左右空间很多），**能拆分就拆分**方便查看，
                    而且不会导致空间不够用」。
                    
                    拆开是有道理的：三者是**三个不同的量**（数量是张数、名义是敞口、
                    保证金是真金），挤在一格里时谁都无法一眼扫读、也没法纵向对比
                    不同持仓的同项。拆成独立列后，每一列都能**沿着列往下比**。
                  */}
                  <td className="td">
                    {/*
                      保证金模式（全仓 / 逐仓）—— 与订单记录那一列同源同措辞。
                      
                      ⚠️ `PositionView.marginType` 是**实时读自交易所**的当前配置
                      （`/fapi/v2/positionRisk`），不是历史快照。持仓这里它就是
                      "此刻的模式"，所以没有订单表那种"历史行取不到"的问题；
                      读不到（机器人没跑、或该字段缺失）时显示 `—`，**不默认成全仓**。
                    */}
                    <Badge
                      tone="muted"
                      title={
                        position.marginType
                          ? `该持仓在交易所的保证金模式：${marginModeLabel(position.marginType)}。实时读自交易所。`
                          : '暂时读不到该持仓的保证金模式（机器人未运行、或交易所未返回该字段）。'
                      }
                    >
                      {position.marginType ? marginModeLabel(position.marginType) : '—'}
                    </Badge>
                  </td>

                  <td className="td num text-right">{fmtQty(position.quantity)}</td>

                  <td className="td num text-right">{fmtUsd(position.notional, 2)}</td>

                  <td
                    className="td num text-right"
                    title="该仓位占用的保证金（本金）= 名义价值 ÷ 杠杆。"
                  >
                    {fmtUsd(position.marginUsed, 2)}
                  </td>

                  <td className="td num text-right">{fmtPrice(position.entryPrice)}</td>

                  <td className="td num text-right">{fmtPrice(position.markPrice)}</td>

                  <td className="td num text-right">
                    <div className="text-base text-up">
                      {position.takeProfit ? fmtPrice(position.takeProfit) : '无'}
                    </div>
                    {targetDistance && <div className="text-xs text-ink-faint">{targetDistance}</div>}
                  </td>

                  <td className="td num text-right">
                    <div className={`text-base ${missingStop ? 'font-semibold' : ''} text-down`}>
                      {position.stopLoss ? fmtPrice(position.stopLoss) : '无'}
                    </div>
                    {stopDistance && <div className="text-xs text-ink-faint">{stopDistance}</div>}
                  </td>

                  <td className={`td num text-right ${position.liquidationPrice ? 'text-warn' : 'text-ink-faint'}`}>
                    {position.liquidationPrice ? fmtPrice(position.liquidationPrice) : '—'}
                  </td>

                  <td className={`td num text-right ${pnlColor(position.unrealizedPnl)}`}>
                    {fmtUsdSigned(position.unrealizedPnl, 2)}
                    <div className="text-xs">{fmtPercent(position.unrealizedPnlPercent)}</div>
                  </td>

                  <td className="td text-right">
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => onCloseRequest(position.symbol)}
                      title="查看手工平仓的说明"
                    >
                      平仓
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <CapNote shown={shown.length} total={positions.length} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Orders (open / all)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Binance order states that will never change again.
 *
 * `NEW` and `PARTIALLY_FILLED` are the only genuinely live ones; everything
 * else is history, so an "open orders" view filters on exactly that.
 *
 * `FINISHED` is the **Algo** API's word for "this conditional order is done"
 * (see `binance/types.ts`'s `BinanceAlgoStatus`), and it belongs here for a
 * concrete reason: `orders.status` stores whichever vocabulary the endpoint
 * that created the row speaks. A stop that fired reports `FINISHED`, and since
 * this set did not contain it, a settled stop stayed in 「当前委托」 claiming to
 * be 已挂单 — the same display defect as a row that was never reconciled, just
 * wearing a different code. `TRIGGERED` stays out on purpose: the market order
 * it creates still has to fill.
 *
 * 服务端 `store/repositories.ts` 的 `TERMINAL_ORDER_STATUSES` 是同一份判据的另一份
 * 实现（前端不能 import 服务端），两处要一起改。
 */
const TERMINAL_STATUSES = new Set([
  'FILLED',
  'FINISHED',
  'CANCELED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
  'EXPIRED_IN_FUTURES',
]);

/**
 * 表格里的**币种单元格**：有色、（可选的）可点击。
 *
 * ## 为什么是一个共用组件
 *
 * 四张表（持仓 / 委托 / 成交 / 订单记录）都要显示币种名，此前各写一遍 ——
 * 于是"有的能点、有的不能"这种分叉迟早发生。**同一屏上的同一个概念只能有一个实现**
 * （这条教训在本文件里已经因为订单数吃过一次）。
 *
 * ## 颜色是辅助，不是信息
 *
 * 色相由 `symbolTone` 按名称哈希得到：同一个币种永远是同一个颜色。
 * 但它只是帮眼睛定位，**身份仍然由文字承担** —— 所以颜色不参与任何判断，也不表示涨跌。
 */
function SymbolCell({
  symbol,
  onSelect,
}: {
  symbol: string;
  onSelect?: (symbol: string) => void;
}) {
  const tone = symbolTone(symbol);
  /*
   * 没有回调时退化成纯文本：表格被用在不需要跳转的地方时（比如策略体检报告），
   * 一个点不动的按钮比一段文字更糟。
   */
  if (!onSelect) {
    return <span style={{ color: tone }}>{symbol}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onSelect(symbol)}
      title={`在行情图表里查看 ${symbol}`}
      className="-mx-1 rounded px-1 transition hover:bg-base-800"
      style={{ color: tone }}
    >
      {symbol}
    </button>
  );
}

export function isOpenOrder(order: OrderRecord): boolean {
  return !TERMINAL_STATUSES.has(order.status.toUpperCase());
}

/* -------------------------------------------------------------------------- */
/*  保证金占用（本金）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 成交行的保证金占用：**服务端字段优先，行数据兜底**。
 *
 * `TradeRecord.marginUsed` 是**可选**的（服务端算不出来时干脆不给这个字段，见
 * `domain.ts` 里那段说明），所以留一条兜底：`|数量 × 开仓价| ÷ 杠杆` ——
 * 三个输入都在这一行上。优先用服务端那一份，是为了**报价来源唯一**：成交价最终以
 * 交易所回报为准，前端再拿 `entryPrice` 自己乘一遍，等于让同一个量有两个算法 ——
 * 而"两个算法"迟早会在某一笔上分岔，那时没人说得清哪个对。
 *
 * 兜底**也不把"算不出来"伪造成一个数字**：杠杆 ≤ 0、价格 / 数量为 0 或不是有限数时
 * 回 `null` → 表格显示 `—`。判据与服务端 `marginUsedOrUndefined()` 逐条对齐 ——
 * 否则服务端说"算不出来"、前端兜底却给出一个数，`—` 的含义就被前端自己破坏了。
 */
function tradeMarginUsed(trade: TradeRecord): number | null {
  if (typeof trade.marginUsed === 'number' && Number.isFinite(trade.marginUsed)) return trade.marginUsed;
  const { quantity, entryPrice, leverage } = trade;
  if (!Number.isFinite(leverage) || leverage <= 0) return null;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(quantity)) return null;
  if (entryPrice === 0 || quantity === 0) return null;
  return Math.abs(entryPrice * quantity) / Math.max(leverage, 1);
}

/**
 * 「保证金占用」列的口径说明 —— 与 `PositionsTable` 那一列**同一条措辞**。
 * 同一屏里同一个量只能有一种说法，否则操作员会怀疑它们是不是两个东西。
 */
const MARGIN_USED_TITLE = '该仓位占用的保证金（本金）= 名义价值 ÷ 杠杆。';

/**
 * 委托那一列的主语是"委托"而不是"仓位"，所以按 `OrderRecord.marginUsed` 的口径另起一句：
 * 开仓单是这一笔自己的保证金，平仓 / 保护单取它所属持仓的。后半句说明 `—` 的含义 ——
 * 这个数由服务端给出，**没有这个数不等于这个数是 0**。
 */
const ORDER_MARGIN_USED_TITLE =
  '该委托涉及的保证金（本金）：开仓单是这一笔自己占用的，平仓 / 保护单取所属持仓占用的。— 表示服务端算不出这个数（例如被拒的单、没有对应本地持仓的单），不是 0。';

/**
 * 「保证金模式」列的口径说明 —— 用户的原话是「订单记录里面显示：全仓\逐仓」。
 *
 * 两句话分别说清"这是什么"与"两种模式的区别"，不写"保证金模式"四个字了事：
 * 全仓与逐仓的差别**是风险差别**（一个亏光整个钱包、一个只亏这一仓的保证金），
 * 而这一列的存在意义就是让操作员一眼看出这个仓位是不是在动整个账户的钱。
 */
const ORDER_MARGIN_MODE_TITLE =
  '该标的的保证金模式。全仓 = 整个合约钱包共同承担这一仓的亏损；逐仓 = 这一仓最多亏掉自己那份保证金。';

/**
 * 这一格的值是**哪来的** —— 两种口径不能共用一句话。
 *
 * `order` 是落库的历史快照（`orders.margin_type`，迁移 v14），可以当证据；
 * `position` 是**此刻**从交易所读到的账户配置，**回答不了"那张单当时是什么模式"** ——
 * 悬停说明必须把这件事说出来，否则以后有人会拿它当历史证据（这正是这个仓库
 * 在 `marginUsed` 那次学到的：同一屏上两个口径长得一样，就会被当成同一个数）。
 */
const ORDER_MARGIN_MODE_SOURCE_TITLE = {
  order: '下单当时该标的的保证金模式（下单那一刻由服务端记下，取自交易所确认过的配置）。',
  position:
    '这张单落库时没有记下保证金模式（迁移之前的历史行，或该标的的模式从未成功设置过）。这里显示的是该标的**当前**的账户配置 —— 实时读自交易所，不是下单那一刻的快照，不能当历史证据。',
  /* 两个来源都没有 —— 说清为什么是空的，而不是让它看起来像一个渲染错误。 */
  none: '这一行没有保证金模式的记录：它可能是迁移之前的历史行，该标的的模式也可能从未成功设置过，而且它现在没有持仓可供读取。— 表示"不知道"，不是"全仓"。',
} as const;

/**
 * 「保证金模式」那一格：`全仓` / `逐仓` / `—`。
 *
 * 抽成一个组件（而不是在行内写三元）是因为它有**三态 + 两种来源**，而行内那个位置
 * 已经被状态列的注释占满了；口径判断本身在 `orderMarginMode()` 里（纯函数、有测试）。
 *
 * ## 两种入参，对应两张表
 *
 * · **订单表**给 `order`：那里的问题"这张单当时是什么模式"存在**两种来源**
 *   （落库快照优先、当前持仓兜底），走 `orderMarginMode()`；
 * · **成交表**给 `mode`：后端已经 `LEFT JOIN orders` 把入场单的模式带出来了，
 *   只有一个来源 —— **不做兜底**。补录的回合（进程没运行时平的仓）本来就没有
 *   对应的本地订单行，用"当前配置"顶上会把"不知道"说成一个看起来很确定的值。
 */
function MarginModeCell({
  order,
  mode,
  symbol,
  liveBySymbol,
}: {
  order?: OrderRecord;
  /** 后端已经带出来的值（成交表走这条）。可能缺失。 */
  mode?: MarginMode;
  /** 该行对应的标的 —— 用于"当前持仓"兜底（成交表也走这条）。 */
  symbol?: string;
  liveBySymbol?: ReadonlyMap<string, MarginMode> | null;
}) {
  if (order) {
    const resolved = orderMarginMode(order, liveBySymbol);
    if (resolved === null) {
      return (
        <span className="text-ink-faint" title={ORDER_MARGIN_MODE_SOURCE_TITLE.none}>
          —
        </span>
      );
    }
    return (
      <span
        title={
          resolved.source === 'order'
            ? ORDER_MARGIN_MODE_SOURCE_TITLE.order
            : ORDER_MARGIN_MODE_SOURCE_TITLE.position
        }
      >
        {marginModeLabel(resolved.mode)}
      </span>
    );
  }

  /* 后端带了值 → 那是**当时**的、可信的。 */
  if (mode !== undefined) {
    return <span title={TRADE_MARGIN_MODE_TITLE.known}>{marginModeLabel(mode)}</span>;
  }

  /*
   * 没有落库值 → 看该标的**现在**有没有持仓。
   *
   * ⚠️ 这一路和订单表共用同一套判断（`TRADE_MARGIN_MODE_TITLE.position` 明确写出
   * "这是当前配置、不是快照"），理由是**用户看到一片 `—` 会以为功能坏了** ——
   * 而这批历史行在迁移之前本来就没记过这个字段，全都取不到。
   * 兜底能让他看到"这个标的现在是逐仓"，同时措辞里说清它不能当历史证据。
   */
  const fallback = symbol ? liveBySymbol?.get(symbol) : undefined;
  if (fallback !== undefined) {
    return <span title={TRADE_MARGIN_MODE_TITLE.position}>{marginModeLabel(fallback)}</span>;
  }

  return (
    <span className="text-ink-faint" title={TRADE_MARGIN_MODE_TITLE.none}>
      —
    </span>
  );
}

/**
 * 成交表那一格的措辞。
 *
 * 三种来源必须**分别**说清，否则读者分不清哪一行可信：
 *  · `known`    —— 入场订单落库的配置，**是当时的值**；
 *  · `position` —— 落库值缺失时用该标的**当前**的配置兜底，**不是快照**；
 *  · `none`     —— 两者都拿不到，`—` 表示"不知道"，不是"全仓"。
 */
const TRADE_MARGIN_MODE_TITLE = {
  known: '该回合入场时的保证金模式，取自入场订单落库的配置 —— 这是**当时**的值。',
  position:
    '这张成交的入场订单没有记下保证金模式（迁移之前的历史行，或该标的的模式从未成功设置过）。' +
    '这里显示的是该标的**当前**的账户配置 —— 实时读自交易所，不是成交当时的快照，不能当历史证据。',
  none:
    '这一行没有保证金模式的记录：入场订单在迁移之前（没有这一列），' +
    '或者这一笔是补录的（机器人没运行时平的仓，没有对应的本地订单行），' +
    '而且该标的现在没有持仓可供读取。— 表示"不知道"，不是"全仓"。',
} as const;

export function OrdersTable({
  paging,
  onlyOpen,
  positionCount,
  onSelectSymbol,
  collapsed = false,
  liveMarginModes,
}: {
  /*
   * 行数据由**容器**（`TraderTables`）持有，不在这里自己拉。
   *
   * 理由不是"架构好看"，而是标签上那个「当前委托 N」与这张表必须说同一件事：
   * 它们以前各读一份数据（标签读 WebSocket 推来的 `order` 事件，表格读 REST 的第一页），
   * 于是刚打开页面时标签是 0、表格里却有十几行。行数据只有一份，就不可能再有第二个数。
   *
   * 只拉**第一页**（26 = 25 + 一条探针），每 15 秒一次。以前是 `traderOrders(id, 200)`：
   * 无论有没有人看，每 15 秒把 200 行宽订单重新拼一遍响应、重新渲染一遍 DOM。
   * 更早的行由 `useTablePaging` 在操作者滚到底时按 `before=id` 游标取回，
   * 轮询的返回值只**并进**已加载的那些行，不会把它们重置掉。
   */
  paging: TablePaging<OrderRecord>;
  onlyOpen: boolean;
  /** 本地持仓数：判断"这张看起来还挂着的单"能不能被相信，见状态列上的标注。 */
  positionCount: number;
  /** 点击币种名时把它送到上面的行情图表（可选；不传就是纯文本）。 */
  onSelectSymbol?: (symbol: string) => void;
  /**
   * 收起态：**只把滚动框的 `max-height` 改小**，不动 DOM 结构。
   *
   * 为什么不卸载表格，见 `COLLAPSED_MAX_H` 那段说明 —— 这个 `ref` 同时是分页观察器的
   * `root`，卸载重挂会让哨兵失去观察者（或者反过来被误判为可见）。
   * 「当前委托」不传（它是行动面板，默认就该看得全）。
   */
  collapsed?: boolean;
  /**
   * 保证金模式的**兜底来源**：当前持仓的 `symbol → marginType`（`PositionView.marginType`）。
   *
   * 只在 `order.marginType`（落库的历史快照）缺失时才被用到，见 `orderMarginMode()`。
   * 映射由容器（`TraderTables`）建一次给两张订单表共用 —— 每行各建一次会变成 O(行数 × 持仓数)。
   */
  liveMarginModes?: ReadonlyMap<string, MarginMode> | null;
}) {
  const all: OrderRecord[] = paging.rows;
  const orders = onlyOpen ? all.filter(isOpenOrder) : all;

  /*
   * ⚠️ **"暂无"是一个结论，结论要有依据 —— 数据还在路上时不能说。**
   *
   * 实测的真实序列（MutationObserver 逐次记录，刷新后点「当前委托」）：
   *
   *     spinner                 400ms
   *     1/LTCUSDT多|—|0.288     ← 默认标签的持仓表漏了一帧
   *     empty-orders            ← ⚠️「暂无当前委托。」——**那时数据还在路上**
   *     spinner                 又转圈
   *     4/2026-09-|LTCUSDT|止盈  ← 这才是真正的委托
   *
   * 用户看到的就是 `empty-orders` ↔ 数据的跳变，加上持仓表的闪现 —— 他形容为
   * 「错位 + 频率高，仿佛多个重叠」。
   *
   * 所以这里分三步，各自都有依据：
   *   ① 还没成功拿到过数据 → **保留加载占位**（延迟 350ms 才显示转圈；
   *      在此之前给一个撑住高度的空盒子，**没有视觉跳变**）；
   *   ② 拿过数据、当前确实没有行 → 这时才可以显示「暂无」；
   *   ③ 有行 → 显示表格。
   */
  const showSpinner = useDelayedSpinner(paging.loading && !paging.hasLoadedOnce && all.length === 0);

  if (!paging.hasLoadedOnce && all.length === 0) {
    if (showSpinner) return <Spinner3 label="正在加载委托" />;
    /*
     * 转圈还没到显示时机 —— 给一个**占位**而不是"暂无"。
     * 高度与空状态接近，避免表格区域在数据到达时发生布局跳动。
     */
    return <div className="py-8" aria-hidden />;
  }

  if (orders.length === 0) {
    return onlyOpen ? (
      <TableEmpty message="暂无当前委托。" hint="交易所侧的止损 / 止盈单在触发前会出现在这里。" />
    ) : (
      <TableEmpty message="暂无订单记录。" />
    );
  }

  return (
    <div>
      {/*
        14 columns: this is the table that most needs its own horizontal
        scroller rather than a page-wide one.

        `max-h-[34vh] overflow-y-auto` 同时是**分页观察器的 root**（`paging.scrollerRef`）：
        行高超过 60vh 之后是**这个盒子**在滚，不是页面。观察错了对象，
        哨兵会在"没滚到底"时就被判为可见，于是一口气把整段历史拉进来。

        收起态换的是**这一个 class**（`COLLAPSED_MAX_H`），节点、`ref`、观察器都不换 ——
        理由见 `COLLAPSED_MAX_H`。
      */}
      <div
        ref={paging.scrollerRef}
        className={`scroll-x ${collapsed ? COLLAPSED_MAX_H : EXPANDED_MAX_H} overflow-y-auto`}
      >
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
            <tr>
              <th className="th">时间</th>
              <th className="th">交易对</th>
              <th className="th">用途</th>
              <th className="th">方向</th>
              <th className="th">类型</th>
              <th className="th text-right">数量</th>
              {/* 保证金紧跟在"数量"后面：它和数量、价格是同一组的三个量，
                  隔着"触发价 / 已成交"去看会让人以为它属于后者。 */}
              <th className="th text-right" title={ORDER_MARGIN_USED_TITLE}>
                {BALANCE_LABEL.marginUsed}
              </th>
              {/* 保证金模式紧跟在「保证金占用」后面：两者说的是同一件风险的两面
                  （压了多少本金 / 这笔本金亏光之后会不会牵连别的仓位）。
                  放在"交易对"旁边也说得通，但那里已经隔着一个用途徽章了。 */}
              <th className="th" title={ORDER_MARGIN_MODE_TITLE}>
                保证金模式
              </th>
              <th className="th text-right">价格</th>
              <th className="th text-right">触发价</th>
              <th className="th text-right">已成交</th>
              <th className="th text-right">均价</th>
              <th className="th">状态</th>
              <th className="th">错误</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              /*
               * 这张"还挂着"的单，现在能不能被相信？
               *
               * `orders.status` 是**下单那一刻**交易所给的返回值，之后由服务端的对账
               * （`AutoTrader.settleStaleOrders()`）在确认"交易所已经不挂着了"之后改写。
               * 也就是说界面上的 `NEW` 只代表"上一次对账之后它还是这个状态"。
               *
               * 判据故意取得很窄，宁可少标也不要错标：只有**整本账都没有持仓**时，
               * 一张仍然写着挂单的委托才值得怀疑（实盘上那 16 行孤儿委托，每一个标的的
               * 本地持仓都是 0）。有持仓时保护单本来就该挂在那里，标上去只会制造假警报 ——
               * 而假警报和数据缺失一样会让这个界面失去信任。
               *
               * ⚠️ **但入场单不算可疑 —— 它在成交之前，整本账本来就是空的。**
               *
               * 这正是上面那条判据唯一抓错的地方：一张**限价入场单**从挂出到成交
               * 之间必然没有持仓，那是它的**正常状态**，不是"账本可能错了"。
               * 把它标成「待对账」，等于给每一张刚挂出的单都挂上一个"数据可能不对"
               * 的警告，而这个警告会一直挂到它成交或被撤（最长 `pendingEntryTimeoutMinutes`）。
               *
               * 实测（用户连着两次问到这里）：一张 `03:23:14` 挂出的 HYPEUSDT 限价单，
               * 界面上写着「已挂单（待对账）」，他问的是"这个不是系统应该自动自主
               * 实时处理的吗"。答案是：**它本来就在正常等待，没有任何东西需要处理。**
               *
               * 真正可疑的是**保护单**：有止损/止盈挂着、而整本账没有任何持仓 ——
               * 那才是"委托与持仓对不上"。所以只对那两种用途保留这个标记。
               *
               * 入场单成交之后由谁纠正？`applyExchangeFill()`（成交推送到达即对账）
               * 与 `settleStaleOrders()`（对账兜底），两条路都在服务端 ——
               * **界面不需要用一个警告去替它们兜底**，那只会让操作员学会忽略这个颜色。
               */
              const pendingReconcile = needsReconcileFlag({
                onlyOpen,
                stillOpen: isOpenOrder(order),
                purpose: order.purpose,
                positionCount,
              });

              /*
               * ⚠️ **成交数量已经等于下单数量时，这一单就是成交了 —— 不管 `status` 那一刻写的是什么。**
               *
               * 实测一条真实的市价开仓单：交易所返回
               * `{"status":"NEW","executedQty":"0.000","avgPrice":"0.00"}`，而**持仓那边
               * 确实出现了那个数量**。于是表格里出现了自相矛盾的一行 ——
               * 「状态」列写着**已挂单**（读 `status`），而同一行的「已成交」列写着
               * **0.009**、均价 **2634.32**（读 `filled_qty` / `avg_price`）。
               *
               * **一个自己跟自己打架的表格，比少一列更糟**：操作员会去数到底是哪个对，
               * 而正确答案是"这一单已经成交了，只是状态字段没跟上"。
               *
               * 所以这里按**事实**显示：数量对上就是已成交。容差用相对值
               * （交易所会对数量做四舍五入，不保证位级相等），与 `autoTrader`
               * 里 `fullyExecuted`、以及 `broker.ts` 里 `normalizeStandard` 的终态判据
               * **同一口径** —— 三处对"什么算成交完了"必须是同一个答案。
               *
               * 排除掉撤销/拒绝/过期：那些状态下即使数量曾经对上，结论也已经变了。
               */
              const fullyFilled =
                order.quantity > 0 &&
                order.filledQty >= order.quantity * (1 - 1e-9) &&
                !/cancel|reject|expired/i.test(order.status);

              return (
                // `data-row-id` 是**给滚动锚点用的 DOM 标记**（见 `useTablePaging` 里那个
                // `useLayoutEffect`）：新订单插到顶部时要靠它量出"我正在读的那一行"被推了多远。
                <tr key={order.id} className="row-hover" data-row-id={order.id}>
                  <td className="td num text-ink-faint">{fmtDateTime(order.createdAt)}</td>
                    <td className="td font-semibold"><SymbolCell symbol={order.symbol} onSelect={onSelectSymbol} /></td>
                  <td className="td">
                    <Badge tone={purposeTone(order.purpose)}>{orderPurposeLabel(order.purpose)}</Badge>
                  </td>
                  <td className={`td font-semibold ${order.side === 'BUY' ? 'text-up' : 'text-down'}`}>
                    {order.side === 'BUY' ? '买入' : '卖出'}
                  </td>
                  <td className="td text-ink-lo">{orderTypeLabel(order.type)}</td>
                  <td className="td num text-right">{fmtQty(order.quantity)}</td>
                  {/* `OrderRecord.marginUsed` 是**可选**字段：服务端算不出这一行对应的保证金时
                      就不给（被拒的单、没有对应本地持仓的单…）。所以这一格必须显示 `—`
                      而不是 `0` —— `fmtUsd(undefined)` 是 `—`、`fmtUsd(0)` 是 `$0.00`，
                      这两件事在任何时候都不能混。 */}
                  <td className="td num text-right">{fmtUsd(order.marginUsed, 2)}</td>
                  {/*
                    保证金模式：落库值优先，当前持仓兜底（见 `orderMarginMode()`）。

                    ⚠️ **`—` 不是「全仓」。** 币安的默认确实是全仓，但"默认是"与
                    "我们读到了"是两件事 —— 把没读到的行渲染成「全仓」等于替交易所
                    宣布一个我们没验证过的事实。所以两个来源都拿不到时只画 `—`，
                    并用 `title` 说明为什么空。
                  */}
                  <td className="td">
                    <MarginModeCell order={order} liveBySymbol={liveMarginModes} />
                  </td>
                  <td className="td num text-right">{order.price ? fmtPrice(order.price) : '市价'}</td>
                  <td className="td num text-right text-ink-lo">{order.stopPrice ? fmtPrice(order.stopPrice) : '—'}</td>
                  <td className="td num text-right">{fmtQty(order.filledQty)}</td>
                  <td className="td num text-right">{order.avgPrice ? fmtPrice(order.avgPrice) : '—'}</td>
                  <td className="td">
                    {/* `order.status` 是币安自己的机器码（NEW / FILLED / …），
                        中文标签在 `@aq/shared` 的 ORDER_STATUS_LABELS —— 之前这里
                        直接把英文码打在表格里。

                        `pendingReconcile` 的那一行不写「已挂单」而写「待对账」：
                        本地这一列可能比交易所落后一轮，界面没有资格替交易所打包票。 */}
                    <span
                      title={
                        pendingReconcile
                          ? `交易所状态 ${order.status}（由上一次对账写入）。当前本地没有任何持仓记录，这张委托可能已经成交或被撤销，等下一次对账确认。`
                          : fullyFilled
                            ? `成交数量 ${fmtQty(order.filledQty)} 已等于下单数量 ${fmtQty(order.quantity)}，所以这一单实质已成交 —— 尽管交易所那一刻返回的状态是 ${order.status}。`
                            : order.status
                      }
                      className={
                        pendingReconcile
                          ? 'text-warn'
                          : isOpenOrder(order)
                            ? 'text-up'
                            : /cancel|reject|expired/i.test(order.status)
                              ? 'text-warn'
                              : 'text-ink-mid'
                      }
                    >
                      {pendingReconcile
                        ? `${orderStatusLabel(order.status)}（待对账）`
                        : fullyFilled
                          ? '已成交'
                          : orderStatusLabel(order.status)}
                    </span>
                  </td>
                  <td className="td max-w-[240px] truncate text-down" title={order.error ?? undefined}>
                      {order.error ? exchangeErrorLabel(order.error) : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {/* 末尾状态（哨兵 / 加载中 / 失败可重试 / 已到最早一笔）必须在滚动框**里面**：
            哨兵要和滚动框这个 root 比较，放到框外面等于永远不交叉。 */}
        <PageTail
          sentinelRef={paging.sentinelRef}
          hasMore={paging.hasMore}
          moreState={paging.moreState}
          moreError={paging.moreError}
          onRetry={paging.retry}
          noun="订单"
        />
      </div>
    </div>
  );
}

function purposeTone(purpose: string): 'accent' | 'neutral' | 'down' | 'up' | 'warn' {
  switch (purpose) {
    case 'entry':
      return 'accent';
    case 'stop_loss':
      return 'down';
    case 'take_profit':
      return 'up';
    case 'adjustment':
      return 'warn';
    default:
      return 'neutral';
  }
}

/* -------------------------------------------------------------------------- */
/*  Trades                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 「对账补录」这个来源**不在表格里显示**，只在悬停该行时给出说明。
 *
 * ## 为什么把徽章去掉了
 *
 * 这里原来给补录的行挂一个橙色徽章、外加整行 `bg-warn/5` 的黄色底。理由是
 * 「看见徽章说明实时记账漏了一笔，那是操作员该知道的」—— **那个假设是错的**：
 *
 *  · 那笔成交是**真实的**（交易所的成交历史里有它），盈亏也**算得对**；
 *  · 「补录」只说明**系统是怎么知道它的**（进程当时没在跑，事后从成交历史核对出来），
 *    不说明账本有问题、更不需要操作员做任何事；
 *  · 而**当初真正值得报警的那个 bug 已经修了** —— 运行中触发的止损曾被记成
 *    `reconciled`（对账两遍的顺序反了），现在运行期的原因优先。今天还落在这个
 *    来源里的，只剩"机器人停着的时候交易所侧止盈/止损被触发"这一种正常情形。
 *
 * 所以它是一个**开发信号**，不是操作信号：开发要看"补录率"来判断记账有没有漏，
 * 而操作员看到一行黄色的 `对账补录` 只会以为出了故障。**把维护者的仪表装到
 * 操作员的界面上，代价是让正常状态看起来像异常** —— 而一个经常误报的界面，
 * 在真的出事时也没人看。
 *
 * 保留 `title`：需要的时候（比如排查）把鼠标放上去仍然能看到来源。
 */
const RECONCILED_TITLE =
  '这笔在机器人未运行期间平仓（例如交易所侧的止盈被触发），成交与盈亏取自交易所的成交历史，是真实记录。';

export function TradesTable({
  traderId,
  refreshToken,
  onSelectSymbol,
  collapsed = false,
  paging: providedPaging,
  liveMarginModes,
}: {
  traderId: number;
  refreshToken?: number;
  /** 点击币种名时把它送到上面的行情图表（可选；不传就是纯文本）。 */
  onSelectSymbol?: (symbol: string) => void;
  /** 收起态：只把滚动框的 `max-height` 改小 —— 理由见 `COLLAPSED_MAX_H`。 */
  collapsed?: boolean;
  /**
   * 由**容器**预取好的分页实例。不传时组件内部自己建一套（向后兼容）。
   *
   * ⚠️ **为什么需要它：数据要是切过去才开始拉，就一定会闪。**
   *
   * 实测（headed 真实窗口，切到「历史成交」）：
   *
   *     23381ms  空白            ← 组件刚挂载
   *     23732ms  转圈            ← ⚠️ 这时才在请求数据
   *     24067ms  trades 25行
   *
   * 而「当前委托」不闪，因为它的数据在**容器**里、页面加载时就已经拿到了。
   * 两者差的就是"什么时候开始请求"。
   */
  paging?: TablePaging<TradeRecord>;
  /**
   * 「保证金模式」的**兜底来源**：当前持仓的 `symbol → marginType`。
   *
   * 迁移 v14 之前的成交没有这一列，届时用该标的**现在**的配置顶一下（措辞里
   * 写明"不是快照"）—— 否则整张历史表会是一片 `—`，用户会以为功能没生效。
   * 与订单表共用容器里建好的那一份映射，不各自建。
   */
  liveMarginModes?: ReadonlyMap<string, MarginMode> | null;
}) {
  const live = useEvents((s) => s.byTrader[traderId]?.trades);
  /*
   * 只拉**第一页**（26 = 25 + 一条探针），每 15 秒一次 —— 以前是 `traderTrades(id, 200)`。
   * 成交行是最宽的一张（毛/净盈亏、两侧手续费、资金费、两个订单号），
   * 更早的行由 `useTablePaging` 在滚到底时按 `before=id` 游标取回。
   */
  const query = usePolled((signal) => api.traderTrades(traderId, { limit: PAGE_LIMIT, signal }), {
    intervalMs: 15_000,
    deps: [traderId, refreshToken],
  });

  const internalPaging = useTablePaging<TradeRecord>(
    traderId,
    api.traderTrades,
    query,
    live,
    /*
     * ⚠️ **成交表必须按 `closedAt` 排，不能按 id。**
     *
     * 用户的原话：「历史成交里面日期显示错乱（不是完全按时间排序）」。
     * `trades.id` 是插入顺序，而**对账补录的行 id 更大、成交时刻更早** ——
     * 实测 18 行里 4 处乱序，界面上就是日期跳来跳去。
     *
     * 订单表不传这个参数：它的 id 顺序与创建顺序一致，按 id 排本来就是对的。
     */
    (row) => row.closedAt,
  );

  /* 容器给了就用容器的（数据早就到手，不会闪）；没给才用内部那份。 */
  const paging = providedPaging ?? internalPaging;

  // 屏幕上要渲染的全部行 = 轮询的第一页 + 已经翻出来的更早的页 + 推送进来的实时行（按 id 去重）。
  const trades: TradeRecord[] = paging.rows;

  /* 同 `OrdersTable`：只有"从没成功加载过"才显示转圈；再延迟一层，避免出现又消失。 */
  const showSpinner = useDelayedSpinner(query.loading && query.updatedAt === null && trades.length === 0);

  /* 同 `OrdersTable`：数据还在路上时不能下"暂无"的结论。 */
  if (query.updatedAt === null && trades.length === 0) {
    if (showSpinner) return <Spinner3 label="正在加载成交记录" />;
    return <div className="py-8" aria-hidden />;
  }

  if (trades.length === 0) {
    return <TableEmpty message="暂无历史成交。" hint="每笔平仓都会连同平仓原因一起持久化。" />;
  }

  /*
   * Counted on 净盈亏, not on the gross.
   *
   * Commission can turn a nominally positive round-trip into a loss (the live
   * account has one: gross +0.0011, net −0.0187), and the backend's own
   * `wins`/`losses` count the net. Counting the gross here made this header
   * disagree with the 胜率 card above it.
   *
   * 合计覆盖的是**已经加载出来的那些行**（分页之后"已加载"就是屏幕上这一份）。
   * 滚到底会自动把更早的页并进来，于是这里的数字跟着变大；翻到「已到最早一笔」时
   * 它才等于全部历史。所以 `hasMore` 为真时标题里写的是「已加载 N 笔」而不是
   * 「N 笔成交」—— 一个只统计了最近 25 笔的"净额"必须自己说清楚它的口径。
   */
  const wins = trades.filter((trade) => trade.netPnl > 0).length;
  const totals: PnlCosts = trades.reduce<PnlCosts>(
    (sum, trade) => ({
      gross: sum.gross + trade.pnl,
      fees: sum.fees + trade.fee,
      funding: sum.funding - trade.fundingFee,
      net: sum.net + trade.netPnl,
    }),
    { gross: 0, fees: 0, funding: 0, net: 0 },
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-base-800 px-3 py-2 text-xs">
        <span className="text-ink-lo">
          {paging.hasMore ? `已加载 ${trades.length} 笔` : `${trades.length} 笔成交`} ·{' '}
          <span className="text-up">{wins} 盈</span> /{' '}
          <span className="text-down">{trades.length - wins} 亏</span>
        </span>
        {/*
          The gross → net bridge, and it stays inline. Collapsing it into the
          single 净额 figure is the difference between a number the operator
          trusts and one they have to take on faith.
        */}
        <PnlBreakdown costs={totals} />
        <span className={`num ml-auto text-base font-semibold ${pnlColor(totals.net)}`} title={NET_PNL_FORMULA}>
          净额 {fmtUsdSigned(totals.net, 2)}
        </span>
      </div>
      {/* 与订单表同一个滚动框：它既是横向滚动盒，也是分页观察器的 root（见 `useTablePaging`）。
          收起态只换这一个 class（`COLLAPSED_MAX_H`），节点与 `ref` 都不换。 */}
      <div
        ref={paging.scrollerRef}
        className={`scroll-x ${collapsed ? COLLAPSED_MAX_H : EXPANDED_MAX_H} overflow-y-auto`}
      >
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
            <tr>
              <th className="th">交易对</th>
              {/* 方向与杠杆合成一列（`空 5x`）——杠杆只在方向旁边有意义，拆开白占宽度。 */}
              <th className="th">方向 / 杠杆</th>
              <th className="th text-right">数量</th>
              {/* 保证金紧跟在"数量"后面：数量 × 开仓价 ÷ 杠杆 就是它，三个量本来就该挨着。 */}
              <th className="th text-right" title={MARGIN_USED_TITLE}>
                {BALANCE_LABEL.marginUsed}
              </th>
              {/*
                保证金模式紧跟在「保证金占用」后面 —— 与订单表同一处摆放、同一套措辞
                （用户的原话是「历史成交里面也要显示保证金模式（全仓\逐仓）」）。
                两者说的是同一件风险的两面：占了多少本金、以及这笔本金是全仓共担还是逐仓独担。
              */}
              <th className="th" title={TRADE_MARGIN_MODE_TITLE.known}>
                保证金模式
              </th>
              <th className="th text-right">开仓价</th>
              <th className="th text-right">平仓价</th>
              <th className="th text-right">盈亏（毛）</th>
              <th className="th text-right">手续费</th>
              {/* 净盈亏与百分比合成一列 —— 它们永远一起看。 */}
              <th className="th text-right">净盈亏 / %</th>
              <th className="th">平仓原因</th>
              {/*
                持仓时长与平仓时间合成一列。

                两列都是"这笔是什么时候的"，拆开会把表格撑到 14 列（含新增的保证金占用）——
                在常见分辨率下最后一列（平仓时间）需要左右拖动才看得全，
                而那正是操作者最常核对的一列。合成 `3 分 · 09-17 01:44`
                读起来更顺，且直接省掉一整列宽度。
              */}
              <th className="th text-right">持仓 / 平仓时间</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => {
              const costs = tradeCosts(trade);
              const reconciled = trade.source === 'reconciled' || trade.closeReason === 'reconciled';
              /*
               * 这一笔占用的保证金。成交行**能自己算**（服务端字段缺失时用行数据兜底），
               * 因为 `quantity` / `entryPrice` / `leverage` 都在这行上；服务端有值时优先用它
               * —— 见 `tradeMarginUsed`。
               */
              const marginUsed = tradeMarginUsed(trade);
              return (
                // `data-row-id` 给滚动锚点用（见 `useTablePaging` 的 `useLayoutEffect`）。
                <tr
                  key={trade.id}
                  /* 补录来源不再改变整行底色 —— 见 `RECONCILED_TITLE` 的说明。 */
                  className="row-hover"
                  data-row-id={trade.id}
                >
                  <td className="td font-semibold text-ink-hi">
                    <div className="flex items-center gap-1.5">
                      <SymbolCell symbol={trade.symbol} onSelect={onSelectSymbol} />
                    </div>
                  </td>
                  <td className="td whitespace-nowrap">
                    <SideBadge side={trade.side} />
                    <span className="num ml-1 text-ink-faint">{trade.leverage}x</span>
                  </td>
                  <td className="td num text-right">{fmtQty(trade.quantity)}</td>
                  <td className="td num text-right">{fmtUsd(marginUsed, 2)}</td>
                  <td className="td">
                    {/*
                      保证金模式。数据来自后端 `LEFT JOIN orders`（入场订单那一行的
                      `margin_type`）—— 取不到就是 `—`，**不默认成"全仓"**。

                      这里**不做"当前持仓兜底"**：那是订单表才需要的东西。
                      订单表要回答"这张单当时是什么模式"，而历史行的落库值可能缺失，
                      所以用该标的**现在**的配置补一句、并在悬停说明里写明它不是快照。
                      成交表这一格问的是"这一回合当时是什么模式"—— 补录的回合（进程
                      没运行时平的仓）本来就没有对应的本地订单行，用当前配置顶上会把
                      "不知道"说成一个看起来很确定的值。
                    */}
                    <MarginModeCell mode={trade.marginType} symbol={trade.symbol} liveBySymbol={liveMarginModes} />
                  </td>
                  <td className="td num text-right">{fmtPrice(trade.entryPrice)}</td>
                  <td className="td num text-right">{fmtPrice(trade.exitPrice)}</td>
                  {/* The gross stays visible but muted: it is the input to the
                      arithmetic, not the answer. 净盈亏 is the answer. */}
                  <td className="td num text-right text-ink-lo" title={pnlFormulaText(costs)}>
                    {fmtUsdSigned(trade.pnl, 2)}
                  </td>
                  <td className="td num text-right text-warn" title={pnlFormulaText(costs)}>
                    {fmtSigned(-trade.fee, 4)}
                    <div className="text-xs text-ink-faint">
                      开 {fmtSigned(trade.entryFee, 4)} · 平 {fmtSigned(trade.exitFee, 4)}
                    </div>
                    {trade.fundingFee !== 0 && (
                      <div className={`text-xs ${pnlColor(trade.fundingFee)}`} title="资金费：负数表示支付">
                        资 {fmtSigned(trade.fundingFee, 4)}
                      </div>
                    )}
                  </td>
                  <td
                    className={`td num text-right whitespace-nowrap font-semibold ${pnlColor(trade.netPnl)}`}
                    title={pnlFormulaText(costs)}
                  >
                    {fmtUsdSigned(trade.netPnl, 2)}
                    <span className="font-normal opacity-70"> · {fmtPercent(trade.pnlPercent)}</span>
                  </td>
                  <td className="td" title={reconciled ? RECONCILED_TITLE : undefined}>
                    {/* `closeReason` is a persisted machine code; the Chinese
                        label lives in CLOSE_REASON_LABELS only.

                        ⚠️ 这一格**不再因为来源是补录而变黄**：那是一个开发信号
                        （说明记账当时漏了一笔），不是操作信号 —— 这笔成交真实、
                        盈亏正确、也不需要操作员做任何事。见 `RECONCILED_TITLE`。 */}
                    <span className="text-ink-lo">
                      {closeReasonLabel(trade.closeReason, trade.netPnl)}
                    </span>
                  </td>
                  <td className="td num text-right whitespace-nowrap">
                    {fmtDuration(trade.holdMinutes)}
                    <span className="text-ink-faint"> · {fmtDateTime(trade.closedAt)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {/* 末尾状态（哨兵 / 加载中 / 失败可重试 / 已到最早一笔）必须在滚动框**里面**。 */}
        <PageTail
          sentinelRef={paging.sentinelRef}
          hasMore={paging.hasMore}
          moreState={paging.moreState}
          moreError={paging.moreError}
          onRetry={paging.retry}
          noun="成交"
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Container with the toolbar                                                 */
/* -------------------------------------------------------------------------- */

export type TraderTabId = 'positions' | 'orders' | 'trades' | 'history';

/* -------------------------------------------------------------------------- */
/*  历史区高度（收起 / 展开）                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 展开态与收起态的滚动框高度。
 *
 * ## 为什么是 `max-height`，而不是把表格卸载掉（`Collapsible` / `display:none`）
 *
 * 这两张表的滚动框（`paging.scrollerRef`）**同时是分页观察器的 `root`**：
 * 哨兵与它比较，判断"滚到底了没有"。收起时把表格卸载掉的代价是**两次**真实故障：
 *
 *  1. 展开回来时 `sentinelRef` 指向的是一个**新**节点，而观察器 effect 的依赖
 *     （`hasMore` / `moreState` / `traderId` / `listMounted`）一个都没变 → effect 不重跑
 *     → 新哨兵**没有观察者**，"滚到底加载更早的记录"静默失效（下面的 `remountKey`
 *     就是为了这个坑的另一半：节点被换掉时必须让观察器重挂）；
 *  2. `ref` 落在已卸载的节点上时，哨兵会被判成可见 → **一次把整段历史拉进来**，
 *     也就是这次分页改造要修的那个 bug。
 *
 * 所以收起**只改这一个 class**：同一个 DOM 节点、同一个 `ref`、同一个 `root`，
 * React 只更新 `class`，不重挂。
 *
 * ## 而且缩小是**安全**的方向
 *
 * 观察器的 `rootMargin` 是往下 240px。盒子变矮之后，哨兵离 `root` 底边只会**更远**
 * （`contentBottom − scrollTop − clientHeight` 随 `clientHeight` 减小而增大），
 * 所以"收起"在结构上**不可能**多取一页；反过来"展开"才会让哨兵更近一步 ——
 * 那也只是把盒子填满（本来就有的行为）。
 */
const EXPANDED_MAX_H = 'max-h-[34vh]';

/**
 * 收起态：表头 + 3~4 行（16vh 在 900px 高的屏上约 144px）。
 *
 * 够认出"这是哪张表、最近几笔是什么"，又不会把上面刚看过的行情/决策流顶出屏幕。
 * **一行都不隐藏**：行仍然全在框里，往下滚就能看到（哨兵照旧工作）。
 */
const COLLAPSED_MAX_H = 'max-h-[16vh]';

export function TraderTables({
  traderId,
  tab,
  onChange,
  positionCount,
  openOrderCount,
  refreshToken,
  onSelectSymbol,
  positionSymbols,
  onPositionsChanged,
  positionMarginModes,
}: {
  traderId: number;
  tab: TraderTabId;
  onChange: (tab: TraderTabId) => void;
  positionCount: number;
  /**
   * **已废弃，故意不再使用**。
   *
   * 它数的是 WebSocket 推来的 `order` 事件（`store.ts` 的 `live.orders`）里还没到终态的那些：
   * 页面刚打开时它是 **0**（推送只在"页面开着的时候恰好下了单"时才有人写），
   * 而撤单与成交**永远不会**把它删掉。表格读的却是 REST 的第一页 —— 于是截图里
   * 「当前委托 0」下面躺着十六行委托。两个数说的根本不是同一件事。
   *
   * 现在标签与表格读的是同一个数组（见下面的 `ordersPaging`），这个 prop 只为了让
   * 调用方（`TraderPage.tsx`）不用改就能编译。调用方那边还有一个同样口径的
   * 「持仓 / 委托」数字，改它要动 `TraderPage.tsx`，不在本次范围内。
   */
  openOrderCount?: number;
  /**
   * Bumped by the caller after a manual 对账, so the tables refetch instead of
   * waiting out their 15-second poll — the numbers the operator just changed
   * should be the numbers on screen.
   */
  refreshToken?: number;
  /** 点击币种名时把它送到上面的行情图表（可选；不传就是纯文本）。 */
  onSelectSymbol?: (symbol: string) => void;
  /** 当前持仓的币种 —— 弹窗用它把"全部"说成"全部 2 个持仓"。 */
  positionSymbols: string[];
  /** 平仓成功后通知页面立刻重取持仓 —— 否则界面还留着刚平掉的那一行。 */
  onPositionsChanged?: () => void;
  /**
   * 页面手上那份**当前持仓** —— 只用来给订单行的「保证金模式」兜底。
   *
   * ## 为什么是持仓数组而不是一个现成的 Map
   *
   * 页面已经有一份 `positions`（`/account` 的实时读数，30 秒轮询），直接把它原样传下来
   * 最简单：调用处一行、不需要在渲染里 `new Map(...)`。映射在这里用 `useMemo` 建一次，
   * 两张订单表共用。**请传稳定的数组引用**（同一份 state，不要在调用处 `.map()` 出新数组），
   * 否则 `useMemo` 每次渲染都会重建。
   *
   * ## 为什么它只是"兜底"
   *
   * 这些值的口径是**当前账户配置**（实时读交易所），不是下单当时的快照 ——
   * 历史问题由 `OrderRecord.marginType`（落库值）回答。两个来源的先后与措辞
   * 都在 `orderMarginMode()` / `ORDER_MARGIN_MODE_SOURCE_TITLE` 里定死了。
   *
   * 不传 = 没有兜底（历史行显示 `—`），表格照常工作。
   */
  positionMarginModes?: ReadonlyArray<{ symbol: string; marginType?: MarginMode | null }>;
}) {
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [ordersRefreshToken, setOrdersRefreshToken] = useState(0);

  /**
   * `positionMarginModes` → `symbol → marginType`，供两张订单表给「保证金模式」兜底。
   *
   * 认不出的值（`undefined`、或交易所将来给出的新写法）**不进这张表** ——
   * 进不去就是"没有这个事实"，那张单显示 `—`。这里不补默认值。
   */
  const liveMarginModes = useMemo(() => {
    const map = new Map<string, MarginMode>();
    for (const position of positionMarginModes ?? []) {
      if (position.marginType === 'cross' || position.marginType === 'isolated') {
        map.set(position.symbol, position.marginType);
      }
    }
    return map;
  }, [positionMarginModes]);
  // One token drives both tables: the toolbar ⟳ and the caller's 对账 both mean
  // "these rows are stale".
  const token = (refreshToken ?? 0) + ordersRefreshToken;

  /**
   * 这两张表就是用户抱怨的那两个栏目：行数**没有天然上界**（每下一单、每平一仓就多一行），
   * 点开就占掉半个屏幕。所以只有它们有收起态。
   *
   * 「当前委托」刻意**不**给这个开关：它是**行动面板**（对着它撤单、确认保护单），
   * 行数受挂单数约束，默认就该看得全；给每个标签都塞一个高度开关只会让人多想一步。
   */
  const isHeavyTab = tab === 'trades' || tab === 'history';

  /**
   * 历史区是不是收起了。**一个开关同时管两张表**：它们是同一个问题的两面，
   * 操作者点一次「收起」要的是"这两栏都别再占半屏" —— 切标签时仍然紧凑，
   * 不必每换一个标签再点一次。
   */
  const [historyCollapsed, setHistoryCollapsed] = useState(false);

  /**
   * 「表格区域」的两个 DOM 范围 —— 工具栏与表格区，一起算作"里面"。
   *
   * 分成两个 `ref`（而不是把两者包进一个新 div）是刻意的：这一层的 DOM 结构不动，
   * 就不会有任何一行布局跟着变。工具栏**必须**算在里面，否则点「刷新」会被当成
   * "点了外面"，表格在操作者正要继续看它的时候缩掉。
   */
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const tableAreaRef = useRef<HTMLDivElement | null>(null);

  /**
   * 点表格区域之外 → 历史区**自动收起**（用户建议的那条，但**不切标签**）。
   *
   * 用户的原话是"点开以后占太多高度，得手动点回当前持仓才能缩回去"。照他的建议
   * 跳回「当前持仓」会把操作者正在看的那一栏**换掉** —— 他只是想让它矮一点，
   * 不是想离开。所以这里做的是**收起**：位置还在、数据还在，一键就能展开回来。
   *
   * ## 什么情况下**不**收起（宁可不动，也不要打断正当操作）
   *
   *  · **只认左键**（`button !== 0` 一律忽略）：右键是"刚打开上下文菜单"或"正在拖拽"，
   *    中键是滚动 —— 都不是"我看完了"；
   *  · 按下的位置在面板**里面**（工具栏、表头、行、行内按钮、滚动条）→ 完全不管：
   *    滚动、点币种跳行情图、按「平仓」、从表格里往外拖选文字，**起点都在里面**。
   *    这也是为什么监听 `pointerdown`（按下的那一刻）而不是 `click`：拖选文字的
   *    起点在表格里、终点在外面，`click` 会把它当成"点了外面"；
   *  · **任何对话框开着**→ 不管：平仓确认框是 Radix 的 portal，DOM 上本来就落在面板之外，
   *    点遮罩关掉它不该顺手把表格也收了；
   *  · 本来就已经收起 / 当前不是历史类标签 → 监听器根本不挂。
   */
  useEffect(() => {
    if (!isHeavyTab || historyCollapsed) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (toolbarRef.current?.contains(target) || tableAreaRef.current?.contains(target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      setHistoryCollapsed(true);
    };
    // 捕获阶段挂：内层的 `stopPropagation` 管不到它，判断只看"按在了谁身上"。
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [isHeavyTab, historyCollapsed]);

  /*
   * 委托数据**唯一的一份**，容器持有。
   *
   * 它同时喂给两个地方：表格的行、以及标签上的「当前委托 N」。以前这两处各读一份
   * （标签读 WebSocket 的 `order` 事件、表格读 REST），于是它们可以互相矛盾 ——
   * 而"上面写 0、下面列十六行"这种矛盾正好发生在这个系统最需要被相信的地方。
   * 一份数据、一个数组，不一致在结构上就不再可能。
   *
   * 代价是这一轮询问在切到别的标签时也会发生（以前只有订单表挂载时才拉）。
   * 25 行的一页、15 秒一次，换来的是标签上的数字与表格永远一致。
   */
  const liveOrders = useEvents((s) => s.byTrader[traderId]?.orders);
  const ordersQuery = usePolled(
    (signal) => api.traderOrders(traderId, { limit: PAGE_LIMIT, signal }),
    { intervalMs: 15_000, deps: [traderId, token] },
  );
  const ordersPaging = useTablePaging<OrderRecord>(
    traderId,
    api.traderOrders,
    ordersQuery,
    liveOrders,
    /*
     * 没有时间排序（订单的 id 顺序就是创建顺序），所以第 5 个参数不传 —— 但第 6 个
     * （重挂信号）必须传：这张表在「当前委托」与「订单记录」两处各挂一次，
     * `tab` 一变 DOM 就被换掉而观察器 effect 不会自己重跑。见 `useTablePaging` 的 `remountKey`。
     */
    undefined,
    tab,
  );
  const openOrders = ordersPaging.rows.filter(isOpenOrder);

  /*
   * 成交数据**也在容器里预取**，理由同上面那一段 —— 但这里还有一条更直接的教训。
   *
   * ⚠️ 原来成交表的数据是**在 `TradesTable` 组件内部**拉的，于是：
   * **数据要等你切过去那一刻才开始请求**，界面必然经历「空白 → 转圈 → 数据」三段跳。
   *
   * 实测（headed 真实窗口，切到「历史成交」）：
   *
   *     23381ms  空白      ← 组件刚挂载
   *     23732ms  转圈      ← 这时才发起请求
   *     24067ms  trades 25行
   *
   * 而「当前委托」不闪，因为它的数据一直在这里、页面加载时就已经拿到。
   * 两者差的不是样式，是"**什么时候开始请求**"。
   */
  const liveTrades = useEvents((s) => s.byTrader[traderId]?.trades);
  const tradesQuery = usePolled(
    (signal) => api.traderTrades(traderId, { limit: PAGE_LIMIT, signal }),
    { intervalMs: 15_000, deps: [traderId, token] },
  );
  const tradesPaging = useTablePaging<TradeRecord>(
    traderId,
    api.traderTrades,
    tradesQuery,
    liveTrades,
    /* 成交按 `closedAt` 排 —— 理由见 `TradesTable` 里那一段（日期错乱的事故）。 */
    (row) => row.closedAt,
    tab,
  );

  const tabs: Array<{ id: TraderTabId; label: string; count?: number }> = [
    { id: 'positions', label: '当前持仓', count: positionCount },
    // 与表格同一个数组，见上面 `ordersPaging` 的说明。
    { id: 'orders', label: '当前委托', count: openOrders.length },
    { id: 'trades', label: '历史成交' },
    { id: 'history', label: '订单记录' },
  ];

  return (
    <Panel padded={false} bodyClassName="p-0">
      <div
        ref={toolbarRef}
        className="flex flex-wrap items-center gap-2 border-b border-base-800 px-3 py-2"
      >
        {/* Real tab semantics, so the arrow keys and the tab order work. */}
        <div role="tablist" aria-label="机器人数据表" className="flex items-center gap-0.5">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => onChange(item.id)}
              className={
                tab === item.id
                  ? '-mb-px border-b-2 border-accent px-3 py-1.5 text-base font-semibold text-ink-hi'
                  : '-mb-px border-b-2 border-transparent px-3 py-1.5 text-base text-ink-lo transition hover:text-ink-mid'
              }
            >
              {item.label}
              {item.count !== undefined && <span className="num ml-1.5 text-xs text-ink-faint">{item.count}</span>}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="danger"
            disabled={positionCount === 0}
            title={positionCount === 0 ? '当前没有持仓' : '查看手工平仓的说明'}
            onClick={() => setCloseTarget('__all__')}
          >
            全部平仓
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOrdersRefreshToken((n) => n + 1)} title="立即刷新表格数据">
            刷新
          </Button>
          {/*
            历史区的收起 / 展开。与 `TraderPage.tsx` 权益曲线那个按钮**同一套交互语言**：
            `variant="ghost" size="sm"` + `aria-expanded` + 文案跟着状态走。

            放在工具栏而不是各表内部：两张历史表是**同一个开关**，而"同一屏上的同一个概念
            只能有一个实现"是这个文件自己的纪律（四张表各写一遍币种单元格吃过一次亏）。
            收起后的手上动作也只有一步 —— 不用点回「当前持仓」。
          */}
          {isHeavyTab && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={!historyCollapsed}
              title={
                historyCollapsed
                  ? '把历史表展开到完整高度（更早的记录仍然在表格里往下滚）'
                  : '把历史表收成几行，给上面的行情 / 决策流让出高度'
              }
              onClick={() => setHistoryCollapsed((collapsed) => !collapsed)}
            >
              {historyCollapsed ? '展开全部' : '收起'}
            </Button>
          )}
        </div>
      </div>

      {/* 空表格不占位：`min-h` 曾经给这一区留了 220px，于是"暂无持仓"下面跟着
          一片空白。高度交给内容，有行时才需要滚动。

          这个 `ref` 只用于"点击区域之外"的判断（见上面那个 `useEffect`），不参与布局。 */}
      <div ref={tableAreaRef}>
        {/*
          ⚠️ **`onSelectSymbol` 必须传** —— 漏过一次。

          `PositionsTable` 一直支持点击币种跳转行情图（它内部用的就是下面三张表同一个
          `SymbolCell`），但这一行**没有把它传进去**：委托表、成交表、订单记录都传了，
          持仓表漏了。于是四张表里唯独最上面那张点了没反应 —— 而它恰恰是操作员最想
          看行情的那一张（手上正拿着这个仓位）。

          `onSelectSymbol` 是可选的，所以漏传**不会报错**，只会静默失去功能。
          这正是四个调用点里最容易漏掉第三个的原因。
        */}
        {tab === 'positions' && (
          <PositionsTable
            traderId={traderId}
            onCloseRequest={setCloseTarget}
            onSelectSymbol={onSelectSymbol}
          />
        )}
        {/*
          两个标签共用同一个分页实例：它们读的是同一个端点，只是过滤条件不同；
          分开两套只会让翻出来的历史与"当前委托"的数字再次分家。

          ⚠️ **这里原来写成了两个并列的 `{tab === 'orders' && …}{tab === 'history' && …}`，
          那会让两个标签之间有 25 行一闪而过的残留。**

          实测（1600px 视口，点「当前委托」后每 30ms 采一次 DOM）：

              0ms   行=25   ← 还是「订单记录」的内容
              30ms  行= 2   ← 才换成「当前委托」

          成因：两个 `&&` 分支虽然渲染的是同一个组件类型，但它们**在 JSX 里是两个不同的
          位置** —— `tab` 一变，React 把旧的那个**卸载**、新的那个**挂载**，卸载发生在先，
          而浏览器的下一帧仍可能画出旧 DOM。用户的描述是「点进去会快速闪烁出现一堆订单，
          闪完以后又恢复正常」。

          合并成一个条件之后，React 在同一个位置看到**同一个组件类型**，于是**复用同一个实例**
          （只更新 props），中间不存在"旧表格还在、新表格还没上"的那一帧。

          两处的差异只有 `onlyOpen` 与 `collapsed` —— 把它们写成 `tab` 的表达式即可，
          不需要两个 JSX 分支。
        */}
        {(tab === 'orders' || tab === 'history') && (
          <OrdersTable
            paging={ordersPaging}
            onlyOpen={tab === 'orders'}
            positionCount={positionCount}
            onSelectSymbol={onSelectSymbol}
            /*
             * 只有「历史」那侧才有收起态：「当前委托」是行动面板（对着它撤单、
             * 确认保护单），行数受挂单数约束，默认就该看得全 —— 见 `isHeavyTab`。
             */
            collapsed={tab === 'history' ? historyCollapsed : undefined}
            liveMarginModes={liveMarginModes}
          />
        )}
        {tab === 'trades' && (
          <TradesTable
            traderId={traderId}
            refreshToken={token}
            onSelectSymbol={onSelectSymbol}
            collapsed={historyCollapsed}
            /* 容器预取好的那份 —— 切过来时数据已在手上，不会经历"空白 → 转圈"。 */
            paging={tradesPaging}
            /* 「保证金模式」的兜底来源，与订单表共用同一份映射。 */
            liveMarginModes={liveMarginModes}
          />
        )}
      </div>

      {/*
        平仓后要刷新的是**三样东西**，不只是订单表。

        第一版我只加了 `setOrdersRefreshToken` —— 于是手工平仓成功后
        持仓行还留在「当前持仓」里（用户实测报回来的就是这个）。
        `positionCount` 是页面从 WebSocket 里算的，它有自己的更新节奏，
        **不能指望它"过一会儿自己会好"**：操作员按了平仓、界面却还显示着那个仓，
        他会以为没平掉，然后再按一次。
      */}
      <ClosePositionModal
        traderId={traderId}
        target={closeTarget}
        symbols={positionSymbols}
        onClose={() => setCloseTarget(null)}
        onDone={() => {
          setOrdersRefreshToken((n) => n + 1);
          onPositionsChanged?.();
        }}
      />
    </Panel>
  );
}
