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
import { fmtCompact, fmtPercent, fmtPrice, pnlColor } from '../lib/format';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
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

  const symbols = symbolsQuery.data ?? [];
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
    <div className="space-y-3">
      {/* ------------------------------------------------------------------ */}
      {/*  顶栏：当前交易对的报价 + 周期切换                                   */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-wide text-ink-hi">行情</h1>
        <Badge tone="muted">{symbols.length} 个 USDT-M 永续</Badge>

        {active && (
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="num text-2xl leading-tight text-ink-strong" title="最新成交价（USDT）">
              {fmtPrice(active.price)}
            </span>
            {/* 带符号：颜色只是辅助，符号才是所有人都能读到的方向 */}
            <span className={cn('num text-lg', pnlColor(active.changePercent24h))} title="24 小时涨跌幅">
              {fmtPercent(active.changePercent24h)}
              <span className="ml-1 text-xs text-ink-faint">24h</span>
            </span>
            <span className="num text-xs text-ink-faint">
              24h 成交额 {fmtCompact(active.quoteVolume24h)} USDT · 最小名义价值 {active.minNotional}
            </span>
          </span>
        )}

        <div className="ml-auto">
          <IntervalPicker value={interval} onChange={setKlineInterval} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        {/* ---------------------------------------------------------------- */}
        {/*  交易对清单                                                       */}
        {/* ---------------------------------------------------------------- */}
        <Panel
          title="交易对"
          actions={
            <span className="num text-xs text-ink-faint">
              {filtered.length} / {matched.length}
            </span>
          }
          bodyClassName="p-2"
          padded={false}
        >
          <div className="relative mb-2">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <TextInput
              className="pl-8"
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
               * `scroll-x` 只包住表格本身：窄屏上让这 4 列自己横滚，
               * 而不是把整页顶出横向滚动条（Layout 的内容区会直接裁掉）。
               */}
              <div className="scroll-x max-h-[min(60vh,560px)] overflow-y-auto">
                <table className="w-full min-w-[276px] border-collapse">
                  <thead className="sticky top-0 z-10 bg-base-900">
                    <tr>
                      {(['symbol', 'price', 'change', 'volume'] as SortKey[]).map((key) => (
                        <th
                          key={key}
                          scope="col"
                          aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                          className={cn('th', key !== 'symbol' && 'text-right')}
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
                          <td className="td font-semibold text-ink-hi">
                            {row.baseAsset}
                            <span className="text-ink-faint">USDT</span>
                          </td>
                          <td className="td num text-right">{fmtPrice(row.price)}</td>
                          <td className={cn('td num text-right', pnlColor(row.changePercent24h))}>
                            {fmtPercent(row.changePercent24h)}
                          </td>
                          <td className="td num text-right text-ink-lo">{fmtCompact(row.quoteVolume24h)}</td>
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
        <div className="min-w-0 space-y-2">
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
              <span className="flex items-center gap-2">
                <span className="num hidden text-xs text-ink-faint sm:inline">
                  {klinesQuery.loading ? '加载中…' : '每 15s 自动刷新'}
                </span>
                <Button size="sm" busy={klinesQuery.loading} onClick={() => klinesQuery.reload()}>
                  <RefreshCw aria-hidden className="h-3.5 w-3.5" />
                  刷新
                </Button>
              </span>
            }
            bodyClassName="p-1"
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
              <CandlestickChart candles={candles} height={460} />
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
                <Readout label={`开盘（${selected.replace(/USDT$/, '')}）`} value={fmtPrice(last.open)} />
                <Readout label="最高" value={fmtPrice(last.high)} tone="text-up" />
                <Readout label="最低" value={fmtPrice(last.low)} tone="text-down" />
                <Readout label="收盘" value={fmtPrice(last.close)} />
                <Readout label="成交量（币）" value={fmtCompact(last.volume)} />
                <Readout label="成交额（USDT）" value={fmtCompact(last.quoteVolume)} />
                <Readout label="成交笔数" value={String(last.trades)} />
                <Readout label="主动买入（币）" value={fmtCompact(last.takerBuyBase)} />
                <Readout label="主动买入（额）" value={fmtCompact(last.takerBuyQuote)} />
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
