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

/**
 * Candlestick chart wrapper.
 *
 * The chart instance is created once per mount and the series data is swapped on
 * every update — recreating the chart on each poll would reset the user's pan and
 * zoom, which is exactly the wrong behaviour in a live terminal.
 */
export function CandlestickChart({ candles, height = 460 }: { candles: Kline[]; height?: number }) {
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
        textColor: '#a7b0c0',
        fontFamily: 'JetBrains Mono, ui-monospace, Menlo, Consolas, monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#15181f' },
        horzLines: { color: '#15181f' },
      },
      rightPriceScale: {
        borderColor: '#21242e',
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: '#21242e',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#3a3f4d', labelBackgroundColor: '#21242e' },
        horzLine: { color: '#3a3f4d', labelBackgroundColor: '#21242e' },
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
      upColor: '#22c98a',
      downColor: '#f4525f',
      borderUpColor: '#22c98a',
      borderDownColor: '#f4525f',
      wickUpColor: '#22c98a',
      wickDownColor: '#f4525f',
      priceLineColor: '#4d8dff',
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

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}
