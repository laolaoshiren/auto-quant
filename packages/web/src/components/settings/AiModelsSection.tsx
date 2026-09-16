/**
 * AI 模型配置：供应商、端点、密钥、模型清单。
 *
 * 两条硬规则贯穿全文：
 *
 * 1. **密钥永不还原成明文。** 列表里只显示服务端返回的掩码（`apiKeyMasked`，
 *    由 `maskSecret` 生成）；编辑框永远是 `type="password"` 且初值为空 ——
 *    留空即"保留已存储的密钥"，所以浏览器里根本不存在明文可渲染。接口本身
 *    也从不回传明文（见 `/api/ai-models`）。
 * 2. **列表不无上限渲染。** 模型清单可以很长，所以列表页有搜索 + 分批展开，
 *    选择器也有搜索 + 上限。
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, Lock, Search, TriangleAlert, X } from 'lucide-react';
import { authStyleLabel, jsonModeLabel } from '@aq/shared';
import {
  api,
  type AiModelRow,
  type DiscoveredModel,
  type DiscoverModelsResult,
  type ModelTestResult,
} from '../../lib/api';
import { useApp } from '../../lib/store';
import { usePolled } from '../../lib/hooks';
import {
  Badge,
  Button,
  Collapsible,
  Empty,
  ErrorNote,
  Field,
  Modal,
  NumberInput,
  Panel,
  Select,
  Spinner,
  Spinner3,
  TextInput,
  cn,
} from '../ui';
import { SectionLabel } from '../shell';
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

/** 表格首屏渲染多少行；点「显示更多」再追加，避免一次挂几百个 DOM 节点。 */
const ROW_PAGE = 25;
/** 选择器里最多渲染多少个模型（搜索为先）。 */
const PICKER_LIMIT = 200;

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
/*  Secret rendering                                                           */
/* -------------------------------------------------------------------------- */

/**
 * 密钥单元格。
 *
 * 只接受**掩码**。这里的签名刻意不叫 `apiKey` —— 传明文进来在类型上就不可能，
 * 免得以后有人顺手把 `row.apiKey` 接上去。没有任何路径能显示完整密钥。
 */
function SecretChip({ hasKey, masked }: { hasKey: boolean; masked: string }) {
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

/* -------------------------------------------------------------------------- */
/*  Test outcome                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 连接测试结果。
 *
 * 结果必须一眼可辨：图标 + 颜色 + 延迟，失败时把原因整条写出来（截断的
 * `title` 提示对"为什么连不上"没有帮助）。测试进行中也要有独立状态，
 * 否则用户会以为按钮没反应。
 */
const TestOutcome = memo(function TestOutcome({
  testing,
  result,
}: {
  testing: boolean;
  result?: ModelTestResult & { at: number };
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

/* -------------------------------------------------------------------------- */
/*  Row                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 一行模型。
 *
 * 单独抽出来是因为这张表原本把 30 多行 JSX 写在 `models.map` 里，
 * 行内结构（参数、密钥、测试结果）几乎每次改动都要复制一遍。
 * 现在是 `memo` 组件：测试某一行的连接只重渲染那一行。
 *
 * 密度与层级（LAYOUT.md §2/§3）：
 *
 * - **参数不再常驻。** 原来每行都摊着 `温度 · Token · 超时 · 重试` 四段等权重
 *   的数字，等于每一行都在喊同一句话。默认配置是常态，只有**偏离供应商默认值**
 *   时才露一个「已调参」角标；完整参数在行的 `title` 里。
 * - **模型 id 与基础 URL 合成一格。** 它们一起回答"请求发到哪里、要哪个模型"，
 *   分成两列只是把一次阅读拆成两次横向扫视。
 * - 机器码 `provider` 走目录里的中文名，界面不再出现裸的 `deepseek`。
 *
 * ⚠️ **密钥永远只渲染掩码。** `SecretChip` 的签名刻意不接受 `apiKey`，所以
 * 「顺手把 `row.apiKey` 接上去」在类型上就不可能。
 */
const ModelRow = memo(function ModelRow({
  row,
  providerLabel,
  defaults,
  result,
  testing,
  removing,
  onTest,
  onEdit,
  onRemove,
}: {
  row: AiModelRow;
  /** 供应商的中文名（来自目录）。缺目录时退回机器码。 */
  providerLabel: string;
  /** 供应商默认推理参数；用来判断这一行是否被调过参。 */
  defaults?: { temperature: number; maxTokens: number; timeoutSeconds: number; maxRetries: number };
  result?: ModelTestResult & { at: number };
  testing: boolean;
  removing: boolean;
  onTest: (row: AiModelRow) => void;
  onEdit: (row: AiModelRow) => void;
  onRemove: (row: AiModelRow) => void;
}) {
  const params = `温度 ${row.temperature} · ${fmtInt(row.maxTokens)} tok · ${row.timeoutSeconds}s · 重试 ${row.maxRetries}`;
  const tuned =
    defaults !== undefined &&
    (row.temperature !== defaults.temperature ||
      row.maxTokens !== defaults.maxTokens ||
      row.timeoutSeconds !== defaults.timeoutSeconds ||
      row.maxRetries !== defaults.maxRetries);

  return (
    <tr className="row-hover" title={params}>
      <td className="td px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-base font-semibold text-ink-hi">{row.label}</span>
          <Badge tone="accent">{providerLabel}</Badge>
          {tuned && (
            <Badge tone="muted" title={`已偏离供应商默认值：${params}`}>
              已调参
            </Badge>
          )}
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
      <td className="td px-2 py-1.5">
        <SecretChip hasKey={row.hasKey} masked={row.apiKeyMasked} />
      </td>
      <td className="td max-w-[220px] px-2 py-1.5">
        <TestOutcome testing={testing} result={result} />
      </td>
      <td className="td px-2 py-1.5 text-right">
        <div className="flex items-center justify-end gap-1">
          <Button small variant="ghost" busy={testing} onClick={() => onTest(row)} title="发送一次最小补全请求">
            测试
          </Button>
          <Button small onClick={() => onEdit(row)}>
            编辑
          </Button>
          <Button
            small
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

/* -------------------------------------------------------------------------- */
/*  Section                                                                    */
/* -------------------------------------------------------------------------- */

export function AiModelsSection() {
  const catalog = useApp((s) => s.catalog);
  const query = usePolled((signal) => api.aiModels(signal), { intervalMs: 30_000 });
  const reload = query.reload;

  const [editing, setEditing] = useState<AiModelRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ModelDraft>(() => emptyDraft('deepseek', '', ''));
  const [touched, setTouched] = useState<Set<AdvancedKey>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<number, ModelTestResult & { at: number }>>({});
  const [testingId, setTestingId] = useState<number | null>(null);
  const [discovery, setDiscovery] = useState<DiscoverModelsResult | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [draftTest, setDraftTest] = useState<ModelTestResult | null>(null);
  const [testingDraft, setTestingDraft] = useState(false);
  const [filter, setFilter] = useState('');
  const [rowLimit, setRowLimit] = useState(ROW_PAGE);

  const models = query.data ?? [];
  const providers = catalog?.providers ?? [];

  /**
   * 供应商目录按 id 索引。
   *
   * 行里要用的两样东西都从这里来：中文名（否则表格里是裸的 `deepseek`）和默认
   * 推理参数（用来判断某一行是否被调过参）。做成 Map 是因为它按行查、每行两次。
   */
  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);

  const descriptor = providers.find((p) => p.id === draft.provider);
  const defaults = descriptor?.defaults ?? FALLBACK_DEFAULTS;

  /* --- list filtering ---------------------------------------------------- */

  const filtered = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return models;
    return models.filter((row) =>
      [row.label, row.model, row.provider, row.baseUrl].some((field) => field.toLowerCase().includes(term)),
    );
  }, [models, filter]);

  // A new search term must not keep the previous "显示更多" page size.
  useEffect(() => setRowLimit(ROW_PAGE), [filter]);

  const shown = filtered.slice(0, rowLimit);
  const remaining = filtered.length - shown.length;

  /** 最近测试汇总：让"哪些能连上"在表头就能读出来，不用逐行看。 */
  const testedRows = models.filter((row) => testResult[row.id]);
  const testedOk = testedRows.filter((row) => testResult[row.id]?.ok).length;

  /* --- dialogs ----------------------------------------------------------- */

  const openCreate = useCallback(() => {
    const first = providers[0];
    const builtin = first?.models[0] ?? '';
    setDraft({ ...emptyDraft(first?.id ?? 'deepseek', first?.label ?? '', first?.baseUrl ?? ''), model: builtin });
    setTouched(new Set());
    setError(null);
    setDiscovery(null);
    setDraftTest(null);
    setCreating(true);
  }, [providers]);

  const openEdit = useCallback((row: AiModelRow) => {
    setDraft({
      provider: row.provider,
      label: row.label,
      model: row.model,
      baseUrl: row.baseUrl,
      // 永远不从服务端把密钥读回草稿：留空即保留原密钥。
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
  }, []);

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
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = useCallback(
    async (row: AiModelRow) => {
      // 后果写进确认文案：删掉模型本身不会撤销历史决策，但会让引用它的机器人在预检就被拦下。
      const confirmed = window.confirm(
        `删除模型“${row.label}”？\n\n引用它的机器人将无法启动（预检会直接失败），历史决策记录不受影响。此操作不可撤销。`,
      );
      if (!confirmed) return;
      setRemovingId(row.id);
      setError(null);
      try {
        await api.deleteAiModel(row.id);
        reload();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setRemovingId(null);
      }
    },
    [reload],
  );

  const test = useCallback(async (row: AiModelRow) => {
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
  }, []);

  const onTest = useCallback((row: AiModelRow) => void test(row), [test]);
  const onRemove = useCallback((row: AiModelRow) => void remove(row), [remove]);

  /* --- render ------------------------------------------------------------ */

  const newestUpdate = models.reduce<string | null>(
    (latest, row) => (!latest || row.updatedAt > latest ? row.updatedAt : latest),
    null,
  );

  return (
    <div className="space-y-2">
      {error && <ErrorNote>{error}</ErrorNote>}

      {/* 区块标题用 LAYOUT.md §5 的小字距标签 + 延伸线，而不是面板自带的标题栏：
          它和表格在视觉上绑在一起，而且省掉一整条 40px 的头部。 */}
      <SectionLabel
        title="已配置模型"
        count={fmtInt(models.length)}
        actions={
          <Button variant="primary" size="sm" onClick={openCreate} disabled={providers.length === 0}>
            + 添加模型
          </Button>
        }
      />

      <Panel padded={false}>
        {/* 轮询失败必须说出来：否则空列表会被读成"还没配过模型" */}
        {query.error && models.length === 0 ? (
          <div className="space-y-2 p-4">
            <ErrorNote>读取模型列表失败：{query.error}</ErrorNote>
            <Button onClick={reload}>重试</Button>
          </div>
        ) : query.loading && models.length === 0 ? (
          <Spinner3 label="正在加载模型" />
        ) : models.length === 0 ? (
          <Empty
            message="尚未配置任何 AI 模型。"
            hint="交易循环至少需要一个模型来请求决策。先添加一个 — 一个便宜的推理模型就够起步了。"
            action={
              <Button variant="primary" onClick={openCreate} disabled={providers.length === 0}>
                + 添加模型
              </Button>
            }
          />
        ) : (
          <>
            {/* 工具条：搜索 + 最近测试汇总 */}
            <div className="flex flex-wrap items-center gap-2 border-b border-base-800 px-2 py-1.5">
              <div className="relative min-w-[12rem] flex-1">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
                />
                <TextInput
                  className="pl-8"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="搜索名称、模型 id、供应商或端点…"
                  aria-label="搜索已配置模型"
                />
              </div>
              {testedRows.length > 0 ? (
                <Badge tone={testedOk === testedRows.length ? 'up' : 'warn'}>
                  最近测试 {testedOk}/{testedRows.length} 正常
                </Badge>
              ) : (
                <span className="text-xs text-ink-faint">还没有测试过任何一个模型</span>
              )}
              {filter && (
                <span className="num text-xs text-ink-faint">
                  匹配 {fmtInt(filtered.length)} / {fmtInt(models.length)}
                </span>
              )}
            </div>

            {filtered.length === 0 ? (
              <Empty
                message={`没有匹配「${filter}」的模型。`}
                hint="换个关键词，或清空搜索框。"
                action={<Button onClick={() => setFilter('')}>清空搜索</Button>}
              />
            ) : (
              <>
                <div className="scroll-x">
                  <table className="w-full border-collapse">
                    <thead className="border-b border-base-800 bg-base-850/60">
                      <tr>
                        <th className="th px-2 py-1.5">名称</th>
                        <th className="th px-2 py-1.5">模型 · 端点</th>
                        <th className="th px-2 py-1.5">密钥</th>
                        <th className="th px-2 py-1.5">最近测试</th>
                        <th className="th px-2 py-1.5 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((row) => (
                        <ModelRow
                          key={row.id}
                          row={row}
                          providerLabel={providerById.get(row.provider)?.label ?? row.provider}
                          defaults={providerById.get(row.provider)?.defaults}
                          result={testResult[row.id]}
                          testing={testingId === row.id}
                          removing={removingId === row.id}
                          onTest={onTest}
                          onEdit={openEdit}
                          onRemove={onRemove}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                {remaining > 0 && (
                  <div className="flex items-center justify-between gap-2 border-t border-base-800 px-2 py-1.5">
                    <span className="num text-xs text-ink-faint">
                      已显示 {fmtInt(shown.length)} / {fmtInt(filtered.length)} 个
                    </span>
                    <Button small onClick={() => setRowLimit((current) => current + ROW_PAGE)}>
                      显示更多（+{Math.min(ROW_PAGE, remaining)}）
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </Panel>

      {models.length > 0 && (
        <p className="text-xs leading-relaxed text-ink-faint">
          「测试」会向该接口发送一次最小补全请求，并报告延迟与它回显的模型 id。它不会启动任何机器人，最多只消耗少量
          Token。密钥列显示的是服务端掩码，任何界面都无法取出明文。
          {newestUpdate && <> 最近更新 {fmtDateTime(newestUpdate)}。</>}
        </p>
      )}

      <Modal
        open={creating || editing !== null}
        onClose={close}
        title={editing ? `编辑“${editing.label}”` : '添加 AI 模型'}
        description="密钥只会以密文存入服务端；接口从不回传明文，编辑时留空即保留原密钥。"
        width="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" busy={testingDraft} onClick={() => void runDraftTest()}>
              测试连接
            </Button>
            <span className="mr-auto text-xs text-ink-faint">
              {draftTest ? (draftTest.ok ? '连接正常' : '连接测试未通过') : '保存前建议先测一次。'}
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
                  spellCheck={false}
                />
              </Field>
            </div>
          </div>

          {/* Draft test result ------------------------------------------- */}
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
 *
 * 面板用 Radix Popover 而不是手写的绝对定位 div：手写版没有 Esc 关闭、
 * 没有焦点归还、点外部靠 `mousedown` 猜，键盘用户基本用不了。
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

  // A stale search term from a previous provider would hide every new result.
  useEffect(() => {
    setSearch('');
  }, [discovery]);

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
    return list.slice(0, PICKER_LIMIT);
  }, [entries, search]);

  // Built-in list empty *and* no key yet: say so instead of showing a void.
  const needsKey = !discovery && entries.length === 0;

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

      {needsKey && (
        <p className="mt-1.5 flex items-start gap-1 text-xs leading-relaxed text-warn">
          <TriangleAlert aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
          该供应商内置建议为空。请先填写 API Key，然后点「获取可用模型」；也可以直接手动输入模型 id。
        </p>
      )}

      {/* Discovery note --------------------------------------------------- */}
      {discovery && (
        <div
          className={cn(
            'mt-1.5 rounded-md border px-2.5 py-1.5 text-xs leading-relaxed',
            discovery.ok ? 'border-up/40 bg-up/10 text-up' : 'border-warn/50 bg-warn/10 text-warn',
          )}
        >
          {discovery.ok ? '✓ ' : '⚠ '}
          {discovery.message}
          {!discovery.ok && entries.length > 0 && ' 下方列表为内置建议，并非实时结果。'}
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
  const changed = touched.size;

  return (
    <Collapsible
      title={<span className="font-semibold">高级设置</span>}
      meta={
        <span className="num">
          默认 温度 {defaults.temperature} · Token {fmtInt(defaults.maxTokens)} · 超时 {defaults.timeoutSeconds}s
        </span>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs leading-relaxed text-ink-lo">这些参数已按供应商预填，通常无需修改。</p>
          {changed > 0 && <Badge tone="warn">{changed} 项已修改</Badge>}
        </div>

        {supportsThinking && (
          <p className="rounded-md border border-warn/40 bg-warn/10 px-2.5 py-2 text-xs leading-relaxed text-warn">
            该供应商支持推理模式：推理过程会消耗输出预算，若「最大输出 Token」设得过低，模型可能思考完就
            没有额度输出决策了。
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="温度" hint="越低越确定 — 交易场景建议调低。">
            <NumberInput
              className="text-right"
              value={draft.temperature}
              onValueChange={(value) => onChange('temperature', value)}
              step={0.1}
              min={0}
              max={2}
            />
          </Field>

          <Field label="最大输出 Token" hint="上限 2,000,000。">
            <NumberInput
              className="text-right"
              value={draft.maxTokens}
              onValueChange={(value) => onChange('maxTokens', value)}
              step={256}
              min={64}
              max={2000000}
            />
          </Field>

          <Field label="超时（秒）">
            <NumberInput
              className="text-right"
              value={draft.timeoutSeconds}
              onValueChange={(value) => onChange('timeoutSeconds', value)}
              step={10}
              min={5}
              max={3600}
            />
          </Field>

          <Field label="最大重试次数（次）">
            <NumberInput
              className="text-right"
              value={draft.maxRetries}
              onValueChange={(value) => onChange('maxRetries', value)}
              step={1}
              min={0}
              max={10}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-ink-faint">
            未修改的字段不会随请求提交 — 服务端会使用该供应商的默认值。
          </span>
          <Button small onClick={onReset} disabled={changed === 0}>
            恢复供应商默认值
          </Button>
        </div>
      </div>
    </Collapsible>
  );
}
