/**
 * Dashboard chart + stat-card primitives.
 *
 * Kept apart from the page so the equity chart, the leverage gauge and the win
 * ratio bar can each be reasoned about (and reused) on their own.
 */
import type { ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { EquitySnapshot } from '@aq/shared';
import { fmtCompact, fmtInt, fmtNum, fmtTime } from '../lib/format';

/* -------------------------------------------------------------------------- */
/*  Equity chart                                                               */
/* -------------------------------------------------------------------------- */

export type EquityRange = '1D' | '7D' | '1M' | '3M' | 'ALL';

export const EQUITY_RANGES: Array<{ id: EquityRange; label: string; ms: number | null }> = [
  { id: '1D', label: '1D', ms: 24 * 3600 * 1000 },
  { id: '7D', label: '7D', ms: 7 * 24 * 3600 * 1000 },
  { id: '1M', label: '1M', ms: 30 * 24 * 3600 * 1000 },
  { id: '3M', label: '3M', ms: 90 * 24 * 3600 * 1000 },
  { id: 'ALL', label: '全部', ms: null },
];

/** Down-sample to the selected window. `ALL` keeps everything. */
export function filterByRange(snapshots: EquitySnapshot[], range: EquityRange): EquitySnapshot[] {
  const window = EQUITY_RANGES.find((r) => r.id === range)?.ms ?? null;
  if (window === null) {
    return [...snapshots].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  const cutoff = Date.now() - window;
  const inside = snapshots.filter((s) => new Date(s.timestamp).getTime() >= cutoff);
  // A quiet account can have nothing inside a short window; showing an empty
  // chart would read as "no data" when the truth is "nothing recent".
  return inside.length >= 2 ? sortSnapshots(inside) : sortSnapshots(snapshots).slice(-2);
}

function sortSnapshots(snapshots: EquitySnapshot[]): EquitySnapshot[] {
  return [...snapshots].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

interface EquityPoint {
  t: number;
  equity: number;
}

function EquityTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: EquityPoint }> }) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="rounded border border-base-600 bg-base-850 px-2 py-1 text-2xs shadow-panel">
      <div className="num text-ink-hi">{fmtNum(point.equity, 2)} USDT</div>
      <div className="num text-ink-faint">{new Date(point.t).toLocaleString('en-GB', { hour12: false })}</div>
    </div>
  );
}

export function DashboardEquityChart({
  snapshots,
  range,
  height = 240,
  baseline,
}: {
  snapshots: EquitySnapshot[];
  range: EquityRange;
  height?: number;
  baseline?: number;
}) {
  const windowed = filterByRange(snapshots, range);
  const points: EquityPoint[] = windowed
    .map((snapshot) => ({ t: new Date(snapshot.timestamp).getTime(), equity: snapshot.equity }))
    .filter((point) => Number.isFinite(point.t));

  if (points.length < 2) {
    return (
      <div
        className="flex items-center justify-center rounded border border-dashed border-base-700 text-2xs text-ink-faint"
        style={{ height }}
      >
        权益快照不足 — 第二个周期后才会显示曲线。
      </div>
    );
  }

  const values = points.map((p) => p.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.12, Math.abs(max) * 0.002, 0.5);
  const domain: [number, number] = [min - pad, max + pad];
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const rising = last >= first;
  const referenceValue = baseline ?? first;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="dashboardEquityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={rising ? '#22c98a' : '#f4525f'} stopOpacity={0.34} />
            <stop offset="100%" stopColor={rising ? '#22c98a' : '#f4525f'} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#1b1e26" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(value: number) => fmtTime(new Date(value).toISOString())}
          tick={{ fill: '#6b7486', fontSize: 10 }}
          stroke="#2b2f3a"
          minTickGap={40}
        />
        <YAxis
          domain={domain}
          tickFormatter={(value: number) => fmtCompact(value)}
          tick={{ fill: '#6b7486', fontSize: 10 }}
          stroke="#2b2f3a"
          width={56}
        />
        <Tooltip content={<EquityTooltip />} />
        <ReferenceLine
          y={referenceValue}
          stroke="#3a3f4d"
          strokeDasharray="4 4"
          label={{ value: '起始', fill: '#6b7486', fontSize: 9, position: 'insideTopRight' }}
        />
        <Area
          type="monotone"
          dataKey="equity"
          stroke={rising ? '#22c98a' : '#f4525f'}
          strokeWidth={1.6}
          fill="url(#dashboardEquityFill)"
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* -------------------------------------------------------------------------- */
/*  Leverage gauge (semicircular arc)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Effective leverage as a half-doughnut.
 *
 * The arc runs green → amber → red over 0–10x, so an over-levered account is
 * obvious at a glance rather than needing the number to be read.
 */
export function LeverageGauge({ value, size = 100 }: { value: number; size?: number }) {
  const max = 10;
  const clamped = Number.isFinite(value) ? Math.min(Math.max(value, 0), max) : 0;
  const ratio = clamped / max;

  const stroke = 9;
  const width = size;
  const height = size * 0.62;
  const cx = width / 2;
  const cy = height - 4;
  const r = (width - stroke) / 2 - 2;
  const startAngle = Math.PI;
  const endAngle = 0;

  const point = (angle: number) => ({
    x: cx + r * Math.cos(angle),
    y: cy - r * Math.sin(angle),
  });

  const arcPath = (from: number, to: number) => {
    const a = point(from);
    const b = point(to);
    const largeArc = Math.abs(to - from) > Math.PI ? 1 : 0;
    // Sweep is clockwise on screen because y is flipped by the point() helper.
    return `M ${a.x} ${a.y} A ${r} ${r} 0 ${largeArc} 0 ${b.x} ${b.y}`;
  };

  const valueAngle = startAngle + (endAngle - startAngle) * ratio;
  const tone = ratio >= 0.7 ? '#f4525f' : ratio >= 0.4 ? '#f5a524' : '#22c98a';

  return (
    <div className="flex flex-col items-center">
      <svg width={width} height={height} role="img" aria-label={`有效杠杆 ${value.toFixed(2)} 倍`}>
        <defs>
          <linearGradient id="leverageArc" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#22c98a" />
            <stop offset="55%" stopColor="#f5a524" />
            <stop offset="100%" stopColor="#f4525f" />
          </linearGradient>
        </defs>
        <path d={arcPath(startAngle, endAngle)} fill="none" stroke="#21242e" strokeWidth={stroke} strokeLinecap="round" />
        <path
          d={arcPath(startAngle, valueAngle)}
          fill="none"
          stroke={ratio > 0.02 ? 'url(#leverageArc)' : tone}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        <text
          x={cx}
          y={cy - 10}
          textAnchor="middle"
          fill="#e8ecf3"
          fontSize={size * 0.22}
          fontFamily='JetBrains Mono, ui-monospace, Menlo, Consolas, monospace'
        >
          {Number.isFinite(value) ? `${value.toFixed(2)}x` : '—'}
        </text>
        <text x={cx} y={cy + 2} textAnchor="middle" fill="#464e5e" fontSize={size * 0.095}>
          {`0 – ${max}x`}
        </text>
      </svg>
      {/*
       * No "杠杆" caption here. The card's own label already says 有效杠杆, and
       * the gauge is the tallest thing in the stat row — this card sets the row
       * height, so a redundant word costs the order table real pixels.
       */}
    </div>
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
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-down/50">
        <div className="h-full bg-up" style={{ width: `${winPercent}%` }} />
      </div>
      <div className="mt-0.5 flex items-center justify-between text-xs">
        <span className="num text-up">{fmtInt(wins)} 盈</span>
        <span className="num text-down">{fmtInt(losses)} 亏</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Compact metric card                                                        */
/* -------------------------------------------------------------------------- */

export function MetricCard({
  label,
  value,
  tone,
  sub,
  children,
  title,
}: {
  label: string;
  value?: ReactNode;
  tone?: string;
  sub?: ReactNode;
  children?: ReactNode;
  title?: string;
}) {
  /*
   * Bigger type, smaller footprint.
   *
   * The type went up a step (label/sub 2xs→xs, value xl→2xl) while the vertical
   * padding and the gaps between the three lines came down by more, so the card
   * ends up *shorter* than before despite the larger text. That is the point:
   * these four numbers are what an operator reads at a glance, and every pixel
   * the row gives up is a pixel the order table below gets.
   */
  return (
    <div
      title={title}
      className="flex flex-col rounded border border-base-750 bg-base-900 px-3 py-1.5 shadow-panel"
    >
      <div className="text-xs font-semibold tracking-[0.08em] text-ink-lo">{label}</div>
      {value !== undefined && (
        <div className={`num mt-0.5 text-2xl leading-none ${tone ?? 'text-ink-hi'}`}>{value}</div>
      )}
      {sub !== undefined && <div className="mt-1 text-xs leading-snug text-ink-faint">{sub}</div>}
      {children}
    </div>
  );
}
