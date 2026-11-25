import { Landmark, RotateCw, Trash2 } from 'lucide-react';
import type { ExchangeAccountRow, PreflightCheck } from '../../lib/api';
import { Badge, Button, Collapsible, ErrorNote } from '../ui';
import { CheckList } from '../Badges';
import { BalanceCell } from '../BalanceCells';
import {
  DEFAULT_SETTLE_ASSET,
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

/** 一次连接测试的结果 + 它发生的时刻。 */
export interface TestOutcome {
  at: number;
  checks: PreflightCheck[];
  error: string | null;
}

function EnvBadge({ testnet, className }: { testnet: boolean; className?: string }) {
  return (
    <Badge tone={testnet ? 'muted' : 'warn'} className={className} title={tradingEnvTitle(testnet)}>
      {tradingEnvLabel(testnet, 'short')}
    </Badge>
  );
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
    <li className="overflow-hidden rounded-lg border border-base-750 bg-base-900 shadow-panel">
      <div className="flex flex-col gap-1.5 border-b border-base-800 bg-base-850/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-base-700 bg-base-800 text-ink-lo">
            <Landmark aria-hidden className="h-3 w-3" />
          </span>
          <span className="min-w-0 flex-1 truncate text-base font-semibold text-ink-hi" title={row.label}>
            {row.label}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              busy={testing}
              onClick={onTest}
              title="用已保存的密钥向交易所发起一次只读探测"
            >
              测试连接
            </Button>
            <Button size="sm" onClick={onEdit}>
              编辑
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={onRemove}
              aria-label={`删除凭证 ${row.label}`}
            >
              <Trash2 aria-hidden className="h-3.5 w-3.5" />
              删除
            </Button>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-7">
          <Badge tone="accent">{exchangeLabel}</Badge>
          <EnvBadge testnet={row.testnet} />
          {row.canTrade ? <Badge tone="up">可下单</Badge> : <Badge tone="warn">只读</Badge>}
        </div>
      </div>

      <div className="px-3 py-2.5">
        <BalanceCell balance={balance} error={balanceError} testnet={row.testnet} />
        {balance && asset !== DEFAULT_SETTLE_ASSET && (
          <p className="mt-0.5 text-xs text-warn">
            该钱包以 {asset} 计价，不会计入左栏的 {DEFAULT_SETTLE_ASSET} 合计。
          </p>
        )}
      </div>

      <div className="num flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-base-800 bg-base-850/40 px-3 py-2 text-xs text-ink-lo">
        <span className="min-w-0">
          API Key <span className="text-ink-mid">{row.apiKeyMasked || '—'}</span>
        </span>
        <span>
          添加于 <span className="text-ink-faint">{fmtDateTime(row.createdAt)}</span>
        </span>
        <span>
          最后更新 <span className="text-ink-faint">{fmtDateTime(row.updatedAt)}</span>
        </span>
        <span className="min-w-0 text-ink-faint">
          {balance
            ? `读取于 ${timeAgo(balance.readAt)}（${fmtTime(balance.readAt)}）`
            : balanceError
              ? '读取未成功'
              : '未读取'}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            busy={refreshing}
            onClick={onRefresh}
            title="向交易所强制重新读取该凭证的余额（绕过服务端缓存）"
          >
            <RotateCw aria-hidden className="h-3.5 w-3.5" />
            刷新
          </Button>
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
                  {countBy(outcome.checks, 'ok')} 项通过 · {countBy(outcome.checks, 'error')} 项失败 ·{' '}
                  {countBy(outcome.checks, 'warn')} 项待确认
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
