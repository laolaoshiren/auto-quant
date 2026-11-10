/**
 * 「这台机器人用的是**哪个交易所、哪个钱包、测试网还是主网**」——一枚紧凑的组合标识。
 *
 * ## 为什么需要它（用户 2026-11-11 需求）
 *
 * 原话：「机器人列表页、详情页要能清楚看到机器人使用的是什么交易所什么钱包
 * （有测试网的也要清楚看到）」。
 *
 * 背景是 Gate 接入以后，同一个平台上可能同时挂着：
 *   · 币安子账号（主网/实盘）
 *   · Gate 测试网账户（假钱）
 *   · 纯模拟盘机器人（没有账户）
 *
 * 只显示「账户名」不够 —— 名字是用户自己起的，「Gate 测试网」这种名字里带
 * 环境信息纯属巧合；而「测试网/主网」决定的是**这单会不会真的动钱**，
 * 必须是结构化字段（`testnet`）渲染出来的徽章，不能靠名字里有没有「测试」两个字。
 */
import type { ExchangeAccountRow } from '../lib/api';
import { Badge } from './ui';

/** 交易所短名（`EXCHANGES` 的 label 是"币安 USDT 本位合约"，在表格里太长）。 */
const EXCHANGE_SHORT: Record<string, string> = {
  binance: '币安',
  gate: 'Gate',
};

export interface ExchangeAccountLike {
  exchange?: string;
  label?: string;
  testnet?: boolean;
}

/**
 * @param account 该机器人绑定的凭据行；`null`/`undefined` = 纯模拟盘（没有账户）。
 */
export function ExchangeAccountChip({
  account,
  className = '',
}: {
  account?: ExchangeAccountLike | null;
  className?: string;
}) {
  if (!account) {
    return (
      <Badge tone="muted" className={className} title="没有绑定交易所账户：这台机器人是纯模拟盘，不会向交易所发任何订单。">
        无账户
      </Badge>
    );
  }
  const exchange = account.exchange ?? '';
  const short = EXCHANGE_SHORT[exchange] ?? exchange ?? '未知所';
  const testnet = account.testnet === true;
  return (
    <span className={`flex min-w-0 items-center gap-1 ${className}`}>
      <Badge tone={exchange === 'gate' ? 'accent' : 'neutral'} title={`交易所：${short}`}>
        {short}
      </Badge>
      <span className="min-w-0 max-w-[9rem] truncate text-xs text-ink-mid" title={account.label ?? ''}>
        {account.label ?? '未命名账户'}
      </span>
      {testnet ? (
        <Badge tone="muted" title="测试网 / 模拟交易：假钱、真实撮合，不会造成资金损失。">
          测试网
        </Badge>
      ) : (
        <Badge tone="warn" title="主网 / 正式环境：真实资金，下单会动真钱。">
          主网
        </Badge>
      )}
    </span>
  );
}

/** 从账户列表里取某台机器人绑定的那一行（找不到时返回 `null`）。 */
export function accountOf(
  accounts: ReadonlyArray<ExchangeAccountRow> | null | undefined,
  exchangeAccountId: number | null | undefined,
): ExchangeAccountRow | null {
  if (exchangeAccountId === null || exchangeAccountId === undefined) return null;
  return accounts?.find((row) => row.id === exchangeAccountId) ?? null;
}
