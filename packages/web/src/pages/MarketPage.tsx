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
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, RefreshCw, Search } from 'lucide-react';
import { api, type MarketSymbol } from '../lib/api';
import { useEvents } from '../lib/store';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { Badge, Button, Empty, ErrorNote, Panel, Spinner3, TextInput, cn } from '../components/ui';
import { CandlestickChart } from '../components/CandlestickChart';
import { fmtCompactAmount, fmtPercent, fmtPriceUsd, pnlColor } from '../lib/format';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

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

/** 一次能扫完的行数上限；再多的靠搜索定位，不靠滚动。 */
const MAX_ROWS = 120;

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

  const symbolsQuery = usePolled((signal) => api.marketSymbols(signal), {
    intervalMs: socketOpen ? 20_000 : 10_000,
  });

  const symbols = symbolsQuery.data ?? NO_SYMBOLS;
  const [selected, setSelected] = useState<string>('BTCUSDT');
  const [interval, setKlineInterval] = useState<Interval>('15m');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('volume');
  const [sortDir, setSortDir] = useState<SortDir>(DEFAULT_DIR.volume);

  // Fall back to the deepest market when the preferred default is not listed.
  useEffect(() => {
    if (symbols.length === 0) return;
    if (symbols.some((row) => row.symbol === selected)) return;
    setSelected(symbols[0]?.symbol ?? 'BTCUSDT');
  }, [symbols, selected]);

  const klinesQuery = usePolled(
    (signal) => api.marketKlines(selected, interval, 400, signal),
    { intervalMs: 15_000, enabled: selected.length > 0, deps: [selected, interval] },
  );

  const matched = useMemo(() => {
    const term = search.trim().toUpperCase();
    if (!term) return symbols;
    return symbols.filter((row) => row.symbol.includes(term) || row.baseAsset.includes(term));
  }, [symbols, search]);

  const filtered = useMemo(() => {
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
    return sorted.slice(0, MAX_ROWS);
  }, [matched, sortKey, sortDir]);

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
  const hiddenRows = matched.length - filtered.length;

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

        <div className="ml-auto shrink-0">
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
      <div className="grid min-h-0 grid-cols-1 gap-3 md:grid-cols-[minmax(0,300px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
        {/* ---------------------------------------------------------------- */}
        {/*  交易对清单                                                       */}
        {/* ---------------------------------------------------------------- */}
        <Panel
          title="交易对"
          /*
           * 左栏撑满这一行的高度，表格体内部滚动 —— 交易对最多 528 个，
           * 让它把整页顶长就等于"看图表必须先滚过几百行币种"。
           */
          className="flex min-h-0 flex-col"
          bodyClassName="flex min-h-0 flex-1 flex-col p-2"
          actions={
            <span className="num text-xs text-ink-faint">
              {filtered.length} / {matched.length}
            </span>
          }
          padded={false}
        >
          <div className="relative mb-2">
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
               * ⚠️ **不出现横向滚动条**（2026-11-10 用户明确要求：
               * 「不应该出现横向滚动条（完全能容纳下数据）」）。
               *
               * 之前这里用 `scroll-x` 让 4 列在窄屏自己横滚 —— 那是把"放不下"
               * 当成排版的默认解法，用户看到的是右边界被切、底部一条横向滚动条。
               *
               * 现在：
               *  · 表格 `table-fixed w-full`（列宽按比例分配，不再按内容撑开）；
               *  · 窄屏（< md）**隐藏 24h 成交额列** —— 它是三列里唯一"少了也不影响
               *    判断"的辅助信息，手机/窄窗口上优先保价格与涨跌；
               *  · 数字列 `whitespace-nowrap`、交易对列 `truncate`，避免文字把列顶宽。
               */}
              <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
                {/*
                  单元格上显式写 `px-1.5`（6px）：两套模板的基础内边距不一样
                  （经典 `px-3` = 12px、控制台 `0 6px`），而这张表在 440px 的列里
                  只有 16px 余量 —— 按模板走的话经典那边会多出 48px 又溢出。
                  宽度是这里最硬的约束，所以密度写成页面级的事实，不交给模板。
                */}
                <table className="w-full table-fixed border-collapse">
                  <thead className="sticky top-0 z-10 bg-base-900">
                    <tr>
                      {(['symbol', 'price', 'change', 'volume'] as SortKey[]).map((key) => (
                        <th
                          key={key}
                          scope="col"
                          aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                          className={cn(
                            'th px-1.5',
                            key !== 'symbol' && 'text-right',
                            key === 'volume' && 'hidden xl:table-cell',
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
                                <ArrowUp aria-hidden className="h-3 w-3" />
                              ) : (
                                <ArrowDown aria-hidden className="h-3 w-3" />
                              )
                            ) : (
                              <span aria-hidden className="w-3" />
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
                            'cursor-pointer border-b border-base-850 transition-colors hover:bg-base-850/70',
                            isActive && 'bg-accent/10',
                          )}
                        >
                          <td className="td truncate px-1.5 font-semibold text-ink-hi">
                            {row.baseAsset}
                            <span className="text-ink-faint">USDT</span>
                          </td>
                          <td className="td whitespace-nowrap px-1.5 num text-right">{fmtPriceUsd(row.price)}</td>
                          <td className={cn('td whitespace-nowrap px-1.5 num text-right', pnlColor(row.changePercent24h))}>
                            {fmtPercent(row.changePercent24h)}
                          </td>
                          <td className="td hidden whitespace-nowrap px-1.5 num text-right text-ink-lo xl:table-cell">
                            {fmtCompactAmount(row.quoteVolume24h, 'USDT')}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {hiddenRows > 0 && (
                <p className="num px-1 pt-2 text-xs text-ink-faint">
                  另有 {hiddenRows} 个交易对未渲染（每页最多 {MAX_ROWS} 个）—— 用上方搜索框按代码定位。
                </p>
              )}
              {symbolsQuery.error && <ErrorNote className="mt-2">列表刷新失败：{symbolsQuery.error}</ErrorNote>}
            </>
          )}
        </Panel>

        {/* ---------------------------------------------------------------- */}
        {/*  图表 + 最新K线                                                   */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
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
            actions={
              /*
               * 「刷新」是页面级动作 → 统一接口；「每 15s 自动刷新」是**说明文字**，
               * 不属于动作，所以它留在原地（`Panel` 的 actions 槽里），只有按钮被
               * portal 进工具栏。
               */
              <span className="flex items-center gap-2">
                <span className="num hidden text-xs text-ink-faint sm:inline">
                  {klinesQuery.loading ? '加载中…' : '每 15s 自动刷新'}
                </span>
              </span>
            }
            /*
             * 图表面板吃掉右栏剩下的高度，「最新K线」保持自然高度贴在下面。
             * `min-h-0` 见 `CandlestickChart` 的 `fill` 说明。
             */
            className="flex min-h-0 flex-1 flex-col"
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
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 xl:grid-cols-4 3xl:grid-cols-6">
                {/*
                 * 每一条都带单位：同一个 `12.35M` 在"成交量（币）"和"成交额（USDT）"
                 * 里是两个量级完全不同的东西，单位必须进数值本身而不只靠标签
                 * （见 `lib/format.ts` 的命名规则与 `DESIGN.md` §5.3）。
                 */}
                <Readout
                  label={`开盘（${selected.replace(/USDT$/, '')}）`}
                  value={fmtPriceUsd(last.open)}
                />
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
                  label={`主动买入（${selected.replace(/USDT$/, '')}）`}
                  value={fmtCompactAmount(last.takerBuyBase, selected.replace(/USDT$/, ''))}
                />
                <Readout label="主动买入（USDT）" value={fmtCompactAmount(last.takerBuyQuote, 'USDT')} />
                <Readout
                  label="主动买入占比"
                  value={last.volume > 0 ? `${((last.takerBuyBase / last.volume) * 100).toFixed(1)}%` : '—'}
                />
                <Readout label="开盘时间" value={new Date(last.openTime).toLocaleString('en-GB', { hour12: false })} />
                <Readout label="收盘时间" value={new Date(last.closeTime).toLocaleString('en-GB', { hour12: false })} />
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
