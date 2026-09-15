import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type AiModelRow,
  type DiscoveredModel,
  type DiscoverModelsResult,
  type ModelTestResult,
} from '../../lib/api';
import { useApp } from '../../lib/store';
import { usePolled } from '../../lib/hooks';
import { Badge, Button, Empty, ErrorNote, Field, Modal, NumberInput, Panel, Select, Spinner3, TextInput } from '../ui';
import { fmtDateTime, fmtInt, fmtLatency } from '../../lib/format';

/* -------------------------------------------------------------------------- */
/*  Draft                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The five things a user actually has to decide, plus the four inference knobs
 * that are pre-filled from the provider catalogue and collapsed behind
 * 「高级设置」. `touched` records which advanced fields the operator edited, so
 * the payload can omit the rest and let the server apply provider defaults.
 */
interface ModelDraft {
  provider: string;
  label: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
  maxRetries: number;
}

const FALLBACK_DEFAULTS = { temperature: 0.2, maxTokens: 8192, timeoutSeconds: 180, maxRetries: 2 };

type AdvancedKey = 'temperature' | 'maxTokens' | 'timeoutSeconds' | 'maxRetries';

function emptyDraft(providerId: string, label: string, baseUrl: string): ModelDraft {
  return {
    provider: providerId,
    label,
    model: '',
    baseUrl,
    apiKey: '',
    temperature: FALLBACK_DEFAULTS.temperature,
    maxTokens: FALLBACK_DEFAULTS.maxTokens,
    timeoutSeconds: FALLBACK_DEFAULTS.timeoutSeconds,
    maxRetries: FALLBACK_DEFAULTS.maxRetries,
  };
}

/* -------------------------------------------------------------------------- */
/*  Section                                                                    */
/* -------------------------------------------------------------------------- */

export function AiModelsSection() {
  const catalog = useApp((s) => s.catalog);
  const query = usePolled((signal) => api.aiModels(signal), { intervalMs: 30_000 });

  const [editing, setEditing] = useState<AiModelRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ModelDraft>(() => emptyDraft('deepseek', '', ''));
  const [touched, setTouched] = useState<Set<AdvancedKey>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<number, ModelTestResult & { at: number }>>({});
  const [testingId, setTestingId] = useState<number | null>(null);
  const [discovery, setDiscovery] = useState<DiscoverModelsResult | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [draftTest, setDraftTest] = useState<ModelTestResult | null>(null);
  const [testingDraft, setTestingDraft] = useState(false);

  const models = query.data ?? [];
  const providers = catalog?.providers ?? [];

  const descriptor = providers.find((p) => p.id === draft.provider);
  const defaults = descriptor?.defaults ?? FALLBACK_DEFAULTS;

  const openCreate = () => {
    const first = providers[0];
    const builtin = first?.models[0] ?? '';
    setDraft({ ...emptyDraft(first?.id ?? 'deepseek', first?.label ?? '', first?.baseUrl ?? ''), model: builtin });
    setTouched(new Set());
    setError(null);
    setDiscovery(null);
    setDraftTest(null);
    setCreating(true);
  };

  const openEdit = (row: AiModelRow) => {
    setDraft({
      provider: row.provider,
      label: row.label,
      model: row.model,
      baseUrl: row.baseUrl,
      apiKey: '',
      temperature: row.temperature,
      maxTokens: row.maxTokens,
      timeoutSeconds: row.timeoutSeconds,
      maxRetries: row.maxRetries,
    });
    // Editing an existing row means every knob is already a deliberate value.
    setTouched(new Set<AdvancedKey>(['temperature', 'maxTokens', 'timeoutSeconds', 'maxRetries']));
    setError(null);
    setDiscovery(null);
    setDraftTest(null);
    setEditing(row);
  };

  const close = () => {
    setCreating(false);
    setEditing(null);
    setDiscovery(null);
    setDraftTest(null);
  };

  /**
   * Switching provider resets the base URL and clears the model, because a
   * model id from another vendor is never valid here. The name only follows the
   * provider while it is still the untouched provider label.
   */
  const applyProvider = (providerId: string) => {
    const next = providers.find((p) => p.id === providerId);
    setDraft((current) => {
      const labelIsDefault = current.label === '' || providers.some((p) => p.label === current.label);
      return {
        ...current,
        provider: providerId,
        label: labelIsDefault ? (next?.label ?? current.label) : current.label,
        baseUrl: next?.baseUrl ?? '',
        model: '',
        temperature: next?.defaults.temperature ?? FALLBACK_DEFAULTS.temperature,
        maxTokens: next?.defaults.maxTokens ?? FALLBACK_DEFAULTS.maxTokens,
        timeoutSeconds: next?.defaults.timeoutSeconds ?? FALLBACK_DEFAULTS.timeoutSeconds,
        maxRetries: next?.defaults.maxRetries ?? FALLBACK_DEFAULTS.maxRetries,
      };
    });
    // Back to "untouched": the new provider's own defaults are the right answer.
    setTouched(new Set());
    setDiscovery(null);
    setDraftTest(null);
    setError(null);
  };

  const setAdvanced = (key: AdvancedKey, value: number) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setTouched((current) => new Set(current).add(key));
  };

  /* --- discovery --------------------------------------------------------- */

  const runDiscover = async () => {
    setDiscovering(true);
    setError(null);
    try {
      const result = await api.discoverModels({
        provider: draft.provider,
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey,
      });
      setDiscovery(result);
    } catch (err) {
      setDiscovery({
        ok: false,
        models: [],
        source: 'fallback',
        message: (err as Error).message,
      });
    } finally {
      setDiscovering(false);
    }
  };

  /* --- draft test -------------------------------------------------------- */

  const buildPayload = () => {
    const payload: Parameters<typeof api.createAiModel>[0] = {
      provider: draft.provider,
      // The server requires a name; the provider label is the natural default.
      label: draft.label.trim() || descriptor?.label || draft.provider,
      model: draft.model.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey,
    };
    // Only the advanced fields the operator actually touched travel with the
    // request — the rest are left to the provider defaults server-side.
    if (touched.has('temperature')) payload.temperature = draft.temperature;
    if (touched.has('maxTokens')) payload.maxTokens = draft.maxTokens;
    if (touched.has('timeoutSeconds')) payload.timeoutSeconds = draft.timeoutSeconds;
    if (touched.has('maxRetries')) payload.maxRetries = draft.maxRetries;
    return payload;
  };

  const runDraftTest = async () => {
    if (!draft.model.trim()) {
      setDraftTest({ ok: false, message: '请先填写或选择一个模型 id，然后再测试。', latencyMs: 0 });
      return;
    }
    setTestingDraft(true);
    setDraftTest(null);
    try {
      setDraftTest(await api.testAiModelDraft(buildPayload()));
    } catch (err) {
      const payload = (err as Error & { payload?: ModelTestResult }).payload;
      setDraftTest({
        ok: false,
        message: payload?.message ?? (err as Error).message,
        latencyMs: payload?.latencyMs ?? 0,
      });
    } finally {
      setTestingDraft(false);
    }
  };

  /* --- submit ------------------------------------------------------------ */

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = buildPayload();
      if (!payload.label || !payload.model) throw new Error('名称与模型 id 为必填项。');

      if (editing) {
        await api.updateAiModel(editing.id, payload);
      } else {
        await api.createAiModel(payload);
      }
      close();
      query.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: AiModelRow) => {
    if (!window.confirm(`删除模型“${row.label}”？`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAiModel(row.id);
      query.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const test = async (row: AiModelRow) => {
    setTestingId(row.id);
    setError(null);
    try {
      const result = await api.testAiModel(row.id);
      setTestResult((current) => ({ ...current, [row.id]: { ...result, at: Date.now() } }));
    } catch (err) {
      const payload = (err as Error & { payload?: ModelTestResult }).payload;
      setTestResult((current) => ({
        ...current,
        [row.id]: {
          ok: false,
          message: payload?.message ?? (err as Error).message,
          latencyMs: payload?.latencyMs ?? 0,
          at: Date.now(),
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="space-y-2">
      {error && <ErrorNote>{error}</ErrorNote>}

      <Panel
        title="已配置模型"
        actions={
          <Button variant="primary" onClick={openCreate} disabled={providers.length === 0}>
            + 添加模型
          </Button>
        }
        padded={false}
      >
        {query.loading && models.length === 0 ? (
          <Spinner3 label="正在加载模型" />
        ) : models.length === 0 ? (
          <Empty
            message="尚未配置任何 AI 模型。"
            hint="交易循环至少需要一个模型来请求决策。先添加一个 — 一个便宜的推理模型就够起步了。"
          />
        ) : (
          <div className="scroll-x">
            <table className="w-full border-collapse">
              <thead className="border-b border-base-800 bg-base-850/60">
                <tr>
                  <th className="th">名称</th>
                  <th className="th">供应商</th>
                  <th className="th">模型</th>
                  <th className="th">基础 URL</th>
                  <th className="th">API Key</th>
                  <th className="th text-right">温度</th>
                  <th className="th text-right">最大 Token</th>
                  <th className="th text-right">超时</th>
                  <th className="th">最近测试</th>
                  <th className="th text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {models.map((row) => {
                  const result = testResult[row.id];
                  return (
                    <tr key={row.id} className="row-hover">
                      <td className="td font-semibold text-ink-hi">{row.label}</td>
                      <td className="td">
                        <Badge tone="accent">{row.provider}</Badge>
                      </td>
                      <td className="td num text-ink-mid">{row.model}</td>
                      <td className="td max-w-[220px] truncate text-ink-faint" title={row.baseUrl}>
                        {row.baseUrl || '—'}
                      </td>
                      <td className="td">
                        <span className="num text-ink-lo">{row.hasKey ? row.apiKeyMasked || '••••' : '无'}</span>
                      </td>
                      <td className="td num text-right">{row.temperature}</td>
                      <td className="td num text-right">{fmtInt(row.maxTokens)}</td>
                      <td className="td num text-right">{row.timeoutSeconds}s</td>
                      <td className="td">
                        {result ? (
                          <span className={result.ok ? 'text-up' : 'text-down'} title={result.message}>
                            {result.ok ? '✓' : '✕'} {fmtLatency(result.latencyMs)}
                            {result.modelEcho ? <span className="text-ink-faint"> · {result.modelEcho}</span> : null}
                          </span>
                        ) : (
                          <span className="text-ink-faint">从未</span>
                        )}
                      </td>
                      <td className="td text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button small variant="ghost" busy={testingId === row.id} onClick={() => void test(row)}>
                            测试
                          </Button>
                          <Button small onClick={() => openEdit(row)}>
                            编辑
                          </Button>
                          <Button small variant="danger" busy={busy} onClick={() => void remove(row)}>
                            ✕
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {models.length > 0 && (
        <p className="text-2xs text-ink-faint">
          “测试”会向该接口发送一次最小补全请求，并报告延迟与它回显的模型 id。它不会启动任何机器人，
          最多只消耗少量 Token。添加时间 {fmtDateTime(models[0]?.createdAt)}。
        </p>
      )}

      <Modal
        open={creating || editing !== null}
        onClose={close}
        title={editing ? `编辑“${editing.label}”` : '添加 AI 模型'}
        width="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" busy={testingDraft} onClick={() => void runDraftTest()}>
              测试连接
            </Button>
            <span className="mr-auto text-2xs text-ink-faint">
              {draftTest
                ? draftTest.ok
                  ? '连接正常'
                  : '连接测试未通过'
                : '保存前建议先测一次。'}
            </span>
            <Button onClick={close}>取消</Button>
            <Button variant="primary" busy={busy} onClick={() => void submit()}>
              {editing ? '保存模型' : '添加模型'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field
              label="供应商"
              hint={descriptor ? (descriptor.openAiCompatible ? 'OpenAI 兼容 API' : `原生 ${descriptor.authStyle} 鉴权`) : undefined}
            >
              <Select value={draft.provider} onChange={(event) => applyProvider(event.target.value)}>
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
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
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
                    setDraft({ ...draft, apiKey: event.target.value });
                    setDiscovery(null);
                    setDraftTest(null);
                  }}
                  placeholder={editing ? editing.apiKeyMasked || '••••••••' : 'sk-…'}
                  autoComplete="off"
                />
              </Field>
            </div>

            <div className="md:col-span-2">
              <ModelField
                descriptor={descriptor}
                draft={draft}
                discovery={discovery}
                discovering={discovering}
                onDiscover={() => void runDiscover()}
                onPick={(id) => {
                  setDraft((current) => ({ ...current, model: id }));
                  setDraftTest(null);
                }}
                onType={(id) => {
                  setDraft((current) => ({ ...current, model: id }));
                  setDraftTest(null);
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
                    setDraft({ ...draft, baseUrl: event.target.value });
                    setDiscovery(null);
                    setDraftTest(null);
                  }}
                  placeholder="https://api.example.com/v1"
                />
              </Field>
            </div>
          </div>

          {/* Draft test result ------------------------------------------- */}
          {draftTest && (
            <div
              className={
                draftTest.ok
                  ? 'rounded border border-up/50 bg-up/10 px-2.5 py-2 text-xs text-up'
                  : 'rounded border border-down/50 bg-down/10 px-2.5 py-2 text-xs text-down'
              }
            >
              {draftTest.ok ? (
                <>
                  <span className="font-semibold">✓ 连接成功</span> · 延迟 {fmtLatency(draftTest.latencyMs)}
                  {draftTest.modelEcho && (
                    <>
                      {' '}
                      · 回显模型 id <span className="num">{draftTest.modelEcho}</span>
                    </>
                  )}
                </>
              ) : (
                <>
                  <span className="font-semibold">✕ 连接失败</span> · {draftTest.message}
                </>
              )}
            </div>
          )}

          {/* Advanced disclosure ----------------------------------------- */}
          <AdvancedSettings
            draft={draft}
            touched={touched}
            defaults={defaults}
            supportsThinking={descriptor?.supportsThinking ?? false}
            onChange={setAdvanced}
            onReset={() => {
              setDraft((current) => ({
                ...current,
                temperature: defaults.temperature,
                maxTokens: defaults.maxTokens,
                timeoutSeconds: defaults.timeoutSeconds,
                maxRetries: defaults.maxRetries,
              }));
              setTouched(new Set());
            }}
          />

          {descriptor && (
            <div className="rounded border border-base-800 bg-base-850/40 px-2.5 py-1.5 text-2xs text-ink-lo">
              鉴权方式 <span className="num text-ink-mid">{descriptor.authStyle}</span> · JSON 模式{' '}
              <span className="num text-ink-mid">{descriptor.jsonMode}</span>
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
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Model picker                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The model id field is *always* a free-text input — the fetched list is only a
 * picker that fills it. Discovery can fail (wrong key, no key, endpoint down),
 * and when it does the response still carries the provider's built-in hints,
 * clearly labelled as suggestions rather than live results.
 */
function ModelField({
  descriptor,
  draft,
  discovery,
  discovering,
  onDiscover,
  onPick,
  onType,
}: {
  descriptor: { label: string; models: string[] } | undefined;
  draft: ModelDraft;
  discovery: DiscoverModelsResult | null;
  discovering: boolean;
  onDiscover: () => void;
  onPick: (id: string) => void;
  onType: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // A stale search term from a previous provider would hide every new result.
  useEffect(() => {
    setSearch('');
  }, [discovery]);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, [open]);

  const entries: DiscoveredModel[] = useMemo(() => {
    if (discovery) return discovery.models;
    // Before a fetch, fall back to the provider's built-in hints so the operator
    // is never staring at an empty picker.
    return (descriptor?.models ?? []).map((id) => ({ id, discovered: false }));
  }, [discovery, descriptor]);

  const live = discovery?.source === 'live';
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = term ? entries.filter((m) => m.id.toLowerCase().includes(term)) : entries;
    return list.slice(0, 300);
  }, [entries, search]);

  // Built-in list empty *and* no key yet: say so instead of showing a void.
  const needsKey = !discovery && entries.length === 0;

  return (
    <div ref={boxRef} className="relative">
      <Field
        label="模型"
        hint="可以直接输入 id；「获取可用模型」会向接口询问该密钥可用的列表。"
        error={null}
      >
        <div className="flex items-stretch gap-1.5">
          <TextInput
            className="num"
            value={draft.model}
            onChange={(event) => onType(event.target.value)}
            placeholder="deepseek-chat"
            autoComplete="off"
          />
          <Button
            variant="ghost"
            busy={discovering}
            className="shrink-0"
            onClick={onDiscover}
            title="用当前供应商、基础 URL 与 API Key 请求模型列表"
          >
            获取可用模型
          </Button>
          {entries.length > 0 && (
            <Button variant="ghost" className="shrink-0" onClick={() => setOpen((v) => !v)}>
              {open ? '收起' : `选择（${entries.length}）`}
            </Button>
          )}
        </div>
      </Field>

      {needsKey && (
        <p className="mt-1 text-2xs text-warn">
          该供应商内置建议为空。请先填写 API Key，然后点「获取可用模型」；也可以直接手动输入模型 id。
        </p>
      )}

      {/* Discovery note --------------------------------------------------- */}
      {discovery && (
        <div
          className={
            discovery.ok
              ? 'mt-1.5 rounded border border-up/40 bg-up/10 px-2 py-1 text-2xs text-up'
              : 'mt-1.5 rounded border border-warn/50 bg-warn/10 px-2 py-1 text-2xs text-warn'
          }
        >
          {discovery.ok ? '✓ ' : '⚠ '}
          {discovery.message}
          {!discovery.ok && entries.length > 0 && ' 下方列表为内置建议，并非实时结果。'}
        </div>
      )}

      {/* Picker ----------------------------------------------------------- */}
      {open && entries.length > 0 && (
        <div className="absolute z-30 mt-1 w-full rounded border border-base-600 bg-base-900 shadow-panel">
          <div className="flex items-center gap-2 border-b border-base-800 px-2 py-1.5">
            <TextInput
              className="h-6 py-0 text-2xs"
              placeholder={entries.length > 20 ? `在 ${entries.length} 个模型中搜索…` : '搜索模型…'}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              autoFocus
            />
            <Badge tone={live ? 'up' : 'muted'}>{live ? '实时' : '内置建议'}</Badge>
          </div>
          {filtered.length === 0 ? (
            <p className="px-2 py-2 text-2xs text-ink-faint">
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
                  className={`flex w-full items-center justify-between gap-2 px-2 py-1 text-left transition hover:bg-accent/12 ${
                    draft.model === entry.id ? 'bg-accent/12' : ''
                  }`}
                >
                  <span className="min-w-0">
                    <span className="num block truncate text-xs text-ink-hi">{entry.id}</span>
                    {entry.label && entry.label !== entry.id && (
                      <span className="block truncate text-2xs text-ink-faint">{entry.label}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-2xs text-ink-faint">
                    {entry.contextLength ? `上下文 ${fmtInt(entry.contextLength)}` : ''}
                    {!entry.discovered ? ' · 建议' : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
          <p className="border-t border-base-800 px-2 py-1 text-2xs text-ink-faint">
            共 {entries.length} 个{live ? '' : '（内置建议）'}，显示 {filtered.length} 个。
          </p>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Advanced parameters                                                        */
/* -------------------------------------------------------------------------- */

function AdvancedSettings({
  draft,
  touched,
  defaults,
  supportsThinking,
  onChange,
  onReset,
}: {
  draft: ModelDraft;
  touched: Set<AdvancedKey>;
  defaults: { temperature: number; maxTokens: number; timeoutSeconds: number; maxRetries: number };
  supportsThinking: boolean;
  onChange: (key: AdvancedKey, value: number) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const changed = touched.size;

  return (
    <div className="rounded border border-base-800 bg-base-850/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left transition hover:bg-base-800/60"
      >
        <span className="flex items-center gap-1.5 text-xs text-ink-mid">
          <span className="text-ink-faint">{open ? '▼' : '▶'}</span>
          高级设置
          {changed > 0 && <Badge tone="warn">{changed} 项已修改</Badge>}
        </span>
        <span className="num text-2xs text-ink-faint">
          默认 温度 {defaults.temperature} · Token {fmtInt(defaults.maxTokens)} · 超时 {defaults.timeoutSeconds}s
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-base-800 p-2.5">
          <p className="text-2xs leading-relaxed text-ink-lo">这些参数已按供应商预填，通常无需修改。</p>

          {supportsThinking && (
            <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-2xs leading-relaxed text-warn">
              该供应商支持推理模式：推理过程会消耗输出预算，若「最大输出 Token」设得过低，模型可能思考完就
              没有额度输出决策了。
            </p>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="温度" hint="越低越确定 — 交易场景建议调低。">
              <NumberInput
                value={draft.temperature}
                onValueChange={(value) => onChange('temperature', value)}
                step={0.1}
                min={0}
                max={2}
              />
            </Field>

            <Field label="最大输出 Token" hint="上限 2,000,000。">
              <NumberInput
                value={draft.maxTokens}
                onValueChange={(value) => onChange('maxTokens', value)}
                step={256}
                min={64}
                max={2000000}
              />
            </Field>

            <Field label="超时（秒）">
              <NumberInput
                value={draft.timeoutSeconds}
                onValueChange={(value) => onChange('timeoutSeconds', value)}
                step={10}
                min={5}
                max={3600}
              />
            </Field>

            <Field label="最大重试次数">
              <NumberInput
                value={draft.maxRetries}
                onValueChange={(value) => onChange('maxRetries', value)}
                step={1}
                min={0}
                max={10}
              />
            </Field>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs text-ink-faint">
              未修改的字段不会随请求提交 — 服务端会使用该供应商的默认值。
            </span>
            <Button small onClick={onReset} disabled={changed === 0}>
              恢复供应商默认值
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
