/**
 * The gross → net bridge for realised PnL.
 *
 * 已实现盈亏 is **net**: what the account actually gained, i.e. gross minus the
 * commission paid on both legs minus funding. The console used to print the
 * gross figure and call it net, which on a live 10 USDT account showed −0.3136
 * while the wallet had gone *up* by 0.2586. Three screens render the same
 * figures, so the arithmetic lives in one place rather than being re-derived —
 * and re-broken — in each of them.
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
  /** 资金费 — negative when paid, positive when received. */
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
  return { gross: trade.pnl, fees: trade.fee, funding: trade.fundingFee, net: trade.netPnl };
}

/** Same four figures, read off the stats endpoint. */
export function statsCosts(
  stats: Pick<TraderStats, 'realizedPnl' | 'grossRealizedPnl' | 'totalFees' | 'totalFunding'>,
): PnlCosts {
  return {
    gross: stats.grossRealizedPnl,
    fees: stats.totalFees,
    funding: stats.totalFunding,
    net: stats.realizedPnl,
  };
}

/**
 * `− 手续费 0.0240`, or `+ 手续费 0.0012` for a rebate.
 *
 * The magnitude is unsigned on purpose: the operator is already reading the
 * minus sign in front of the label, and `− 手续费 +0.0240` reads as a double
 * negative on exactly the line that is supposed to make the arithmetic clear.
 * A funding cost is written the same way, since its contribution to net PnL is
 * `− fundingFee`.
 */
function costTerm(label: string, value: number, digits: number): string {
  if (value === 0) return '';
  return `${value > 0 ? '−' : '+'} ${label} ${fmtNum(Math.abs(value), digits)}`;
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
      className={`num inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-ink-lo${
        className ? ` ${className}` : ''
      }`}
      title={pnlFormulaText(costs, digits)}
    >
      <span>
        毛 <span className="text-ink-mid">{fmtSigned(costs.gross, digits)}</span>
      </span>
      <span className="text-ink-faint">·</span>
      <span>
        手续费 <span className="text-warn">{fmtSigned(-costs.fees, digits)}</span>
      </span>
      {costs.funding !== 0 && (
        <>
          <span className="text-ink-faint">·</span>
          <span>
            资金费 <span className={pnlColor(costs.funding)}>{fmtSigned(costs.funding, digits)}</span>
          </span>
        </>
      )}
    </span>
  );
}
