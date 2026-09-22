/**
 * The gross → net bridge for realised PnL.
 *
 * 已实现盈亏 is **net**: what the account actually gained, i.e. gross minus the
 * commission paid on both legs minus funding. The console used to print the
 * gross figure and call it net, which on a live 10 USDT account showed −0.3136
 * while the wallet had gone *up* by 0.2586. Three screens render the same
 * figures, so the arithmetic lives in one place rather than being re-derived —
 * and re-broken — in each of them.
 *
 * The identity is never collapsed to a single number: 毛 − 手续费 − 资金费 = 净 is
 * the accounting the whole platform is trusted on, and an operator who cannot
 * see the two costs cannot tell a bad strategy from a fee-bleed.
 *
 * ## ⚠️ 两项成本都是**正数**，符号在运算符上
 *
 * `fees` 与 `funding` 统一按「**成本为正**」存：付出 0.0092 的资金费存 `+0.0092`，
 * 收到 0.0092 存 `−0.0092`。渲染时符号由 `CostTerm` 单独生成（`− 资金费 0.0092`），
 * 于是**屏幕上那三个数字可以直接按屏幕上那句公式心算**。
 *
 * 这里曾经反过来：`funding` 直接存交易所口径（付出为**负**），而公式字符串仍写
 * 「− 资金费」—— 操作员按屏幕上的数字算，与净额**差正好是资金费的两倍**，
 * 于是"历史成交对不上"。同一个符号错误在 `netPnlOf()` 里也犯过一次
 * （见 `binance/income.ts` 的长注释：它让平台每轮报一条假的账目告警）。
 * 两处收口到同一条约定：**算术里带符号，展示时把符号提到数字前面**。
 */
import type { TraderStats } from '@aq/shared';
import { fmtNum, fmtSigned, pnlColor } from '../lib/format';

/** The rule, spelled out. Every net figure in the console points at this. */
export const NET_PNL_FORMULA = '净盈亏 = 毛盈亏 − 手续费 − 资金费';

/** One trader's (or one trade's) gross → net breakdown, in account currency. */
export interface PnlCosts {
  /** 毛盈亏 — before costs. */
  gross: number;
  /** 手续费合计 — commission on both legs, as a positive cost. */
  fees: number;
  /** 资金费 — **正的成本**（付出为正、收到为负），与 `fees` 同一个约定。 */
  funding: number;
  /** 净盈亏 — the number that moved the balance. */
  net: number;
}

/** Same four figures, read off one trade row. */
export function tradeCosts(trade: {
  pnl: number;
  fee: number;
  fundingFee: number;
  netPnl: number;
}): PnlCosts {
  return {
    gross: trade.pnl,
    fees: trade.fee,
    /*
     * 取负：交易所口径是"付出为负"，`PnlCosts` 统一成"成本为正"。
     * 平仓那一行显示的是原始口径（`资 -0.0020`），两者不要混。
     */
    funding: -trade.fundingFee,
    net: trade.netPnl,
  };
}

/** Same four figures, read off the stats endpoint. */
export function statsCosts(
  stats: Pick<TraderStats, 'realizedPnl' | 'grossRealizedPnl' | 'totalFees' | 'totalFunding'>,
): PnlCosts {
  return {
    gross: stats.grossRealizedPnl,
    fees: stats.totalFees,
    /* 同上：`totalFunding` 也是交易所口径（付出为负）。 */
    funding: -stats.totalFunding,
    net: stats.realizedPnl,
  };
}

/**
 * `− 手续费 0.0240`, or `+ 手续费 0.0012` for a rebate.
 *
 * The magnitude is unsigned on purpose: the operator is already reading the
 * minus sign in front of the label, and `− 手续费 +0.0240` reads as a double
 * negative on exactly the line that is supposed to make the arithmetic clear.
 *
 * 资金费走同一条规则 —— 它的贡献就是 `− funding`，而 `funding` 在这里已经是
 * "成本为正"，所以运算符完全由 `value` 的符号决定，不需要第二套规则。
 *
 * （这句话原来写的是「its contribution to net PnL is `− fundingFee`」，那是在
 * `funding` 还存着交易所口径时说的；口径改过来之后它就成了一条**错的注释**，
 * 而它正是下一个改这段代码的人会照着做的那句话。一并改掉。）
 */
function costTerm(label: string, value: number, digits: number): string {
  if (value === 0) return '';
  return `${value > 0 ? '−' : '+'} ${label} ${fmtNum(Math.abs(value), digits)}`;
}

/**
 * 一项成本，连同它在恒等式里的那个运算符 —— 屏幕上的版本。
 *
 * 把符号与数字**分开渲染**（`− 手续费 0.2071`），而不是写成 `手续费 -0.2071`：
 * 屏幕上那句公式是「毛 − 手续费 − 资金费」，而一个已经带着负号的数字紧挨着
 * 那个减号，读的人会多数一次负号 —— **用户就是这样发现"历史成交对不上"的**
 * （他算出来与净额差 0.0187，正好是资金费的两倍）。
 *
 * 零项仍然要渲染：一条会消失的项，比一条写着 `0.0000` 的项更难核对。
 */
function CostTerm({
  label,
  value,
  digits,
  tone,
}: {
  label: string;
  /** **成本为正**的数额（收到则为负）。 */
  value: number;
  digits: number;
  tone: string;
}) {
  if (value === 0) {
    return (
      <>
        <span aria-hidden className="text-ink-faint">
          ·
        </span>
        <span>
          {label} <span className="text-ink-mid">{fmtNum(0, digits)}</span>
        </span>
      </>
    );
  }
  return (
    <>
      <span aria-hidden className="text-ink-faint">
        {value > 0 ? '−' : '+'}
      </span>
      <span>
        {label} <span className={tone}>{fmtNum(Math.abs(value), digits)}</span>
      </span>
    </>
  );
}

/** The same line plus the arithmetic, for a `title` tooltip. */
export function pnlFormulaText(costs: PnlCosts, digits = 4): string {
  const terms = [costTerm('手续费', costs.fees, digits), costTerm('资金费', costs.funding, digits)]
    .filter(Boolean)
    .join(' ');
  return `${NET_PNL_FORMULA}：净 ${fmtSigned(costs.net, digits)} = 毛 ${fmtSigned(
    costs.gross,
    digits,
  )}${terms ? ` ${terms}` : ''}`;
}

/**
 * The breakdown as a muted inline line.
 *
 * Rendered wherever a net figure is the headline, so the costs that were
 * subtracted sit next to it rather than hiding behind a tooltip.
 *
 * Three readability changes, no behaviour change:
 *
 * - the three figures are `tabular-nums` (`.num` on the wrapper) so they stop
 *   jittering as the poll refreshes — the whole strip updates together every
 *   few seconds, and moving digits in a row of four numbers is very visible;
 * - 手续费 is amber rather than plain `ink-mid`: it is a guaranteed cost, and
 *   the same amber marks fees in the trade tables and the preflight warnings;
 * - 资金费 is always rendered, even at exactly zero. It used to be dropped when
 *   zero, which made the line silently two terms instead of three — and since
 *   the formula is part of what the operator is being asked to trust, a term
 *   that disappears is worse than a term that reads `+0.0000`. The cost is one
 *   short word in a line that is already secondary information.
 */
export function PnlBreakdown({
  costs,
  digits = 4,
  className,
}: {
  costs: PnlCosts;
  /** Four decimals by default: on a small account the costs *are* the story. */
  digits?: number;
  className?: string;
}) {
  return (
    <span
      className={`num inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-ink-lo${
        className ? ` ${className}` : ''
      }`}
      title={pnlFormulaText(costs, digits)}
      /* The visible line already spells out every term, but the identity itself
         is only in the tooltip — so it is exposed here for a screen reader. */
      aria-label={pnlFormulaText(costs, digits)}
    >
      <span>
        毛 <span className="text-ink-mid">{fmtSigned(costs.gross, digits)}</span>
      </span>
      <CostTerm label="手续费" value={costs.fees} digits={digits} tone="text-warn" />
      <CostTerm
        label="资金费"
        value={costs.funding}
        digits={digits}
        tone={pnlColor(-costs.funding)}
      />
      {/*
       * 净 is rendered last, and only here.
       *
       * The callers already print the net figure as the headline, so repeating it
       * inside the breakdown would double every row's numbers without adding a
       * fact. The tooltip carries the full `净 = 毛 − 手续费 − 资金费` sentence.
       */}
    </span>
  );
}
