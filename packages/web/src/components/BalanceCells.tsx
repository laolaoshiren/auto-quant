import { Badge, Button } from './ui';
import {
  BALANCE_LABEL,
  DEFAULT_SETTLE_ASSET,
  fmtAsset,
  fmtNum,
  fmtSigned,
  pnlColor,
  timeAgo,
  fmtTime,
} from '../lib/format';
import type { ExchangeBalance } from '../lib/api';

/* -------------------------------------------------------------------------- */
/*  One credential's live balance                                              */
/* -------------------------------------------------------------------------- */

/**
 * The 余额 cell of the credentials table.
 *
 * Three lines, in the order an operator reads them:
 *
 *   1. 权益 — the margin balance, i.e. what the bot actually trades with;
 *   2. 钱包 / 可用 — the settled balance the exchange's own app calls
 *      “钱包余额”, plus what is still free;
 *   3. 未实现 — only when there is one, coloured by sign.
 *
 * A failed read is rendered as a warning here rather than as an empty cell:
 * “we could not read this” is information, a blank is not.
 */
export function BalanceCell({
  balance,
  error,
  testnet,
  now,
}: {
  balance: ExchangeBalance | null;
  error: string | null;
  testnet: boolean;
  /** Ticking clock, so the relative read time stays honest between renders. */
  now: number;
}) {
  const env = <Badge tone={testnet ? 'muted' : 'warn'}>{testnet ? '测试网' : '主网'}</Badge>;

  if (!balance) {
    const message = error ?? '尚未读取到余额。';
    return (
      <div className="w-[196px] max-w-full space-y-1 whitespace-normal">
        <div className="flex items-center gap-1.5">
          <span
            className="min-w-0 flex-1 truncate text-2xs text-warn"
            title={`余额读取失败：${message}`}
          >
            ⚠ 余额读取失败：{message}
          </span>
          {env}
        </div>
        <div className="text-2xs text-ink-faint">点右侧 ⟳ 重试</div>
      </div>
    );
  }

  const asset = balance.asset?.trim() || DEFAULT_SETTLE_ASSET;

  return (
    <div className="num w-[196px] max-w-full space-y-0.5 whitespace-normal">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold text-ink-hi" title={`${BALANCE_LABEL.equity}（保证金余额 = 钱包 + 未实现盈亏）`}>
          {fmtAsset(balance.equity, asset)}
        </span>
        <span className="text-2xs text-ink-faint">权益</span>
        {env}
      </div>
      <div className="text-2xs text-ink-lo">
        {BALANCE_LABEL.short.wallet} {fmtNum(balance.walletBalance)} · {BALANCE_LABEL.short.available}{' '}
        {fmtNum(balance.availableBalance)}
      </div>
      {balance.unrealizedPnl !== 0 && (
        <div className={`text-2xs ${pnlColor(balance.unrealizedPnl)}`}>
          {BALANCE_LABEL.unrealized} {fmtSigned(balance.unrealizedPnl)}
        </div>
      )}
      <div className="text-2xs text-ink-faint" title={`读取于 ${fmtTime(balance.readAt)}`}>
        读取于 {timeAgo(balance.readAt)}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Trader dashboard account panel                                             */
/* -------------------------------------------------------------------------- */

/** The live account object `GET /traders/:id/account` returns. */
export interface TraderAccountState {
  equity: number;
  walletBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginUsed: number;
  openOrderMargin?: number;
}

/**
 * The trader dashboard's account strip.
 *
 * Shares `BALANCE_LABEL` / `fmtAsset` with the credentials table on purpose:
 * 钱包余额 must mean the same number on both screens, otherwise the operator
 * has to guess which one is the settled balance.
 */
export function TraderAccountStrip({
  account,
  asset,
  busy,
  onRefresh,
  error,
}: {
  account: TraderAccountState | null;
  asset?: string;
  busy?: boolean;
  onRefresh?: () => void;
  error?: string | null;
}) {
  const unit = asset?.trim() || DEFAULT_SETTLE_ASSET;
  const openOrderMargin = account?.openOrderMargin ?? 0;

  if (!account) {
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-base-800 pt-1.5 text-xs text-ink-lo">
        <Badge tone="muted">未连接交易所</Badge>
        <span>机器人运行时会在这里显示交易所的真实账户余额。</span>
        {error && <span className="text-warn">（{error}）</span>}
      </div>
    );
  }

  return (
    <div className="num mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-base-800 pt-1.5 text-xs text-ink-lo">
      {/* The settled balance is the number an operator checks most, so it gets
          the size and weight rather than sitting in the same small type as the
          rest of the strip. */}
      <span>
        {BALANCE_LABEL.wallet}{' '}
        <span className="text-sm font-semibold text-ink-hi">{fmtAsset(account.walletBalance, unit)}</span>
      </span>
      <span>
        {BALANCE_LABEL.available} <span className="text-ink-hi">{fmtNum(account.availableBalance)}</span>
      </span>
      <span>
        {BALANCE_LABEL.unrealized}{' '}
        <span className={pnlColor(account.unrealizedPnl)}>{fmtSigned(account.unrealizedPnl)}</span>
      </span>
      <span>
        {BALANCE_LABEL.marginUsed} <span className="text-ink-hi">{fmtNum(account.marginUsed)}</span>
      </span>
      <span className="text-ink-faint">
        {BALANCE_LABEL.equity} <span className="text-ink-mid">{fmtAsset(account.equity, unit)}</span>
      </span>
      {openOrderMargin > 0 && (
        <span className="text-ink-faint">
          {BALANCE_LABEL.openOrderMargin} <span className="text-ink-mid">{fmtNum(openOrderMargin)}</span>
        </span>
      )}
      {onRefresh && (
        <Button small variant="ghost" busy={busy} title="重新从交易所读取账户余额" onClick={onRefresh}>
          ⟳ 刷新余额
        </Button>
      )}
    </div>
  );
}
