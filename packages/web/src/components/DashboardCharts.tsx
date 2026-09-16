/**
 * Per-trader dashboard chart primitives: the equity curve and the win/loss bar.
 *
 * Kept apart from the page so each can be reasoned about (and reused) on its own.
 *
 * The overview page reaches the same visual language through
 * `EquityCurveChart.tsx`, which is a separate module on purpose — see the header
 * of that file for why the recharts import must not be shared.
 */
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { EquitySnapshot } from '@aq/shared';
import { fmtInt, fmtNum, fmtTime } from '../lib/format';
import { CHART_INK, equityAxisFormatter, filterByRange, rangeSpanMs, type EquityPoint, type EquityRange } from './equityCurve';

/* -------------------------------------------------------------------------- */
/*  Equity chart                                                               */
/* -------------------------------------------------------------------------- */

interface EquityTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: EquityPoint }>;
}

/**
 * The floating readout.
 *
 * A plain div styled with the app's tokens rather than recharts' default white
 * box: the default is unreadable on a dark terminal, and `contentStyle` can only
 * reach the wrapper — the rows inside stay dark-on-dark.
 */
function EquityTooltip({ active, payload }: EquityTooltipProps) {
  if (!active) return null;
  const point = payload?.[0]?.payload;
  if (!point) return null;

  const floating = point.unrealizedPnl ?? 0;
  return (
    <div
      className="pointer-events-none min-w-[10rem] rounded-md border border-base-600 px-2.5 py-1.5 shadow-overlay"
      style={{ backgroundColor: CHART_INK.surface }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-lo">权益</span>
        <span className="num text-sm text-ink-hi">{fmtNum(point.equity, 2)} USDT</span>
      </div>
      {point.unrealizedPnl !== undefined && (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-ink-lo">浮动盈亏</span>
          {/* Sign always present: colour alone is not a signal every operator can read. */}
          <span className={`num text-sm ${floating >= 0 ? 'text-up' : 'text-down'}`}>
            {floating >= 0 ? '+' : '-'}${fmtNum(Math.abs(floating), 2)}
          </span>
        </div>
      )}
      <div className="mt-0.5 flex items-baseline justify-between gap-3 border-t border-base-750 pt-0.5">
        <span className="text-xs text-ink-lo">持仓</span>
        <span className="num text-xs text-ink-mid">{fmtInt(point.openPositions ?? 0)}</span>
      </div>
      <div className="num text-xs text-ink-faint">
        {new Date(point.t).toLocaleString('en-GB', { hour12: false })}
      </div>
    </div>
  );
}

/**
 * The hover cursor.
 *
 * Recharts' default is a wide translucent grey band; over a dark chart that
 * reads as a smudge across the curve rather than as a pointer at one snapshot.
 */
function EquityCursor({ points }: { points?: Array<{ x?: number; y?: number }> }) {
  const x = points?.[0]?.x;
  if (typeof x !== 'number') return null;
  return <line x1={x} x2={x} y1={0} y2="100%" stroke={CHART_INK.rule} strokeWidth={1} />;
}

export function DashboardEquityChart({
  snapshots,
  range,
  height = 240,
  baseline,
  asset,
}: {
  snapshots: EquitySnapshot[];
  range: EquityRange;
  height?: number;
  baseline?: number;
  /** Settlement unit for the readout. Defaults to USDT, the only one in practice. */
  asset?: string;
}) {
  const windowed = filterByRange(snapshots, range);
  const points: EquityPoint[] = windowed
    .map((snapshot) => ({
      t: new Date(snapshot.timestamp).getTime(),
      equity: snapshot.equity,
      unrealizedPnl: snapshot.unrealizedPnl,
      openPositions: snapshot.openPositions,
    }))
    .filter((point) => Number.isFinite(point.t));

  if (points.length < 2) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-base-700 px-4 text-center"
        style={{ height }}
      >
        <p className="text-base text-ink-lo">还没有足够的权益快照</p>
        <p className="text-xs text-ink-faint">每个决策周期结束时会记录一次，两个周期后这里就会画出曲线。</p>
      </div>
    );
  }

  const values = points.map((p) => p.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  /*
   * A *minimum* pad, not just a proportional one.
   *
   * A fully flat account (every snapshot equal) would otherwise collapse to a
   * zero-height domain and the curve renders pinned to one edge — or not at all.
   * 0.5 is small enough to stay honest on a large account and large enough to
   * keep a quiet one visible.
   */
  const pad = Math.max((max - min) * 0.12, Math.abs(max) * 0.002, 0.5);
  const domain: [number, number] = [min - pad, max + pad];
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const rising = last >= first;
  const stroke = rising ? CHART_INK.up : CHART_INK.down;
  const referenceValue = baseline ?? first;
  const unit = asset?.trim() || 'USDT';

  // Under a day the axis is a clock; past that a clock tells the operator
  // nothing about where in the month a dip happened.
  const axisTick =
    rangeSpanMs(range) <= 24 * 3600 * 1000
      ? (value: number) => fmtTime(new Date(value).toISOString())
      : (value: number) => new Date(value).toLocaleDateString('en-CA', { month: '2-digit', day: '2-digit' });

  return (
    <ResponsiveContainer width="100%" height={height}>
      {/* No left margin and no axis title: the tick labels already carry the
          magnitude, and a title would cost the curve real width. */}
      <AreaChart data={points} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="dashboardEquityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.3} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {/* Horizontal only: vertical lines land on the time labels and turn a
            dense window into a barcode. */}
        <CartesianGrid stroke={CHART_INK.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={axisTick}
          tick={{ fill: CHART_INK.axis, fontSize: 11 }}
          tickLine={false}
          axisLine={{ stroke: CHART_INK.grid }}
          minTickGap={44}
          tickMargin={6}
        />
        <YAxis
          domain={domain}
          tickFormatter={equityAxisFormatter}
          tick={{ fill: CHART_INK.axis, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={62}
          tickMargin={4}
          tickCount={5}
        />
        <Tooltip
          content={<EquityTooltip />}
          cursor={<EquityCursor />}
          shared={false}
          isAnimationActive={false}
          wrapperStyle={{ outline: 'none' }}
        />
        <ReferenceLine
          y={referenceValue}
          stroke={CHART_INK.rule}
          strokeDasharray="4 4"
          label={{ value: '初始', fill: CHART_INK.axis, fontSize: 10, position: 'insideTopRight' }}
          ifOverflow="extendDomain"
        />
        <Area
          type="monotone"
          dataKey="equity"
          stroke={stroke}
          strokeWidth={1.8}
          fill="url(#dashboardEquityFill)"
          dot={false}
          /* Off on purpose: the page polls, and a curve that re-draws itself from
             scratch every few seconds flickers in peripheral vision — which is
             exactly where a trading terminal lives. */
          isAnimationActive={false}
          activeDot={{ r: 3, fill: stroke, stroke: CHART_INK.surface, strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* -------------------------------------------------------------------------- */
/*  Win / loss proportional bar                                                */
/* -------------------------------------------------------------------------- */

export function WinLossBar({ wins, losses }: { wins: number; losses: number }) {
  const total = wins + losses;
  const winPercent = total > 0 ? (wins / total) * 100 : 0;

  return (
    <div className="mt-1">
      {/*
       * The track is a neutral token, not `bg-down/50`.
       *
       * With no trades closed the old track still painted half its width in the
       * loss colour, so a brand-new bot looked like it had a 50% loss rate. With
       * trades, a grey track reads as "the remainder" instead of implying the
       * unfilled part is all losses.
       */}
      <div
        className="flex h-1.5 w-full overflow-hidden rounded-full"
        style={{ backgroundColor: CHART_INK.track }}
        role="img"
        aria-label={`${fmtInt(wins)} 笔盈利，${fmtInt(losses)} 笔亏损`}
      >
        <div className="h-full" style={{ width: `${winPercent}%`, backgroundColor: CHART_INK.up }} />
      </div>
      <div className="mt-0.5 flex items-center justify-between text-xs">
        <span className="num text-up">{fmtInt(wins)} 盈</span>
        <span className="num text-down">{fmtInt(losses)} 亏</span>
      </div>
    </div>
  );
}
