/** Presentation helpers. Money and PnL always carry an explicit sign. */

export function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Compact money: 12,345.6 → `12,345.60`, 1,234,567 → `1.23M`. */
export function fmtNum(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 100_000) return `${(value / 1000).toFixed(1)}K`;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtUsd(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) return '—';
  return `$${fmtNum(value, digits)}`;
}

/**
 * The single place the balance vocabulary lives.
 *
 * The credentials table and the trader dashboard both label the same exchange
 * figures, so a divergence here (“钱包余额” on one screen, “余额” on the other)
 * would make an operator doubt both.
 *
 * `equity` 从“权益”改成“账户权益”是刻意的：这些读数是**交易所账户**的（共享钱包），
 * 而机器人页面上的“权益”是**该机器人归属**的那一份。同一个词指两个数，操作员就
 * 没法判断哪个是账户里的钱、哪个是这个机器人挣的 —— 这正是本次修的那个 bug。
 */
export const BALANCE_LABEL = {
  equity: '账户权益',
  wallet: '钱包余额',
  available: '可用',
  unrealized: '未实现',
  marginUsed: '保证金占用',
  openOrderMargin: '挂单占用',
  short: {
    equity: '账户权益',
    wallet: '钱包',
    available: '可用',
  },
} as const;

/** Asset shown when a payload predates the `asset` field. */
export const DEFAULT_SETTLE_ASSET = 'USDT';

/** `1,015.50 USDT` — money with its settlement unit spelled out. */
export function fmtAsset(
  value: number | null | undefined,
  asset: string | null | undefined,
  digits = 2,
): string {
  const amount = fmtNum(value, digits);
  if (amount === '—') return '—';
  return `${amount} ${asset?.trim() || DEFAULT_SETTLE_ASSET}`;
}

/** Unsigned magnitude, for labels that already say `未实现`. */
export function fmtSigned(
  value: number | null | undefined,
  digits = 2,
): string {
  if (!isNum(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${fmtNum(Math.abs(value), digits)}`;
}

/** Signed money — used for every PnL figure, so the sign is never implied. */
export function fmtUsdSigned(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${fmtNum(Math.abs(value), digits)}`;
}

export function fmtPercent(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

export function fmtPrice(value: number | null | undefined): string {
  if (!isNum(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 100 ? 3 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 8;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtQty(value: number | null | undefined): string {
  if (!isNum(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function fmtInt(value: number | null | undefined): string {
  if (!isNum(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

export function fmtCompact(value: number | null | undefined): string {
  if (!isNum(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(2);
}

/** Tailwind text colour for a signed number. Zero is neutral. */
export function pnlColor(value: number | null | undefined): string {
  if (!isNum(value) || value === 0) return 'text-ink-mid';
  return value > 0 ? 'text-up' : 'text-down';
}

export function fmtDuration(minutes: number | null | undefined): string {
  if (!isNum(minutes)) return '—';
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total}分`;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours < 24) return `${hours}时${mins}分`;
  const days = Math.floor(hours / 24);
  return `${days}天${hours % 24}时`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toLocaleDateString('en-CA')} ${date.toLocaleTimeString('en-GB', { hour12: false })}`;
}

export function fmtClockOffset(ms: number | null | undefined): string {
  if (!isNum(ms)) return '—';
  const sign = ms >= 0 ? '+' : '-';
  return `${sign}${Math.abs(Math.round(ms))} ms`;
}

/** `12.3s` / `840ms` — model latency reads better than a raw millisecond count. */
export function fmtLatency(ms: number | null | undefined): string {
  if (!isNum(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Profit factor. The API serialises `Infinity` to `null` — that means "no losing
 * trades closed yet", which must read as ∞ and not as zero.
 */
export function fmtProfitFactor(value: number | null | undefined): string {
  if (value === null || value === undefined) return '∞';
  if (!Number.isFinite(value)) return '∞';
  return value.toFixed(2);
}

/** Coarse relative time, good enough for a status line. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '从未';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '从未';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

export function sideLabel(side: string): string {
  return side === 'long' || side === 'BUY' ? '多' : '空';
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function safeJson(value: unknown, indent = 2): string {
  try {
    return JSON.stringify(value, null, indent);
  } catch {
    return String(value);
  }
}
