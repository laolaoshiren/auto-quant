import { useMemo, type MutableRefObject, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { MarginMode, OrderRecord } from '@aq/shared';
import { marginModeLabel, orderMarginMode, symbolTone, symbolToneWithAvoidance } from '../../lib/format';
import type { MoreState } from './useTablePaging';

/* -------------------------------------------------------------------------- */
/*  历史区高度（收起 / 展开）                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 展开态与收起态的滚动框高度。
 * 收起只改这一个 class：同一个 DOM 节点、同一个 `ref`、同一个 `root`，
 * React 只更新 `class`，不重挂（避免分页观察器失效）。
 * 使用 `clamp` 确保手机横屏等矮视口下展开态（≥180px）恒高于收起态（120–160px），不会倒挂。
 */
export const EXPANDED_MAX_H = 'max-h-[clamp(180px,30dvh,260px)]';

/**
 * 收起态：表头 + 至少 2 行，恒小于展开态高度。
 */
export const COLLAPSED_MAX_H = 'max-h-[clamp(120px,18dvh,160px)]';

/* -------------------------------------------------------------------------- */
/*  Shared column tooltips                                                     */
/* -------------------------------------------------------------------------- */

/** 「保证金占用」列的口径说明 —— 与 `PositionsTable` 那一列同一条措辞。 */
export const MARGIN_USED_TITLE = '该仓位占用的保证金（本金）= 名义价值 ÷ 杠杆。';

/** 委托表「保证金占用」列的口径说明。 */
export const ORDER_MARGIN_USED_TITLE =
  '该委托涉及的保证金（本金）：开仓单是这一笔自己占用的，平仓 / 保护单取所属持仓占用的。— 表示服务端算不出这个数（例如被拒的单、没有对应本地持仓的单），不是 0。';

/** 「保证金模式」列的口径说明。 */
export const ORDER_MARGIN_MODE_TITLE =
  '该标的的保证金模式。全仓 = 整个合约钱包共同承担这一仓的亏损；逐仓 = 这一仓最多亏掉自己那份保证金。';

/** 订单表保证金模式三种来源的悬停说明。 */
export const ORDER_MARGIN_MODE_SOURCE_TITLE = {
  order: '下单当时该标的的保证金模式（下单那一刻由服务端记下，取自交易所确认过的配置）。',
  position:
    '这张单落库时没有记下保证金模式（迁移之前的历史行，或该标的的模式从未成功设置过）。这里显示的是该标的当前的账户配置 —— 实时读自交易所，不是下单那一刻的快照，不能当历史证据。',
  none: '这一行没有保证金模式的记录：它可能是迁移之前的历史行，该标的的模式也可能从未成功设置过，而且它现在没有持仓可供读取。— 表示"不知道"，不是"全仓"。',
} as const;

/** 成交表保证金模式三种来源的悬停说明。 */
export const TRADE_MARGIN_MODE_TITLE = {
  known: '该回合入场时的保证金模式，取自入场订单落库的配置 —— 这是当时的值。',
  position:
    '这张成交的入场订单没有记下保证金模式（迁移之前的历史行，或该标的的模式从未成功设置过）。' +
    '这里显示的是该标的当前的账户配置 —— 实时读自交易所，不是成交当时的快照，不能当历史证据。',
  none:
    '这一行没有保证金模式的记录：入场订单在迁移之前（没有这一列），' +
    '或者这一笔是补录的（机器人没运行时平的仓，没有对应的本地订单行），' +
    '而且该标的现在没有持仓可供读取。— 表示"不知道"，不是"全仓"。',
} as const;

/* -------------------------------------------------------------------------- */
/*  Shared table chrome                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 表格末尾那几行状态：哨兵 + 加载中 + 失败可重试 + 终点。
 */
export function PageTail({
  sentinelRef,
  hasMore,
  moreState,
  moreError,
  onRetry,
  noun,
}: {
  sentinelRef: MutableRefObject<HTMLDivElement | null>;
  hasMore: boolean;
  moreState: MoreState;
  moreError: string | null;
  onRetry: () => void;
  /** 加载文案里的名词：`订单` / `成交`。 */
  noun: string;
}) {
  return (
    <>
      <div ref={sentinelRef} aria-hidden className="h-px w-full" />

      {moreState === 'loading' && (
        <p
          role="status"
          className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-ink-faint"
        >
          <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
          正在加载更早的{noun}…
        </p>
      )}

      {moreState === 'error' && (
        <p role="alert" className="px-3 py-2 text-center text-xs text-down">
          加载更早的{noun}失败{moreError ? `：${moreError}` : ''}
          <button type="button" onClick={onRetry} className="ml-1 text-accent hover:underline">
            重试
          </button>
        </p>
      )}

      {!hasMore && <p className="px-3 py-2 text-center text-xs text-ink-faint">已到最早一笔</p>}
    </>
  );
}

/** What a capped table says instead of quietly losing rows. */
export function CapNote({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <p className="border-t border-base-800 px-3 py-2 text-xs text-ink-faint">
      只渲染最近 {shown} 行，共 {total} 行 — 更早的记录请在交易所或导出接口查询，避免一次渲染上千行拖慢页面。
    </p>
  );
}

/** 空表格只留一行。 */
export function TableEmpty({
  message,
  hint,
  action,
}: {
  message: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium text-ink-mid">{message}</span>
        {hint && <span className="text-xs text-ink-faint">{hint}</span>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Shared table cells                                                         */
/* -------------------------------------------------------------------------- */

/** 表格里的币种单元格：有色、（可选的）可点击。 */
export function SymbolCell({
  symbol,
  onSelect,
  tone: toneOverride,
}: {
  symbol: string;
  onSelect?: (symbol: string) => void;
  tone?: string;
}) {
  const tone = toneOverride ?? symbolTone(symbol);
  const content = (
    <span className="inline-flex items-center gap-1.5 font-semibold text-ink-hi">
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: tone }}
      />
      <span>{symbol}</span>
    </span>
  );
  if (!onSelect) {
    return content;
  }
  return (
    <button
      type="button"
      onClick={() => onSelect(symbol)}
      title={`在行情图表里查看 ${symbol}`}
      className="-mx-1 inline-flex items-center rounded px-1 transition hover:bg-base-800"
    >
      {content}
    </button>
  );
}

/** 一张表的同屏不重复配色：按行序给每个币种分配一个还没被用过的颜色。 */
export function useSymbolTones(symbols: readonly string[]): Map<string, string> {
  return useMemo(() => {
    const used = new Set<string>();
    const map = new Map<string, string>();
    for (const symbol of symbols) {
      if (map.has(symbol)) continue;
      const tone = symbolToneWithAvoidance(symbol, used);
      used.add(tone);
      map.set(symbol, tone);
    }
    return map;
  }, [symbols]);
}

/** 「保证金模式」单元格：`全仓` / `逐仓` / `—`。 */
export function MarginModeCell({
  order,
  mode,
  symbol,
  liveBySymbol,
}: {
  order?: OrderRecord;
  /** 后端已经带出来的值（成交表走这条）。可能缺失。 */
  mode?: MarginMode;
  /** 该行对应的标的 —— 用于"当前持仓"兜底（成交表也走这条）。 */
  symbol?: string;
  liveBySymbol?: ReadonlyMap<string, MarginMode> | null;
}) {
  if (order) {
    const resolved = orderMarginMode(order, liveBySymbol);
    if (resolved === null) {
      return (
        <span className="text-ink-faint" title={ORDER_MARGIN_MODE_SOURCE_TITLE.none}>
          —
        </span>
      );
    }
    return (
      <span
        title={
          resolved.source === 'order'
            ? ORDER_MARGIN_MODE_SOURCE_TITLE.order
            : ORDER_MARGIN_MODE_SOURCE_TITLE.position
        }
      >
        {marginModeLabel(resolved.mode)}
      </span>
    );
  }

  if (mode !== undefined) {
    return <span title={TRADE_MARGIN_MODE_TITLE.known}>{marginModeLabel(mode)}</span>;
  }

  const fallback = symbol ? liveBySymbol?.get(symbol) : undefined;
  if (fallback !== undefined) {
    return <span title={TRADE_MARGIN_MODE_TITLE.position}>{marginModeLabel(fallback)}</span>;
  }

  return (
    <span className="text-ink-faint" title={TRADE_MARGIN_MODE_TITLE.none}>
      —
    </span>
  );
}
