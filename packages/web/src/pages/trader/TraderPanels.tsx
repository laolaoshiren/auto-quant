import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { EquitySnapshot, ExchangeId } from '@aq/shared';
import { CandlestickChart } from '../../components/CandlestickChart';
import type { ChartPriceLine } from '../../components/chartPriceLines';
import {
  EQUITY_RANGES,
  filterByRange,
  type EquityRange,
} from '../../components/equityCurve';
import { api } from '../../lib/api';
import { usePolled } from '../../lib/hooks';
import {
  fmtDateTime,
  fmtInt,
  fmtNum,
  fmtPercent,
  fmtPriceUsd,
  fmtUsd,
  fmtUsdSigned,
  formatCandlePrice,
  pnlColor,
} from '../../lib/format';
import { Button, cn, Empty, ErrorNote, Spinner3 } from '../../components/ui';

/* -------------------------------------------------------------------------- */
/*  指标卡                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 指标行里的一格。
 *
 * 为什么要有这层壳：`Metric` 是**指标**（标签 + 数值 + 说明），本身没有底色。
 * 从竖排指标栏改成横排之后，需要一层卡片边界才能一眼看出"这是 4 个并列的数字"，
 * 否则它们只是浮在页面底底色上的四段文字（`LAYOUT.md` §0 规则 3 要的就是卡片）。
 *
 * ⚠️ **这层壳不设高度 —— 等高由网格的默认 `stretch` 负责，这一行不要加 `items-start`。**
 *
 * 这里原来写着「网格上也加了 `items-start`：每张卡只占自己内容的高度」—— **那句话是错的**：
 * 网格的 class 里从来没有 `items-start`，实测四张卡也确实是等高的
 * （浏览器实测：`460×132 / 132 / 132 / 132`，最大差 0px）。
 *
 * 两条注释曾经互相矛盾（`metricCards` 那边写的是"等高，不加 `items-start`，这是刻意的"），
 * 而**错的那条正好在真正的组件旁边** —— 下一个读代码的人会照着它去加 `items-start`，
 * 于是把一组本该成块的 KPI 拆成高低不齐的四块。所以这里改成陈述事实。
 */
export function MetricCard({
  children,
  title,
  className,
}: {
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <div
      title={title}
      className={cn(
        'flex h-full min-w-0 flex-col rounded-xl border border-base-700/90 bg-base-900 px-2.5 py-2.5 transition-colors hover:border-base-600',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Chart helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 数据太薄时的紧凑权益条。
 *
 * 为什么是"画出来"而不是"藏起来"：曲线讲的是形状，而这里要回答的正是
 * "为什么没有形状"。一条 36px 的缩略线把这件事一次说完 —— 走平就是走平，
 * 两个点就是两个点，不需要 220px 的坐标轴来证明（`LAYOUT.md` §3）。
 *
 * 为什么就画在这个文件里，而不是复用总览页的曲线
 * （`pages/overviewParts.tsx`）：那一页的点是**多机器人合并**后的序列，形状不同、
 * 这一页要显示的口径也不同（归属权益 vs 总权益），跨页互引会让两个页面必须一起改。
 */
export function EquityMiniStrip({
  values,
  delta,
  percent,
  asset,
  note,
  onExpand,
}: {
  values: number[];
  delta: number;
  percent: number;
  asset: string;
  /** 为什么收起了 —— 一句话说清，比"暂无数据"有用。 */
  note: string;
  onExpand: () => void;
}) {
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  const span = max - min;
  const last = values.length - 1;

  /*
   * `viewBox="0 0 100 100"` + `preserveAspectRatio="none"` 把线拉满整宽，所以
   * `strokeWidth` 必须配 `vectorEffect="non-scaling-stroke"`：非等比缩放会把线宽
   * 一起压成细丝或拉成色块。
   */
  const path = values
    .map((value, index) => {
      const x = last <= 0 ? 0 : (index / last) * 100;
      // 走平时按中线画：贴在盒子边缘的一条线看起来像被裁掉了。
      const y = span === 0 ? 50 : 100 - ((value - min) / span) * 100;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
      {values.length >= 2 ? (
        <div className={cn('h-9 min-w-[8rem] flex-1', pnlColor(delta))}>
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="h-full w-full"
            role="img"
            aria-label={`收益曲线缩略线，共 ${fmtInt(values.length)} 个快照`}
          >
            <path d={path} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      ) : (
        <span className="min-w-[8rem] flex-1 text-xs text-ink-faint">{note}</span>
      )}

      <div className="shrink-0 text-right">
        <div className={cn('num text-base leading-tight', pnlColor(delta))}>
          {fmtUsdSigned(delta, 2)} <span className="text-xs text-ink-faint">{asset}</span>
        </div>
        <div className="num text-xs text-ink-faint">
          {values.length >= 2 && `${note} · `}
          {fmtPercent(percent)}
        </div>
      </div>

      <Button size="sm" variant="ghost" onClick={onExpand} aria-expanded={false} title="展开完整权益曲线">
        <ChevronRight aria-hidden className="h-3.5 w-3.5" />
        展开
      </Button>
    </div>
  );
}

/**
 * 展开态下图表上方的一行口径说明。
 *
 * 只讲**这一段窗口里涨跌了多少**：当前权益本身已经常驻在上面那张指标卡里，
 * 在这里再放一个 `text-3xl` 会让同一个数字在一屏里出现两次，而且都比别的东西显眼
 * （DESIGN.md §4 "不要把所有东西做成一样大"）。
 *
 * 这里**不再显示快照条数**：快照数量是内部指标（`LAYOUT.md` §5 点名的那一类），
 * 正常运行时它既不是状态、也没有后果 —— 曲线上有多少个点，看曲线本身就知道。
 * 真正需要解释"为什么这条曲线这么稀"的时候（快照太少、或一条平线被收成一行），
 * 说明就在 `EquityMiniStrip` 的 `note` 里，那里是**带结论**的一句话。
 *
 * ## ⚠️ 2026-10-13：这里曾经有过第二行「同期账户」，已删除
 *
 * 起因是用户报「图表显示和实际账号对不上」。我第一版的修法是
 * **把两个口径并排显示 + 解释差额来源**：
 * ```
 *   本段变化  +$8.58 USDT (+8.57%)  本机器人归属
 *   同期账户  −$2.10 USDT (−2.09%)  同一钱包含其他机器人（…多 +$10.67）
 * ```
 * 用户的第二次反馈（原话）：
 * > 「图标完全乱套了，上面叫归属权益、同期账户、本段变化，一大堆莫名其妙的，
 * >  搞这么多没用的画蛇添足，无端增加BUG？图标不就是最真实准确简单的，
 * >  **账号余额、总盈亏能对上的吗**？」
 *
 * **他是对的** —— 那个修法把"数字对不上"换成了"要读两行解释才懂"，
 * 而问题本身有更简单的解：**让曲线画账户口径**（见 `DashboardEquityChart`
 * 的 `metric` prop 与下面 `windowFirst` / `windowLast` 的说明）。
 * 于是这一行回到一行，标签也改回中性的"本段变化"。
 */
export function EquityWindowLine({
  equity,
  delta,
  percent,
  asset,
  high,
  low,
  maxDrawdownPct,
  running,
}: {
  equity: number;
  delta: number;
  percent: number;
  asset: string;
  high?: number;
  low?: number;
  maxDrawdownPct?: number;
  running?: boolean;
}) {
  const positive = delta > 5e-9;
  const negative = delta < -5e-9;
  const pctBadgeCls = positive
    ? 'border-up/25 bg-up/8 text-up/90'
    : negative
      ? 'border-down/25 bg-down/8 text-down/90'
      : 'border-base-700 bg-base-850 text-ink-mid';

  return (
    <div className="mb-2 flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
      <span
        className="text-ink-lo"
        title="相对可见区间第一个快照的变化。与上方「账户余额」同一口径（共享钱包的真实权益）。"
      >
        本段变化
      </span>
      <span className={cn('num text-base font-semibold tracking-tight', pnlColor(delta))}>
        {fmtUsdSigned(delta, 2)} {asset}
      </span>
      <span className={cn('num rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none', pctBadgeCls)}>
        {fmtPercent(percent)}
      </span>

      {(high !== undefined || low !== undefined || maxDrawdownPct !== undefined) && (
        <span className="ml-auto flex flex-wrap items-center gap-1.5 text-[11px]">
          {high !== undefined && (
            <span
              className="inline-flex items-baseline gap-1 rounded border border-base-750/80 bg-base-900/55 px-1.5 py-0.5"
              title="当前所选区间内的最高权益"
            >
              <span className="text-ink-faint">峰值</span>
              <strong className="num font-medium text-up/90">{fmtNum(high, 2)}</strong>
            </span>
          )}
          {low !== undefined && (
            <span
              className="inline-flex items-baseline gap-1 rounded border border-base-750/80 bg-base-900/55 px-1.5 py-0.5"
              title="当前所选区间内的最低权益"
            >
              <span className="text-ink-faint">最低</span>
              <strong className="num font-medium text-down/90">{fmtNum(low, 2)}</strong>
            </span>
          )}
          {maxDrawdownPct !== undefined && maxDrawdownPct > 0.005 && (
            <span
              className="inline-flex items-baseline gap-1 rounded border border-base-750/80 bg-base-900/55 px-1.5 py-0.5"
              title="当前区间从阶段高点到后续低点的最大回撤幅度"
            >
              <span className="text-ink-faint">回撤</span>
              <strong className="num font-medium text-ink-mid">
                -{fmtNum(maxDrawdownPct, 2)}%
              </strong>
            </span>
          )}
          {running && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-base-750/80 bg-base-900/55 px-2 py-0.5 text-[10px] font-medium text-ink-lo"
              title="机器人运行中，曲线实时同步最新账户权益"
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up/60 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-up/90" />
              </span>
              实时
            </span>
          )}
        </span>
      )}

      {/* `equity` 只用来兜底没有快照时的比较基准，与图表内部口径一致；
          它是给屏幕阅读器的，不占视觉位置。 */}
      <span className="sr-only">当前账户权益 {fmtNum(equity, 2)}</span>
    </div>
  );
}

export function ChartTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  /*
   * 与面板头里的区间按钮**同一套控件**（`Button` primary/ghost）。
   * 原来这里自己写了一套 `border-base-700 bg-base-800` 的选中态，而右边
   * 区间按钮是 accent 描边 —— 同一个面板头两种选中样式，一眼就能看出是拼的。
   */
  return (
    <Button size="sm" variant={active ? 'primary' : 'ghost'} aria-pressed={active} onClick={onClick}>
      {children}
    </Button>
  );
}

/** The trader's most recent position symbol, as a candlestick chart. */
export function CandlesPanel({
  symbol,
  exchange,
  exchangeReady = true,
  priceLines = [],
}: {
  symbol?: string;
  exchange?: ExchangeId;
  exchangeReady?: boolean;
  priceLines?: ReadonlyArray<ChartPriceLine>;
}) {
  const [interval, setIntervalValue] = useState('15m');
  const query = usePolled(
    (signal) => api.marketKlines(symbol ?? '', interval, 400, signal, exchange),
    {
      intervalMs: 15_000,
      enabled: Boolean(symbol) && exchangeReady,
      deps: [symbol, interval, exchange],
    },
  );

  if (!symbol) {
    /*
     * ⚠️ **空状态也要占住图表的弹性高度**：切到「行情图表」时同样把下方空白顶满。
     */
    return (
      <p className="flex min-h-[200px] flex-1 items-center justify-center px-3 text-base text-ink-faint">
        该机器人当前没有持仓或挂单 —— 开仓、挂单或点选币种后这里会显示其行情图表。
      </p>
    );
  }

  const candles = query.data ?? [];
  const first = candles[0];
  const last = candles[candles.length - 1];
  const barChangePct =
    first && last && first.open > 0 ? ((last.close - first.open) / first.open) * 100 : null;
  const barRising = (barChangePct ?? 0) >= 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <div className="mb-2.5 flex shrink-0 flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-base font-semibold text-ink-hi">
          <span className="relative flex h-2 w-2">
            <span
              className={cn(
                'absolute inline-flex h-full w-full animate-ping rounded-full opacity-75',
                barRising ? 'bg-up' : 'bg-down',
              )}
            />
            <span className={cn('relative inline-flex h-2 w-2 rounded-full', barRising ? 'bg-up' : 'bg-down')} />
          </span>
          {symbol}
        </span>
        {last && <span className="num text-base font-semibold text-ink-hi">{fmtPriceUsd(last.close)}</span>}
        {barChangePct !== null && (
          <span
            className={cn(
              'num rounded-md border px-1.5 py-0.5 text-[11px] font-semibold leading-none',
              barRising ? 'border-up/35 bg-up/12 text-up' : 'border-down/35 bg-down/12 text-down',
            )}
            title="当前窗口内首尾 K 线涨跌幅"
          >
            {fmtPercent(barChangePct)}
          </span>
        )}
        {priceLines.length > 0 && (
          <span className="inline-flex flex-wrap items-center gap-1">
            {priceLines.map((line) => (
              <span
                key={line.id}
                className={cn(
                  'num inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none',
                  line.kind === 'take_profit'
                    ? 'border-up/30 bg-up/10 text-up'
                    : line.kind === 'stop_loss'
                      ? 'border-down/30 bg-down/10 text-down'
                      : line.kind === 'pending_entry'
                        ? 'border-warn/35 bg-warn/12 text-warn'
                        : 'border-accent/35 bg-accent/12 text-accent',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    line.kind === 'take_profit'
                      ? 'bg-up'
                      : line.kind === 'stop_loss'
                        ? 'bg-down'
                        : line.kind === 'pending_entry'
                          ? 'bg-warn'
                          : 'bg-accent',
                  )}
                />
                <span>{line.title}</span>
                <span>{formatCandlePrice(line.price)}</span>
              </span>
            ))}
          </span>
        )}
        <span className="ml-auto inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-base-750/80 bg-base-900/75 p-0.5">
          {['5m', '15m', '1h', '4h'].map((value) => (
            <Button
              key={value}
              size="sm"
              variant={interval === value ? 'primary' : 'ghost'}
              aria-pressed={interval === value}
              onClick={() => setIntervalValue(value)}
            >
              {value}
            </Button>
          ))}
        </span>
      </div>
      {query.error ? (
        <ErrorNote>{query.error}</ErrorNote>
      ) : query.loading && candles.length === 0 ? (
        <div className="flex min-h-[160px] flex-1 items-center justify-center">
          <Spinner3 label="正在加载K线" />
        </div>
      ) : candles.length === 0 ? (
        <Empty message="该交易对没有返回K线。" />
      ) : (
        <div className="relative min-h-[200px] w-full flex-1 overflow-hidden xl:min-h-[112px]">
          <div className="absolute inset-0">
            <CandlestickChart candles={candles} priceLines={priceLines} fill />
          </div>
        </div>
      )}
    </div>
  );
}

