/**
 * Equity-curve arithmetic, shared by the two chart implementations.
 *
 * This module is deliberately free of any charting import: `DashboardCharts.tsx`
 * (recharts, bundled with the lazy trader page) and `EquityCurveChart.tsx`
 * (recharts, its own lazy chunk behind the overview page) both import it. Putting
 * a single shared *component* here instead would have re-united the two and
 * dragged the library back into the landing chunk — which is the one thing the
 * split exists to prevent.
 */
import type { EquitySnapshot } from '@aq/shared';

/* -------------------------------------------------------------------------- */
/*  Chart palette                                                              */
/* -------------------------------------------------------------------------- */

/*
 * SVG `stroke` / `fill` attributes cannot take a Tailwind class, so these are
 * hex literals — the one place in the app where a raw colour is unavoidable.
 * They are kept **identical to the tokens** in tailwind.config.js (`up`, `down`,
 * `warn`, `accent`, `base-750`, `base-700`, `base-600`, `base-900`, `ink-lo`,
 * `ink-hi`) and are shared by both chart implementations plus every values-based
 * SVG primitive, so the curve, the candles, the gauge and the chips can never
 * disagree. If a token changes, these lines change with it and every chart
 * follows.
 *
 * They live here, in the dependency-free module, rather than in either chart
 * file: `DashboardCharts.tsx` importing them from `EquityCurveChart.tsx` would
 * pull recharts back into the landing chunk — the exact thing the split exists
 * to prevent.
 */
export const CHART_INK = {
  up: '#2ed3a3',
  down: '#ff6b7a',
  /** `warn` — the middle stop of the leverage arc and its "getting hot" state. */
  warn: '#f5b544',
  accent: '#5b8def',
  /** Grid — `base-750`. One step off the panel so it separates without competing with the data. */
  grid: '#232a38',
  /** Axis ticks — `ink-lo`. */
  axis: '#76839a',
  /** Reference lines and the crosshair — `base-600`. */
  rule: '#3a4558',
  /** Track behind a proportional bar — `base-700`. */
  track: '#2c3546',
  /** Tooltip surface — `base-900`, opaque so the curve does not show through the digits. */
  surface: '#11151e',
  /** Large value inside an SVG gauge — `ink-hi`. */
  inkHi: '#e4e9f2',
} as const;

/** One point on a rendered curve. */
export interface EquityPoint {
  /** Epoch milliseconds. */
  t: number;
  equity: number;
  unrealizedPnl?: number;
  openPositions?: number;
}

/** The equity snapshot sampled at or before this epoch, accurate within one bucket. */
export const EQUITY_BUCKET_MS = 60_000;

/**
 * How many points the merged curve is allowed to carry.
 *
 * The 1D window is `ms`/bucket = 1440 points, so this only ever bites on `ALL`
 * or 3M — where the extra points are sub-pixel anyway and each one costs a
 * re-render on every poll.
 */
export const MAX_EQUITY_POINTS = 1600;

/**
 * Compact axis label: `12,480` → `12.5K`, `1,234,567` → `1.23M`.
 *
 * Written out rather than imported from `lib/format` so this file keeps zero
 * dependencies — it is pulled into a lazy chunk that must stay tiny, and the
 * formatter there is shaped for table cells (`1,234.60`), not for a 62px gutter.
 */
export function equityAxisFormatter(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  if (abs >= 1_000) return `${value.toFixed(0)}`;
  return value.toFixed(2);
}

/* -------------------------------------------------------------------------- */
/*  Equity ranges                                                              */
/* -------------------------------------------------------------------------- */

/*
 * The range selector's vocabulary lives here, not in `DashboardCharts.tsx`.
 *
 * `OverviewPage.tsx` needs `EQUITY_RANGES` to render its range buttons, and it
 * used to import them from `DashboardCharts.tsx` — which begins with an
 * `import ... from 'recharts'`. The bundler therefore put the entire 398 kB
 * recharts chunk *in front of* the landing page's first paint, defeating the
 * lazy `EquityCurveChart` import that exists for exactly that reason. Anything
 * the overview page shares with a chart belongs in this module, which imports
 * nothing but a type.
 */
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

/**
 * 这段权益序列值不值得画成曲线？
 *
 * 起因是操作者的反馈：权益曲线占了 40% 屏高，却只画出一条平线，而真正要看的
 * 决策流被挤到屏幕底部要滚动（见 `LAYOUT.md` §3：图表只在有数据可看时才占大块）。
 *
 * 判据放在这个无依赖模块里，而不是某个图表组件内部，是因为**"平"只能有一个定义**：
 * 交易页在调用处决定收起还是展开，两个图表组件各自决定 Y 轴留白。三处阈值如果
 * 各写一套，同一条序列在不同页面上会得到不同结论。
 *
 * 阈值与总览页的 `equityShape()`（`pages/overviewParts.tsx`）**必须逐位一致**：
 * `max(|峰值| × 0.02%, 0.005)`，外加"至少 3 个点"。
 *
 * - 绝对下限用一分钱：一个 0.00 的账户上任何浮点噪声都会变成相对意义上的"巨大波动"；
 * - 相对下限让大账户上几美分的抖动不至于撑起一整张图 —— 那种抖动在
 *   `[min - pad, max + pad]` 的坐标轴里同样是一条直线。
 *
 * 它只回答"有没有形状"，**不返回任何被丢弃的数据**：调用方据此收起图表时，
 * 仍要把这条序列本身画出来（见 `TraderPage` 的权益条），否则就是静默丢数据。
 */
export function hasEquityVariation(values: ReadonlyArray<number>, minPoints = 3): boolean {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < minPoints) return false;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of finite) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max - min > Math.max(Math.abs(max) * 0.0002, 0.005);
}

/** Visible window of a range id, in ms. `ALL` (or anything unknown) is unbounded. */
export function rangeSpanMs(range: string): number {
  switch (range) {
    case '1D':
      return 24 * 3600 * 1000;
    case '7D':
      return 7 * 24 * 3600 * 1000;
    case '1M':
      return 30 * 24 * 3600 * 1000;
    case '3M':
      return 90 * 24 * 3600 * 1000;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

/**
 * The snapshot the REST endpoint would have returned, plus whatever the live
 * socket has pushed since. Kept here so the dedupe happens once, in the module
 * that owns the merging, instead of in every caller.
 */
export type EquitySnapshotSeries = Record<number, EquitySnapshot[]>;

/** One contributor: its starting capital and everything recorded since. */
export interface EquityContributor {
  /** Per-trader snapshot lists, keyed by trader id. */
  series: EquitySnapshotSeries;
  /** The live socket's extra points, keyed by trader id. */
  live?: EquitySnapshotSeries;
  /**
   * `trader.initialEquity`, keyed by trader id.
   *
   * Its only job is to hold a trader's line flat *backwards* from its first
   * snapshot to the start of the window. Without it a bot that started five
   * minutes ago makes the whole seven-day curve begin five minutes ago, and the
   * really explosive part of the chart ("did my equity go up this week?") is
   * missing — which is a worse lie than a flat segment at the known starting
   * capital.
   */
  baseline: Record<number, number>;
}

/**
 * Combine several per-trader snapshot lists into one account-level curve.
 *
 * The naive version — position-sum the series, then pick the nearest value from
 * each — invents numbers: a trader that has not reported for an hour gets its
 * stale equity counted as if it were current, and a normal 资产再平衡 ends up
 * looking like a jump in total equity.
 *
 * Instead every point is a **real sum taken from one aligned timestamp**: per
 * bucket, each contributor holds its last snapshot at or before that bucket —
 * seeded with `baseline` for the stretch before its first snapshot, and with
 * nothing at all if it has neither. A trader that has not even been created yet
 * contributes nothing, so the early buckets are honestly smaller rather than
 * confidently wrong.
 *
 * Two consequences worth knowing:
 *
 * - the result is a *step* curve, and it can waggle slightly when two traders
 *   report a few seconds apart inside the same minute, since both are sampled
 *   into that minute's bucket;
 * - `bucketMs` must not be finer than the server's snapshot cadence, or every
 *   point ends up in its own bucket and the alignment buys nothing.
 */
export function mergeEquityCurves(
  contributors: ReadonlyArray<EquityContributor>,
  bucketMs = EQUITY_BUCKET_MS,
  maxPoints = MAX_EQUITY_POINTS,
): EquityPoint[] {
  // A non-positive bucket would divide the timeline by zero and collapse every
  // point onto `Infinity`.
  const step = bucketMs > 0 ? bucketMs : EQUITY_BUCKET_MS;

  interface Sample {
    t: number;
    snapshot: EquitySnapshot;
  }

  interface Series {
    samples: Sample[];
    baseline: number | null;
    /** Read cursor into `samples`, advanced in lockstep with the shared axis. */
    cursor: number;
  }

  const built: Series[] = [];
  for (const contributor of contributors) {
    const ids = new Set<number>([
      ...Object.keys(contributor.series).map(Number),
      ...Object.keys(contributor.live ?? {}).map(Number),
      ...Object.keys(contributor.baseline).map(Number),
    ]);

    for (const id of ids) {
      const samples: Sample[] = [
        ...(contributor.series[id] ?? []),
        ...(contributor.live?.[id] ?? []),
      ]
        .map((snapshot) => ({ t: new Date(snapshot.timestamp).getTime(), snapshot }))
        .filter((sample) => Number.isFinite(sample.t))
        .sort((a, b) => a.t - b.t);

      const baseline = contributor.baseline[id];
      const hasBaseline = typeof baseline === 'number' && Number.isFinite(baseline);
      if (samples.length === 0 && !hasBaseline) continue;

      built.push({
        samples,
        baseline: hasBaseline ? (baseline as number) : null,
        cursor: -1,
      });
    }
  }

  if (built.length === 0) return [];

  /*
   * The axis is the set of buckets that actually exist in the data — no
   * timestamps are invented, and no bucket is emitted for a minute nothing was
   * recorded in. A contributor with only a baseline and no snapshots yet
   * anchors its line at the first bucket of the window instead.
   */
  const buckets = new Set<number>();
  for (const series of built) {
    for (const sample of series.samples) buckets.add(Math.floor(sample.t / step) * step);
  }
  if (buckets.size === 0) return [];
  const axis = [...buckets].sort((a, b) => a - b);

  const points: EquityPoint[] = [];
  for (const bucket of axis) {
    let equity = 0;
    let unrealizedPnl = 0;
    let openPositions = 0;

    for (const series of built) {
      /*
       * Advance one cursor per contributor.
       *
       * `findIndex` per bucket would be O(buckets × samples), and `ALL` over a
       * few busy traders is ~1500 buckets against ~500 samples each — a visible
       * stall on every poll.
       */
      while (
        series.cursor + 1 < series.samples.length &&
        (series.samples[series.cursor + 1]?.t ?? Infinity) <= bucket
      ) {
        series.cursor += 1;
      }

      /*
       * The value on screen at this bucket.
       *
       * Before the first snapshot this contributor holds its known starting
       * capital, so a bot created today does not truncate the whole window back
       * to today — but only if the trader actually existed by then, otherwise an
       * account that is about to be created would be counted as if it were
       * already funded.
       *
       * ⚠️ `first.t <= bucket` 对**首桶恒为假**，必须写成"第一个样本落在本桶内"。
       *
       * 轴上的桶是 `floor(sample.t / step) * step`，所以第一个样本所在的桶
       * **一定 ≤ 它自己的时间**（`first.t < bucket + step` 恒成立）。用
       * `first.t <= bucket` 判断时首桶永远进不了 baseline 分支、也就没有值，
       * 于是**曲线第一个点恒为 0**。
       *
       * 后果很具体：区间盈亏 = 末点 − 首点，首点为 0 就变成"整个账户权益"
       * —— 实测显示 +$10.42，而真实只有 +$0.03。
       */
      const first = series.samples[0];
      const existedByThisBucket =
        first === undefined ||
        first.t <= bucket ||
        // 首桶：样本还没到（cursor 仍是 -1）但它就落在本桶之内
        first.t < bucket + step;
      const held =
        series.cursor >= 0
          ? series.samples[series.cursor]?.snapshot
          : series.baseline !== null && existedByThisBucket
            ? { equity: series.baseline, unrealizedPnl: 0, openPositions: 0 }
            : null;

      if (!held) continue;
      equity += held.equity;
      unrealizedPnl += held.unrealizedPnl ?? 0;
      openPositions += held.openPositions ?? 0;
    }

    points.push({ t: bucket, equity, unrealizedPnl, openPositions });
  }

  return points.length > maxPoints ? points.slice(-maxPoints) : points;
}
