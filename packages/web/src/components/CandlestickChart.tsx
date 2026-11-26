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
  TickMarkType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { fmtBeijingTime, type Kline } from '@aq/shared';
import { formatCandlePrice } from '../lib/format';
import type { ChartPriceLine } from './chartPriceLines';
import { useChartInk } from './useChartInk';

function timeToMs(time: Time): number | null {
  if (typeof time === 'number' && Number.isFinite(time)) return time * 1000;
  if (typeof time === 'string') {
    const ms = Date.parse(time);
    return Number.isFinite(ms) ? ms : null;
  }
  if (time && typeof time === 'object' && 'year' in time) {
    return Date.UTC(time.year, time.month - 1, time.day);
  }
  return null;
}

function formatBeijingCrosshairTime(time: Time): string {
  const ms = timeToMs(time);
  return ms === null ? '' : fmtBeijingTime(ms, 'minute');
}

function formatBeijingTickMark(time: Time, tickMarkType: TickMarkType): string {
  const ms = timeToMs(time);
  if (ms === null) return '';
  switch (tickMarkType) {
    case TickMarkType.Year:
      return fmtBeijingTime(ms, 'y');
    case TickMarkType.Month:
      return fmtBeijingTime(ms, 'ym');
    case TickMarkType.DayOfMonth:
      return fmtBeijingTime(ms, 'md');
    case TickMarkType.TimeWithSeconds:
      return fmtBeijingTime(ms, 'hms');
    case TickMarkType.Time:
    default:
      return fmtBeijingTime(ms, 'hm');
  }
}

export function CandlestickChart({
  candles,
  priceLines,
  height = 460,
  loading = false,
  fill = false,
}: {
  candles: Kline[];
  /**
   * 仅针对当前有持仓或挂单的交易对绘制水平参考线（开仓均价 / 挂单开仓 / 止损 / 止盈）。
   * 未传入或为空数组时不绘制任何额外线条。
   */
  priceLines?: ReadonlyArray<ChartPriceLine>;
  /**
   * 固定高度（像素）。`fill` 为真时**忽略**它 —— 高度改由容器决定。
   */
  height?: number;
  /** Render the "no data yet" copy only once the first fetch has settled. */
  loading?: boolean;
  /**
   * 撑满父容器的高度，而不是用固定像素。
   *
   * ## 为什么需要它
   *
   * 行情页要"不滚动就能看完"：图表得吃掉交易对表之外剩下的高度。写死 460px
   * 时，窗口高一点就留一大片空、矮一点就把「最新K线」挤到屏幕外 —— 两种都
   * 要用户滚动。用户的原话是「自动适配页面长度，不要超出页面」。
   *
   * 高度跟随容器需要两件事，缺一不可：
   *
   *   1. 外层 `h-full`（而不是 `style={{height}}`）—— 否则容器只有 0 高；
   *   2. `ResizeObserver` **同时**上报高度（原来只报宽度）—— lightweight-charts
   *      的 canvas 尺寸由它自己的 options 决定，CSS 变高不会自动跟上。
   *
   * 父级必须给出确定高度（`flex-1` + `min-h-0`），否则 `h-full` 解析成 `auto`，
   * 图表会塌成 0 —— 与 `PageShell` 那条 `min-h-0` 是同一个道理。
   */
  fill?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLineHandlesRef = useRef<IPriceLine[]>([]);
  /*
   * 当前外观下的配色。**换模板或切深浅时它会变**，而下面两个 effect 都依赖
   * 它 —— 所以图表会跟着重画，不会停在上一套主题的绿上（见 `useChartInk`）。
   */
  const ink = useChartInk();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      /* `fill` 模式下直接取容器实际高度（而不是写死默认 460），避免首帧溢出或跳动。 */
      height: fill ? container.clientHeight : height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        /*
         * lightweight-charts 在自己的 canvas 层里画，颜色只能是字符串 ——
         * 与 `equityCurve.ts` 里的 `CHART_INK` 是同一个例外，这里也统一
         * 走 `ink`（它按当前模板与深浅实时取色）。
         *
         * 用 `inkMid` 而不是 `axis`：这些是压在网格上的**价格数字**，
         * 用刻度线那一档的灰在 11px 上读不清 —— 而交易台的屏幕亮度通常
         * 只开到一半。
         */
        textColor: ink.inkMid,
        fontFamily: 'JetBrains Mono, ui-monospace, Menlo, Consolas, monospace',
        fontSize: 11,
      },
      grid: {
        // `base-750`: one step off the panel, so the grid organises without
        // competing with the candles for attention.
        vertLines: { color: ink.grid },
        horzLines: { color: ink.grid },
      },
      rightPriceScale: {
        borderColor: ink.grid,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: ink.grid,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        // A minimum bar spacing keeps a 3-bar window from stretching each candle
        // into a slab that looks like a different timeframe.
        minBarSpacing: 2,
        // 统一以北京时间（UTC+8）渲染 K 线横轴刻度，避免 lightweight-charts 默认显示 UTC 慢 8 小时。
        tickMarkFormatter: formatBeijingTickMark,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: ink.rule, labelBackgroundColor: ink.track, width: 1 },
        horzLine: { color: ink.rule, labelBackgroundColor: ink.track, width: 1 },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      localization: {
        priceFormatter: formatCandlePrice,
        timeFormatter: formatBeijingCrosshairTime,
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: ink.up,
      downColor: ink.down,
      borderUpColor: ink.up,
      borderDownColor: ink.down,
      wickUpColor: ink.up,
      wickDownColor: ink.down,
      priceLineColor: ink.accent,
      priceLineStyle: LineStyle.Dashed,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    let rafId: number | null = null;
    const syncSize = () => {
      rafId = null;
      const el = containerRef.current;
      if (!el || chartRef.current !== chart) return;
      const nextWidth = el.clientWidth;
      const nextHeight = el.clientHeight;
      if (nextWidth <= 0 || (fill && nextHeight <= 0)) return;
      /*
       * 高度也要跟着报 —— 只报宽度时，`fill` 模式下的 canvas 会停在初始高度，
       * 容器变高了图表还是一小条（见 `fill` 的说明）。
       */
      chart.applyOptions({
        width: nextWidth,
        ...(fill ? { height: nextHeight } : {}),
      });
    };

    const scheduleResize = () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(syncSize);
    };

    const observer = new ResizeObserver(scheduleResize);
    observer.observe(container);
    // 初始化挂载后补一次 rAF 尺寸同步，确保首帧撑满父容器 100% 宽度
    scheduleResize();

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      observer.disconnect();
      priceLineHandlesRef.current = [];
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    /*
     * ⚠️ **依赖里没有 `ink`**，这是刻意的。
     *
     * 把 `ink` 放进来会让"换模板"变成"重建图表" —— 而重建会**丢掉用户
     * 当前的缩放与平移位置**（本文件顶部那段注释正是说这件事：重建是
     * 实时终端里最不该发生的行为）。
     *
     * 外观变化的处理放在下面那个 `applyOptions` 的 effect 里：换配色不需要
     * 换图表，只需要把新的颜色**应用**上去。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill, height]);

  /*
   * 外观（模板 / 深浅）变化时，把新配色**应用**到已有的图表与序列上。
   *
   * 用 `applyOptions` 而不是重建：用户在这里可能已经缩放到某个区间，
   * 重建会把他拨回去（见上面那段注释）。`applyOptions` 只换颜色，
   * 视口与数据一个都不动。
   */
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    chart.applyOptions({
      layout: { textColor: ink.inkMid },
      grid: { vertLines: { color: ink.grid }, horzLines: { color: ink.grid } },
      rightPriceScale: { borderColor: ink.grid },
      timeScale: { borderColor: ink.grid },
      crosshair: {
        vertLine: { color: ink.rule, labelBackgroundColor: ink.track },
        horzLine: { color: ink.rule, labelBackgroundColor: ink.track },
      },
    });
    series.applyOptions({
      upColor: ink.up,
      downColor: ink.down,
      borderUpColor: ink.up,
      borderDownColor: ink.down,
      wickUpColor: ink.up,
      wickDownColor: ink.down,
      priceLineColor: ink.accent,
    });
  }, [ink]);

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

  /*
   * 持仓 / 委托水平价格线（开仓均价、挂单开仓、止损、止盈）。
   * 独立于图表重建与 K 线 setData，切换价位或切换深浅主题时仅原地替换 PriceLine，
   * 绝不重置用户当前的缩放与平移视口。
   */
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    for (const handle of priceLineHandlesRef.current) {
      try {
        series.removePriceLine(handle);
      } catch {
        /* ignore if series already detached */
      }
    }
    priceLineHandlesRef.current = [];

    if (!priceLines || priceLines.length === 0) return;

    for (const item of priceLines) {
      const color =
        item.kind === 'take_profit'
          ? ink.up
          : item.kind === 'stop_loss'
            ? ink.down
            : item.kind === 'pending_entry'
              ? ink.warn
              : ink.accent;
      const lineStyle = item.kind === 'entry' ? LineStyle.Solid : LineStyle.Dashed;
      const lineWidth = item.kind === 'entry' ? 2 : 1;

      const handle = series.createPriceLine({
        price: item.price,
        color,
        lineWidth,
        lineStyle,
        axisLabelVisible: true,
        title: item.title,
      });
      priceLineHandlesRef.current.push(handle);
    }
  }, [priceLines, ink, fill, height]);

  return (
    /*
     * `fill` 走 `h-full`（父级已经给了确定高度），否则用固定像素。
     * 不做兜底：父级没给高度时图表塌成 0 是**立刻看得见的**错误，
     * 比"看着正常但画在屏幕外"好排查。
     */
    <div className={fill ? 'relative h-full w-full' : 'relative w-full'} style={fill ? undefined : { height }}>
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
