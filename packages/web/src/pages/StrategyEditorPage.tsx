/**
 * 策略编辑器 —— 全应用最长的表单。
 *
 * 三个结构决定，都是为了让这张表单"能读、能跳、不会误丢"：
 *
 * 1. **分区标签页（Radix Tabs）而不是一条长滚动**。一次只挂载一个分区，
 *    所以在一个文本域里敲字不会让另外五个分区的几十个受控输入一起重渲染 ——
 *    这既是可导航性，也是性能手段（长表单每敲一个字就重算全树，在低频笔记本上很明显）。
 * 2. **核心风控常驻在顶栏**。杠杆 / 仓位 / 强制止损 / 盈亏比决定这笔钱能亏多少，
 *    它们必须在任何分区下都看得见，而不是夹在指标周期之间。
 * 3. **脏状态必须显式**。这是真实下单的配置，用户不能靠"我记得我保存过"来判断。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { Activity, Coins, FileText, LoaderCircle, ShieldAlert, ShieldCheck, Tag, TriangleAlert } from 'lucide-react';
import type { StrategyConfig } from '@aq/shared';
import { STRATEGY_PRESETS } from '@aq/shared';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { useCopy, useDocumentTitle, usePolled } from '../lib/hooks';
import { applyPreset, cloneConfig, presetById, validateStrategy } from '../lib/strategy';
import { Badge, Button, CopyButton, ErrorNote, Panel, Select, Spinner3, cn } from '../components/ui';
import { CoinSourceSection, IndicatorsSection } from '../components/StrategyFields';
import { PromptSection, ProtectionSection, RiskSection, StrategyHeaderSection } from '../components/StrategyRiskFields';
import { StrategyCheckButton, StrategyCheckModal } from '../components/StrategyCheckModal';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'ready'; id: number; name: string; description: string; presetId: string | null; config: StrategyConfig };

/* -------------------------------------------------------------------------- */
/*  Tabs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 分区顺序即优先级：标识 → 核心风控 → 币种 → 指标 → 保护 → 提示词。
 * 风控排在币种与指标**之前**，因为先定"能亏多少"，再谈"看什么数据"。
 */
const TABS = [
  { id: 'identity', label: '标识', icon: Tag },
  { id: 'risk', label: '核心风控', icon: ShieldAlert },
  { id: 'universe', label: '币种来源', icon: Coins },
  { id: 'indicators', label: '指标', icon: Activity },
  { id: 'protection', label: '保护与限流', icon: ShieldCheck },
  { id: 'prompt', label: '提示词', icon: FileText },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** 校验错误路径 → 它属于哪个分区。用于标签页上的红点和"去修复"按钮。 */
function tabForPath(path: string): TabId {
  if (path.startsWith('coinSource')) return 'universe';
  if (path.startsWith('indicators')) return 'indicators';
  if (path.startsWith('riskControl')) return 'risk';
  if (path.startsWith('drawdownGuard') || path.startsWith('throttle') || path.startsWith('circuitBreaker')) {
    return 'protection';
  }
  if (path.startsWith('promptSections') || path === 'customPrompt') return 'prompt';
  return 'identity';
}

/* -------------------------------------------------------------------------- */
/*  Risk banner                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 常驻的风控读数。
 *
 * **层级，不是四个等大的格子。** 主读数只有一个：「强制止损」—— 它是唯一一个
 * 关掉就等于"亏损没有上限"的开关，所以它拿到最大的字号、最宽的格子，未开启时
 * 还带红边。杠杆、仓位、盈亏比都是在这个前提下的数量约束，降一档并排放在一条
 * 紧凑的行里即可（LAYOUT.md §2，以及本文档开头"决定单笔亏损上限的数字要最大"）。
 *
 * 只接收原始值（而不是整个 `riskControl` 对象）：对象每次按键都会换身份，
 * `memo` 就白加了。这几个数字才是它真正依赖的东西。
 */
const RiskBanner = memo(function RiskBanner({
  leverage,
  altcoinLeverage,
  positionRatio,
  altcoinPositionRatio,
  requireStopLoss,
  riskReward,
  onOpen,
}: {
  leverage: number;
  altcoinLeverage: number;
  positionRatio: number;
  altcoinPositionRatio: number;
  requireStopLoss: boolean;
  riskReward: number;
  onOpen: () => void;
}) {
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      <button
        type="button"
        onClick={onOpen}
        title="强制止损 — 点击跳到核心风控"
        className={cn(
          'group flex min-w-0 shrink-0 basis-full flex-col rounded-md border bg-base-850/80 px-3 py-1.5 text-left transition hover:bg-base-800 sm:basis-auto sm:min-w-[16rem]',
          requireStopLoss ? 'border-base-750 hover:border-accent/60' : 'border-down/60 hover:border-down',
        )}
      >
        <span className="flex w-full items-center gap-1.5 text-xs uppercase tracking-[0.12em] text-ink-lo">
          强制止损
          <span className="ml-auto hidden shrink-0 text-xs normal-case tracking-normal text-accent group-hover:inline">
            调整
          </span>
        </span>
        <span className={cn('num truncate text-xl leading-tight', requireStopLoss ? 'text-up' : 'text-down')}>
          {requireStopLoss ? '已开启' : '未开启'}
        </span>
        <span className={cn('truncate text-xs', requireStopLoss ? 'text-ink-faint' : 'text-down')}>
          {requireStopLoss ? '交易所侧挂单，程序挂掉也仍然有效' : '⚠ 现在可以开出没有止损的仓位'}
        </span>
      </button>

      <div className="grid min-w-0 flex-1 grid-cols-3 gap-1.5">
        <RiskReadout label="杠杆上限（倍）" value={`≤ ${leverage}`} note={`山寨 ≤ ${altcoinLeverage}`} onOpen={onOpen} />
        <RiskReadout
          label="最大仓位（倍权益）"
          value={`${positionRatio}×`}
          note={`山寨 ${altcoinPositionRatio}×`}
          onOpen={onOpen}
        />
        <RiskReadout label="最小盈亏比" value={`1:${riskReward}`} note="低于此值直接拒绝" onOpen={onOpen} />
      </div>
    </div>
  );
});

/** 次要的风控读数：一格一个数字，比主读数小一档（`text-base` 对 `text-xl`）。 */
function RiskReadout({
  label,
  value,
  note,
  onOpen,
}: {
  label: string;
  value: string;
  note: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${label} — 点击跳到核心风控`}
      className="group flex min-w-0 flex-col rounded-md border border-base-750 bg-base-850/60 px-2 py-1 text-left transition hover:border-accent/60 hover:bg-base-800"
    >
      <span className="truncate text-xs text-ink-faint">{label}</span>
      <span className="num truncate text-base leading-tight text-ink-hi">{value}</span>
      <span className="truncate text-xs text-ink-faint">{note}</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

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
  const [tab, setTab] = useState<TabId>('identity');
  const rawCopy = useCopy();

  /**
   * 切换分区时回到内容顶部。
   *
   * 内容区是 `Layout` 里的 `<main>`（它自己滚动，不是窗口），所以直接从
   * 根节点往上找那个滚动容器。不做这一步的话，在提示词分区底部切到标识分区
   * 会看到一片空白 —— 新分区比旧的短，滚动位置被浏览器夹住后停在中间。
   */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectTab = useCallback((next: TabId) => {
    setTab(next);
    rootRef.current?.closest('main')?.scrollTo({ top: 0 });
  }, []);

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

  const ready = state.kind === 'ready';
  const currentPath = ready && state.id > 0 ? `/strategy/${state.id}` : '/strategy/new';
  useDocumentTitle(`${dirty ? '• ' : ''}${isNew ? '新建策略' : ready ? state.name : '策略'}`);

  const validation = useMemo(
    () =>
      state.kind === 'ready'
        ? validateStrategy({ ...state.config, name: state.name, description: state.description })
        : null,
    [state],
  );

  /* --- dirty / clean ---------------------------------------------------- */

  const patchConfig = useCallback((patch: Partial<StrategyConfig>) => {
    setState((current) => (current.kind === 'ready' ? { ...current, config: { ...current.config, ...patch } } : current));
    setDirty(true);
    setNotice(null);
  }, []);

  const patchHeader = useCallback((patch: Partial<Pick<StrategyConfig, 'name' | 'description' | 'tradingMode'>>) => {
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
  }, []);

  const onCoinSource = useCallback((next: StrategyConfig['coinSource']) => patchConfig({ coinSource: next }), [patchConfig]);
  const onIndicators = useCallback((next: StrategyConfig['indicators']) => patchConfig({ indicators: next }), [patchConfig]);
  const onRisk = useCallback((next: StrategyConfig['riskControl']) => patchConfig({ riskControl: next }), [patchConfig]);
  const onProtection = useCallback(
    (patch: Partial<Pick<StrategyConfig, 'drawdownGuard' | 'throttle' | 'circuitBreaker'>>) => patchConfig(patch),
    [patchConfig],
  );
  const onPrompt = useCallback(
    (patch: Partial<Pick<StrategyConfig, 'promptSections' | 'customPrompt'>>) => patchConfig(patch),
    [patchConfig],
  );

  /*
   * 带着未保存的修改离开时必须拦一下。
   *
   * 这个应用用的是普通 `<Routes>`（不是 data router），所以拿不到 `useBlocker`。
   * 退而求其次：`beforeunload` 管刷新/关标签页，捕获阶段的点击监听管所有站内跳转
   * （React Router 的 `Link` 最终就是一个 `<a href>`）。cmd/ctrl+点击、新标签页、
   * 以及跳回当前页本身都不拦 —— 那些不会丢掉编辑内容。
   */
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href') ?? '';
      if (!href.startsWith('/') || href === currentPath) return;
      if (anchor.getAttribute('target') === '_blank') return;
      if (!window.confirm('有未保存的修改，离开后这些修改会丢失。确定要离开吗？')) event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, currentPath]);

  /* --- save ------------------------------------------------------------- */

  const save = async (): Promise<number | null> => {
    if (state.kind !== 'ready') return null;
    if (!validation?.ok || !validation.config) {
      setShowErrors(true);
      setError('请先修正高亮字段再保存。');
      // 直接把用户送到第一个出错的分区：错误列表在底部，不跳过去等于没说。
      const firstPath = Object.keys(validation?.errors ?? {})[0];
      if (firstPath) selectTab(tabForPath(firstPath));
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

  /** ⌘S / Ctrl+S 保存。放进 ref 是为了让监听器只注册一次，不随每次按键重挂。 */
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const applyPresetToDraft = (presetId: string) => {
    if (state.kind !== 'ready') return;
    const preset = STRATEGY_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    const next = applyPreset(state.config, preset);
    setState({ ...state, presetId: preset.id, config: next, description: state.description || preset.summary });
    setDirty(true);
    setNotice(`已将预设“${preset.label}”应用到草稿。`);
  };

  const remove = async () => {
    if (state.kind !== 'ready' || isNew) return;
    const confirmed = window.confirm(
      `删除策略“${state.name}”？\n\n引用它的机器人将无法再启动（预检会直接失败）。此操作不可撤销。`,
    );
    if (!confirmed) return;
    try {
      await api.deleteStrategy(state.id);
      navigate('/strategy');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /* --- derived ---------------------------------------------------------- */

  const tabErrors = useMemo(() => {
    const counts = {} as Record<TabId, number>;
    for (const item of TABS) counts[item.id] = 0;
    for (const path of Object.keys(validation?.errors ?? {})) counts[tabForPath(path)] += 1;
    return counts;
  }, [validation]);

  const rawJson = useMemo(() => {
    if (!rawOpen || state.kind !== 'ready') return '';
    return JSON.stringify(
      {
        ...(validation?.config ?? state.config),
        name: state.name.trim() || state.name,
        description: state.description,
      },
      null,
      2,
    );
  }, [rawOpen, state, validation]);

  if (state.kind === 'loading') return <Spinner3 label="正在加载策略" />;
  if (state.kind === 'missing') {
    return (
      <Panel title="未找到策略">
        <p className="text-base text-ink-lo">{recordQuery.error ?? '它可能已被删除。'}</p>
        <Link to="/strategy" className="btn btn-ghost mt-3 inline-flex">
          返回策略工坊
        </Link>
      </Panel>
    );
  }

  const errors = showErrors ? (validation?.errors ?? {}) : {};
  const errorCount = Object.keys(validation?.errors ?? {}).length;
  const preset = presetById(state.presetId);
  const risk = state.config.riskControl;

  return (
    <TabsPrimitive.Root
      ref={rootRef}
      value={tab}
      onValueChange={(next) => selectTab(next as TabId)}
      className="space-y-3 pb-16"
    >
      {/* ---------------------------------------------------------------- */}
      {/*  常驻控制区：返回 / 状态 / 操作 / 风控读数 / 分区导航              */}
      {/* ---------------------------------------------------------------- */}
      <div className="sticky top-0 z-20 -mx-4 -mt-4 space-y-2 border-b border-base-800 bg-base-950/95 px-4 pb-2 pt-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link
            to="/strategy"
            className="shrink-0 text-base text-ink-lo transition hover:text-accent"
            title={dirty ? '有未保存的修改' : undefined}
          >
            ← 策略工坊
          </Link>
          <h1 className="min-w-0 max-w-[40vw] truncate text-lg font-semibold tracking-wide text-ink-hi">
            {state.name || '未命名策略'}
          </h1>

          {state.id > 0 ? <Badge tone="muted">#{state.id}</Badge> : <Badge tone="accent">未创建</Badge>}
          <SaveState saving={saving} dirty={dirty} isNew={isNew && state.id === 0} />
          {preset && <Badge tone="muted">预设：{preset.label}</Badge>}
          {errorCount > 0 && (
            <Badge tone={validation?.ok ? 'muted' : 'down'} title="点击下方任意分区查看具体字段">
              {errorCount} 处校验问题
            </Badge>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {listQuery.data && listQuery.data.length > 0 && (
              <Select
                className="w-44"
                value={isNew ? '' : String(state.id)}
                aria-label="跳转到其他策略"
                onChange={(event) => {
                  const next = event.target.value;
                  if (next === '') return;
                  if (dirty && !window.confirm('放弃未保存的修改？离开后这些修改会丢失。')) return;
                  navigate(`/strategy/${next}`);
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
            <Select
              className="w-36"
              value={state.presetId ?? ''}
              aria-label="应用预设"
              onChange={(event) => event.target.value && applyPresetToDraft(event.target.value)}
            >
              <option value="">— 应用预设 —</option>
              {STRATEGY_PRESETS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              onClick={() => setRawOpen((v) => !v)}
              title="查看并复制 API 实际收到的 StrategyConfig"
            >
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
            <Button
              variant="primary"
              onClick={() => void save()}
              busy={saving}
              title="保存修改（⌘S / Ctrl+S）"
              disabled={!dirty && state.id > 0}
            >
              {saving ? '正在保存…' : isNew && state.id === 0 ? '创建策略' : '保存修改'}
            </Button>
          </div>
        </div>

        <RiskBanner
          leverage={risk.btcEthMaxLeverage}
          altcoinLeverage={risk.altcoinMaxLeverage}
          positionRatio={risk.btcEthMaxPositionValueRatio}
          altcoinPositionRatio={risk.altcoinMaxPositionValueRatio}
          requireStopLoss={risk.requireStopLoss}
          riskReward={risk.minRiskRewardRatio}
          onOpen={() => selectTab('risk')}
        />

        <TabsPrimitive.List
          aria-label="策略配置分区"
          className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-base-800"
        >
          {TABS.map((item) => {
            const count = showErrors ? tabErrors[item.id] : 0;
            return (
              <TabsPrimitive.Trigger
                key={item.id}
                value={item.id}
                className={cn(
                  '-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-1 text-base font-medium transition',
                  'border-transparent text-ink-lo hover:text-ink-mid',
                  'data-[state=active]:border-accent data-[state=active]:text-ink-hi',
                )}
              >
                <item.icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
                {item.label}
                {count > 0 && (
                  <span className="num rounded bg-down/15 px-1 text-xs text-down" title={`${count} 个字段有问题`}>
                    {count}
                  </span>
                )}
              </TabsPrimitive.Trigger>
            );
          })}
        </TabsPrimitive.List>

        {error && <ErrorNote>{error}</ErrorNote>}
        {notice && !error && (
          <div className="rounded-md border border-up/40 bg-up/10 px-2.5 py-1.5 text-base text-up">{notice}</div>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/*  分区内容                                                         */}
      {/* ---------------------------------------------------------------- */}
      {/* 这里原本有一行「保存前会按 StrategyConfigSchema 校验 · 服务端副本更新于 …」。
          它是内部诊断值（LAYOUT.md §3）：正常编辑时永远"没事"，却常驻在最显眼的
          位置。脏状态由上面的徽章负责，服务端副本在保存后会重新拉取。 */}

      {/*
        * 分区内容不写 `focus-visible:outline-none`：Radix 把面板本身做成可聚焦的，
        * 键盘 Tab 进来时那圈轮廓是**唯一**能说明焦点在哪的线索（DESIGN.md §8）。
        */}
      <TabsPrimitive.Content value="identity">
        <StrategyHeaderSection config={state.config} onChange={patchHeader} errors={errors} />
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="risk">
        <RiskSection config={state.config} onChange={onRisk} errors={errors} />
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="universe">
        <CoinSourceSection config={state.config} onChange={onCoinSource} errors={errors} />
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="indicators">
        <IndicatorsSection config={state.config} onChange={onIndicators} errors={errors} />
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="protection">
        <ProtectionSection config={state.config} onChange={onProtection} errors={errors} />
      </TabsPrimitive.Content>

      <TabsPrimitive.Content value="prompt">
        <PromptSection config={state.config} onChange={onPrompt} errors={errors} />
      </TabsPrimitive.Content>

      {/* ---------------------------------------------------------------- */}
      {/*  校验汇总（可跳转到出错分区）                                      */}
      {/* ---------------------------------------------------------------- */}
      {showErrors && errorCount > 0 && (
        <Panel title={`校验问题（${errorCount}）`} bodyClassName="p-3">
          <ul className="space-y-1">
            {Object.entries(validation?.errors ?? {}).map(([path, message]) => (
              <li key={path} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-base">
                <span className="num shrink-0 text-down">{path}</span>
                <span className="min-w-0 text-ink-lo">{message}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto shrink-0"
                  onClick={() => selectTab(tabForPath(path))}
                >
                  去修复
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* ---------------------------------------------------------------- */}
      {/*  原始 JSON                                                        */}
      {/* ---------------------------------------------------------------- */}
      {rawOpen && (
        <Panel
          title="原始 StrategyConfig"
          actions={
            <span className="flex items-center gap-2">
              <span className="text-xs text-ink-faint">API 实际收到的内容</span>
              <CopyButton copied={rawCopy.copied} onCopy={() => rawCopy.copy(rawJson)} />
            </span>
          }
        >
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-base-800 bg-base-950 px-3 py-2 font-mono text-xs leading-relaxed text-ink-mid">
            {rawJson}
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
    </TabsPrimitive.Root>
  );
}

/* -------------------------------------------------------------------------- */
/*  Save state pill                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 保存状态。
 *
 * 三种状态必须彼此可区分：正在保存（动）、有未保存修改（黄）、已保存（绿）。
 * 只用一个"保存"按钮的 disabled 来表达这三件事，用户会分不清"没改过"
 * 和"改了但没存"—— 这是真实下单的配置，含糊的代价是钱。
 */
const SaveState = memo(function SaveState({
  saving,
  dirty,
  isNew,
}: {
  saving: boolean;
  dirty: boolean;
  isNew: boolean;
}) {
  if (saving) {
    return (
      <Badge tone="accent">
        <LoaderCircle aria-hidden className="h-3 w-3 animate-spin" />
        正在保存…
      </Badge>
    );
  }
  if (dirty) {
    // `title` 而不是 Tooltip：Tooltip 的 Trigger 用 `asChild` + ref，
    // 而 Badge 不是 forwardRef 组件，ref 与事件都会被丢掉。
    return (
      <Badge tone="warn" title="修改只存在于这个页面，按 ⌘S 或点「保存修改」写入服务端">
        <TriangleAlert aria-hidden className="h-3 w-3" />
        有未保存的修改
      </Badge>
    );
  }
  if (isNew) return <Badge tone="accent">尚未创建</Badge>;
  return <Badge tone="up">已保存</Badge>;
});
