/**
 * Balance cells shared by the 交易所 credentials table and the trader dashboard.
 *
 * Both screens read the same exchange figures, so the vocabulary comes from
 * `BALANCE_LABEL` rather than being spelled out per screen — 钱包余额 has to mean
 * one number everywhere, or the operator has to guess which one is settled.
 */
import { RefreshCw, TriangleAlert } from 'lucide-react';
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
        <div className="flex items-start gap-1.5">
          {/*
           * An icon rather than a `⚠` character: the font fallback for that
           * glyph is a different width on every platform, so the wrapped second
           * line of the message used to indent differently on Windows and macOS.
           */}
          <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
          <span className="min-w-0 flex-1 text-2xs text-warn" title={`余额读取失败：${message}`}>
            余额读取失败：{message}
          </span>
          {env}
        </div>
        <div className="pl-5 text-2xs text-ink-faint">点右侧刷新按钮重试。</div>
      </div>
    );
  }

  const asset = balance.asset?.trim() || DEFAULT_SETTLE_ASSET;

  return (
    <div className="num w-[196px] max-w-full space-y-0.5 whitespace-normal">
      <div className="flex items-center gap-1.5">
        <span
          className="text-xs font-semibold text-ink-hi"
          title={`${BALANCE_LABEL.equity}（保证金余额 = 钱包 + 未实现盈亏）。这是「交易所账户」的权益，同一账户下的所有机器人共用这一个钱包。`}
        >
          {fmtAsset(balance.equity, asset)}
        </span>
        <span className="text-2xs text-ink-faint">{BALANCE_LABEL.short.equity}</span>
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
 *
 * Laid out as a definition-style grid rather than a run of `label value` pairs:
 * every figure carries its unit and its label in a fixed column, so the strip
 * stays scannable when it wraps to two lines on a narrow window.
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
    <div className="num mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-base-800 pt-1.5 text-xs text-ink-lo">
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
      {/* 未实现 is signed through `fmtSigned`, so the +/- is always rendered —
          the colour is a second signal, never the only one. */}
      <span>
        {BALANCE_LABEL.unrealized}{' '}
        <span className={pnlColor(account.unrealizedPnl)}>{fmtSigned(account.unrealizedPnl)}</span>
      </span>
      <span>
        {BALANCE_LABEL.marginUsed} <span className="text-ink-hi">{fmtNum(account.marginUsed)}</span>
      </span>
      <span
        className="text-ink-faint"
        title="交易所账户（共享钱包）的权益 = 钱包 + 未实现盈亏。同一账户下的所有机器人共用这一个数，所以它不等于本机器人的归属权益。"
      >
        {BALANCE_LABEL.equity} <span className="text-ink-mid">{fmtAsset(account.equity, unit)}</span>
      </span>
      {openOrderMargin > 0 && (
        <span className="text-ink-faint">
          {BALANCE_LABEL.openOrderMargin} <span className="text-ink-mid">{fmtNum(openOrderMargin)}</span>
        </span>
      )}
      {onRefresh && (
        /* Label plus icon: a bare `⟳` glyph is unreadable to a screen reader and
           ambiguous to anyone who has not used this app before. */
        <Button small variant="ghost" busy={busy} title="重新从交易所读取账户余额" onClick={onRefresh}>
          <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          刷新余额
        </Button>
      )}
    </div>
  );
}
