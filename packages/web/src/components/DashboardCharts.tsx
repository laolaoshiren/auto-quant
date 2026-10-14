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
  equityAxisFormatter,
  filterByRange,
  HOURLY_AXIS_MAX_MS,
  rangeSpanMs,
  type EquityPoint,
  type EquityRange,
} from './equityCurve';
import { useChartInk } from './useChartInk';

/* -------------------------------------------------------------------------- */
/*  Equity chart                                                               */
/* -------------------------------------------------------------------------- */

interface EquityTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: EquityPoint }>;
  /**
   * 初始权益（图上那条虚线）—— 用来算"这个账户从开头到现在赚了多少"。
   *
   * ⚠️ **这里原来还有一行「本段变化」（相对窗口内第一个快照），已经删掉。**
   *
   * 用户的原话：「**不要本段变化（画蛇添足、多此一举）**」。
   *
   * 他是对的，而且不是审美问题 —— 在"全部"这个默认窗口下**两个基准是同一个数**：
   * 第一个快照的权益就是初始权益，于是提示框里出现两行**逐字相同**的
   * `+$1.19（+5.70%）`。那不是"多一个视角"，是把同一句话说两遍 ——
   * 而它恰好出现在最需要一眼看懂的地方。
   *
   * 图顶那一行「本段变化」仍然保留：那里没有别的数字，讲"这一段涨了多少"是它
   * 唯一的职责。**同一个信息在一处出现是说明，在两处出现是噪音。**
   */
  baseline?: number;
  asset?: string;
  /**
   * 曲线画的是哪个口径 —— 提示框的标签必须跟着它，见 `DashboardEquityChart` 的
   * `metric` 说明。不传时按 `'account'`（既有行为）。
   */
  metric?: 'account' | 'attributed';
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
 * 它相对**初始权益**（图上那条虚线）的涨幅 —— 一个孤零零的绝对值和曲线的关系，
 * 用户没法自己看出来。
 */
function EquityTooltip({
  active,
  payload,
  baseline,
  asset = 'USDT',
  metric = 'account',
  ink,
}: EquityTooltipProps & { ink: ReturnType<typeof useChartInk> }) {
  if (!active) return null;
  const point = payload?.[0]?.payload;
  if (!point) return null;

  const floating = point.unrealizedPnl ?? 0;
  const sinceBaseline = baseline === undefined ? undefined : point.equity - baseline;

  return (
    <div
      className="pointer-events-none min-w-[13rem] rounded-md border border-base-600 px-2.5 py-1.5 shadow-overlay"
      style={{ backgroundColor: ink.surface }}
    >
      <div className="num mb-1 text-xs text-ink-faint">
        {new Date(point.t).toLocaleString('en-GB', { hour12: false })}
      </div>

      <div className="flex items-baseline justify-between gap-3">
        {/*
         * ⚠️ **标签必须与实际画的口径一致**（2026-10-15 改成按 `metric` 取）。
         *
         * 实盘画 `accountEquity`（共享钱包的真实权益）→ 标「账户权益」，
         * 与上方「账户余额」指标卡同一个数。
         *
         * ⚠️ **模拟盘画 `equity`（归属）** —— 它的成交是本地模拟的，
         * **从不触碰真实钱包**，所以 `accountEquity` 恒为一个值（实测 #11：
         * 45 条快照里只有 1 种值，而 `equity` 有 23 种）→ 用账户口径画出来
         * **必然是一条平线**（用户实测报过「一点记录痕迹都没有」）。
         * 那时标签必须是「归属权益」，否则等于换了个谎。
         *
         * ⚠️ 归属口径没有消失：它在「交易盈亏」指标卡里回答
         * "这个机器人赚了多少"。
         */}
        <span className="text-xs text-ink-lo">
          {metric === 'account' ? '账户权益' : '归属权益'}
        </span>
        <span className="num text-sm text-ink-hi">
          {fmtNum(point.equity, 2)} {asset}
        </span>
      </div>

      {/* 相对**初始权益**：这个账户从开头到现在赚了多少（图上那条虚线）。 */}
      {sinceBaseline !== undefined && (
        <div className="mt-0.5 flex items-baseline justify-between gap-3 border-t border-base-750 pt-0.5">
          <span className="text-xs text-ink-lo">相对初始</span>
          <span className={`num text-sm ${deltaTone(sinceBaseline)}`}>
            {deltaText(sinceBaseline, baseline)}
          </span>
        </div>
      )}

      {point.unrealizedPnl !== undefined && (
        <div className="flex items-baseline justify-between gap-3">
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
function EquityCursor({
  points,
  ink,
}: {
  points?: Array<{ x?: number; y?: number }>;
  ink: ReturnType<typeof useChartInk>;
}) {
  const x = points?.[0]?.x;
  if (typeof x !== 'number') return null;
  return <line x1={x} x2={x} y1={0} y2="100%" stroke={ink.rule} strokeWidth={1} />;
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
  /*
   * ⚠️ **默认画【账户口径】**（2026-10-13，用户要求）。
   *
   * ## 用户的反馈（原话）
   *
   * > 「图表不就是最真实准确简单的，账号余额、总盈亏能对上的吗？」
   *
   * 他是对的。原来的实现画的是 `snapshot.equity`（**归属**口径：
   * `initial_equity + Σ本机器人已平仓净额`），而页面上方的指标卡
   * 「账户余额」显示的是 `accountEquity`（**共享钱包**的真实权益）——
   * 于是同一屏两个数字，用户第一反应就是"对不上"。
   *
   * ## 两个口径的定义（见 `db/schema.ts` 的 M4 迁移说明）
   *
   * ```
   *   equity         = initial_equity + Σ(本机器人已平仓净额)  ← 只算自己
   *   accountEquity  = 共享钱包的真实权益（含同账户其他机器人）  ← 账户真实值
   * ```
   * 实测 `#10`：`equity` 108.47 vs `accountEquity` 97.80（差 10.67 = 同钱包其他机器人）。
   *
   * ## 为什么改成账户口径是对的
   *
   * **图表是"账户在这段时间怎么走的"** —— 那正是操作员要去交易所核对的数字。
   * 归属口径适合回答"我这个机器人赚了多少"（那是指标卡的事），
   * 但它**不适合画成曲线**：它与钱包余额不一致，而曲线给人的直觉就是
   * "这是我的钱的变化"。
   *
   * ⚠️ 归属口径**没有消失** —— 「本段变化」那一行仍然算它（标签写明
   * "本机器人归属"），因为它回答的是另一个问题。
   */
  metric = 'account',
}: {
  snapshots: EquitySnapshot[];
  range: EquityRange;
  /**
   * 图表高度。
   *
   * 收 `string | number` 而不是只有 `number`：机器人详情页要传
   * `clamp(120px, 22vh, 260px)` —— 那一页的主栏在 722 高的窗口下只剩
   * 三百来像素，写死的高度会把页面顶出滚动条（见 `TraderPage` 里
   * `EQUITY_CHART_HEIGHT` 的说明）。recharts 的 `ResponsiveContainer`
   * 本来就接受字符串，这里只是别把它挡在类型外面。
   */
  height?: string | number;
  baseline?: number;
  /** Settlement unit for the readout. Defaults to USDT, the only one in practice. */
  asset?: string;
  /**
   * 画哪个口径。
   *
   * ```
   *   'account'    —— 共享钱包的真实权益（默认；与「账户余额」指标卡一致）
   *   'attributed' —— 本机器人归属（只算自己的已平仓净额）
   * ```
   * ⚠️ 默认是 `'account'`：**曲线必须能和指标卡对上**，
   * 否则用户看到两个数就会问"为什么对不上"。
   */
  metric?: 'account' | 'attributed';
}) {
  /*
   * ⚠️ hook 必须在"点数不足"那个提前 return **之前**调用 ——
   * React 要求每次渲染的 hook 顺序一致，条件调用会让"有数据/没数据"两种
   * 渲染的 hook 数量不同，直接抛"Rendered fewer hooks than expected"。
   */
  const ink = useChartInk();
  const windowed = filterByRange(snapshots, range);
  const points: EquityPoint[] = windowed
    .map((snapshot) => ({
      t: new Date(snapshot.timestamp).getTime(),
      /*
       * ⚠️ 按 `metric` 取口径 —— 见 props 里那段说明。
       *
       * ⚠️ **`accountEquity` 为 0 时回落到 `equity`**：迁移前的旧行
       * `account_equity` 是回填的，而完全没有值时它是 `0`
       *（见 `db/schema.ts` 的 M4 取舍说明）。直接用 0 会把曲线砸到地板，
       * 而那条曲线**看起来完全正常** —— 只是数字全错。
       */
      equity:
        metric === 'account'
          ? snapshot.accountEquity > 0
            ? snapshot.accountEquity
            : snapshot.equity
          : snapshot.equity,
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
  const stroke = rising ? ink.up : ink.down;
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
        <CartesianGrid stroke={ink.grid} strokeDasharray="3 3" vertical={false} />
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
          tickCount={5}
        />
        <Tooltip
          /*
           * ⚠️ `baseline` 必须传进去，否则提示框只能给出一个孤零零的绝对权益，
           * 回答不了"我在这一刻是赚还是亏"。它就是图上那条「初始」虚线。
           */
          content={<EquityTooltip baseline={baseline} asset={unit} metric={metric} ink={ink} />}
          cursor={<EquityCursor ink={ink} />}
          shared={false}
          isAnimationActive={false}
          wrapperStyle={{ outline: 'none' }}
        />
        <ReferenceLine
          y={referenceValue}
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
          fill="url(#dashboardEquityFill)"
          dot={false}
          /* Off on purpose: the page polls, and a curve that re-draws itself from
             scratch every few seconds flickers in peripheral vision — which is
             exactly where a trading terminal lives. */
          isAnimationActive={false}
          activeDot={{ r: 3, fill: stroke, stroke: ink.surface, strokeWidth: 2 }}
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
  const ink = useChartInk();
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
        style={{ backgroundColor: ink.track }}
        role="img"
        aria-label={`${fmtInt(wins)} 笔盈利，${fmtInt(losses)} 笔亏损`}
      >
        <div className="h-full" style={{ width: `${winPercent}%`, backgroundColor: ink.up }} />
      </div>
      <div className="mt-0.5 flex items-center justify-between text-xs">
        <span className="num text-up">{fmtInt(wins)} 盈</span>
        <span className="num text-down">{fmtInt(losses)} 亏</span>
      </div>
    </div>
  );
}
