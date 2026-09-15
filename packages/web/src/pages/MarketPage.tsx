import { useEffect, useMemo, useState } from 'react';
import { api, type MarketSymbol } from '../lib/api';
import { useEvents } from '../lib/store';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { Badge, Button, Empty, ErrorNote, Panel, Spinner3, TextInput } from '../components/ui';
import { CandlestickChart } from '../components/CandlestickChart';
import { fmtCompact, fmtPercent, fmtPrice, pnlColor } from '../lib/format';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
type Interval = (typeof INTERVALS)[number];

export function MarketPage() {
  useDocumentTitle('行情');
  const socketOpen = useEvents((s) => s.status) === 'open';

  const symbolsQuery = usePolled((signal) => api.marketSymbols(signal), {
    intervalMs: socketOpen ? 20_000 : 10_000,
  });

  const symbols = symbolsQuery.data ?? [];
  const [selected, setSelected] = useState<string>('BTCUSDT');
  const [interval, setIntervalValue] = useState<Interval>('15m');
  const [search, setSearch] = useState('');

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

  const filtered = useMemo(() => {
    const term = search.trim().toUpperCase();
    const list = term
      ? symbols.filter((row) => row.symbol.includes(term) || row.baseAsset.includes(term))
      : symbols;
    return list.slice(0, 120);
  }, [symbols, search]);

  const active: MarketSymbol | undefined = symbols.find((row) => row.symbol === selected);
  const candles = klinesQuery.data ?? [];
  const last = candles[candles.length - 1];
  const first = candles[0];
  const windowChange = last && first && first.open !== 0 ? ((last.close - first.open) / first.open) * 100 : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-base font-semibold tracking-wide text-ink-hi">行情</h1>
        <Badge tone="muted">{symbols.length} 个 USDT-M 永续</Badge>
        {active && (
          <>
            <span className="num text-sm text-ink-hi">{fmtPrice(active.price)}</span>
            <span className={`num text-xs ${pnlColor(active.changePercent24h)}`}>
              {fmtPercent(active.changePercent24h)} 24h
            </span>
            <span className="num text-2xs text-ink-faint">
              24h 额 {fmtCompact(active.quoteVolume24h)} USDT · 最小名义价值 {active.minNotional}
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          {INTERVALS.map((value) => (
            <Button
              key={value}
              small
              variant={interval === value ? 'primary' : 'ghost'}
              onClick={() => setIntervalValue(value)}
            >
              {value}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[320px_1fr]">
        <Panel
          title="交易对"
          actions={<span className="num text-2xs text-ink-faint">显示 {filtered.length} 个</span>}
          bodyClassName="p-2"
          padded={false}
        >
          <TextInput
            placeholder="搜索 BTC、ETH、SOL…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="mb-2"
          />

          {symbolsQuery.loading && symbols.length === 0 ? (
            <Spinner3 label="正在加载交易对" />
          ) : filtered.length === 0 ? (
            <Empty message="没有匹配该搜索的交易对。" />
          ) : (
            <div className="max-h-[560px] overflow-y-auto">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 bg-base-900">
                  <tr>
                    <th className="th">交易对</th>
                    <th className="th text-right">价格</th>
                    <th className="th text-right">24h</th>
                    <th className="th text-right">成交额</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => (
                    <tr
                      key={row.symbol}
                      onClick={() => setSelected(row.symbol)}
                      className={`cursor-pointer border-b border-base-850 transition-colors hover:bg-base-850/70 ${
                        row.symbol === selected ? 'bg-accent/10' : ''
                      }`}
                    >
                      <td className="td font-semibold text-ink-hi">
                        {row.baseAsset}
                        <span className="text-ink-faint">USDT</span>
                      </td>
                      <td className="td num text-right">{fmtPrice(row.price)}</td>
                      <td className={`td num text-right ${pnlColor(row.changePercent24h)}`}>
                        {fmtPercent(row.changePercent24h)}
                      </td>
                      <td className="td num text-right text-ink-lo">{fmtCompact(row.quoteVolume24h)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {symbolsQuery.error && <ErrorNote className="mt-2">{symbolsQuery.error}</ErrorNote>}
        </Panel>

        <div className="space-y-2">
          <Panel
            title={
              <span className="flex items-center gap-2">
                {selected}
                <Badge tone="muted">{interval}</Badge>
                {windowChange !== null && (
                  <span className={`num text-2xs ${pnlColor(windowChange)}`}>{fmtPercent(windowChange)} 区间</span>
                )}
                {candles.length > 0 && (
                  <span className="num text-2xs text-ink-faint">{candles.length} 根K线</span>
                )}
              </span>
            }
            actions={
              <span className="flex items-center gap-2">
                <span className="num text-2xs text-ink-faint">
                  {klinesQuery.loading ? '加载中…' : '每 15s 自动刷新'}
                </span>
                <Button small onClick={() => klinesQuery.reload()}>
                  刷新
                </Button>
              </span>
            }
            bodyClassName="p-1"
            padded={false}
          >
            {klinesQuery.error ? (
              <ErrorNote className="m-3">{klinesQuery.error}</ErrorNote>
            ) : klinesQuery.loading && candles.length === 0 ? (
              <Spinner3 label="正在加载K线" />
            ) : candles.length === 0 ? (
              <Empty message="该交易对与周期没有返回K线。" />
            ) : (
              <CandlestickChart candles={candles} height={460} />
            )}
          </Panel>

          {last && (
            <Panel title="最新K线" bodyClassName="p-3" padded={false}>
              <div className="grid grid-cols-3 gap-x-4 gap-y-1.5 md:grid-cols-6">
                <Readout label="开盘" value={fmtPrice(last.open)} />
                <Readout label="最高" value={fmtPrice(last.high)} tone="text-up" />
                <Readout label="最低" value={fmtPrice(last.low)} tone="text-down" />
                <Readout label="收盘" value={fmtPrice(last.close)} />
                <Readout label="成交量" value={fmtCompact(last.volume)} />
                <Readout label="成交额" value={fmtCompact(last.quoteVolume)} />
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

function Readout({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wide text-ink-faint">{label}</div>
      <div className={`num text-xs ${tone ?? 'text-ink-hi'}`}>{value}</div>
    </div>
  );
}
