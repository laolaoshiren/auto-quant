import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { StrategyConfig } from '@aq/shared';
import { STRATEGY_PRESETS } from '@aq/shared';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { useCopy, useDocumentTitle, usePolled } from '../lib/hooks';
import { applyPreset, cloneConfig, presetById, validateStrategy } from '../lib/strategy';
import { Badge, Button, CopyButton, ErrorNote, Panel, Select, Spinner3 } from '../components/ui';
import { SectionHeading } from '../components/Badges';
import { CoinSourceSection, IndicatorsSection } from '../components/StrategyFields';
import { PromptSection, ProtectionSection, RiskSection, StrategyHeaderSection } from '../components/StrategyRiskFields';
import { StrategyCheckButton, StrategyCheckModal } from '../components/StrategyCheckModal';
import { fmtDateTime } from '../lib/format';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'ready'; id: number; name: string; description: string; presetId: string | null; config: StrategyConfig };

export function StrategyEditorPage() {
  const params = useParams();
  const navigate = useNavigate();
  const isNew = params.id === 'new';
  const strategyId = isNew ? null : Number(params.id);

  const catalog = useApp((s) => s.catalog);
  const loadCatalog = useApp((s) => s.loadCatalog);
  const listQuery = usePolled((signal) => api.strategies(signal), { intervalMs: 60_000 });

  const recordQuery = usePolled(
    (signal) => api.strategy(strategyId as number, signal),
    { enabled: strategyId !== null && Number.isFinite(strategyId), deps: [strategyId] },
  );

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [checkOpen, setCheckOpen] = useState(false);
  const rawCopy = useCopy();

  useEffect(() => {
    if (isNew) {
      if (!catalog) {
        void loadCatalog();
        setState({ kind: 'loading' });
        return;
      }
      if (state.kind !== 'ready') {
        setState({
          kind: 'ready',
          id: 0,
          name: '未命名策略',
          description: '',
          presetId: null,
          config: { ...cloneConfig(catalog.defaultStrategy), name: '未命名策略', description: '' },
        });
      }
      return;
    }

    if (recordQuery.data) {
      const record = recordQuery.data;
      setState({
        kind: 'ready',
        id: record.id,
        name: record.name,
        description: record.description,
        presetId: record.presetId,
        config: cloneConfig(record.config),
      });
      setDirty(false);
    } else if (recordQuery.error) {
      setState({ kind: 'missing' });
    }
  }, [isNew, catalog, loadCatalog, recordQuery.data, recordQuery.error, state.kind]);

  useDocumentTitle(isNew ? '新建策略' : (state.kind === 'ready' ? state.name : '策略'));

  const validation = useMemo(
    () => (state.kind === 'ready' ? validateStrategy({ ...state.config, name: state.name, description: state.description }) : null),
    [state],
  );

  const patchConfig = (patch: Partial<StrategyConfig>) => {
    setState((current) => (current.kind === 'ready' ? { ...current, config: { ...current.config, ...patch } } : current));
    setDirty(true);
    setNotice(null);
  };

  const patchHeader = (patch: Partial<Pick<StrategyConfig, 'name' | 'description' | 'tradingMode'>>) => {
    setState((current) =>
      current.kind === 'ready'
        ? {
            ...current,
            name: patch.name ?? current.name,
            description: patch.description ?? current.description,
            config: { ...current.config, ...patch },
          }
        : current,
    );
    setDirty(true);
    setNotice(null);
  };

  const applyPresetToDraft = (presetId: string) => {
    if (state.kind !== 'ready') return;
    const preset = STRATEGY_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    const next = applyPreset(state.config, preset);
    setState({ ...state, presetId: preset.id, config: next, description: state.description || preset.summary });
    setDirty(true);
    setNotice(`已将预设“${preset.label}”应用到草稿。`);
  };

  const save = async (): Promise<number | null> => {
    if (state.kind !== 'ready') return null;
    if (!validation?.ok || !validation.config) {
      setShowErrors(true);
      setError('请先修正高亮字段再保存。');
      return null;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = {
        name: state.name.trim(),
        description: state.description,
        presetId: state.presetId,
        config: { ...validation.config, name: state.name.trim(), description: state.description },
      };

      if (isNew) {
        const created = await api.createStrategy(payload);
        setDirty(false);
        // Keep the editor mounted instead of navigating away: the health check
        // needs the server-assigned id, and a redirect here would tear the page
        // down mid-session.
        setState((current) =>
          current.kind === 'ready'
            ? { ...current, id: created.id, presetId: created.presetId ?? current.presetId }
            : current,
        );
        setNotice(`已创建并保存（#${created.id}）。`);
        listQuery.reload();
        return created.id;
      }

      await api.updateStrategy(state.id, payload);
      setDirty(false);
      setNotice(`已于 ${new Date().toLocaleTimeString('en-GB', { hour12: false })} 保存。`);
      recordQuery.reload();
      listQuery.reload();
      return state.id;
    } catch (err) {
      setError((err as Error).message);
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (state.kind !== 'ready' || isNew) return;
    if (!window.confirm(`删除“${state.name}”？`)) return;
    try {
      await api.deleteStrategy(state.id);
      navigate('/strategy');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (state.kind === 'loading') return <Spinner3 label="正在加载策略" />;
  if (state.kind === 'missing') {
    return (
      <Panel title="未找到策略">
        <p className="text-xs text-ink-lo">{recordQuery.error ?? '它可能已被删除。'}</p>
        <Link to="/strategy" className="btn btn-ghost mt-3 inline-flex">
          返回策略工坊
        </Link>
      </Panel>
    );
  }

  const errors = showErrors ? (validation?.errors ?? {}) : {};
  const errorCount = Object.keys(validation?.errors ?? {}).length;
  const preset = presetById(state.presetId);

  return (
    <div className="space-y-3 pb-16">
      {/* Sticky action bar ------------------------------------------------ */}
      <div className="sticky top-0 z-20 -mx-4 -mt-4 border-b border-base-800 bg-base-950/95 px-4 py-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link to="/strategy" className="text-xs text-ink-lo transition hover:text-accent">
            ← 策略工坊
          </Link>
          <h1 className="max-w-[280px] truncate text-sm font-semibold tracking-wide text-ink-hi">
            {state.name || '未命名策略'}
          </h1>
          {isNew ? <Badge tone="accent">未保存</Badge> : <Badge tone="muted">#{state.id}</Badge>}
          {dirty && <Badge tone="warn">已修改</Badge>}
          {preset && <Badge tone="muted">预设：{preset.id}</Badge>}
          {validation && !validation.ok && <Badge tone="down">{errorCount} 处校验问题</Badge>}

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {listQuery.data && listQuery.data.length > 0 && (
              <Select
                className="w-48"
                value={isNew ? '' : String(state.id)}
                onChange={(event) => {
                  if (event.target.value === '') return;
                  if (dirty && !window.confirm('放弃未保存的修改？')) return;
                  navigate(`/strategy/${event.target.value}`);
                }}
              >
                <option value="">— 跳转到策略 —</option>
                {listQuery.data.map((record) => (
                  <option key={record.id} value={record.id}>
                    {record.name}
                  </option>
                ))}
              </Select>
            )}
            <Select className="w-40" value={state.presetId ?? ''} onChange={(event) => event.target.value && applyPresetToDraft(event.target.value)}>
              <option value="">— 应用预设 —</option>
              {STRATEGY_PRESETS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </Select>
            <Button variant="ghost" onClick={() => setRawOpen((v) => !v)}>
              {rawOpen ? '隐藏 JSON' : '查看 JSON'}
            </Button>
            {/* Prominent: this is the "does my strategy actually work?" button. */}
            <StrategyCheckButton
              onClick={() => {
                if (dirty && !window.confirm('体检会先保存当前修改，然后运行一次真实模型调用。继续？')) return;
                setCheckOpen(true);
              }}
            />
            {!isNew && (
              <Button variant="danger" onClick={() => void remove()}>
                删除
              </Button>
            )}
            <Button variant="primary" onClick={() => void save()} busy={saving}>
              {isNew ? '创建策略' : '保存修改'}
            </Button>
          </div>
        </div>

        {error && <ErrorNote className="mt-2">{error}</ErrorNote>}
        {notice && !error && (
          <div className="mt-2 rounded border border-up/40 bg-up/10 px-2.5 py-1.5 text-xs text-up">{notice}</div>
        )}
      </div>

      <SectionHeading
        title="策略定义"
        sub={
          state.kind === 'ready'
            ? `保存前会按 StrategyConfigSchema 校验${recordQuery.data ? ` · 服务端副本更新于 ${fmtDateTime(recordQuery.data.updatedAt)}` : ''}`
            : undefined
        }
      />

      <StrategyHeaderSection config={state.config} onChange={patchHeader} errors={errors} />

      <CoinSourceSection
        config={state.config}
        onChange={(next) => patchConfig({ coinSource: next })}
        errors={errors}
      />

      <IndicatorsSection
        config={state.config}
        onChange={(next) => patchConfig({ indicators: next })}
        errors={errors}
      />

      <RiskSection config={state.config} onChange={(next) => patchConfig({ riskControl: next })} errors={errors} />

      <ProtectionSection config={state.config} onChange={(patch) => patchConfig(patch)} errors={errors} />

      <PromptSection config={state.config} onChange={(patch) => patchConfig(patch)} errors={errors} />

      {showErrors && errorCount > 0 && (
        <Panel title={`校验问题（${errorCount}）`}>
          <ul className="space-y-1">
            {Object.entries(validation?.errors ?? {}).map(([path, message]) => (
              <li key={path} className="flex gap-2 text-xs">
                <span className="num shrink-0 text-down">{path}</span>
                <span className="text-ink-lo">{message}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {rawOpen && (
        <Panel
          title="原始 StrategyConfig"
          actions={
            <span className="flex items-center gap-2">
              <span className="num text-2xs text-ink-faint">API 实际收到的内容</span>
              <CopyButton
                copied={rawCopy.copied}
                onCopy={() =>
                  rawCopy.copy(
                    JSON.stringify(
                      { ...(validation?.config ?? state.config), name: state.name.trim() || state.name, description: state.description },
                      null,
                      2,
                    ),
                  )
                }
              />
            </span>
          }
        >
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded border border-base-800 bg-base-950 px-3 py-2 font-mono text-xs leading-relaxed text-ink-mid">
            {JSON.stringify(
              { ...(validation?.config ?? state.config), name: state.name.trim() || state.name, description: state.description },
              null,
              2,
            )}
          </pre>
        </Panel>
      )}

      <StrategyCheckModal
        open={checkOpen}
        onClose={() => setCheckOpen(false)}
        target={
          state.kind === 'ready' && state.id > 0
            ? {
                id: state.id,
                name: state.name,
                dirty,
                saveFirst: async () => {
                  const id = await save();
                  if (id === null) throw new Error('策略未能保存，体检已取消。');
                },
              }
            : null
        }
      />
    </div>
  );
}
