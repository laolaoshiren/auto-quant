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
import {
  axisTicks,
  CHART_INK,
  equityAxisFormatter,
  filterByRange,
  HOURLY_AXIS_MAX_MS,
  rangeSpanMs,
  type EquityPoint,
  type EquityRange,
} from './equityCurve';

/* -------------------------------------------------------------------------- */
/*  Equity chart                                                               */
/* -------------------------------------------------------------------------- */

interface EquityTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: EquityPoint }>;
  /**
   * 本段（当前时间窗）的**第一个**权益 —— 用来算"这一段里涨跌了多少"。
   *
   * ⚠️ **提示框原来只给一个绝对权益值**，用户的原话是：
   *
   *   「鼠标停留在哪里，就能真实看到**那个时间段**到底对于**整个图表时间**
   *     盈亏状况！！！而不是现在这样奇奇怪怪的，根本无法理解逻辑，毫无头绪，
   *     看的人一头雾水」
   *
   * 一个孤零零的 `21.97 USDT` 回答不了"我赚了还是亏了" —— 而图上有两条基准线
   * （初始、本段起点），悬停时却一个都不参与叙述。所以下面把**两个涨幅**都写出来。
   */
  segmentStart?: number;
  /** 初始权益（图上那条虚线）—— 用来算"这个账户从开头到现在赚了多少"。 */
  baseline?: number;
  asset?: string;
}

/**
 * 涨幅的着色：涨绿、跌红、**持平灰**。
 *
 * 持平单独一档是有意的：`0.00` 既不是好消息也不是坏消息，涂成绿色会让
 * 一条完全走平的曲线看起来像在盈利。
 */
function deltaTone(delta: number): string {
  if (Math.abs(delta) < 5e-9) return 'text-ink-mid';
  return delta > 0 ? 'text-up' : 'text-down';
}

/** `+$1.19（+5.7%）` —— 金额与百分比一起给，单给一个都要用户自己换算。 */
function deltaText(delta: number, base: number | undefined, digits = 2): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  const money = `${sign}$${fmtNum(Math.abs(delta), digits)}`;
  if (base === undefined || !Number.isFinite(base) || Math.abs(base) < 1e-9) return money;
  const percent = (delta / base) * 100;
  return `${money}（${percent > 0 ? '+' : percent < 0 ? '-' : ''}${fmtNum(Math.abs(percent), 2)}%）`;
}

/**
 * The floating readout.
 *
 * A plain div styled with the app's tokens rather than recharts' default white
 * box: the default is unreadable on a dark terminal, and `contentStyle` can only
 * reach the wrapper — the rows inside stay dark-on-dark.
 *
 * ## 这个提示框要回答的问题
 *
 * 「**我在这一刻，相对整条时间线赚了多少**」。所以除了归属权益本身，还给出
 * 两个涨幅（相对初始、相对本段起点）—— 图上有两条基准线，提示框就要能把
 * 那条竖线和它们各自的关系说出来。
 */
function EquityTooltip({ active, payload, segmentStart, baseline, asset = 'USDT' }: EquityTooltipProps) {
  if (!active) return null;
  const point = payload?.[0]?.payload;
  if (!point) return null;

  const floating = point.unrealizedPnl ?? 0;
  const sinceStart = segmentStart === undefined ? undefined : point.equity - segmentStart;
  const sinceBaseline = baseline === undefined ? undefined : point.equity - baseline;

  return (
    <div
      className="pointer-events-none min-w-[13rem] rounded-md border border-base-600 px-2.5 py-1.5 shadow-overlay"
      style={{ backgroundColor: CHART_INK.surface }}
    >
      <div className="num mb-1 text-xs text-ink-faint">
        {new Date(point.t).toLocaleString('en-GB', { hour12: false })}
      </div>

      <div className="flex items-baseline justify-between gap-3">
        {/* 「归属权益」而不是「权益」：这条曲线是该机器人自己的账，不是共享钱包。 */}
        <span className="text-xs text-ink-lo">归属权益</span>
        <span className="num text-sm text-ink-hi">
          {fmtNum(point.equity, 2)} {asset}
        </span>
      </div>

      {/* 相对**初始权益**：这个账户从开头到现在赚了多少（图上那条虚线）。 */}
      {sinceBaseline !== undefined && (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-ink-lo">相对初始</span>
          <span className={`num text-sm ${deltaTone(sinceBaseline)}`}>
            {deltaText(sinceBaseline, baseline)}
          </span>
        </div>
      )}

      {/* 相对**本段起点**：与图顶那行「本段变化」同一个口径。 */}
      {sinceStart !== undefined && (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-ink-lo">本段变化</span>
          <span className={`num text-sm ${deltaTone(sinceStart)}`}>
            {deltaText(sinceStart, segmentStart)}
          </span>
        </div>
      )}

      {point.unrealizedPnl !== undefined && (
        <div className="mt-0.5 flex items-baseline justify-between gap-3 border-t border-base-750 pt-0.5">
          <span className="text-xs text-ink-lo">其中浮动盈亏</span>
          {/* Sign always present: colour alone is not a signal every operator can read. */}
          <span className={`num text-xs ${deltaTone(floating)}`}>
            {floating >= 0 ? '+' : '-'}${fmtNum(Math.abs(floating), 2)}
          </span>
        </div>
      )}

      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-lo">持仓</span>
        <span className="num text-xs text-ink-mid">{fmtInt(point.openPositions ?? 0)}</span>
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

/*
 * 时间轴刻度的摆放与格式化阈值都搬去了 `./equityCurve` —— 交易页与总览页是
 * 两个图表组件，而"刻度落在哪"只能有一个定义（理由写在 `axisTicks` 的注释里）。
 */

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
    /*
     * 空状态**不占高度**（`LAYOUT.md` §3：图表只在有数据可看时才占大块）。
     *
     * 这里原来渲染一个 `style={{ height }}` 的虚线盒子（默认 240px），于是
     * "还没有快照"这个状态和一张真图表占一样多的地方 —— 而它一个字的信息量
     * 都不比一行文字多。收成一条横条，页面的其余部分就上来了。
     */
    return (
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md border border-dashed border-base-700 px-3 py-2.5">
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

  // 一天半以内用时钟，更长用日期 —— 阈值与 `axisTicks` 共用，见上面的常量。
  const axisTick =
    rangeSpanMs(range) <= HOURLY_AXIS_MAX_MS
      ? (value: number) => fmtTime(new Date(value).toISOString())
      : (value: number) => new Date(value).toLocaleDateString('en-CA', { month: '2-digit', day: '2-digit' });
  const ticks = axisTicks(points, range);

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
          /*
           * 刻度由 `axisTicks` 钉在真实的整点/日界上，而不是让 Recharts 按数值
           * 均匀摊 —— 理由见那个函数的注释（"查看历史时显示不正确"）。
           * 它可能返回空数组（跨度不足一个整点），那时交回默认行为。
           */
          {...(ticks.length > 0 ? { ticks } : {})}
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
          /*
           * ⚠️ 两个基准值必须**传进去**，否则提示框只能给出一个孤零零的绝对权益，
           * 回答不了"我在这一刻是赚还是亏"。`first` 是这段窗口的起点（与图顶那行
           * 「本段变化」同一个口径），`baseline` 是账户的初始权益（图上那条虚线）。
           */
          content={<EquityTooltip segmentStart={first} baseline={baseline} asset={unit} />}
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

/**
 * 盈亏笔数的比例条。
 *
 * 层级上它只有一个主读数：条本身（`h-1`）。两侧的计数留在 `text-xs`，因为
 * 真正的"胜率"数字由调用方以更大的字号单独给出 —— 在这里再放大一次，等于
 * 同一个数在一屏里出现两次同等权重（DESIGN.md §4"不要把所有东西做成一样大"）。
 */
export function WinLossBar({ wins, losses }: { wins: number; losses: number }) {
  const total = wins + losses;
  const winPercent = total > 0 ? (wins / total) * 100 : 0;

  return (
    <div
      className="mt-1"
      title={total > 0 ? `${fmtInt(wins)} 笔盈利 / ${fmtInt(losses)} 笔亏损` : '还没有平仓记录'}
    >
      {/*
       * The track is a neutral token, not `bg-down/50`.
       *
       * With no trades closed the old track still painted half its width in the
       * loss colour, so a brand-new bot looked like it had a 50% loss rate. With
       * trades, a grey track reads as "the remainder" instead of implying the
       * unfilled part is all losses.
       */}
      <div
        className="flex h-1 w-full overflow-hidden rounded-full"
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
