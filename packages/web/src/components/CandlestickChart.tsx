/**
 * Candlestick chart wrapper.
 *
 * The chart instance is created once per mount and the series data is swapped on
 * every update — recreating the chart on each poll would reset the user's pan and
 * zoom, which is exactly the wrong behaviour in a live terminal.
 *
 * `lightweight-charts` is imported here and **nowhere else** outside a lazy
 * route chunk: it is the second-largest dependency in the app, and the
 * overview/login pages must not pay for it. Anything that needs candles must go
 * through this component (or another lazy import), never a static import from
 * the entry graph.
 */
import { useEffect, useRef } from 'react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Kline } from '@aq/shared';
import { CHART_INK } from './equityCurve';

export function CandlestickChart({
  candles,
  height = 460,
  loading = false,
}: {
  candles: Kline[];
  height?: number;
  /** Render the "no data yet" copy only once the first fetch has settled. */
  loading?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        /*
         * `ink-mid` (#a9b4c7) spelled out: lightweight-charts paints inside its
         * own canvas-like layer and takes colours as strings only — the same
         * exception as `CHART_INK` in `equityCurve.ts`, which is where every
         * other raw colour here comes from.
         *
         * `ink-mid`, not `ink-lo`: these are prices sitting on a dark grid, and
         * the dimmer token is unreadable at 11px on a laptop screen at 50%
         * brightness — which is how a trading desk is usually lit.
         */
        textColor: '#a9b4c7',
        fontFamily: 'JetBrains Mono, ui-monospace, Menlo, Consolas, monospace',
        fontSize: 11,
      },
      grid: {
        // `base-750`: one step off the panel, so the grid organises without
        // competing with the candles for attention.
        vertLines: { color: CHART_INK.grid },
        horzLines: { color: CHART_INK.grid },
      },
      rightPriceScale: {
        borderColor: CHART_INK.grid,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: CHART_INK.grid,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        // A minimum bar spacing keeps a 3-bar window from stretching each candle
        // into a slab that looks like a different timeframe.
        minBarSpacing: 2,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: CHART_INK.rule, labelBackgroundColor: CHART_INK.track, width: 1 },
        horzLine: { color: CHART_INK.rule, labelBackgroundColor: CHART_INK.track, width: 1 },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      localization: {
        priceFormatter: (price: number) =>
          price.toLocaleString('en-US', {
            minimumFractionDigits: price >= 1000 ? 2 : price >= 1 ? 3 : 6,
            maximumFractionDigits: price >= 1000 ? 2 : price >= 1 ? 3 : 6,
          }),
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: CHART_INK.up,
      downColor: CHART_INK.down,
      borderUpColor: CHART_INK.up,
      borderDownColor: CHART_INK.down,
      wickUpColor: CHART_INK.up,
      wickDownColor: CHART_INK.down,
      priceLineColor: CHART_INK.accent,
      priceLineStyle: LineStyle.Dashed,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    // Binance klines carry `openTime` in milliseconds; lightweight-charts wants seconds.
    const data: CandlestickData<Time>[] = candles
      .map((candle) => ({
        time: Math.floor(candle.openTime / 1000) as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));

    // Drop duplicate timestamps, which the series rejects.
    const deduped = data.filter((bar, index) => index === 0 || bar.time !== data[index - 1]?.time);
    series.setData(deduped);
  }, [candles]);

  return (
    <div className="relative w-full" style={{ height }}>
      <div ref={containerRef} className="h-full w-full" />
      {/*
       * Four states, not two: "still fetching" and "this symbol has no history
       * yet" look identical on a blank canvas but call for opposite reactions
       * from the operator, so they get different words.
       */}
      {candles.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center">
          <p className="text-base text-ink-lo">{loading ? '正在加载K线…' : '该周期暂无K线数据'}</p>
          {!loading && <p className="text-xs text-ink-faint">换一个周期或交易对试试。</p>}
        </div>
      )}
    </div>
  );
}
