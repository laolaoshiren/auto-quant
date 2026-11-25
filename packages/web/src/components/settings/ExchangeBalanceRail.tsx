import { Landmark, Plus } from 'lucide-react';
import type { ExchangeId } from '@aq/shared';
import type { ExchangeAccountRow, ExchangeBalance, ExchangeBalanceResult } from '../../lib/api';
import { Badge, Button, Panel, cn } from '../ui';
import { Metric, MetricGroup } from '../shell';
import {
  BALANCE_LABEL,
  DEFAULT_SETTLE_ASSET,
  TRADING_ENV_LABEL,
  fmtAmount,
  fmtAsset,
  fmtTime,
  timeAgo,
} from '../../lib/format';

export type FreshRead = { at: number; result: ExchangeBalanceResult };

export interface ExchangeOption {
  id: ExchangeId;
  label: string;
  market: string;
  available: boolean;
}

/**
 * 把一堆凭证的余额合成左栏要的那一个答案：
 * - 只累加结算币种相同的读数；
 * - 读失败的凭证不当作 0，只记下失败数量；
 * - 读取时刻取最新一次成功读取。
 */
export function aggregateBalance(
  rows: ExchangeAccountRow[],
  freshOf: (id: number) => FreshRead | undefined,
) {
  let total = 0;
  let wallet = 0;
  let available = 0;
  let unrealized = 0;
  let readAt: string | null = null;
  let readAtMs = 0;
  let asset: string = DEFAULT_SETTLE_ASSET;
  let counted = 0;
  let failed = 0;
  let skippedAsset = 0;

  for (const row of rows) {
    const fresh = freshOf(row.id);
    const balance: ExchangeBalance | null = fresh ? (fresh.result.ok ? fresh.result.balance : null) : row.balance;
    const error = fresh ? (fresh.result.ok ? null : fresh.result.error) : row.balanceError;

    if (!balance) {
      if (error) failed += 1;
      continue;
    }
    const rowAsset = balance.asset?.trim() || DEFAULT_SETTLE_ASSET;
    if (counted === 0) asset = rowAsset;
    if (rowAsset !== asset) {
      skippedAsset += 1;
      continue;
    }
    total += balance.equity;
    wallet += balance.walletBalance;
    available += balance.availableBalance;
    unrealized += balance.unrealizedPnl;
    counted += 1;
    const at = new Date(balance.readAt).getTime();
    if (Number.isFinite(at) && at > readAtMs) {
      readAtMs = at;
      readAt = balance.readAt;
    }
  }

  return { total, wallet, available, unrealized, readAt, asset, counted, failed, skippedAsset };
}

export type BalanceTotals = ReturnType<typeof aggregateBalance>;

export function ExchangeBalanceRail({
  loading,
  accounts,
  liveAccounts,
  testnetAccounts,
  liveTotals,
  testnetTotals,
  latestReadAt,
  failedReads,
  skippedAssets,
}: {
  loading: boolean;
  accounts: ExchangeAccountRow[];
  liveAccounts: ExchangeAccountRow[];
  testnetAccounts: ExchangeAccountRow[];
  liveTotals: BalanceTotals;
  testnetTotals: BalanceTotals;
  latestReadAt: string | null;
  failedReads: number;
  skippedAssets: number;
}) {
  return (
    <div className="space-y-4">
      {liveAccounts.length > 0 && (
        <div className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2.5 text-warn">
          <div className="flex items-center gap-2">
            <span className="rounded border border-warn/50 px-1.5 text-xs font-bold tracking-wide">实盘</span>
            <span className="num text-xs font-semibold">{liveAccounts.length} 个凭证</span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed">
            <span className="font-semibold">{TRADING_ENV_LABEL.long.live}：</span>
            它们下的每一单都会在真实市场成交并动用真实资金。不确定时请先切到测试网密钥。
          </p>
          <p className="mt-1 break-words text-xs text-warn/90">{liveAccounts.map((row) => row.label).join('、')}</p>
        </div>
      )}

      <Panel title="账户概览" bodyClassName="p-4">
        {loading && accounts.length === 0 ? (
          <p className="text-xs text-ink-lo">正在读取交易所余额…</p>
        ) : accounts.length === 0 ? (
          <p className="text-xs leading-relaxed text-ink-lo">
            还没有凭证，因此没有余额可读。模拟模式不需要密钥。
          </p>
        ) : (
          <>
            <MetricGroup title="实盘资产（主网）" columns={1}>
              {liveAccounts.length === 0 ? (
                <p className="text-xs text-ink-faint">暂未添加主网实盘凭证。</p>
              ) : liveTotals.counted === 0 ? (
                <Metric label={`实盘${BALANCE_LABEL.equity}`} value="—" size="lg" />
              ) : (
                <>
                  <Metric
                    label={`实盘${BALANCE_LABEL.equity}合计（${liveTotals.asset}）`}
                    value={fmtAsset(liveTotals.total, liveTotals.asset)}
                    sub={`${liveTotals.counted} 个主网凭证 · 可用 ${fmtAmount(liveTotals.available)}`}
                    size="lg"
                    tone="strong"
                    title="仅统计主网实盘账户由交易所回报的真实权益之和，不包含任何测试网资金"
                  />
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-lo">
                    <span>
                      钱包 <span className="num text-ink-mid">{fmtAmount(liveTotals.wallet)}</span>
                    </span>
                    <span>
                      可用 <span className="num text-ink-mid">{fmtAmount(liveTotals.available)}</span>
                    </span>
                    {liveTotals.unrealized !== 0 && (
                      <span>
                        未实现{' '}
                        <span className={cn('num font-medium', liveTotals.unrealized > 0 ? 'text-up' : 'text-down')}>
                          {fmtAsset(liveTotals.unrealized, liveTotals.asset)}
                        </span>
                      </span>
                    )}
                  </div>
                </>
              )}
            </MetricGroup>

            {testnetAccounts.length > 0 && (
              <MetricGroup title="测试网资产（虚拟资金）" columns={1} className="mt-4">
                {testnetTotals.counted === 0 ? (
                  <Metric label={`测试网${BALANCE_LABEL.equity}`} value="—" />
                ) : (
                  <>
                    <Metric
                      label={`测试网${BALANCE_LABEL.equity}合计（${testnetTotals.asset}）`}
                      value={fmtAsset(testnetTotals.total, testnetTotals.asset)}
                      sub={`${testnetTotals.counted} 个测试网凭证 · 仅用于联调，不计入实盘`}
                      title="仅统计测试网虚拟资金余额，与主网真实资金完全隔离"
                    />
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-faint">
                      <span>
                        钱包 <span className="num text-ink-lo">{fmtAmount(testnetTotals.wallet)}</span>
                      </span>
                      <span>
                        可用 <span className="num text-ink-lo">{fmtAmount(testnetTotals.available)}</span>
                      </span>
                    </div>
                  </>
                )}
              </MetricGroup>
            )}
          </>
        )}

        <MetricGroup title="读取" columns={1} className="mt-4">
          <Metric
            label="最近一次成功读取"
            value={latestReadAt ? timeAgo(latestReadAt) : '尚未读取'}
            sub={
              latestReadAt
                ? `${fmtTime(latestReadAt)} · 每 30 秒自动轮询`
                : '点「刷新全部」立即读取'
            }
            title={latestReadAt ? `交易所返回的读取时刻 ${fmtTime(latestReadAt)}` : undefined}
          />
        </MetricGroup>
      </Panel>

      {accounts.length > 0 && liveTotals.counted + testnetTotals.counted === 0 && (
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
          {failedReads > 0
            ? `${failedReads} 个凭证读取失败，合计未知 —— 读不到不等于余额是 0。`
            : '尚未读取到余额。点主区的「刷新全部」向交易所重新查询。'}
        </p>
      )}
      {liveTotals.counted + testnetTotals.counted > 0 && failedReads > 0 && (
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
          {failedReads} 个凭证读取失败，未计入合计。
        </p>
      )}
      {skippedAssets > 0 && (
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
          {skippedAssets} 个凭证以其他币种计价，未计入合计（混币相加没有意义）。
        </p>
      )}
    </div>
  );
}

export function SupportedExchangesPanel({
  exchanges,
  onAdd,
}: {
  exchanges: ExchangeOption[];
  onAdd: (exchangeId: ExchangeId) => void;
}) {
  if (exchanges.length <= 1) return null;
  return (
    <Panel title="支持的交易所" bodyClassName="p-0">
      <ul className="divide-y divide-base-800">
        {exchanges.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-base-700 bg-base-800 text-ink-lo">
              <Landmark aria-hidden className="h-3 w-3" />
            </span>
            <span className="min-w-0 truncate text-base text-ink-hi">{row.label}</span>
            <Badge tone="muted">{row.market}</Badge>
            {!row.available && <Badge tone="warn">联调中</Badge>}
            <span className="ml-auto">
              <Button
                size="sm"
                variant="ghost"
                title={
                  row.available
                    ? `添加一个「${row.label}」凭证 —— 对话框里会预选它`
                    : `${row.label} 正在接入联调：可以先把凭证保存进来，机器人交易前请确认后端已支持`
                }
                onClick={() => onAdd(row.id)}
              >
                <Plus aria-hidden className="h-3.5 w-3.5" />
                添加
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
