/**
 * Equity curve — the recharts half of the dashboard charts.
 *
 * **This file exists to keep `recharts` out of the overview page's chunk.**
 *
 * `DashboardCharts.tsx` exports the same chart for the per-trader dashboard, and
 * it is fine there: that page is lazy, so recharts rides along with it. The
 * overview page is the *first* thing a user sees after logging in, and importing
 * the chart row directly would have pulled the whole library into the landing
 * chunk. So the recharts-using part lives alone here and is reached only through
 * `lazy(() => import('./EquityCurveChart'))` — it downloads right after the
 * shell paints instead of in front of it.
 *
 * Because of that split this file must stay the **only** thing in the module:
 * a single non-chart import (say, a shared tooltip component) would drag the
 * library back into whoever imports the helper.
 *
 * The arithmetic the two implementations share lives in `./equityCurve` — plain
 * numbers and strings, no charting dependency.
 */
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtTime } from '../lib/format';
import { equityAxisFormatter, rangeSpanMs, type EquityPoint } from './equityCurve';

/* -------------------------------------------------------------------------- */
/*  Palette                                                                    */
/* -------------------------------------------------------------------------- */

/*
 * SVG `stroke` / `fill` attributes cannot take a Tailwind class, so these are
 * hex literals — the one place in the app where a raw colour is unavoidable.
 * They are kept **identical to the design tokens** in tailwind.config.js
 * (`up`, `down`, `base-750`, `ink-lo`, `base-950`, `base-850`, `accent`) and to
 * the values in `CandlestickChart.tsx`, so the curve, the candles and every
 * chip on the page agree. If a token changes, these five lines change with it.
 */
const UP = '#2ed3a3';
const DOWN = '#ff6b7a';
const GRID = '#232a38';
const AXIS = '#76839a';
const BASELINE = '#3a4558';
const TOOLTIP_BG = '#11151e';
const ACCENT = '#5b8def';

/** Two decimals in the tooltip: an axis label is a scale, not a number to act on. */
const TOOLTIP_DIGITS = 2;

/* -------------------------------------------------------------------------- */
/*  Tooltip                                                                    */
/* -------------------------------------------------------------------------- */

interface TooltipRow {
  label: string;
  value: string;
  tone?: string;
}

/**
 * The floating panel itself.
 *
 * Deliberately a plain HTML div styled with the app's own tokens rather than
 * recharts' default white box: the default is unreadable on a dark terminal, and
 * `contentStyle={{...}}` can only reach the wrapper — the inner rows stay
 * white-on-white.
 */
function TooltipPanel({ rows, footer }: { rows: TooltipRow[]; footer: string }) {
  return (
    <div
      /* border rather than only `shadow-overlay`: over the filled area a shadow
         alone is nearly invisible on a dark background. */
      className="pointer-events-none min-w-[10rem] rounded-md border border-base-600 px-2.5 py-1.5 shadow-overlay"
      style={{ backgroundColor: TOOLTIP_BG }}
    >
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-ink-lo">{row.label}</span>
          <span className={`num text-sm ${row.tone ?? 'text-ink-hi'}`}>{row.value}</span>
        </div>
      ))}
      <div className="num mt-0.5 border-t border-base-750 pt-0.5 text-xs text-ink-faint">{footer}</div>
    </div>
  );
}

/** Which figure the tooltip leads with: the curve's own domain, or the whole account. */
interface TooltipOptions {
  primaryLabel: string;
  primaryValue: (point: EquityPoint) => string;
  primaryTone?: (point: EquityPoint) => string;
  extra?: (point: EquityPoint) => TooltipRow | null;
}

function buildTooltip(options: TooltipOptions) {
  return function EquityTooltip({
    active,
    payload,
  }: {
    active?: boolean;
    payload?: Array<{ payload?: EquityPoint }>;
  }) {
    if (!active) return null;
    const point = payload?.[0]?.payload;
    if (!point) return null;
    const rows: TooltipRow[] = [
      { label: options.primaryLabel, value: options.primaryValue(point), tone: options.primaryTone?.(point) },
    ];
    const extra = options.extra?.(point);
    if (extra) rows.push(extra);
    return <TooltipPanel rows={rows} footer={new Date(point.t).toLocaleString('en-GB', { hour12: false })} />;
  };
}

/**
 * The cursor is a thin solid line.
 *
 * The default is a wide translucent grey band; over a dark chart that reads as a
 * smudge across the curve rather than as a pointer at one snapshot.
 */
function Cursor({ points }: { points?: Array<{ x?: number; y?: number }> }) {
  const x = points?.[0]?.x;
  if (typeof x !== 'number') return null;
  return <line x1={x} x2={x} y1={0} y2="100%" stroke={BASELINE} strokeWidth={1} />;
}

/* -------------------------------------------------------------------------- */
/*  The chart                                                                  */
/* -------------------------------------------------------------------------- */

export interface EquityCurveChartProps {
  points: EquityPoint[];
  /** Visible window, so the time axis can switch between `HH:MM` and `MM-DD`. */
  range: string;
  height?: number;
  /** Dashed reference line — the account's starting equity. */
  baseline?: number;
  /**
   * Where the figures come from. The overview sums several traders, so a point
   * there is the combined book and not any one account's balance.
   */
  primaryLabel?: string;
  primaryDigits?: number;
  /** Adds `浮动盈亏` from the snapshot, for the per-trader curve. */
  showUnrealized?: boolean;
}

export function EquityCurveChart({
  points,
  range,
  height = 300,
  baseline,
  primaryLabel = '归属权益',
  primaryDigits = TOOLTIP_DIGITS,
  showUnrealized = false,
}: EquityCurveChartProps) {
  const values = points.map((point) => point.equity);

  /*
   * 只取有限值参与极值计算。
   *
   * 空数组或含 NaN 时 `Math.min()` 返回 `Infinity`、`Math.max()` 返回 `-Infinity`，
   * 由此算出的 domain 是 `[Infinity, -Infinity]` —— recharts 遇到非法 domain 会
   * **静默回落到默认的 `[0, 'auto']`**。后果是一个权益 1000 的账户，
   * Y 轴却铺满 0–1000，曲线被压在顶部，99% 的绘图区是空的：
   * 横盘看不出，小波动也看不出。
   *
   * 这个项目里真实出现过（总览页在只有一个快照点时就是这样）。
   */
  const finite = values.filter((value) => Number.isFinite(value));
  const hasData = finite.length > 0;

  const min = hasData ? Math.min(...finite) : 0;
  const max = hasData ? Math.max(...finite) : 0;
  const first = finite[0] ?? 0;
  const last = finite[finite.length - 1] ?? 0;
  const rising = last >= first;

  const stroke = rising ? UP : DOWN;

  /*
   * Y 轴的最小留白，而不是纯百分比留白。
   *
   * 没有它，完全走平的账户（所有快照相等）会塌成一个零高度的 domain，
   * 曲线要么贴在边上、要么干脆不画。0.5 USDT 对大账户足够诚实，
   * 又足以让一个安静的账户保持可见。
   */
  const pad = Math.max((max - min) * 0.12, Math.abs(max) * 0.002, 0.5);

  /*
   * 退化时围绕**基线**取窗口，而不是围绕 0。
   *
   * `baseline` 是该机器人的起始权益，也就是这条线"本来该在"的位置。
   * 用它做中心，一个还没有快照的机器人会看到一条居中的平线 ——
   * 这比铺满 0 到 1000 的空白坐标轴诚实得多，也让人一眼知道
   * "图表在工作，只是还没有数据变化"，而不是"图表坏了"。
   */
  const center = hasData ? (min + max) / 2 : (baseline ?? 1000);

  const domain: [number, number] = hasData
    ? [min - pad, max + pad]
    : [center - Math.max(center * 0.002, 0.5), center + Math.max(center * 0.002, 0.5)];

  const reference = baseline ?? (hasData ? first : center);
  const spanDays = rangeSpanMs(range) / 86_400_000;
  const axisTick =
    spanDays <= 1
      ? (value: number) => fmtTime(new Date(value).toISOString())
      : (value: number) =>
          new Date(value).toLocaleDateString('en-CA', { month: '2-digit', day: '2-digit' });

  const TooltipContent = buildTooltip({
    primaryLabel,
    primaryValue: (point) => `${equityAxisFormatter(point.equity)} USDT`,
    primaryTone: () => 'text-ink-hi',
    extra: showUnrealized
      ? (point) => ({
          label: '浮动盈亏',
          value: signed(point.unrealizedPnl ?? 0, primaryDigits),
          tone: (point.unrealizedPnl ?? 0) >= 0 ? 'text-up' : 'text-down',
        })
      : undefined,
  });

  return (
    <ResponsiveContainer width="100%" height={height}>
      {/* `left: 0` and no axis title: the y labels already carry the unit's
          magnitude, and a title would cost the curve real width. */}
      <AreaChart data={points} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="aqEquityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.3} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
          </linearGradient>
        </defs>

        {/* Horizontal only: vertical grid lines land on top of the time axis
            labels and make a dense window look like a barcode. */}
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />

        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={axisTick}
          tick={{ fill: AXIS, fontSize: 11 }}
          tickLine={false}
          axisLine={{ stroke: GRID }}
          minTickGap={44}
          tickMargin={6}
        />
        <YAxis
          domain={domain}
          tickFormatter={equityAxisFormatter}
          tick={{ fill: AXIS, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={62}
          tickMargin={4}
          /* Left-aligned ticks keep a stable 62px gutter whether the account
             reads 9.99 or 1.23M — right-aligned ticks shift the whole axis. */
          tickCount={5}
        />

        <Tooltip
          content={<TooltipContent />}
          cursor={<Cursor />}
          /* One point at a time: a band highlight over a single series just
             dims the curve the user is trying to read. */
          shared={false}
          isAnimationActive={false}
          wrapperStyle={{ outline: 'none' }}
        />

        <ReferenceLine
          y={reference}
          stroke={BASELINE}
          strokeDasharray="4 4"
          label={{ value: '初始', fill: AXIS, fontSize: 10, position: 'insideTopRight' }}
          ifOverflow="extendDomain"
        />

        <Area
          type="monotone"
          dataKey="equity"
          stroke={stroke}
          strokeWidth={1.8}
          fill="url(#aqEquityFill)"
          dot={false}
          /* Off on purpose: this polls every few seconds, and a curve that
             re-draws itself from scratch on every refresh flickers badly in
             peripheral vision — which is exactly where a trading terminal lives. */
          isAnimationActive={false}
          activeDot={{ r: 3, fill: stroke, stroke: TOOLTIP_BG, strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Signed USDT, sign always present so colour is never the only signal. */
function signed(value: number, digits: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(digits)}`;
}