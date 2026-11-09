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
  Empty,
  ErrorNote,
  Field,
  Modal,
  Panel,
  Select,
  Spinner,
  Spinner3,
  TextInput,
  cn,
} from '../ui';
import { SectionLabel } from '../shell';
import { PageActions } from '../../templates/lib/PageActions';
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
/**
 * 把接口带回来的 `health` 快照转成 `TestOutcome` 认识的结果。
 *
 * ## 为什么必须有这一步（2026-10-10，用户第三次报同一个问题）
 *
 * 用户的原话：「这个页面点了测试刷新又没了记录问题还是没修复啊」。
 *
 * 根因是**后端存了、前端没读**：`testResult` 是组件内存里的一个 map，
 * 刷新就空 —— 于是永远显示「从未测试」。而 `/api/ai-models` 早就把每次测试
 * 与每次模型调用的成败写进 `llm_health:<id>` 并随行返回（`row.health`）。
 *
 * **一个字段只要没人读，它就不算存在。** 这次是第三次因为"只做了一半"而返工。
 */
function healthToResult(
  health: AiModelRow['health'],
): (ModelTestResult & { at: number }) | undefined {
  if (!health) return undefined;
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
  isDefault,
  onTest,
  onEdit,
  onSetDefault,
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
  /** 新建机器人时会不会预选这一行。 */
  isDefault: boolean;
  onTest: (row: AiModelRow) => void;
  onEdit: (row: AiModelRow) => void;
  onSetDefault: (row: AiModelRow) => void;
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
      <td className="td hidden px-2 py-1.5 2xl:table-cell">
        <SecretChip hasKey={row.hasKey} masked={row.apiKeyMasked} />
      </td>
      <td className="td hidden max-w-[220px] px-2 py-1.5 2xl:table-cell">
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
          {/*
            「默认」是一个**标记**而不是一个按钮：已经是默认时不该再有一个可点的
            "设为默认"，那会让操作员怀疑自己点没点上。不是默认时才给按钮。
          */}
          {isDefault ? (
            <span className="px-1 text-xs text-ink-faint" title="新建机器人时会预选这个模型">
              默认
            </span>
          ) : (
            <Button
              small
              variant="ghost"
              onClick={() => onSetDefault(row)}
              title="新建机器人时预选这个模型（而不是列表里的第一个）"
            >
              设为默认
            </Button>
          )}
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
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<number, ModelTestResult & { at: number }>>({});
  const [testingId, setTestingId] = useState<number | null>(null);
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⭐ **一键测试全部**（2026-10-14 用户要求）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 为什么需要它
   *
   * 单个模型的「测试」按钮早就有（见 `test`），但**配置了十几个模型时**，
   * 逐个点等于十几次点击 + 十几次等待，而用户真正想回答的问题是
   * "**我这一批模型里哪些是通的**"。
   *
   * ## 设计取舍
   *
   * ```
   *   ① 并发数限制 4 —— 不是无限并发
   *      每个测试都是真实的上游请求（可能跨洋），同时发十几个会让
   *      网关侧限流或本机连接打满；而**串行**在十几个模型时太慢。
   *   ② 进度必须可见 —— `测试中 3/8`
   *      十几个请求可能要十几秒；没有进度条的等待会被当成"卡住了"，
   *      用户会重复点击（而那会**再发一轮请求**）。
   *   ③ 结果复用 `testResult` —— 与单个测试同一个 state
   *      于是表格里每个模型那一格会自动显示结果，不需要第二套渲染。
   *   ④ 结束时给一行汇总 —— `8 个通过 · 2 个失败`
   *      用户要的是结论，不是自己数格子。
   * ```
   *
   * ⚠️ **不覆盖已有结果时的问题**：批量测试会覆盖之前单个测试的结果 ——
   * 那是**对的**（新结果比旧结果有价值），而且 `at` 时间戳会更新，
   * 界面上的"多久之前"跟着走。
   */
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [batchSummary, setBatchSummary] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<DiscoverModelsResult | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [draftTest, setDraftTest] = useState<ModelTestResult | null>(null);
  const [testingDraft, setTestingDraft] = useState(false);
  const [filter, setFilter] = useState('');
  const [rowLimit, setRowLimit] = useState(ROW_PAGE);
  /**
   * 刚设过的默认模型。
   *
   * `catalog.defaultAiModelId` 是"哪一个是默认"的**权威来源**，但它要等目录
   * 重新拉取才会动。这里存一份**乐观值**：操作员点完立刻看到标记移过去 ——
   * 否则会有几秒钟"我点了吗"的疑惑，而重拉失败时那个疑惑会一直留着。
   */
  const [defaultIdOverride, setDefaultIdOverride] = useState<number | null>(null);

  /*
   * ⚠️ **不能写 `query.data ?? []`** —— 那个字面量每轮渲染都会新建一个数组，
   * 以它为依赖的 `useMemo` / `useCallback` 于是**每轮都重算**，看起来却在做缓存。
   * （这一页的模型列表可能有几十上百项，还要过滤与分页。）
   */
  const models = useMemo(() => query.data ?? [], [query.data]);
  const providers = useMemo(() => catalog?.providers ?? [], [catalog]);

  /**
   * 供应商目录按 id 索引。
   *
   * 行里要用的两样东西都从这里来：中文名（否则表格里是裸的 `deepseek`）和默认
   * 推理参数（用来判断某一行是否被调过参）。做成 Map 是因为它按行查、每行两次。
   */
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
    setDiscovery(null);
    setDraftTest(null);
    setError(null);
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
        // 编辑已有模型时输入框是**故意**留空的（明文密钥从不回显），只发空字符串
        // 会让服务端认为"没提供密钥"而拒绝 —— 带上 id，服务端才知道该去读那条
        // 记录里已加密存储的密钥。新建时 editing 为 null，不传该字段。
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

  /* --- draft test -------------------------------------------------------- */

  const buildPayload = () => {
    const payload: Parameters<typeof api.createAiModel>[0] = {
      provider: draft.provider,
      // The server requires a name; the provider label is the natural default.
      label: draft.label.trim() || descriptor?.label || draft.provider,
      model: draft.model.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey,
      /*
       * ⚠️ **不再发送 temperature / maxTokens / timeoutSeconds / maxRetries。**
       *
       * 它们现在完全由服务端按厂商决定，而服务端的入参里也已经没有这四个字段 ——
       * 客户端继续发送只会得到一个"传了但不生效"的假契约。
       */
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
      /*
       * ⚠️ **编辑态必须带上 `modelId`，否则服务端拿不到已存密钥。**
       *
       * 界面刻意不回显明文密钥（输入框留空 = "不改它"），所以 `buildPayload()` 里的
       * `apiKey` 是空串 —— 服务端会当成"没提供密钥"，直接报 `Missing API key.`。
       * 而**同一个文件里的 `discover` 调用早就传了 `modelId`**，只有这里漏了。
       */
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

  /**
   * 指定"新建机器人时预选哪个模型"。
   *
   * 这个设置此前**读得到、用得上、改不了** —— 服务端与前端都在消费
   * `default_ai_model_id`，却没有任何地方写它。于是"取不到就回落到列表第一个"
   * 成了唯一会发生的行为。
   */
  const setDefault = useCallback(async (row: AiModelRow) => {
    setError(null);
    try {
      await api.setDefaultAiModel(row.id);
      setDefaultIdOverride(row.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

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

  /**
   * **把一次测试的结果写进 state**（单个测试与批量测试共用）。
   *
   * ⚠️ 抽出来是刻意的：批量测试如果自己再写一遍错误解析，
   * 两条路径就会漂移（本项目反复踩过"同一个算术写在两个地方"）。
   *
   * ⚠️ 必须定义在 `test` **之前** —— `test` 依赖它（TS2448：块级作用域
   * 变量不能用在使用之后）。
   */
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

  /**
   * **一键测试全部模型**（并发 4，带进度与汇总）。
   *
   * 见上面 `batch` 的设计说明。⚠️ 失败**不中断整批** —— 一个模型不通
   * 不该让其余模型测不了（那正是用户最需要看到的情况）。
   */
  const testAll = useCallback(async () => {
    const targets = models.map((m) => m.id);
    if (targets.length === 0) return;
    setBatchSummary(null);
    setBatch({ done: 0, total: targets.length });

    let ok = 0;
    let failed = 0;
    let cursor = 0;

    /* 工人函数：从共享游标取下一个任务，直到取完。 */
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
          /*
           * ⚠️ 必须**也记一条失败结果**：那个模型那一格留空的话，
           * 用户看到的是"没测过"，而不是"测了、不通"。
           */
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

    /* 并发 4：够快，又不会把网关与本机连接打满（见设计说明）。 */
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

      {/* 区块标题用 LAYOUT.md §5 的小字距标签 + 延伸线，而不是面板自带的标题栏：
          它和表格在视觉上绑在一起，而且省掉一整条 40px 的头部。 */}
      <SectionLabel
        title="已配置模型"
        count={fmtInt(models.length)}
        actions={
          /* 页面级动作 → 统一接口。禁用态跟着 providers 走，不在这里重复判断。 */
          <PageActions
            start={
              <>
                {/*
                  ⭐ **一键测试全部**（2026-10-14）。
                  ⚠️ 与「+ 添加模型」并列而不是塞进某个菜单：它是这一页第二常用的动作
                  （配完一批模型后第一件事就是问"哪些是通的"）。
                  ⚠️ 测试期间 disabled —— 重复点击会**再发一轮请求**，
                  而那在十几个模型时是明显的浪费（也可能触发网关限流）。
                */}
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
                <Button variant="primary" size="sm" onClick={openCreate} disabled={providers.length === 0}>
                  + 添加模型
                </Button>
              </>
            }
          />
        }
      />

      {/*
        批量测试的汇总 —— 只在跑完一轮之后显示。
        ⚠️ 用户要的是**结论**（"哪些不通"），而不是自己数格子；
        所以给一行"X 个通过 · Y 个失败"，失败的格子另有标记。
      */}
      {batchSummary !== null && (
        <div className="px-0.5 text-xs text-ink-mid">{batchSummary}</div>
      )}

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
              {/*
               * ⚠️ **搜索框不再占满整行**（用户 2026-11-10：「搜索框太长没有设计」）。
               * 固定 288px：一个人名的搜索框拉伸到 1500px 只会让"输入区"看起来像
               * 表单主字段，而它其实是个辅助筛选。
               */}
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
                        <th className="th px-2 py-1.5">名称</th>
                        <th className="th px-2 py-1.5">模型 · 端点</th>
                        <th className="th hidden px-2 py-1.5 2xl:table-cell">密钥</th>
                        <th className="th hidden px-2 py-1.5 2xl:table-cell">最近测试</th>
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
                          result={testResult[row.id] ?? healthToResult(row.health)}
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
          <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2">
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
                /* 已保存的模型可能有一把存在服务端的密钥 —— 输入框为空不代表"没有密钥"。 */
                hasStoredKey={editing?.hasKey ?? false}
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

          {/*
            「高级设置」面板已删除 —— 温度 / 最大输出 / 超时 / 重试次数
            **完全由系统按厂商决定**，用户不需要也不应该改它们。

            ## 为什么不该让用户改

            那四项看起来像"可调参数"，但它们其实是**厂商的属性**：
            每个厂商的合理超时与输出预算由它的接口特性决定（比如网关背后
            常常是推理模型，思考与回答共用同一个输出预算）。

            而「最大输出 Token」特别危险：这个项目的决策输出实测峰值 11487，
            把它调低会让模型**思考完之后没有额度输出决策** —— 返回空内容、
            那一轮什么都不做，而症状看起来像密钥坏了。

            所以后端也已经把这四个字段从入参里删掉了（见 `AiModelInputSchema`），
            **界面与契约同时改**，不留一个"传了但不生效"的假入口。
          */}

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

  /*
   * 提示只在"列表里什么都没有、用户也不知道下一步该做什么"时才出现，三种状态：
   *
   *   · 没有任何可用密钥（输入框为空**且**服务端也没存）→ 让他先去填 API Key；
   *   · 有密钥（刚输入的，或已存储的）但还没点过「获取可用模型」→ 邀请他去点，
   *     并说明也可以直接手填 id；
   *   · 已经获取过 / 内置建议非空 → 什么都不说（结果本身就在下面的 discovery 提示里）。
   *
   * 旧代码写的是 `!discovery && entries.length === 0`，它既漏掉了"密钥其实已经存在"
   * （于是编辑一个已保存的模型时，上方密钥标签明明显示"当前已存储"，下面却还在要求
   * 填 API Key），也把"还没获取过"误描述成"缺密钥"。判断必须同时看这两者。
   */
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
          {!discovery.ok && entries.length > 0 && (
            <>
              {' 下方列表为内置建议，并非实时结果。'}
              {/*
                ⚠️ **要说清它会过期，并给出核对的地方。**

                这份列表是手工维护的外部事实，而模型名更新很快 ——
                实测核对时发现 Gemini 那一条停在 2.5 一代、而当时已经是 3.8，
                DeepSeek 用的还是一个已被官方标为 legacy 的名字变体。

                只写「并非实时结果」不够：用户不知道**该去哪核对**。
                `docsUrl` 就在 provider 描述符里，指过去即可。
              */}
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

/* -------------------------------------------------------------------------- */
