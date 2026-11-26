/**
 * 行情页。
 *
 * 版面按"扫一眼"设计：左边是可排序的交易对清单（价格 / 24h / 成交额都能点列头排序），
 * 右边是图表与最新一根K线的读数。
 *
 * 三条不能退让的规则：
 * - **涨跌必须带正负号**，颜色只是辅助 —— 只靠颜色等于把红绿色盲用户排除在外；
 * - 数字一律 `.num` + 右对齐，否则数值一变列就左右抖；
 * - 交易对清单**渲染上限 120 行**，多出来的靠搜索找，不能让上千行把页面拖死。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react';
import type { ExchangeId } from '@aq/shared';
import { api, type MarketSymbol } from '../lib/api';
import { useEvents } from '../lib/store';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { Badge, Button, Empty, ErrorNote, Panel, Spinner3, TextInput, cn } from '../components/ui';
import { CandlestickChart } from '../components/CandlestickChart';
import { fmtCompactAmount, fmtPercent, fmtPriceUsd, pnlColor } from '../lib/format';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
const MARKET_EXCHANGES: ReadonlyArray<{ id: ExchangeId; label: string }> = [
  { id: 'binance', label: '币安' },
  { id: 'gate', label: 'Gate' },
];

/**
 * 引用**稳定**的空数组。
 *
 * ⚠️ **不要写 `query.data ?? []`** —— 那个字面量每轮渲染都会新建一个数组，于是所有
 * 以它为依赖的 `useMemo` / `useEffect` **每轮都重新执行**，而它们看起来是在做缓存。
 *
 * `react-hooks/exhaustive-deps` 会为此报警，但那句
 * "could make the dependencies change on every render" 读起来像风格建议 ——
 * 它实际说的是**缓存完全失效**。这个页面的清单最多上千行、还要排序，
 * 所以那一层 `useMemo` 是真的在干活。
 */
const NO_SYMBOLS: MarketSymbol[] = [];
type Interval = (typeof INTERVALS)[number];

/** 桌面端单行高度预算（含 1px 边框与高 DPI 余量），用于按视口高度自动计算每页条数。 */
const DESKTOP_ROW_HEIGHT_PX = 33;
/** 极窄/极矮窗口下保底展示行数；再矮则由容器自动兜底滚动。 */
const MIN_DESKTOP_PAGE_SIZE = 6;
/** 中小屏（< xl，堆叠在图表下方）固定每页条数，避免面板内再套一层竖向滚动条。 */
const STACKED_PAGE_SIZE = 10;

type SortKey = 'symbol' | 'price' | 'change' | 'volume';
type SortDir = 'asc' | 'desc';

/**
 * 默认方向。
 *
 * 成交额与涨跌幅默认从大到小 —— "最活跃 / 涨得最多"是打开这张表时最常问的问题；
 * 交易对按字母从小到大。点同一列再次切换方向。
 */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  symbol: 'asc',
  price: 'desc',
  change: 'desc',
  volume: 'desc',
};

const SORT_LABEL: Record<SortKey, string> = {
  symbol: '交易对',
  price: '价格',
  change: '24h 涨跌',
  volume: '24h 成交额',
};

export function MarketPage() {
  useDocumentTitle('行情');
  const socketOpen = useEvents((s) => s.status) === 'open';
  const [exchange, setExchange] = useState<ExchangeId>('binance');

  const symbolsQuery = usePolled((signal) => api.marketSymbols(signal, exchange), {
    intervalMs: socketOpen ? 20_000 : 10_000,
    deps: [exchange],
  });

  const symbols = symbolsQuery.data ?? NO_SYMBOLS;
  const [selected, setSelected] = useState<string>('BTCUSDT');
  const [interval, setKlineInterval] = useState<Interval>('15m');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('volume');
  const [sortDir, setSortDir] = useState<SortDir>(DEFAULT_DIR.volume);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(16);
  const tableBoxRef = useRef<HTMLDivElement | null>(null);
  const theadRef = useRef<HTMLTableSectionElement | null>(null);

  // Fall back to the deepest market when the preferred default is not listed.
  useEffect(() => {
    if (symbols.length === 0) return;
    if (symbols.some((row) => row.symbol === selected)) return;
    setSelected(symbols[0]?.symbol ?? 'BTCUSDT');
  }, [symbols, selected]);

  const matched = useMemo(() => {
    const term = search.trim().toUpperCase();
    if (!term) return symbols;
    return symbols.filter((row) => row.symbol.includes(term) || row.baseAsset.includes(term));
  }, [symbols, search]);

  const sortedAll = useMemo(() => {
    const sorted = [...matched];
    const factor = sortDir === 'asc' ? 1 : -1;
    sorted.sort((a, b) => {
      switch (sortKey) {
        case 'symbol':
          return a.symbol.localeCompare(b.symbol) * factor;
        case 'price':
          return (a.price - b.price) * factor;
        case 'change':
          return (a.changePercent24h - b.changePercent24h) * factor;
        case 'volume':
          return (a.quoteVolume24h - b.quoteVolume24h) * factor;
      }
    });
    return sorted;
  }, [matched, sortKey, sortDir]);

  const hasTable = sortedAll.length > 0;

  // 随容器高度自动计算每页可完整容纳的行数，正常窗口不出现竖向滚动条；
  // 仅当视口极端矮小（放不下保底行数）时由容器自然兜底滚动。
  useEffect(() => {
    const box = tableBoxRef.current;
    if (!box) return;
    let rafId = 0;

    const recalc = () => {
      const isDesktopSplit = window.matchMedia('(min-width: 1280px)').matches;
      if (!isDesktopSplit) {
        setPageSize((prev) => (prev === STACKED_PAGE_SIZE ? prev : STACKED_PAGE_SIZE));
        return;
      }
      const boxHeight = box.clientHeight;
      if (boxHeight <= 0) return;
      const theadHeight = theadRef.current?.getBoundingClientRect().height ?? 34;
      const fitRows = Math.floor((boxHeight - theadHeight - 6) / DESKTOP_ROW_HEIGHT_PX);
      const next = Math.max(MIN_DESKTOP_PAGE_SIZE, fitRows);
      setPageSize((prev) => (prev === next ? prev : next));
    };

    const schedule = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(recalc);
    };

    recalc();
    const ro = new ResizeObserver(schedule);
    ro.observe(box);
    window.addEventListener('resize', schedule);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [hasTable]);

  const klinesQuery = usePolled(
    (signal) => api.marketKlines(selected, interval, 400, signal, exchange),
    { intervalMs: 15_000, enabled: selected.length > 0, deps: [selected, interval, exchange] },
  );

  useEffect(() => {
    setPage(1);
  }, [search, sortKey, sortDir, exchange]);

  const totalPages = Math.max(1, Math.ceil(sortedAll.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const filtered = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return sortedAll.slice(start, start + pageSize);
  }, [sortedAll, safePage, pageSize]);

  /** 点同一列切换方向，换一列则用该列的默认方向。 */
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir(DEFAULT_DIR[key]);
  };

  const active: MarketSymbol | undefined = symbols.find((row) => row.symbol === selected);
  const candles = klinesQuery.data ?? [];
  const last = candles[candles.length - 1];
  const first = candles[0];
  const windowChange = last && first && first.open !== 0 ? ((last.close - first.open) / first.open) * 100 : null;

  return (
    /*
     * `page-fill`：整页撑满外壳给的确定高度，图表与交易对表各自内部滚动。
     * 见 `index.css` 里 `.page-fill` 的说明 —— 宽屏下才有 `height:100%`。
     */
    <div className="page-fill gap-3">
      {/* ------------------------------------------------------------------ */}
      {/*  顶栏：当前交易对的报价 + 周期切换                                   */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-wide text-ink-hi">行情</h1>
        <div role="group" aria-label="行情交易所" className="flex items-center gap-0.5">
          {MARKET_EXCHANGES.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={exchange === item.id ? 'primary' : 'ghost'}
              aria-pressed={exchange === item.id}
              onClick={() => setExchange(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <Badge tone="muted">{symbols.length} 个 USDT-M 永续</Badge>

        {active && (
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="num text-2xl leading-tight text-ink-strong" title="最新成交价（USDT）">
              {fmtPriceUsd(active.price)}
            </span>
            {/* 带符号：颜色只是辅助，符号才是所有人都能读到的方向 */}
            <span className={cn('num text-lg', pnlColor(active.changePercent24h))} title="24 小时涨跌幅">
              {fmtPercent(active.changePercent24h)}
              <span className="ml-1 text-xs text-ink-faint">24h</span>
            </span>
            <span className="num text-xs text-ink-faint">
              24h 成交额 {fmtCompactAmount(active.quoteVolume24h, 'USDT')} · 最小名义价值{' '}
              {fmtCompactAmount(active.minNotional, 'USDT')}
            </span>
          </span>
        )}

        <div className="shrink-0">
          <IntervalPicker value={interval} onChange={setKlineInterval} />
        </div>
      </div>

      {/*
        ⚠️ **左栏在 xl 下是 440px，不是 300px。**

        这一列装的是一张 4 列表（交易对 / 价格 / 24h 涨跌 / 24h 成交额）。实测
        （1440px 视口）它的最小宽度是 **413px**，其中「交易对」一列
        就被币安那种 `1000BONKUSDT` 这种名字撑到 128px。300px 的容器装不下它：
        表格撑破容器、右两列滚出可视区，而深色底上那条横向滚动条几乎看不见 ——
        看起来就是**数字被裁掉了**（用户报的就是这个）。

        所以 xl（≥1280）给 440px：容器内宽 422px > 413px，四列全部露出来。
        md–lg 之间**故意保持 300px** —— 那一档右列还是 `1fr` 的K线图，把 440px
        让给左表会把图挤到 300px 上下；窄屏上让表格自己横滚（`scroll-x`）本来就是
        这一栏的设计。
      */}
      {/*
        `min-h-0` 让这一行能**被压到比内容矮**：它是 `page-fill` 的 flex 子项，
        默认 `min-height:auto` 时会被两栏的内容顶高，整页照样溢出。
      */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,460px)_minmax(0,1fr)]">
        {/* ---------------------------------------------------------------- */}
        {/*  交易对清单                                                       */}
        {/* ---------------------------------------------------------------- */}
        <Panel
          title="交易对"
          /*
           * 桌面端（xl）随可视高度自动分页，正常窗口内零竖向/横向滚动条；
           * 中小屏（< xl）堆叠在图表下方，每页 10 条自然展示，避免嵌套滚动条。
           */
          className="flex flex-col xl:min-h-0"
          bodyClassName="flex min-h-0 flex-1 flex-col p-2"
          actions={
            <span className="num text-xs text-ink-faint">
              {search.trim() ? `${sortedAll.length} / ${symbols.length}` : `${symbols.length} 个`}
            </span>
          }
          padded={false}
        >
          <div className="relative mb-2 max-w-[280px]">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <TextInput
              className="!pl-8"
              placeholder="搜索 BTC、ETH、SOL…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="搜索交易对"
            />
          </div>

          {symbolsQuery.loading && symbols.length === 0 ? (
            <Spinner3 label="正在加载交易对" />
          ) : symbolsQuery.error && symbols.length === 0 ? (
            <div className="p-1">
              <ErrorNote>读取交易对失败：{symbolsQuery.error}</ErrorNote>
              <Button size="sm" className="mt-2" busy={symbolsQuery.loading} onClick={() => symbolsQuery.reload()}>
                <RefreshCw aria-hidden className="h-3.5 w-3.5" />
                重试
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <Empty
              message={search.trim() ? `没有匹配“${search.trim()}”的交易对。` : '交易所没有返回任何交易对。'}
              hint={search.trim() ? '换一个币种代码，或清空搜索框看全部清单。' : '确认 API 权重未耗尽，然后重试。'}
              action={
                search.trim() ? (
                  <Button size="sm" onClick={() => setSearch('')}>
                    清空搜索
                  </Button>
                ) : (
                  <Button size="sm" busy={symbolsQuery.loading} onClick={() => symbolsQuery.reload()}>
                    重新加载
                  </Button>
                )
              }
            />
          ) : (
            <>
              {/*
               * 正常窗口不出现横向与竖向滚动条：
               *  · `table-fixed w-full min-w-[260px]` 按列宽比例完整容纳四列，仅在极端窄屏（<260px）兜底横滚；
               *  · 桌面端（xl）按容器实测高度自动分页（ResizeObserver），仅在极端矮屏（放不下保底 6 行）兜底竖滚；
               *  · 中小屏（< xl）隐藏 24h 成交额列并每页展示 10 行，避免面板内嵌套滚动条。
               */}
              <div ref={tableBoxRef} className="min-h-0 flex-1 overflow-auto">
                <table className="w-full min-w-[260px] table-fixed border-collapse">
                  <thead ref={theadRef} className="sticky top-0 z-10 bg-base-900">
                    <tr>
                      {(['symbol', 'price', 'change', 'volume'] as SortKey[]).map((key) => (
                        <th
                          key={key}
                          scope="col"
                          aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                          className={cn(
                            'th whitespace-nowrap px-1.5',
                            key === 'symbol' && 'w-[42%] xl:w-[30%]',
                            key === 'price' && 'w-[33%] text-right xl:w-[23%]',
                            key === 'change' && 'w-[25%] text-right xl:w-[19%]',
                            key === 'volume' && 'hidden text-right xl:table-cell xl:w-[28%]',
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => toggleSort(key)}
                            title={`按${SORT_LABEL[key]}排序`}
                            className={cn(
                              'inline-flex items-center gap-1 rounded px-1 py-0.5 transition hover:text-ink-mid',
                              key !== 'symbol' && 'flex-row-reverse',
                              sortKey === key ? 'text-ink-hi' : 'text-ink-lo',
                            )}
                          >
                            {SORT_LABEL[key]}
                            {sortKey === key ? (
                              sortDir === 'asc' ? (
                                <ArrowUp aria-hidden className="h-3 w-3 shrink-0" />
                              ) : (
                                <ArrowDown aria-hidden className="h-3 w-3 shrink-0" />
                              )
                            ) : (
                              <span aria-hidden className="w-3 shrink-0" />
                            )}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => {
                      const isActive = row.symbol === selected;
                      return (
                        <tr
                          key={row.symbol}
                          // 整行可点 + 可聚焦：只让一个小图标可点会逼用户去瞄鼠标
                          tabIndex={0}
                          aria-current={isActive ? 'true' : undefined}
                          onClick={() => setSelected(row.symbol)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setSelected(row.symbol);
                            }
                          }}
                          className={cn(
                            'h-8 cursor-pointer border-b border-base-850 transition-colors hover:bg-base-850/70',
                            isActive && 'bg-accent/10',
                          )}
                        >
                          <td className="td !py-0 truncate px-1.5 text-xs font-semibold text-ink-hi sm:text-sm">
                            {row.baseAsset}
                            <span className="text-ink-faint">USDT</span>
                          </td>
                          <td className="td num !py-0 whitespace-nowrap px-1.5 text-right text-xs">{fmtPriceUsd(row.price)}</td>
                          <td className={cn('td num !py-0 whitespace-nowrap px-1.5 text-right text-xs', pnlColor(row.changePercent24h))}>
                            {fmtPercent(row.changePercent24h)}
                          </td>
                          <td className="td num !py-0 hidden whitespace-nowrap px-1.5 text-right text-xs text-ink-lo xl:table-cell">
                            {fmtCompactAmount(row.quoteVolume24h, 'USDT')}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="mt-1.5 flex shrink-0 items-center justify-between gap-2 border-t border-base-850 px-1 pt-1.5 text-xs text-ink-faint">
                  <span className="num">
                    第 {safePage} / {totalPages} 页 · 每页 {pageSize} 个
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="!h-6 !px-1.5 text-xs"
                      disabled={safePage <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      aria-label="上一页"
                    >
                      <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
                      上一页
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="!h-6 !px-1.5 text-xs"
                      disabled={safePage >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      aria-label="下一页"
                    >
                      下一页
                      <ChevronRight aria-hidden className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
              {symbolsQuery.error && <ErrorNote className="mt-2">列表刷新失败：{symbolsQuery.error}</ErrorNote>}
            </>
          )}
        </Panel>

        {/* ---------------------------------------------------------------- */}
        {/*  图表 + 最新K线                                                   */}
        {/* ---------------------------------------------------------------- */}
        <div className="order-first flex min-h-0 min-w-0 flex-col gap-2 xl:order-last">
          <Panel
            title={
              <span className="flex flex-wrap items-center gap-2">
                {selected}
                <Badge tone="muted">{interval}</Badge>
                {windowChange !== null && (
                  <span className={cn('num text-xs', pnlColor(windowChange))}>{fmtPercent(windowChange)} 区间</span>
                )}
                {candles.length > 0 && (
                  <span className="num text-xs text-ink-faint">{candles.length} 根K线</span>
                )}
              </span>
            }
            /*
             * 不再渲染 actions：原来那里只有一行「每 15s 自动刷新」说明。
             * 规范 §5 要求"默认自动刷新、不提供手动刷新按钮"，那么"它会自动刷新"
             * 这件事就不需要一句常驻说明 —— 省一行高度，也少一处噪音。
             */
            className="flex h-[300px] min-h-0 flex-col sm:h-[340px] xl:h-auto xl:flex-1"
            bodyClassName="flex min-h-0 flex-1 flex-col p-1"
            padded={false}
          >
            {klinesQuery.error ? (
              <div className="m-3">
                <ErrorNote>读取K线失败：{klinesQuery.error}</ErrorNote>
                <Button size="sm" className="mt-2" onClick={() => klinesQuery.reload()}>
                  重试
                </Button>
              </div>
            ) : klinesQuery.loading && candles.length === 0 ? (
              <Spinner3 label="正在加载K线" />
            ) : candles.length === 0 ? (
              <Empty
                message={`${selected} 在 ${interval} 周期没有返回K线。`}
                hint="换一个周期试试，或确认该交易对在交易所可交易。"
              />
            ) : (
              <CandlestickChart candles={candles} fill />
            )}
          </Panel>

          {last && (
            <Panel
              title="最新K线"
              actions={
                <span className="num text-xs text-ink-faint">
                  {new Date(last.closeTime).toLocaleString('en-GB', { hour12: false })}
                </span>
              }
              bodyClassName="p-3"
              padded={false}
            >
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 xl:grid-cols-4">
                {/*
                 * 每一条都带单位：同一个 `12.35M` 在"成交量（币）"和"成交额（USDT）"
                 * 里是两个量级完全不同的东西，单位必须进数值本身而不只靠标签
                 * （见 `lib/format.ts` 的命名规则与 `DESIGN.md` §5.3）。
                 *
                 * 2026-11-10：12 格压到 8 格（规范 §1「信息层级」）——
                 * 「主动买入（币）/（USDT）」与「成交额」是同一笔钱的两种切法，
                 * 开盘/收盘时间已经显示在面板标题右侧，不再重复。
                 */}
                <Readout label="开盘（USDT）" value={fmtPriceUsd(last.open)} />
                <Readout label="最高（USDT）" value={fmtPriceUsd(last.high)} tone="text-up" />
                <Readout label="最低（USDT）" value={fmtPriceUsd(last.low)} tone="text-down" />
                <Readout label="收盘（USDT）" value={fmtPriceUsd(last.close)} />
                <Readout
                  label={`成交量（${selected.replace(/USDT$/, '')}）`}
                  value={fmtCompactAmount(last.volume, selected.replace(/USDT$/, ''))}
                />
                <Readout label="成交额（USDT）" value={fmtCompactAmount(last.quoteVolume, 'USDT')} />
                <Readout label="成交笔数" value={String(last.trades)} />
                <Readout
                  label="主动买入占比"
                  value={last.volume > 0 ? `${((last.takerBuyBase / last.volume) * 100).toFixed(1)}%` : '—'}
                />
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 周期切换。
 *
 * 用 `aria-pressed` 的一组按钮而不是自绘选项卡：周期是"选一个"，
 * 读屏会念出"已按下"，键盘也能一路 Tab 过去。选中态同时给底色和文字色 ——
 * 只给底色在深色主题里几乎看不出来。
 */
function IntervalPicker({ value, onChange }: { value: Interval; onChange: (next: Interval) => void }) {
  return (
    <div role="group" aria-label="K线周期" className="flex flex-wrap items-center gap-0.5">
      {INTERVALS.map((item) => (
        <Button
          key={item}
          size="sm"
          variant={value === item ? 'primary' : 'ghost'}
          aria-pressed={value === item}
          className="num"
          onClick={() => onChange(item)}
        >
          {item}
        </Button>
      ))}
    </div>
  );
}

function Readout({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs uppercase tracking-wide text-ink-faint" title={label}>
        {label}
      </div>
      <div className={cn('num mt-0.5 break-all text-base', tone ?? 'text-ink-hi')}>{value}</div>
    </div>
  );
}
