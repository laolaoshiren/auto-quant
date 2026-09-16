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
 *    `.scroll-x` box, so a 13-column order table never pushes the page wide
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
import type { OrderRecord, PositionView, TradeRecord } from '@aq/shared';
import { orderPurposeLabel, orderStatusLabel, orderTypeLabel } from '@aq/shared';
import { api } from '../lib/api';
import { useEvents } from '../lib/store';
import { usePolled } from '../lib/hooks';
import { Badge, Button, Modal, Panel, Spinner3 } from './ui';
import { SideBadge } from './Badges';
import { closeReasonLabel } from '../lib/summaries';
import {
  NET_PNL_FORMULA,
  PnlBreakdown,
  pnlFormulaText,
  tradeCosts,
  type PnlCosts,
} from './PnlBreakdown';
import { fmtDateTime, fmtDuration, fmtPercent, fmtPrice, fmtQty, fmtSigned, fmtUsd, fmtUsdSigned, pnlColor } from '../lib/format';

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
}

/** 一页怎么取。两张表的差别只有一个 API 函数，所以做成参数。 */
type PageFetcher<T> = (
  traderId: number,
  options: { limit: number; before?: number | null; signal?: AbortSignal },
) => Promise<T[]>;

interface TablePaging<T> {
  /** 屏幕上要渲染的全部行：轮询的第一页 + 翻出来的每一页 + 推送进来的实时行，按 id 倒序去重。 */
  rows: T[];
  loading: boolean;
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
 * 这两张表的滚动条在 `<div class="scroll-x max-h-[60vh] overflow-y-auto">` 里
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
    return [...merged.values()].sort((a, b) => b.id - a.id);
  }, [loaded, polled.data, live, traderId]);

  /**
   * 下一页的游标 = **手里最小的 id**，也就是"比我现在有的都更早"。
   *
   * 只统计**服务端给过的行**（已加载的 + 本轮轮询的第一页），不含推送：
   * 推送来的行是"最新的那些"，服务端那一份才是连续的，游标必须锚在连续的那一段上。
   * 被切掉的那条探针行 id 比游标更小，所以下一次翻页会把探针行当作新一页的第一条
   * 正常取回来 —— 不重不漏，代价只是每次多取一行。
   */
  const cursor = useMemo(() => {
    let min: number | null = null;
    for (const row of loaded) if (min === null || row.id < min) min = row.id;
    for (const row of (polled.data ?? []).slice(0, PAGE_SIZE)) {
      if (min === null || row.id < min) min = row.id;
    }
    return min;
  }, [loaded, polled.data]);

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
   * 游标是"手里最小的 id"，不是偏移量，所以**不会**因为这会儿又落了一单而错位：
   * 新行的 id 一定更大，永远落在游标之上。
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
      const page = await fetchRef.current(requestedFor, {
        limit: PAGE_LIMIT,
        before: cursor,
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
  }, [cursor, moreState, traderId]);

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
        if (entries.some((entry) => entry.isIntersecting)) void loadMoreRef.current();
      },
      { root, rootMargin: '240px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    /*
     * `listMounted` 必须在依赖里：`hasMore` 变真的那一次提交里，表格可能还没挂上去
     * （数据先到、渲染列表用的状态后到），`scrollerRef.current` 还是 null，
     * 观察器就永远不会被创建。`traderId` 同理：换机器人之后要重新观察新的滚动框。
     */
  }, [hasMore, moreState, traderId, listMounted]);

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
    error: polled.error,
    hasMore,
    moreState,
    moreError,
    retry: loadMore,
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

const CLOSE_EXPLANATION = [
  '本控制台没有手工平仓的功能：后端不提供手动平仓接口。',
  '持仓由机器人自己了结，只有三条路径：模型在下一个决策周期给出平仓决定；交易所侧的止损 / 止盈单被触发；回撤守卫在浮盈大幅回吐时以市价平仓。',
  '如果你想立刻结束某个持仓，请先在交易所手动平掉它，然后停止该机器人 — 机器人检测到持仓消失后会记录为“外部平仓”。',
];

function CloseNoticeModal({
  symbol,
  onClose,
}: {
  symbol: string | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={symbol !== null}
      onClose={onClose}
      title={symbol === '__all__' ? '全部平仓不可用' : `平仓 ${symbol ?? ''} 不可用`}
      width="max-w-lg"
      footer={<Button onClick={onClose}>知道了</Button>}
    >
      <div className="space-y-2">
        <div className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-base font-semibold text-warn">
          该按钮不会下任何订单。
        </div>
        {CLOSE_EXPLANATION.map((line) => (
          <p key={line} className="text-base leading-relaxed text-ink-mid">
            {line}
          </p>
        ))}
        <p className="text-xs leading-relaxed text-ink-faint">
          这里保留按钮是为了让“我想立刻平掉”这个需求有一个明确的答案，而不是一条静默失败的请求。
        </p>
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
}: {
  traderId: number;
  onCloseRequest: (symbol: string) => void;
}) {
  const live = useEvents((s) => s.byTrader[traderId]?.positions);
  const query = usePolled((signal) => api.traderPositions(traderId, signal), {
    intervalMs: 5000,
    deps: [traderId],
  });

  const positions: PositionView[] = live ?? query.data ?? [];

  if (query.loading && positions.length === 0) return <Spinner3 label="正在加载持仓" />;
  if (positions.length === 0) {
    return <TableEmpty message="暂无持仓。" hint="模型选择空仓 — 没有符合条件的标时不会下任何订单。" />;
  }

  const shown = positions.slice(0, MAX_ROWS);

  return (
    <div>
      {/* max-h as well as the cap: 100 position rows is still taller than any
          screen, and the tab bar above must stay reachable. */}
      <div className="scroll-x max-h-[60vh] overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
            <tr>
              <th className="th">合约 / 方向</th>
              <th className="th text-right">数量 / 价值</th>
              <th className="th text-right">开仓价格 / 标记价格</th>
              <th className="th">止盈 / 止损</th>
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
                      <span className="text-base font-semibold text-ink-hi">{position.symbol}</span>
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

                  <td className="td num text-right">
                    {fmtQty(position.quantity)}
                    <div className="text-xs text-ink-faint">
                      名义 <span className="text-ink-lo">{fmtUsd(position.notional, 2)}</span>
                    </div>
                  </td>

                  <td className="td num text-right">
                    {fmtPrice(position.entryPrice)}
                    <div className="text-xs text-ink-faint">标记 {fmtPrice(position.markPrice)}</div>
                  </td>

                  <td className="td">
                    <div className="num text-base text-up">
                      {position.takeProfit ? fmtPrice(position.takeProfit) : '无'}
                      {targetDistance && <span className="ml-1 text-xs text-ink-faint">{targetDistance}</span>}
                    </div>
                    <div className={`num text-base ${missingStop ? 'font-semibold text-down' : 'text-down'}`}>
                      {position.stopLoss ? fmtPrice(position.stopLoss) : '无'}
                      {stopDistance && <span className="ml-1 text-xs text-ink-faint">{stopDistance}</span>}
                    </div>
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
 */
const TERMINAL_STATUSES = new Set([
  'FILLED',
  'CANCELED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
  'EXPIRED_IN_FUTURES',
]);

export function isOpenOrder(order: OrderRecord): boolean {
  return !TERMINAL_STATUSES.has(order.status.toUpperCase());
}

export function OrdersTable({
  traderId,
  onlyOpen,
  refreshToken,
}: {
  traderId: number;
  onlyOpen: boolean;
  refreshToken?: number;
}) {
  const live = useEvents((s) => s.byTrader[traderId]?.orders);
  /*
   * 只拉**第一页**（26 = 25 + 一条探针），每 15 秒一次。以前这里是 `traderOrders(id, 200)`：
   * 无论有没有人看，每 15 秒把 200 行宽订单重新拼一遍响应、重新渲染一遍 DOM。
   * 更早的行由 `useTablePaging` 在操作者滚到底时按 `before=id` 游标取回，
   * 轮询的返回值只**并进**已加载的那些行，不会把它们重置掉。
   */
  const query = usePolled((signal) => api.traderOrders(traderId, { limit: PAGE_LIMIT, signal }), {
    intervalMs: 15_000,
    deps: [traderId, refreshToken],
  });

  const paging = useTablePaging<OrderRecord>(traderId, api.traderOrders, query, live);

  const all: OrderRecord[] = paging.rows;
  const orders = onlyOpen ? all.filter(isOpenOrder) : all;

  if (query.loading && all.length === 0) return <Spinner3 label="正在加载委托" />;
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
        12 columns: this is the table that most needs its own horizontal
        scroller rather than a page-wide one.

        `max-h-[60vh] overflow-y-auto` 同时是**分页观察器的 root**（`paging.scrollerRef`）：
        行高超过 60vh 之后是**这个盒子**在滚，不是页面。观察错了对象，
        哨兵会在"没滚到底"时就被判为可见，于是一口气把整段历史拉进来。
      */}
      <div ref={paging.scrollerRef} className="scroll-x max-h-[60vh] overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
            <tr>
              <th className="th">时间</th>
              <th className="th">交易对</th>
              <th className="th">用途</th>
              <th className="th">方向</th>
              <th className="th">类型</th>
              <th className="th text-right">数量</th>
              <th className="th text-right">价格</th>
              <th className="th text-right">触发价</th>
              <th className="th text-right">已成交</th>
              <th className="th text-right">均价</th>
              <th className="th">状态</th>
              <th className="th">错误</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              // `data-row-id` 是**给滚动锚点用的 DOM 标记**（见 `useTablePaging` 里那个
              // `useLayoutEffect`）：新订单插到顶部时要靠它量出"我正在读的那一行"被推了多远。
              <tr key={order.id} className="row-hover" data-row-id={order.id}>
                <td className="td num text-ink-faint">{fmtDateTime(order.createdAt)}</td>
                <td className="td font-semibold text-ink-hi">{order.symbol}</td>
                <td className="td">
                  <Badge tone={purposeTone(order.purpose)}>{orderPurposeLabel(order.purpose)}</Badge>
                </td>
                <td className={`td font-semibold ${order.side === 'BUY' ? 'text-up' : 'text-down'}`}>
                  {order.side === 'BUY' ? '买入' : '卖出'}
                </td>
                <td className="td text-ink-lo">{orderTypeLabel(order.type)}</td>
                <td className="td num text-right">{fmtQty(order.quantity)}</td>
                <td className="td num text-right">{order.price ? fmtPrice(order.price) : '市价'}</td>
                <td className="td num text-right text-ink-lo">{order.stopPrice ? fmtPrice(order.stopPrice) : '—'}</td>
                <td className="td num text-right">{fmtQty(order.filledQty)}</td>
                <td className="td num text-right">{order.avgPrice ? fmtPrice(order.avgPrice) : '—'}</td>
                <td className="td">
                  {/* `order.status` 是币安自己的机器码（NEW / FILLED / …），
                      中文标签在 `@aq/shared` 的 ORDER_STATUS_LABELS —— 之前这里
                      直接把英文码打在表格里。 */}
                  <span
                    title={order.status}
                    className={
                      isOpenOrder(order) ? 'text-up' : /cancel|reject|expired/i.test(order.status) ? 'text-warn' : 'text-ink-mid'
                    }
                  >
                    {orderStatusLabel(order.status)}
                  </span>
                </td>
                <td className="td max-w-[240px] truncate text-down" title={order.error ?? undefined}>
                  {order.error ?? ''}
                </td>
              </tr>
            ))}
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
 * Why a row carries the 对账补录 badge.
 *
 * The position certainly closed — the exchange's own history says so — but the
 * bot was not running to observe which order did it, so the round-trip was
 * rebuilt afterwards. Seeing the badge means live bookkeeping missed a close,
 * which is exactly the thing an operator should know about.
 */
const RECONCILED_TITLE =
  '该持仓在机器人未运行期间平仓（例如交易所侧止盈被触发），本行由对账从交易所的成交历史补录，实时记账当时漏掉了它。';

export function TradesTable({ traderId, refreshToken }: { traderId: number; refreshToken?: number }) {
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

  const paging = useTablePaging<TradeRecord>(traderId, api.traderTrades, query, live);

  // 屏幕上要渲染的全部行 = 轮询的第一页 + 已经翻出来的更早的页 + 推送进来的实时行（按 id 去重）。
  const trades: TradeRecord[] = paging.rows;

  if (query.loading && trades.length === 0) return <Spinner3 label="正在加载成交记录" />;
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
      funding: sum.funding + trade.fundingFee,
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
      {/* 与订单表同一个滚动框：它既是横向滚动盒，也是分页观察器的 root（见 `useTablePaging`）。 */}
      <div ref={paging.scrollerRef} className="scroll-x max-h-[60vh] overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 border-b border-base-800 bg-base-850">
            <tr>
              <th className="th">交易对</th>
              <th className="th">方向</th>
              <th className="th text-right">杠杆</th>
              <th className="th text-right">数量</th>
              <th className="th text-right">开仓价</th>
              <th className="th text-right">平仓价</th>
              <th className="th text-right">盈亏（毛）</th>
              <th className="th text-right">手续费</th>
              <th className="th text-right">净盈亏</th>
              <th className="th text-right">净盈亏 %</th>
              <th className="th">平仓原因</th>
              <th className="th text-right">持仓时长</th>
              <th className="th">平仓时间</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => {
              const costs = tradeCosts(trade);
              const reconciled = trade.source === 'reconciled' || trade.closeReason === 'reconciled';
              return (
                // `data-row-id` 给滚动锚点用（见 `useTablePaging` 的 `useLayoutEffect`）。
                <tr
                  key={trade.id}
                  className={reconciled ? 'row-hover bg-warn/5' : 'row-hover'}
                  data-row-id={trade.id}
                >
                  <td className="td font-semibold text-ink-hi">
                    <div className="flex items-center gap-1.5">
                      <span>{trade.symbol}</span>
                      {reconciled && (
                        <Badge tone="warn" title={RECONCILED_TITLE}>
                          对账补录
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="td">
                    <SideBadge side={trade.side} />
                  </td>
                  <td className="td num text-right text-ink-lo">{trade.leverage}x</td>
                  <td className="td num text-right">{fmtQty(trade.quantity)}</td>
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
                    className={`td num text-right font-semibold ${pnlColor(trade.netPnl)}`}
                    title={pnlFormulaText(costs)}
                  >
                    {fmtUsdSigned(trade.netPnl, 2)}
                  </td>
                  <td className={`td num text-right ${pnlColor(trade.netPnl)}`} title={pnlFormulaText(costs)}>
                    {fmtPercent(trade.pnlPercent)}
                  </td>
                  <td className="td" title={reconciled ? RECONCILED_TITLE : undefined}>
                    {/* `closeReason` is a persisted machine code; the Chinese
                        label lives in CLOSE_REASON_LABELS only. */}
                    <span className={reconciled ? 'text-warn' : 'text-ink-lo'}>
                      {closeReasonLabel(trade.closeReason)}
                    </span>
                  </td>
                  <td className="td num text-right">{fmtDuration(trade.holdMinutes)}</td>
                  <td className="td num text-ink-faint">{fmtDateTime(trade.closedAt)}</td>
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

export function TraderTables({
  traderId,
  tab,
  onChange,
  positionCount,
  openOrderCount,
  refreshToken,
}: {
  traderId: number;
  tab: TraderTabId;
  onChange: (tab: TraderTabId) => void;
  positionCount: number;
  openOrderCount: number;
  /**
   * Bumped by the caller after a manual 对账, so the tables refetch instead of
   * waiting out their 15-second poll — the numbers the operator just changed
   * should be the numbers on screen.
   */
  refreshToken?: number;
}) {
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [ordersRefreshToken, setOrdersRefreshToken] = useState(0);
  // One token drives both tables: the toolbar ⟳ and the caller's 对账 both mean
  // "these rows are stale".
  const token = (refreshToken ?? 0) + ordersRefreshToken;

  const tabs: Array<{ id: TraderTabId; label: string; count?: number }> = [
    { id: 'positions', label: '当前持仓', count: positionCount },
    { id: 'orders', label: '当前委托', count: openOrderCount },
    { id: 'trades', label: '历史成交' },
    { id: 'history', label: '订单记录' },
  ];

  return (
    <Panel padded={false} bodyClassName="p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-base-800 px-3 py-2">
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
        </div>
      </div>

      {/* 空表格不占位：`min-h` 曾经给这一区留了 220px，于是"暂无持仓"下面跟着
          一片空白。高度交给内容，有行时才需要滚动。 */}
      <div>
        {tab === 'positions' && <PositionsTable traderId={traderId} onCloseRequest={setCloseTarget} />}
        {tab === 'orders' && <OrdersTable traderId={traderId} onlyOpen refreshToken={token} />}
        {tab === 'trades' && <TradesTable traderId={traderId} refreshToken={token} />}
        {tab === 'history' && <OrdersTable traderId={traderId} onlyOpen={false} refreshToken={token} />}
      </div>

      <CloseNoticeModal symbol={closeTarget} onClose={() => setCloseTarget(null)} />
    </Panel>
  );
}
