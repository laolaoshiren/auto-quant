/**
 * AI 模型配置：供应商、端点、密钥、模型清单。
 *
 * 两条硬规则贯穿全文：
 * 1. 密钥永不还原成明文（只渲染掩码，编辑框留空即保留原密钥）；
 * 2. 列表不无上限渲染（搜索 + 分批展开）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import {
  api,
  type AiModelRow,
  type DiscoverModelsResult,
  type ModelTestResult,
} from '../../lib/api';
import { useApp } from '../../lib/store';
import { usePolled } from '../../lib/hooks';
import {
  Badge,
  Button,
  Empty,
  ErrorNote,
  Panel,
  Spinner3,
  TextInput,
} from '../ui';
import { fmtDateTime, fmtInt } from '../../lib/format';
import { healthToResult, ModelRow, type ModelTestSnapshot } from './AiModelRow';
import { AiModelModal, emptyDraft, type ModelDraft } from './AiModelModal';

/** 表格首屏渲染多少行；点「显示更多」再追加，避免一次挂几百个 DOM 节点。 */
const ROW_PAGE = 25;

export function AiModelsSection() {
  const catalog = useApp((s) => s.catalog);
  const query = usePolled((signal) => api.aiModels(signal), { intervalMs: 30_000 });
  const reload = query.reload;

  const [editing, setEditing] = useState<AiModelRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ModelDraft>(() => emptyDraft('deepseek', '', ''));
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<number, ModelTestSnapshot>>({});
  const [testingId, setTestingId] = useState<number | null>(null);
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [batchSummary, setBatchSummary] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<DiscoverModelsResult | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [draftTest, setDraftTest] = useState<ModelTestResult | null>(null);
  const [testingDraft, setTestingDraft] = useState(false);
  const [filter, setFilter] = useState('');
  const [rowLimit, setRowLimit] = useState(ROW_PAGE);
  const [defaultIdOverride, setDefaultIdOverride] = useState<number | null>(null);

  const models = useMemo(() => query.data ?? [], [query.data]);
  const providers = useMemo(() => catalog?.providers ?? [], [catalog]);
  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);
  const descriptor = providers.find((p) => p.id === draft.provider);

  /* --- list filtering ---------------------------------------------------- */

  const filtered = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return models;
    return models.filter((row) =>
      [row.label, row.model, row.provider, row.baseUrl].some((field) => field.toLowerCase().includes(term)),
    );
  }, [models, filter]);

  useEffect(() => setRowLimit(ROW_PAGE), [filter]);

  const shown = filtered.slice(0, rowLimit);
  const remaining = filtered.length - shown.length;

  const resolvedResults = useMemo(() => {
    const map: Record<number, ModelTestSnapshot | undefined> = {};
    for (const row of models) {
      map[row.id] = testResult[row.id] ?? healthToResult(row.health);
    }
    return map;
  }, [models, testResult]);

  const testedRows = useMemo(
    () => models.filter((row) => resolvedResults[row.id] !== undefined),
    [models, resolvedResults],
  );
  const testedOk = useMemo(
    () => testedRows.filter((row) => resolvedResults[row.id]?.ok).length,
    [testedRows, resolvedResults],
  );

  /* --- dialogs ----------------------------------------------------------- */

  const openCreate = useCallback(() => {
    const first = providers[0];
    const builtin = first?.models[0] ?? '';
    setDraft({ ...emptyDraft(first?.id ?? 'deepseek', first?.label ?? '', first?.baseUrl ?? ''), model: builtin });
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
    });
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
      };
    });
    setDiscovery(null);
    setDraftTest(null);
    setError(null);
  };

  /* --- discovery & draft test -------------------------------------------- */

  const runDiscover = async () => {
    setDiscovering(true);
    setError(null);
    try {
      const result = await api.discoverModels({
        provider: draft.provider,
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey,
        ...(editing ? { modelId: editing.id } : {}),
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

  const buildPayload = () => {
    const payload: Parameters<typeof api.createAiModel>[0] = {
      provider: draft.provider,
      label: draft.label.trim() || descriptor?.label || draft.provider,
      model: draft.model.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey,
    };
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
      setDraftTest(
        await api.testAiModelDraft({
          ...buildPayload(),
          ...(editing ? { modelId: editing.id } : {}),
        }),
      );
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

  /* --- submit / default / delete ----------------------------------------- */

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

  const setDefault = useCallback(async (row: AiModelRow) => {
    setError(null);
    try {
      await api.setDefaultAiModel(row.id);
      setDefaultIdOverride(row.id);
      void useApp.getState().loadCatalog();
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const remove = useCallback(
    async (row: AiModelRow) => {
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

  /* --- single & batch connectivity tests --------------------------------- */

  const recordTestResult = useCallback((id: number, result: ModelTestResult) => {
    setTestResult((current) => ({ ...current, [id]: { ...result, at: Date.now() } }));
  }, []);

  const test = useCallback(async (row: AiModelRow) => {
    setTestingId(row.id);
    setError(null);
    try {
      const result = await api.testAiModel(row.id);
      recordTestResult(row.id, result);
    } catch (err) {
      const payload = (err as Error & { payload?: ModelTestResult }).payload;
      recordTestResult(row.id, {
        ok: false,
        message: payload?.message ?? (err as Error).message,
        latencyMs: payload?.latencyMs ?? 0,
      });
    } finally {
      setTestingId(null);
    }
  }, [recordTestResult]);

  const onTest = useCallback((row: AiModelRow) => void test(row), [test]);
  const onRemove = useCallback((row: AiModelRow) => void remove(row), [remove]);

  /** 一键测试全部模型（并发 4，带进度与汇总；单个失败不中断整批）。 */
  const testAll = useCallback(async () => {
    const targets = models.map((m) => m.id);
    if (targets.length === 0) return;
    setBatchSummary(null);
    setBatch({ done: 0, total: targets.length });

    let ok = 0;
    let failed = 0;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= targets.length) return;
        const id = targets[index]!;
        try {
          const result = await api.testAiModel(id);
          recordTestResult(id, result);
          if (result.ok) ok += 1;
          else failed += 1;
        } catch (err) {
          const payload = (err as Error & { payload?: ModelTestResult }).payload;
          recordTestResult(id, {
            ok: false,
            message: payload?.message ?? (err as Error).message,
            latencyMs: payload?.latencyMs ?? 0,
          });
          failed += 1;
        }
        setBatch((current) => (current === null ? null : { ...current, done: current.done + 1 }));
      }
    };

    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));

    setBatch(null);
    setBatchSummary(
      failed === 0
        ? `${fmtInt(targets.length)} 个模型全部通过`
        : `${fmtInt(ok)} 个通过 · ${fmtInt(failed)} 个失败（失败的格子标红，鼠标悬停看原因）`,
    );
  }, [models, recordTestResult]);

  /* --- render ------------------------------------------------------------ */

  const newestUpdate = models.reduce<string | null>(
    (latest, row) => (!latest || row.updatedAt > latest ? row.updatedAt : latest),
    null,
  );

  return (
    <div className="space-y-2">
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex flex-wrap items-center gap-2">
        <h2 className="shrink-0 text-xs font-semibold uppercase tracking-[0.14em] text-ink-lo">
          已配置模型 <span className="num ml-1 text-ink-faint">{fmtInt(models.length)}</span>
        </h2>
        <Button variant="primary" size="sm" onClick={openCreate} disabled={providers.length === 0}>
          + 添加模型
        </Button>
        <Button
          size="sm"
          variant="ghost"
          busy={batch !== null}
          disabled={batch !== null || models.length === 0}
          onClick={() => void testAll()}
          title={
            batch !== null
              ? `正在测试（${batch.done}/${batch.total}）`
              : '对每个已配置模型各发一次最小补全请求，结果直接标在下面每一行上'
          }
        >
          {batch !== null ? `测试中 ${batch.done}/${batch.total}` : '一键测试全部'}
        </Button>
        <span aria-hidden className="h-px min-w-4 flex-1 bg-base-800" />
      </div>

      {batchSummary !== null && (
        <div className="px-0.5 text-xs text-ink-mid">{batchSummary}</div>
      )}

      <Panel padded={false}>
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
            <div className="flex flex-wrap items-center gap-2 border-b border-base-800 px-2 py-1.5">
              <div className="relative w-72 max-w-full">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
                />
                <TextInput
                  className="!pl-8"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="搜索名称、模型 id、供应商或端点…"
                  aria-label="搜索已配置模型"
                />
              </div>
              {testedRows.length > 0 ? (
                <Badge className="ml-auto" tone={testedOk === testedRows.length ? 'up' : 'warn'}>
                  最近测试 {testedOk}/{testedRows.length} 正常
                </Badge>
              ) : (
                <span className="ml-auto text-xs text-ink-faint">还没有测试过任何一个模型</span>
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
                <div className="overflow-x-hidden">
                  <table className="w-full table-fixed border-collapse">
                    <thead className="border-b border-base-800 bg-base-850/60">
                      <tr>
                        <th className="th w-[26%] px-2 py-1.5">名称</th>
                        <th className="th w-[34%] px-2 py-1.5">模型 · 端点</th>
                        <th className="th hidden w-[14%] px-2 py-1.5 2xl:table-cell">密钥</th>
                        <th className="th hidden w-[14%] px-2 py-1.5 xl:table-cell">最近测试</th>
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
                          result={resolvedResults[row.id]}
                          testing={testingId === row.id}
                          removing={removingId === row.id}
                          isDefault={row.id === (defaultIdOverride ?? catalog?.defaultAiModelId ?? null)}
                          onTest={onTest}
                          onEdit={openEdit}
                          onSetDefault={setDefault}
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
          「测试」会发一次最小补全请求并报告延迟；密钥列只是服务端掩码，无法取出明文。
          {newestUpdate && <> 最近更新 {fmtDateTime(newestUpdate)}。</>}
        </p>
      )}

      <AiModelModal
        open={creating || editing !== null}
        editing={editing}
        draft={draft}
        providers={providers}
        descriptor={descriptor}
        discovery={discovery}
        discovering={discovering}
        draftTest={draftTest}
        testingDraft={testingDraft}
        busy={busy}
        onClose={close}
        onApplyProvider={applyProvider}
        onChangeDraft={setDraft}
        onClearDiscoveryAndTest={() => {
          setDiscovery(null);
          setDraftTest(null);
        }}
        onClearDraftTest={() => setDraftTest(null)}
        onDiscover={() => void runDiscover()}
        onTestDraft={() => void runDraftTest()}
        onSubmit={() => void submit()}
      />
    </div>
  );
}
