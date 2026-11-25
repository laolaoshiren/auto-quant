import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';

/* -------------------------------------------------------------------------- */
/*  Row caps                                                                   */
/* -------------------------------------------------------------------------- */

/** 当前持仓表渲染多少行。持仓数受 `maxPositions` 约束，不需要分页。 */
export const MAX_ROWS = 100;

/**
 * 历史成交 / 订单记录第一页多少行，以及"滚到底再取下一页"的页大小。
 *
 * 25 是"一屏左右"：比一屏多一点，所以第一眼就能看出下面还有东西；又足够小，
 * 一次请求与一次渲染都不可能有感知。这两张表以前一次要 200 行 ——
 * 操作者的原话是"成千上万数据一次加载出来导致系统卡死"。
 */
export const PAGE_SIZE = 25;

/**
 * 每页向服务端**多要一条**，只用来判断"还有没有更早的"。
 *
 * 响应体是 `OrderRecord[]` / `TradeRecord[]`（形状没变：老客户端与 `docs/API.md`
 * 都照旧），数组里没有"还有下一页吗"这个字段，所以多要一条是最便宜的探针：
 * 拿到 26 条 = 还有更早的；拿到 ≤25 条 = 已经到最早一笔了。
 * 不这么做就只能靠"再请求一次、拿到空数组"来判断终点 —— 那时"加载中"会先多闪一下，
 * 而终点提示也总是迟一步。决策流（`DecisionFeed`）用的是同一套办法。
 */
export const PAGE_LIMIT = PAGE_SIZE + 1;

/* -------------------------------------------------------------------------- */
/*  Cursor pagination shared by the two history tables                         */
/* -------------------------------------------------------------------------- */

/** 「加载更多」的状态机：与决策流一致（idle / loading / error / done）。 */
export type MoreState = 'idle' | 'loading' | 'error' | 'done';

/** `usePolled` 那一份数据里，这个组件关心的三个字段。 */
export interface PolledPage<T> {
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
 * 做法：**只有加载真的超过阈值才显示它**。快的时候表格区域短暂空白 —— 人眼感知不到；
 * 慢的时候才给出"正在加载"的反馈，否则用户会以为界面卡住了。
 *
 * 阈值 350ms 的取法：低于它，人会把"空白 → 内容"当成一次性出现；高于它，就该有反馈。
 */
export function useDelayedSpinner(active: boolean, delayMs = 350): boolean {
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
export type PageFetcher<T> = (
  traderId: number,
  options: {
    limit: number;
    before?: number | null;
    /**
     * **时间游标**：只看成交表。它的 `id` 是插入顺序，而**对账补录的行 id 更大、
     * 成交时刻更早** —— 按 id 排序会让日期看起来错乱，所以服务端改成按 `closed_at`
     * 排序，而按时间排序之后只用 id 做游标会漏行。订单表不传它，行为与以前完全一致。
     */
    beforeClosedAt?: string | null;
    signal?: AbortSignal;
  },
) => Promise<T[]>;

export interface TablePaging<T> {
  /** 屏幕上要渲染的全部行：轮询的第一页 + 翻出来的每一页 + 推送进来的实时行，按 id 倒序去重。 */
  rows: T[];
  loading: boolean;
  /**
   * **是否曾经成功拿到过数据**（一旦为 true 就永远是 true）。
   * 加载态只在**真的什么都没有**时出现：数据一旦到过手上，就算下一轮
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
 * 没有新行时返回原数组以跳过无效重渲染。
 */
function mergeById<T extends { id: number }>(
  prev: T[],
  rows: T[],
  reconcile?: (existing: T, incoming: T) => T,
): T[] {
  if (!reconcile) {
    const seen = new Set(prev.map((row) => row.id));
    const fresh = rows.filter((row) => !seen.has(row.id));
    return fresh.length > 0 ? [...prev, ...fresh] : prev;
  }

  let changed = false;
  const indexById = new Map<number, number>();
  prev.forEach((row, idx) => indexById.set(row.id, idx));
  const next = [...prev];

  for (const row of rows) {
    const idx = indexById.get(row.id);
    if (idx === undefined) {
      indexById.set(row.id, next.length);
      next.push(row);
      changed = true;
    } else {
      const winner = reconcile(next[idx]!, row);
      if (winner !== next[idx]) {
        next[idx] = winner;
        changed = true;
      }
    }
  }
  return changed ? next : prev;
}

/**
 * 历史成交 / 订单记录的**游标分页**，两张表共用。
 *
 * - 游标是 `before=id`（成交表带 `beforeClosedAt`），不是 `offset`；
 * - `root` 是表格自己的滚动框（`scrollerRef`），不是窗口；
 * - 轮询只负责最新一页并累加进已加载列表，不覆盖操作者已翻出的历史；
 * - 顶部插入新行时用 `data-row-id` 锚点补偿 `scrollTop`，防止正在阅读的内容跳动。
 */
export function useTablePaging<T extends { id: number; traderId: number }>(
  traderId: number,
  fetchPage: PageFetcher<T>,
  polled: PolledPage<T>,
  live: T[] | undefined,
  timeOf?: (row: T) => string,
  remountKey?: unknown,
  mergeOptions?: {
    reconcile?: (existing: T, incoming: T) => T;
    mergeAll?: (
      loaded: readonly T[],
      live: readonly T[] | undefined,
      polledPage: readonly T[] | undefined,
      traderId: number,
    ) => T[];
  },
): TablePaging<T> {
  const reconcile = mergeOptions?.reconcile;
  const mergeAll = mergeOptions?.mergeAll;

  const [loaded, setLoaded] = useState<T[]>([]);
  const [moreState, setMoreState] = useState<MoreState>('idle');
  const [moreError, setMoreError] = useState<string | null>(null);
  const [deeperFull, setDeeperFull] = useState(false);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const moreAbortRef = useRef<AbortController | null>(null);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const traderIdRef = useRef(traderId);
  traderIdRef.current = traderId;

  useEffect(() => {
    setLoaded([]);
    setMoreState('idle');
    setMoreError(null);
    setDeeperFull(false);
    return () => moreAbortRef.current?.abort();
  }, [traderId]);

  useEffect(() => {
    const page = polled.data;
    if (!page) return;
    const rows = page.slice(0, PAGE_SIZE);
    if (rows.length === 0) return;
    setLoaded((prev) => mergeById(prev, rows, reconcile));
  }, [polled.data, traderId, reconcile]);

  const rows = useMemo(() => {
    const polledPage = (polled.data ?? []).slice(0, PAGE_SIZE);
    if (mergeAll) {
      return mergeAll(loaded, live, polledPage, traderId);
    }
    const merged = new Map<number, T>();
    for (const row of loaded) merged.set(row.id, row);
    for (const row of live ?? []) if (row.traderId === traderId) merged.set(row.id, row);
    for (const row of polledPage) merged.set(row.id, row);
    const all = [...merged.values()];
    return timeOf
      ? all.sort((a, b) => {
          const ta = timeOf(a);
          const tb = timeOf(b);
          return ta === tb ? b.id - a.id : tb.localeCompare(ta);
        })
      : all.sort((a, b) => b.id - a.id);
  }, [loaded, polled.data, live, traderId, timeOf, mergeAll]);

  const cursor = useMemo(() => {
    let earliest: T | null = null;
    const consider = (row: T): void => {
      if (earliest === null) {
        earliest = row;
        return;
      }
      const older = timeOf
        ? timeOf(row) < timeOf(earliest) ||
          (timeOf(row) === timeOf(earliest) && row.id < earliest.id)
        : row.id < earliest.id;
      if (older) earliest = row;
    };
    for (const row of loaded) consider(row);
    for (const row of (polled.data ?? []).slice(0, PAGE_SIZE)) consider(row);
    return earliest as T | null;
  }, [loaded, polled.data, timeOf]);

  const hasMore = moreState !== 'done' && (deeperFull || (polled.data?.length ?? 0) > PAGE_SIZE);

  const loadMore = useCallback(async (opts?: { silent?: boolean }) => {
    if (moreState === 'loading' || moreState === 'done') return;
    if (cursor === null) {
      setMoreState('done');
      return;
    }

    const requestedFor = traderId;
    moreAbortRef.current?.abort();
    const controller = new AbortController();
    moreAbortRef.current = controller;
    if (!opts?.silent) setMoreState('loading');
    setMoreError(null);

    try {
      const page = await fetchRef.current(requestedFor, {
        limit: PAGE_LIMIT,
        before: cursor.id,
        ...(timeOf ? { beforeClosedAt: timeOf(cursor) } : {}),
        signal: controller.signal,
      });
      if (controller.signal.aborted || traderIdRef.current !== requestedFor) return;

      setLoaded((prev) => mergeById(prev, page.slice(0, PAGE_SIZE), reconcile));
      setDeeperFull(page.length > PAGE_SIZE);
      setMoreState(page.length > PAGE_SIZE ? 'idle' : 'done');
    } catch (error) {
      if (controller.signal.aborted) return;
      setMoreError((error as Error).message);
      setMoreState('error');
    }
  }, [cursor, moreState, traderId, timeOf, reconcile]);

  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  const listMounted = rows.length > 0;

  useEffect(() => {
    if (!hasMore || moreState !== 'idle') return;
    const root = scrollerRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const notScrollable = root.scrollHeight <= root.clientHeight + 2;
        void loadMoreRef.current({ silent: notScrollable });
      },
      { root, rootMargin: '240px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, moreState, traderId, listMounted, remountKey]);

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
    retry: () => void loadMore(),
    scrollerRef,
    sentinelRef,
  };
}
