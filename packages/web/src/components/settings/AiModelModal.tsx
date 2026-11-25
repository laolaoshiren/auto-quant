import { useEffect, useMemo, useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, TriangleAlert, X } from 'lucide-react';
import { authStyleLabel, jsonModeLabel } from '@aq/shared';
import type {
  AiModelRow,
  Catalog,
  DiscoveredModel,
  DiscoverModelsResult,
  ModelTestResult,
} from '../../lib/api';
import { Badge, Button, Field, Modal, Select, TextInput, cn } from '../ui';
import { fmtInt, fmtLatency } from '../../lib/format';
import { SecretChip } from './AiModelRow';

export interface ModelDraft {
  provider: string;
  label: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

/** 选择器里最多渲染多少个模型（搜索为先）。 */
const PICKER_LIMIT = 200;

export function emptyDraft(providerId: string, label: string, baseUrl: string): ModelDraft {
  return {
    provider: providerId,
    label,
    model: '',
    baseUrl,
    apiKey: '',
  };
}

type ProviderDescriptor = Catalog['providers'][number];

export function AiModelModal({
  open,
  editing,
  draft,
  providers,
  descriptor,
  discovery,
  discovering,
  draftTest,
  testingDraft,
  busy,
  onClose,
  onApplyProvider,
  onChangeDraft,
  onClearDiscoveryAndTest,
  onClearDraftTest,
  onDiscover,
  onTestDraft,
  onSubmit,
}: {
  open: boolean;
  editing: AiModelRow | null;
  draft: ModelDraft;
  providers: ProviderDescriptor[];
  descriptor: ProviderDescriptor | undefined;
  discovery: DiscoverModelsResult | null;
  discovering: boolean;
  draftTest: ModelTestResult | null;
  testingDraft: boolean;
  busy: boolean;
  onClose: () => void;
  onApplyProvider: (providerId: string) => void;
  onChangeDraft: (updater: (current: ModelDraft) => ModelDraft) => void;
  onClearDiscoveryAndTest: () => void;
  onClearDraftTest: () => void;
  onDiscover: () => void;
  onTestDraft: () => void;
  onSubmit: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `编辑“${editing.label}”` : '添加 AI 模型'}
      description="密钥只会以密文存入服务端；接口从不回传明文，编辑时留空即保留原密钥。"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" busy={testingDraft} onClick={onTestDraft}>
            测试连接
          </Button>
          <span className="mr-auto text-xs text-ink-faint">
            {draftTest ? (draftTest.ok ? '连接正常' : '连接测试未通过') : '保存前建议先测一次。'}
          </span>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" busy={busy} onClick={onSubmit}>
            {editing ? '保存模型' : '添加模型'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2">
          <Field
            label="供应商"
            hint={descriptor ? (descriptor.openAiCompatible ? 'OpenAI 兼容 API' : `原生 ${descriptor.authStyle} 鉴权`) : undefined}
          >
            <Select value={draft.provider} onChange={(event) => onApplyProvider(event.target.value)}>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="名称" hint="在机器人列表与审计记录中的显示名称。">
            <TextInput
              value={draft.label}
              onChange={(event) => onChangeDraft((current) => ({ ...current, label: event.target.value }))}
              placeholder={descriptor?.label}
            />
          </Field>

          <div className="md:col-span-2">
            <Field
              label="API Key"
              hint={
                editing
                  ? '留空则保留已存储的密钥。接口永远不会以明文返回它。'
                  : '静态存储时加密；返回的始终只是掩码形式。'
              }
            >
              <TextInput
                type="password"
                className="num"
                value={draft.apiKey}
                onChange={(event) => {
                  onChangeDraft((current) => ({ ...current, apiKey: event.target.value }));
                  onClearDiscoveryAndTest();
                }}
                placeholder={editing ? editing.apiKeyMasked || '••••••••' : 'sk-…'}
                autoComplete="new-password"
                spellCheck={false}
              />
            </Field>
            {editing && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-ink-lo">当前已存储：</span>
                <SecretChip hasKey={editing.hasKey} masked={editing.apiKeyMasked} />
                <span className="text-xs text-ink-faint">留空不会改动它。</span>
              </div>
            )}
          </div>

          <div className="md:col-span-2">
            <ModelField
              descriptor={descriptor}
              draft={draft}
              discovery={discovery}
              discovering={discovering}
              hasStoredKey={editing?.hasKey ?? false}
              onDiscover={onDiscover}
              onPick={(id) => {
                onChangeDraft((current) => ({ ...current, model: id }));
                onClearDraftTest();
              }}
              onType={(id) => {
                onChangeDraft((current) => ({ ...current, model: id }));
                onClearDraftTest();
              }}
            />
          </div>

          <div className="md:col-span-2">
            <Field
              label="基础 URL"
              hint={
                descriptor?.docsUrl
                  ? `已按供应商预填。文档：${descriptor.docsUrl}`
                  : '自定义 OpenAI 兼容端点必须填写。'
              }
            >
              <TextInput
                className="num"
                value={draft.baseUrl}
                onChange={(event) => {
                  onChangeDraft((current) => ({ ...current, baseUrl: event.target.value }));
                  onClearDiscoveryAndTest();
                }}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
              />
            </Field>
          </div>
        </div>

        {draftTest && (
          <div
            role="status"
            className={cn(
              'rounded-md border px-3 py-2.5',
              draftTest.ok ? 'border-up/50 bg-up/10' : 'border-down/50 bg-down/10',
            )}
          >
            {draftTest.ok ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
                <Badge tone="up">
                  <Check aria-hidden className="h-3 w-3" />
                  连接成功
                </Badge>
                <span className="num text-ink-mid">延迟 {fmtLatency(draftTest.latencyMs)}</span>
                {draftTest.modelEcho && (
                  <span className="num text-ink-lo">回显模型 id {draftTest.modelEcho}</span>
                )}
              </div>
            ) : (
              <div className="min-w-0">
                <Badge tone="down">
                  <X aria-hidden className="h-3 w-3" />
                  连接失败
                </Badge>
                <p className="mt-1 break-words text-base leading-relaxed text-down">{draftTest.message}</p>
                <p className="mt-1 text-xs text-ink-lo">
                  按顺序检查：API Key 是否正确、基础 URL 是否能从本机访问、模型 id 是否在该账号可用。
                </p>
              </div>
            )}
          </div>
        )}

        {descriptor && (
          <div className="rounded-md border border-base-800 bg-base-850/40 px-3 py-2 text-xs text-ink-lo">
            鉴权 <span className="text-ink-mid">{authStyleLabel(descriptor.authStyle)}</span> ·{' '}
            <span className="text-ink-mid">{jsonModeLabel(descriptor.jsonMode)}</span>
            {descriptor.docsUrl && (
              <>
                {' · '}
                <a href={descriptor.docsUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  供应商文档 ↗
                </a>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * The model id field is *always* a free-text input — the fetched list is only a
 * picker that fills it. Uses Radix Popover for Escape close and focus return.
 */
function ModelField({
  descriptor,
  draft,
  discovery,
  discovering,
  hasStoredKey,
  onDiscover,
  onPick,
  onType,
}: {
  descriptor: { label: string; models: string[]; docsUrl?: string } | undefined;
  draft: ModelDraft;
  discovery: DiscoverModelsResult | null;
  discovering: boolean;
  /** 服务端是否已为该模型存有密钥（`AiModelRow.hasKey`）。 */
  hasStoredKey: boolean;
  onDiscover: () => void;
  onPick: (id: string) => void;
  onType: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setSearch('');
  }, [discovery]);

  const entries: DiscoveredModel[] = useMemo(() => {
    if (discovery) return discovery.models;
    return (descriptor?.models ?? []).map((id) => ({ id, discovered: false }));
  }, [discovery, descriptor]);

  const live = discovery?.source === 'live';
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = term ? entries.filter((m) => m.id.toLowerCase().includes(term)) : entries;
    return list.slice(0, PICKER_LIMIT);
  }, [entries, search]);

  const hasUsableKey = hasStoredKey || draft.apiKey.trim().length > 0;
  const warning = !discovery
    ? !hasUsableKey
      ? '请先填写 API Key，然后再获取模型列表。'
      : entries.length === 0
        ? '点「获取可用模型」向接口询问该密钥可用的模型列表；也可以直接在输入框中手动填写模型 id。'
        : null
    : null;

  return (
    <div className="min-w-0">
      <Field label="模型" hint="可以直接输入 id；「获取可用模型」会向接口询问该密钥可用的列表。">
        <TextInput
          className="num"
          value={draft.model}
          onChange={(event) => onType(event.target.value)}
          placeholder="deepseek-chat"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          busy={discovering}
          onClick={onDiscover}
          title="用当前供应商、基础 URL 与 API Key 请求模型列表"
        >
          获取可用模型
        </Button>

        <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
          <PopoverPrimitive.Trigger asChild>
            <Button variant="ghost" size="sm" disabled={entries.length === 0}>
              {open ? '收起列表' : `选择（${fmtInt(entries.length)}）`}
            </Button>
          </PopoverPrimitive.Trigger>
          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
              align="start"
              sideOffset={4}
              className="z-50 w-[min(30rem,90vw)] overflow-hidden rounded-md border border-base-600 bg-base-900 shadow-overlay"
            >
              <div className="flex items-center gap-2 border-b border-base-800 px-2 py-1.5">
                <TextInput
                  className="h-7 py-0 text-xs"
                  placeholder={entries.length > 20 ? `在 ${fmtInt(entries.length)} 个模型中搜索…` : '搜索模型…'}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-label="搜索模型 id"
                  autoFocus
                />
                <Badge tone={live ? 'up' : 'muted'}>{live ? '实时' : '内置建议'}</Badge>
              </div>

              {filtered.length === 0 ? (
                <p className="px-3 py-3 text-xs text-ink-faint">
                  没有匹配「{search}」的模型 — 仍可直接在输入框中手动填写 id。
                </p>
              ) : (
                <div className="max-h-56 overflow-y-auto">
                  {filtered.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => {
                        onPick(entry.id);
                        setOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left transition hover:bg-accent/10',
                        draft.model === entry.id && 'bg-accent/10',
                      )}
                    >
                      <span className="min-w-0">
                        <span className="num block truncate text-sm text-ink-hi">{entry.id}</span>
                        {entry.label && entry.label !== entry.id && (
                          <span className="block truncate text-xs text-ink-faint">{entry.label}</span>
                        )}
                      </span>
                      <span className="num shrink-0 text-xs text-ink-faint">
                        {entry.contextLength ? `上下文 ${fmtInt(entry.contextLength)}` : ''}
                        {!entry.discovered ? ' · 建议' : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <p className="num border-t border-base-800 px-2.5 py-1.5 text-xs text-ink-faint">
                共 {fmtInt(entries.length)} 个{live ? '' : '（内置建议）'}，显示 {fmtInt(filtered.length)} 个
                {entries.length > PICKER_LIMIT && ` · 用搜索收窄`}。
              </p>
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
      </div>

      {warning && (
        <p className="mt-1.5 flex items-start gap-1 text-xs leading-relaxed text-warn">
          <TriangleAlert aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
          {warning}
        </p>
      )}

      {discovery && (
        <div
          className={cn(
            'mt-1.5 rounded-md border px-2.5 py-1.5 text-xs leading-relaxed',
            discovery.ok ? 'border-up/40 bg-up/10 text-up' : 'border-warn/50 bg-warn/10 text-warn',
          )}
        >
          {discovery.ok ? '✓ ' : '⚠ '}
          {discovery.message}
          {!discovery.ok && entries.length > 0 && (
            <>
              {' 下方列表为内置建议，并非实时结果。'}
              {'这些名字会随时间过期，请以官方文档为准。'}
              {descriptor?.docsUrl && (
                <>
                  {' '}
                  <a
                    href={descriptor.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-dotted underline-offset-2"
                  >
                    查看官方文档
                  </a>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
