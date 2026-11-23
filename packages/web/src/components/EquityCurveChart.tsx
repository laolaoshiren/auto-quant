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
import { axisTicks, equityAxisFormatter, HOURLY_AXIS_MAX_MS, rangeSpanMs, type EquityPoint } from './equityCurve';
import { useChartInk } from './useChartInk';

/*
 * ⚠️ **这里不再有一份本地的调色板。**
 *
 * 原来这个文件里写着 `UP = '#2ed3a3'` / `ACCENT = '#5b8def'` 等七个字面量，
 * 而 `DashboardCharts.tsx` 与 `CandlestickChart.tsx` 用的是
 * `equityCurve.CHART_INK` —— **两套值，而且已经漂移了**（这里还是旧的
 * 青绿 + 琥珀，那边已经是币安的绿红；主色这边是蓝、那边是紫）。
 *
 * 后果是：同一个账户的权益曲线，在总览页是青绿、在机器人详情页是另一种绿，
 * 而两边看起来都"正常"。所以现在统一走 `useChartInk()`：它按**当前模板**
 * 与深浅从 CSS 变量读，并在外观切换时重新读（见那个 hook 的注释）。
 *
 * 这也顺带解决了模板问题：两套模板的 `--aq-up` / `--aq-accent` 是不同的色，
 * 而写死的字面量**不会**跟着变 —— 换模板后整页都换了，只剩这条曲线还是旧的。
 */

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
function TooltipPanel({
  rows,
  footer,
  surface,
}: {
  rows: TooltipRow[];
  footer: string;
  /** 提示框底色 = 当前外观下的 `base-900`（不透明，免得曲线从数字后面透出来）。 */
  surface: string;
}) {
  return (
    <div
      /* border rather than only `shadow-overlay`: over the filled area a shadow
         alone is nearly invisible on a dark background. */
      className="pointer-events-none min-w-[10rem] rounded-md border border-base-600 px-2.5 py-1.5 shadow-overlay"
      style={{ backgroundColor: surface }}
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

interface EquityTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: EquityPoint }>;
  primaryLabel: string;
  primaryDigits: number;
  /** 当前外观的提示框底色（`ink.surface`），由调用方透传进来。 */
  surface: string;
  showUnrealized: boolean;
}

/**
 * 模块级稳定 Tooltip 组件：通过 props 接收配置而非在渲染体内动态工厂新建组件类型，
 * 避免每次轮询重渲染都把 Tooltip 子树反复卸载重建。
 */
function EquityTooltip({
  active,
  payload,
  primaryLabel,
  primaryDigits,
  surface,
  showUnrealized,
}: EquityTooltipProps) {
  if (!active) return null;
  const point = payload?.[0]?.payload;
  if (!point) return null;
  const rows: TooltipRow[] = [
    { label: primaryLabel, value: `${equityAxisFormatter(point.equity)} USDT`, tone: 'text-ink-hi' },
  ];
  if (showUnrealized) {
    const unrealized = point.unrealizedPnl ?? 0;
    rows.push({
      label: '浮动盈亏',
      value: signed(unrealized, primaryDigits),
      tone: unrealized >= 0 ? 'text-up' : 'text-down',
    });
  }
  return (
    <TooltipPanel
      rows={rows}
      footer={new Date(point.t).toLocaleString('en-GB', { hour12: false })}
      surface={surface}
    />
  );
}

/**
 * The cursor is a thin solid line.
 *
 * The default is a wide translucent grey band; over a dark chart that reads as a
 * smudge across the curve rather than as a pointer at one snapshot.
 */
function Cursor({ points, color }: { points?: Array<{ x?: number; y?: number }>; color: string }) {
  const x = points?.[0]?.x;
  if (typeof x !== 'number') return null;
  return <line x1={x} x2={x} y1={0} y2="100%" stroke={color} strokeWidth={1} />;
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
  /* 当前外观（模板 + 深浅）下的图表配色，切的时候重绘。 */
  const ink = useChartInk();
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

  const stroke = rising ? ink.up : ink.down;

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
  /*
   * 阈值与刻度摆放共用 `HOURLY_AXIS_MAX_MS` —— 见 `axisTicks` 的注释：
   * 一处按整点摆、另一处把整点格式化成日期，会得到重复标签。
   */
  const axisTick =
    rangeSpanMs(range) <= HOURLY_AXIS_MAX_MS
      ? (value: number) => fmtTime(new Date(value).toISOString())
      : (value: number) =>
          new Date(value).toLocaleDateString('en-CA', { month: '2-digit', day: '2-digit' });
  /*
   * 刻度钉在真实的整点 / 日界上 —— 与交易页那条曲线同一份实现，
   * 否则同一个区间在两个页面上会长出两条不一样的时间轴。
   */
  const ticks = axisTicks(points, range);

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
        <CartesianGrid stroke={ink.grid} strokeDasharray="3 3" vertical={false} />

        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          /* 刻度钉在真实整点/日界上，理由见 `equityCurve.axisTicks`。 */
          {...(ticks.length > 0 ? { ticks } : {})}
          tickFormatter={axisTick}
          tick={{ fill: ink.axis, fontSize: 11 }}
          tickLine={false}
          axisLine={{ stroke: ink.grid }}
          minTickGap={44}
          tickMargin={6}
        />
        <YAxis
          domain={domain}
          tickFormatter={equityAxisFormatter}
          tick={{ fill: ink.axis, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={62}
          tickMargin={4}
          /* Left-aligned ticks keep a stable 62px gutter whether the account
             reads 9.99 or 1.23M — right-aligned ticks shift the whole axis. */
          tickCount={5}
        />

        <Tooltip
          content={
            <EquityTooltip
              primaryLabel={primaryLabel}
              primaryDigits={primaryDigits}
              surface={ink.surface}
              showUnrealized={showUnrealized}
            />
          }
          cursor={<Cursor color={ink.rule} />}
          /* One point at a time: a band highlight over a single series just
             dims the curve the user is trying to read. */
          shared={false}
          isAnimationActive={false}
          wrapperStyle={{ outline: 'none' }}
        />

        <ReferenceLine
          y={reference}
          stroke={ink.rule}
          strokeDasharray="4 4"
          label={{ value: '初始', fill: ink.axis, fontSize: 10, position: 'insideTopRight' }}
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
          activeDot={{ r: 3, fill: stroke, stroke: ink.surface, strokeWidth: 2 }}
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
