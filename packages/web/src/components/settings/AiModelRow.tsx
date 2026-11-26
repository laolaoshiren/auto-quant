import { memo } from 'react';
import { Check, Lock, Star, X } from 'lucide-react';
import type { AiModelRow, ModelTestResult } from '../../lib/api';
import { Badge, Button, Spinner } from '../ui';
import { fmtInt, fmtLatency } from '../../lib/format';

export type ModelTestSnapshot = ModelTestResult & { at: number };

/**
 * 密钥单元格。
 * 只接受掩码，不接受明文密钥，没有任何路径能渲染完整密钥。
 */
export function SecretChip({ hasKey, masked }: { hasKey: boolean; masked: string }) {
  if (!hasKey) {
    return (
      <span className="text-base text-ink-faint" title="该模型没有存储密钥（仅适用于本地或免鉴权端点）">
        无密钥
      </span>
    );
  }
  return (
    <span
      className="num inline-flex items-center gap-1 rounded border border-base-700 bg-base-800 px-1.5 py-px text-xs text-ink-lo"
      title="密钥只以掩码形式返回，界面与接口都无法取出明文"
    >
      <Lock aria-hidden className="h-3 w-3 shrink-0" />
      {masked || '••••••••'}
    </span>
  );
}

/**
 * 把接口带回来的 `health` 快照转成 `TestOutcome` 认识的结果。
 * 被取消（abort）是"没有结论"，不当成连接失败。
 */
export function healthToResult(health: AiModelRow['health']): ModelTestSnapshot | undefined {
  if (!health) return undefined;
  if (/abort/i.test(String(health.error ?? ''))) return undefined;
  const at = Date.parse(String(health.at));
  return {
    ok: health.ok,
    message: health.error ?? '',
    latencyMs: health.latencyMs ?? 0,
    at: Number.isFinite(at) ? at : Date.now(),
  };
}

const TestOutcome = memo(function TestOutcome({
  testing,
  result,
}: {
  testing: boolean;
  result?: ModelTestSnapshot;
}) {
  if (testing) {
    return (
      <span className="flex items-center gap-1.5 text-base text-accent">
        <Spinner />
        正在测试…
      </span>
    );
  }
  if (!result) return <span className="text-base text-ink-faint">从未测试</span>;

  const at = new Date(result.at).toLocaleTimeString('en-GB', { hour12: false });
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={result.ok ? 'up' : 'down'}>
          {result.ok ? <Check aria-hidden className="h-3 w-3" /> : <X aria-hidden className="h-3 w-3" />}
          {result.ok ? '连接正常' : '连接失败'}
        </Badge>
        <span className="num text-xs text-ink-lo">{fmtLatency(result.latencyMs)}</span>
        <span className="num text-xs text-ink-faint">{at}</span>
      </div>
      {result.modelEcho && (
        <div className="num mt-0.5 truncate text-xs text-ink-faint" title={result.modelEcho}>
          回显 {result.modelEcho}
        </div>
      )}
      {!result.ok && (
        <div className="mt-0.5 line-clamp-2 break-words text-xs leading-relaxed text-down" title={result.message}>
          {result.message}
        </div>
      )}
    </div>
  );
});

export interface ModelRowProps {
  row: AiModelRow;
  /** 供应商的中文名（来自目录）。缺目录时退回机器码。 */
  providerLabel: string;
  /** 供应商默认推理参数；用来判断这一行是否被调过参。 */
  defaults?: { temperature: number; maxTokens: number; timeoutSeconds: number; maxRetries: number };
  result?: ModelTestSnapshot;
  testing: boolean;
  removing: boolean;
  /** 新建机器人时会不会预选这一行。 */
  isDefault: boolean;
  onTest: (row: AiModelRow) => void;
  onEdit: (row: AiModelRow) => void;
  onSetDefault: (row: AiModelRow) => void;
  onRemove: (row: AiModelRow) => void;
}

/** 一行已配置 AI 模型（memo：测试单行连接只重渲染那一行）。 */
export const ModelRow = memo(function ModelRow({
  row,
  providerLabel,
  defaults,
  result,
  testing,
  removing,
  isDefault,
  onTest,
  onEdit,
  onSetDefault,
  onRemove,
}: ModelRowProps) {
  const params = `温度 ${row.temperature} · ${fmtInt(row.maxTokens)} tok · ${row.timeoutSeconds}s · 重试 ${row.maxRetries}`;
  const tuned =
    defaults !== undefined &&
    (row.temperature !== defaults.temperature ||
      row.maxTokens !== defaults.maxTokens ||
      row.timeoutSeconds !== defaults.timeoutSeconds ||
      row.maxRetries !== defaults.maxRetries);

  return (
    <tr className="row-hover" title={params}>
      <td className="td max-w-[240px] px-2 py-1.5">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-ink-hi" title={row.label}>
            {row.label}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-xs text-ink-faint">
            <span className="shrink-0 text-ink-lo">{providerLabel}</span>
            {tuned && (
              <span className="shrink-0 text-warn" title={`已偏离供应商默认值：${params}`}>
                · 已调参
              </span>
            )}
          </div>
        </div>
      </td>
      <td className="td num max-w-[260px] px-2 py-1.5">
        <div className="truncate text-ink-mid" title={row.model}>
          {row.model}
        </div>
        <div className="truncate text-xs text-ink-faint" title={row.baseUrl || '—'}>
          {row.baseUrl || '—'}
        </div>
      </td>
      <td className="td hidden px-2 py-1.5 2xl:table-cell">
        <SecretChip hasKey={row.hasKey} masked={row.apiKeyMasked} />
      </td>
      <td className="td hidden max-w-[220px] px-2 py-1.5 xl:table-cell">
        <TestOutcome testing={testing} result={result} />
      </td>
      <td className="td whitespace-nowrap px-2 py-1.5 text-right">
        <div className="flex items-center justify-end gap-1">
          <Button small variant="ghost" busy={testing} onClick={() => onTest(row)} title="发送一次最小补全请求">
            测试
          </Button>
          <Button small onClick={() => onEdit(row)}>
            编辑
          </Button>
          {isDefault ? (
            <Badge tone="accent" title="新建机器人时会预选这个模型">
              默认
            </Badge>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              aria-label={`将 ${row.label} 设为默认模型`}
              title="新建机器人时预选这个模型（而不是列表里的第一个）"
              onClick={() => onSetDefault(row)}
            >
              <Star aria-hidden className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="danger"
            busy={removing}
            aria-label={`删除模型 ${row.label}`}
            title="删除模型"
            onClick={() => onRemove(row)}
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  );
});

/** 移动端结构化卡片视图（< md），名称/状态、模型与端点、操作按钮清晰分层，绝不重叠。 */
export const ModelCard = memo(function ModelCard({
  row,
  providerLabel,
  defaults,
  result,
  testing,
  removing,
  isDefault,
  onTest,
  onEdit,
  onSetDefault,
  onRemove,
}: ModelRowProps) {
  const params = `温度 ${row.temperature} · ${fmtInt(row.maxTokens)} tok · ${row.timeoutSeconds}s · 重试 ${row.maxRetries}`;
  const tuned =
    defaults !== undefined &&
    (row.temperature !== defaults.temperature ||
      row.maxTokens !== defaults.maxTokens ||
      row.timeoutSeconds !== defaults.timeoutSeconds ||
      row.maxRetries !== defaults.maxRetries);

  return (
    <div className="space-y-2 px-3 py-2.5" title={params}>
      {/* 顶部：名称 + 状态标签 */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="break-words text-base font-semibold text-ink-hi">{row.label}</span>
            {isDefault && (
              <Badge tone="accent" title="新建机器人时会预选这个模型">
                默认
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-faint">
            <span className="text-ink-lo">{providerLabel}</span>
            {tuned && <span className="text-warn">· 已调参</span>}
            <SecretChip hasKey={row.hasKey} masked={row.apiKeyMasked} />
          </div>
        </div>
      </div>

      {/* 中间：模型 ID 与端点地址独立分行且 break-all */}
      <div className="space-y-1 rounded-md border border-base-800/80 bg-base-950/60 px-2.5 py-2 text-xs">
        <div className="flex items-start gap-2">
          <span className="shrink-0 text-ink-faint">模型</span>
          <span className="num min-w-0 break-all text-ink-mid">{row.model}</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="shrink-0 text-ink-faint">端点</span>
          <span className="num min-w-0 break-all text-ink-faint">{row.baseUrl || '—'}</span>
        </div>
      </div>

      {/* 最近测试状态 */}
      <div>
        <TestOutcome testing={testing} result={result} />
      </div>

      {/* 底部：整行操作按钮 */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-base-800/70 pt-2">
        <Button small variant="ghost" busy={testing} onClick={() => onTest(row)} title="发送一次最小补全请求">
          测试
        </Button>
        <Button small onClick={() => onEdit(row)}>
          编辑
        </Button>
        {!isDefault && (
          <Button
            small
            variant="ghost"
            aria-label={`将 ${row.label} 设为默认模型`}
            title="新建机器人时预选这个模型"
            onClick={() => onSetDefault(row)}
          >
            <Star aria-hidden className="h-3.5 w-3.5" />
            默认
          </Button>
        )}
        <Button
          small
          variant="danger"
          className="ml-auto"
          busy={removing}
          aria-label={`删除模型 ${row.label}`}
          title="删除模型"
          onClick={() => onRemove(row)}
        >
          <X aria-hidden className="h-3.5 w-3.5" />
          删除
        </Button>
      </div>
    </div>
  );
});
