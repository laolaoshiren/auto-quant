import { Landmark, Pencil, RotateCw, Trash2, Wifi } from 'lucide-react';
import type { ExchangeAccountRow, PreflightCheck } from '../../lib/api';
import { Badge, Button, Collapsible, ErrorNote, cn } from '../ui';
import { CheckList } from '../Badges';
import {
  DEFAULT_SETTLE_ASSET,
  fmtAmount,
  fmtDateTime,
  fmtTime,
  timeAgo,
  tradingEnvLabel,
  tradingEnvTitle,
} from '../../lib/format';
import type { FreshRead } from './ExchangeBalanceRail';

export function checksPassed(checks: PreflightCheck[]): boolean {
  return checks.every((check) => check.ok || !check.blocking);
}

function severityOf(check: PreflightCheck): 'ok' | 'warn' | 'error' {
  return check.severity ?? (check.ok ? 'ok' : check.blocking ? 'error' : 'warn');
}

function countBy(checks: PreflightCheck[], severity: 'ok' | 'warn' | 'error'): number {
  return checks.filter((check) => severityOf(check) === severity).length;
}

export interface TestOutcome {
  at: number;
  checks: PreflightCheck[];
  error: string | null;
}

export function ExchangeAccountCard({
  row,
  exchangeLabel,
  fresh,
  outcome,
  testOpen,
  testing,
  refreshing,
  onTest,
  onEdit,
  onRemove,
  onRefresh,
  onToggleTest,
}: {
  row: ExchangeAccountRow;
  exchangeLabel: string;
  fresh: FreshRead | undefined;
  outcome: TestOutcome | undefined;
  testOpen: boolean | undefined;
  testing: boolean;
  refreshing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onRefresh: () => void;
  onToggleTest: (open: boolean) => void;
}) {
  const passed = outcome ? checksPassed(outcome.checks) : false;
  const balance = fresh ? (fresh.result.ok ? fresh.result.balance : null) : row.balance;
  const balanceError = fresh ? (fresh.result.ok ? null : fresh.result.error) : row.balanceError;
  const asset = balance?.asset?.trim() || DEFAULT_SETTLE_ASSET;
  const testedAtLabel = (
    <span className="num text-xs text-ink-faint">
      测试于 {outcome ? fmtTime(new Date(outcome.at).toISOString()) : '—'}
    </span>
  );

  return (
    <li className="overflow-hidden rounded-xl border border-base-750 bg-base-900 transition hover:border-base-600">
      {/* 紧凑单行顶栏：图标 + 名称 + 标签 + 快捷动作 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-base-800 bg-base-850/60 px-3 py-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-base-700 bg-base-800 text-ink-lo">
          <Landmark aria-hidden className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 truncate text-sm font-bold text-ink-hi" title={row.label}>
          {row.label}
        </span>
        <Badge tone="accent">{exchangeLabel.replace(/ USDT 本位合约/, '')}</Badge>
        <Badge tone={row.testnet ? 'muted' : 'warn'} title={tradingEnvTitle(row.testnet)}>
          {tradingEnvLabel(row.testnet, 'short')}
        </Badge>
        {row.canTrade ? <Badge tone="up">可下单</Badge> : <Badge tone="warn">只读</Badge>}

        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            busy={refreshing}
            onClick={onRefresh}
            aria-label={`刷新 ${row.label} 余额`}
            title="强制向交易所刷新该凭证余额"
          >
            <RotateCw aria-hidden className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            busy={testing}
            onClick={onTest}
            title="用已保存密钥向交易所发起只读连通探测"
          >
            <Wifi aria-hidden className="h-3 w-3" />
            测试
          </Button>
          <Button size="icon" variant="ghost" onClick={onEdit} aria-label={`编辑 ${row.label}`} title="编辑凭证">
            <Pencil aria-hidden className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="danger"
            onClick={onRemove}
            aria-label={`删除凭证 ${row.label}`}
            title="删除该凭证"
          >
            <Trash2 aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </span>
      </div>

      {/* 横向 4 格紧凑资产栏（告别旧版纵向大段留白） */}
      <div className="px-3 py-2.5">
        {balance ? (
          <div className="grid grid-cols-2 gap-2 rounded-lg bg-base-950/55 px-3 py-2 sm:grid-cols-4">
            <div className="min-w-0">
              <div className="text-[11px] text-ink-faint">账户权益 ({asset})</div>
              <div className="num mt-0.5 truncate text-base font-bold text-ink-strong">
                {fmtAmount(balance.equity)}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-ink-faint">钱包余额</div>
              <div className="num mt-0.5 truncate text-sm font-semibold text-ink-hi">
                {fmtAmount(balance.walletBalance)}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-ink-faint">可用余额</div>
              <div className="num mt-0.5 truncate text-sm font-semibold text-ink-mid">
                {fmtAmount(balance.availableBalance)}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-ink-faint">未实现盈亏</div>
              <div
                className={cn(
                  'num mt-0.5 truncate text-sm font-semibold',
                  balance.unrealizedPnl > 0
                    ? 'text-up'
                    : balance.unrealizedPnl < 0
                      ? 'text-down'
                      : 'text-ink-lo',
                )}
              >
                {balance.unrealizedPnl > 0 ? '+' : ''}
                {fmtAmount(balance.unrealizedPnl)}
              </div>
            </div>
          </div>
        ) : balanceError ? (
          <div className="rounded-lg border border-warn/35 bg-warn/10 px-2.5 py-2 text-xs text-warn">
            余额读取失败：{balanceError}
          </div>
        ) : (
          <div className="rounded-lg bg-base-950/40 px-3 py-2 text-xs text-ink-faint">
            尚未读取到余额，点击右上角刷新按钮立即查询。
          </div>
        )}
      </div>

      {/* 极简底部元信息 */}
      <div className="num flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-base-800/80 bg-base-850/35 px-3 py-1.5 text-[11px] text-ink-faint">
        <span>
          Key <span className="text-ink-mid">{row.apiKeyMasked || '—'}</span>
        </span>
        <span title={`添加于 ${fmtDateTime(row.createdAt)} · 更新于 ${fmtDateTime(row.updatedAt)}`}>
          {balance ? `同步于 ${timeAgo(balance.readAt)}（${fmtTime(balance.readAt)}）` : '未同步'}
        </span>
      </div>

      {outcome && (
        <div className="px-3 pb-3">
          <Collapsible
            open={testOpen ?? !passed}
            onOpenChange={onToggleTest}
            meta={testedAtLabel}
            title={
              <span className="flex flex-wrap items-center gap-2">
                <span>连接测试</span>
                <Badge tone={passed ? 'up' : 'down'}>{passed ? '通过' : '未通过'}</Badge>
                <span className="num text-xs text-ink-lo">
                  {countBy(outcome.checks, 'ok')} 通过 · {countBy(outcome.checks, 'error')} 失败 ·{' '}
                  {countBy(outcome.checks, 'warn')} 待确认
                </span>
              </span>
            }
          >
            {outcome.error && <ErrorNote className="mb-2">{outcome.error}</ErrorNote>}
            <CheckList checks={outcome.checks} />
          </Collapsible>
        </div>
      )}
    </li>
  );
}
