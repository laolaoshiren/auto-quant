import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TraderMode, TraderStatus } from '@aq/shared';
import {
  api,
  type AiModelRow,
  type DiscoverModelsResult,
  type EquitySource,
  type ExchangeAccountRow,
  type PreflightCheck,
  type TraderRow,
} from '../lib/api';
import { useApp } from '../lib/store';
import { Badge, Button, ErrorNote, Field, Modal, NumberInput, Select, Spinner3, TextInput } from './ui';
import { CheckList } from './Badges';
import { EquitySourceField, equityPayload, useExchangeEquity } from './EquitySourceField';
import { fmtUsd } from '../lib/format';
import type { Catalog } from '../lib/api';

/* -------------------------------------------------------------------------- */
/*  Create a trader                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 提交时该给 `strategyId` 传什么 —— **AI 托管一律 `null`**。
 *
 * ## 为什么这行逻辑要单独抽出来
 *
 * 它原来内联在 `submit()` 里写的是 `Number(strategyId)`（无条件），而服务端
 * 在 `mode === 'ai_managed'` 时**主动拒绝**非 null 的 `strategyId`：
 *
 *   throw new Error('智能托管模式不引用任何策略 —— 请不要为它选择策略。');
 *
 * 后果是 **AI 托管模式下创建机器人必定失败**（用户 2026-10-03 报的
 * 「创建不了机器人」）。而这种"两处规则必须一致、却各自写一遍"的分歧，
 * 靠人记住是防不住的 —— 抽成纯函数之后，`strategyIdFor` 有测试钉着，
 * 谁改坏了都会红。
 *
 * ## 为什么不是"下拉框 disabled 就够了"
 *
 * `disabled` 只阻止**用户交互**，不改变 state 里那个值 —— 它仍然是一个真实
 * 策略 id（`#9`），提交时照样会被带上。**界面上"选不了"不等于请求里"没有"。**
 */
export function strategyIdFor(mode: TraderMode, selected: number): number | null {
  return mode === 'ai_managed' ? null : selected;
}

export function NewTraderModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (trader: TraderRow) => void;
}) {
  const [accounts, setAccounts] = useState<ExchangeAccountRow[] | null>(null);
  const [models, setModels] = useState<AiModelRow[] | null>(null);
  const [strategyList, setStrategyList] = useState<Array<{ id: number; name: string }> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /**
   * 厂商目录（`LlmProviderDescriptor[]`）与默认模型。
   *
   * 原来 `catalog` 只是 `.then()` 里的一个局部变量，用完就丢了 ——
   * 而两级选择需要它（第一个下拉就是厂商列表）。
   */
  const [catalog, setCatalog] = useState<Catalog | null>(null);

  const [name, setName] = useState('');
  const [exchangeAccountId, setExchangeAccountId] = useState<number | ''>('');
  const [aiModelId, setAiModelId] = useState<number | ''>('');
  /*
   * 两级选择的中间态 —— 见下面「AI 模型」那一栏上的说明。
   *
   * `providerId` 是厂商，`modelChoice` 是模型下拉的**编码值**：
   *   · 纯数字（`"3"`）→ 该厂商下**已有**的模型记录，直接用它的 id
   *   · `new:<modelId>` → 该厂商内置建议里、**还没有记录**的模型；
   *     提交时先建一条记录再创建机器人
   */
  const [providerId, setProviderId] = useState<string>('');
  const [modelChoice, setModelChoice] = useState<string>('');
  /**
   * 每个厂商**从它自己的接口读回来**的模型列表，按 provider id 缓存。
   *
   * ## 为什么必须是"读取接口"，而不是内置静态列表
   *
   * 二级选择里"用户没自定义"的那一半，要展示的正是**该厂商此刻真正提供**的模型。
   * 内置的 `descriptor.models` 是一份手抄的提示，而它对聚合网关这类厂商**故意留空**
   * （`LLM_PROVIDERS` 里 commandcode 的 `models: []`）—— 于是选了 Command Code 之后
   * 那个下拉是**空的**，提示还写着"可以到「AI 模型」页添加"，恰好把这次要消掉的那一步
   * 又推回给用户。实测该厂商有 **71 个**可用模型，一个都不显示。
   *
   * 所以这里直接用**该厂商已存密钥**去问它的 `/models`：这正是 `discoverModels()`
   * 存在的理由，也让"模型列表会随上游变"这件事自动成立。
   *
   * ## 为什么缓存
   *
   * 用户在"厂商"下拉里来回比较是常态，而每次切换都发一次外部请求既慢又白费配额。
   * 一个厂商在一个弹窗的生命周期里只读一次。
   */
  const [discovered, setDiscovered] = useState<Record<string, DiscoverModelsResult>>({});
  /**
   * **正在读取哪个厂商** —— 记厂商 id，而不是一个布尔值。
   *
   * 布尔值在这里是错的：用户在读取途中切到另一个**已缓存**的厂商时，effect 会从
   * "已读过"那条分支提前返回，于是那个 `true` 再也没有人负责关掉 —— 界面上会
   * 一直显示"正在读取该厂商当前可用的模型…"，而请求其实早就结束了。
   * 记 id 之后，"读取中"只在它确实是**当前这个厂商**时才成立。
   */
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [strategyId, setStrategyId] = useState<number | ''>('');
  /** 运行模式。默认按策略，与既有行为一致。 */
  const [mode, setMode] = useState<TraderMode>('strategy');
  const [cycleIntervalMinutes, setCycleIntervalMinutes] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the server could not seed the baseline from the exchange. */
  const [baselineWarning, setBaselineWarning] = useState<string | null>(null);

  const selectedAccountId = exchangeAccountId === '' ? 0 : Number(exchangeAccountId);
  // The credential's own read error, so the field explains the failure even
  // before our own `?refresh=1` probe comes back.
  const selectedAccount = accounts?.find((row) => row.id === selectedAccountId) ?? null;
  const equity = useExchangeEquity({
    open,
    exchangeAccountId: selectedAccountId,
    fallbackError: selectedAccount?.balanceError ?? null,
  });

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoadError(null);
    setBaselineWarning(null);
    void Promise.all([api.exchangeAccounts(), api.aiModels(), api.strategies(), api.catalog()])
      .then(([accountRows, modelRows, strategyRows, catalog]) => {
        if (!alive) return;
        setAccounts(accountRows);
        setModels(modelRows);
        setStrategyList(strategyRows.map((s) => ({ id: s.id, name: s.name })));
        setCatalog(catalog);
        if (accountRows[0]) setExchangeAccountId(accountRows[0].id);
        /*
         * 预选服务端指定的默认模型，而不是"列表第一个"。
         *
         * 列表按 id 排，所以一个**余额不足或已失效**的模型只要 id 最小，
         * 就会成为每个新机器人的默认 —— 每次创建都要手动改回来。
         * 取不到时回落到第一个，与以前的行为一致。
         *
         * ⚠️ 预选必须**同时**写满两级。改两级选择时这里漏过一次：只写了 `aiModelId`，
         * 而提交校验看的是 `modelChoice` —— 于是默认值形同虚设，每次新建机器人都
         * 要把厂商和模型各选一遍，而界面上看不出默认值其实已经"选好了"。
         * 一条被后续校验绕过的赋值，比没有它更难发现。
         */
        const preferred = catalog.defaultAiModelId;
        const preselected =
          (preferred ? modelRows.find((m) => m.id === preferred) : undefined) ?? modelRows[0];
        if (preselected) {
          setProviderId(preselected.provider);
          setModelChoice(String(preselected.id));
          setAiModelId(preselected.id);
        }
        if (strategyRows[0]) setStrategyId(strategyRows[0].id);
      })
      .catch((err: Error) => alive && setLoadError(err.message));
    return () => {
      alive = false;
    };
  }, [open]);

  const ready = accounts !== null && models !== null && strategyList !== null;
  /*
   * 两级选择的派生数据 —— 正是"2 种情况"：
   *
   *   · `configuredModels` —— 该厂商**已配置的**记录（用户自定义的）
   *   · `availableModels`  —— **从厂商接口读回来的**、还没有记录的那些
   */
  const providers = catalog?.providers ?? [];
  const descriptor = providers.find((p) => p.id === providerId);
  const configuredModels = (models ?? []).filter((m) => m.provider === providerId);
  const providerDiscovery = providerId ? discovered[providerId] : undefined;
  /** 该厂商有没有一条带密钥的记录 —— 没有就读不了它的模型列表。 */
  const canDiscover = (models ?? []).some((m) => m.provider === providerId && m.hasKey);
  const discovering = providerId !== '' && loadingProvider === providerId;

  /*
   * 选了厂商就去问它有哪些模型。
   *
   * 密钥只存在服务端，所以这里只传**记录 id**，由服务端取密钥并发出请求 ——
   * 密钥本身永远不下发到浏览器（这一点与「AI 模型」页的获取按钮是同一条路径）。
   */
  useEffect(() => {
    if (!open || !providerId) return;
    if (discovered[providerId]) return; // 这个厂商已经读过了
    const rows = (models ?? []).filter((m) => m.provider === providerId);
    const withKey = rows.find((m) => m.hasKey);
    if (!withKey) return; // 没有密钥 —— 读不了，由提示说明原因

    let alive = true;
    setLoadingProvider(providerId);
    api
      .discoverModels({
        provider: providerId,
        // 用这条记录自己的 baseUrl：`custom` 厂商的内置 baseUrl 是空的。
        baseUrl: withKey.baseUrl,
        apiKey: '',
        modelId: withKey.id,
      })
      .then((result) => {
        if (alive) setDiscovered((prev) => ({ ...prev, [providerId]: result }));
      })
      .catch(() => {
        /* 读不到就停在"未读取"，由提示说明；不打断创建流程。 */
      })
      .finally(() => {
        if (alive) setLoadingProvider(null);
      });
    return () => {
      alive = false;
    };
  }, [open, providerId, models, discovered]);

  /*
   * 接口结果优先，读不到时才回落到内置提示。
   *
   * 回落是有意的：一个还没有密钥的厂商仍值得显示"它大概有哪些模型"，
   * 但那必须**标明是建议** —— 不能让用户以为那是该账号真正可用的清单。
   */
  const availableModels = (() => {
    const configured = new Set(configuredModels.map((m) => m.model));
    const fromApi = providerDiscovery?.ok ? providerDiscovery.models.map((m) => m.id) : null;
    const source = fromApi ?? descriptor?.models ?? [];
    return { ids: source.filter((id) => !configured.has(id)), live: fromApi !== null };
  })();

  const missing = useMemo(() => {
    const gaps: string[] = [];
    if (accounts && accounts.length === 0) gaps.push('交易所凭证');
    if (models && models.length === 0) gaps.push('AI 模型');
    if (strategyList && strategyList.length === 0) gaps.push('策略');
    return gaps;
  }, [accounts, models, strategyList]);

  const submit = async () => {
    setError(null);
    setBaselineWarning(null);
    if (!name.trim()) return setError('请为机器人起个名字。');
    /*
     * 校验按 `modelChoice` 而不是 `aiModelId` —— 选了"厂商建议"里的模型时
     * `aiModelId` 还是空的（它的记录要等到下面才建）。
     */
    if (exchangeAccountId === '' || modelChoice === '' || strategyId === '') return setError('请选择凭证、模型与策略。');

    setBusy(true);
    try {
      /*
       * 选了「厂商建议」里的模型 → **先建一条记录**，再拿它的 id 创建机器人。
       *
       * ## 为什么必须有这一步
       *
       * 机器人绑定的是 `ai_model_id`（一条记录），而不是"厂商 + 型号"这对字符串。
       * 而"厂商建议"里那些模型**还没有记录** —— 不建就只能让用户先去模型管理页
       * 手工添加，那正是这次要消掉的那一步。
       *
       * ## 空 API Key 是允许的
       *
       * 服务端的 `apiKey` 默认空串，而 `custom` / 网关类厂商本来就可能没有 Key。
       * 所以这里建出来的记录**可能还没有密钥** —— 那没关系：机器人启动时才需要它，
       * 而用户随后可以在模型管理页补上。**不因此拦住创建机器人。**
       */
      let resolvedModelId = Number(aiModelId);
      if (modelChoice.startsWith('new:')) {
        const modelId = modelChoice.slice(4);
        const created = await api.createAiModel({
          provider: providerId,
          label: `${descriptor?.label ?? providerId} · ${modelId}`,
          model: modelId,
          baseUrl: descriptor?.baseUrl ?? '',
          apiKey: '',
        });
        resolvedModelId = created.id;
      }

      const manualEquity = equityPayload(equity);
      const trader = await api.createTrader({
        name: name.trim(),
        exchangeAccountId: Number(exchangeAccountId),
        aiModelId: resolvedModelId,
        /*
         * ⚠️ **AI 托管必须传 `null`，不能传下拉框里选中的那个 id。**
         *
         * 服务端在 `mode === 'ai_managed'` 时**主动拒绝**任何非 null 的 `strategyId`：
         *
         *   throw new Error('智能托管模式不引用任何策略 —— 请不要为它选择策略。');
         *
         * 而这里原来无条件写 `Number(strategyId)` —— 下拉框虽然被 `disabled`，
         * 它的值仍然是一个真实策略（`#9`），于是**AI 托管模式下创建机器人必定失败**。
         * 用户 2026-10-03 报的「创建不了机器人」就是它（错误文字与上面一字不差）。
         *
         * 下拉框保留在界面上是为了"策略模式"能用它，不是为了给 AI 托管传值。
         */
        strategyId: strategyIdFor(mode, Number(strategyId)),
        mode,
        cycleIntervalMinutes,
        // Omitted unless the operator took over: the server then reads the real
        // wallet balance itself. `undefined` drops the key from the JSON body.
        ...(manualEquity !== undefined ? { initialEquity: manualEquity } : {}),
      });

      if (trader.equitySource === 'unavailable') {
        // The trader exists, but its return baseline is 0 — every performance
        // percentage derived from it will be meaningless. Say so and let the
        // operator act, without throwing their work away.
        setBaselineWarning(
          '机器人已创建，但未能从交易所读取钱包余额，起始权益被记为 0。在凭证可用之前，该机器人的收益率等业绩指标都没有意义。',
        );
        return;
      }

      onCreated({ ...trader, isRunning: false });
      setName('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建机器人"
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit} busy={busy} disabled={!ready || missing.length > 0}>
            创建机器人
          </Button>
        </>
      }
    >
      {!ready && !loadError && <Spinner3 label="正在加载凭证与策略" />}

      {loadError && <ErrorNote>{loadError}</ErrorNote>}

      {ready && missing.length > 0 && (
        <div className="mb-3 rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-base text-warn">
          创建机器人前，需要先添加{missing.join('、')}。
          {accounts && accounts.length === 0 && (
            <>
              {' '}
              <Link to="/exchanges" className="font-semibold underline">
                前往交易所页添加凭证
              </Link>
              。
            </>
          )}
        </div>
      )}

      {ready && missing.length === 0 && (
        <div className="space-y-3">
          <Field label="名称" hint="在控制台与审计记录中显示。">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="BTC 动量 · 模拟"
              autoFocus
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="交易所凭证">
              <Select value={exchangeAccountId} onChange={(e) => setExchangeAccountId(Number(e.target.value))}>
                {accounts?.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label} · {account.testnet ? '测试网' : '主网'}
                  </option>
                ))}
              </Select>
            </Field>

            {/*
              两级：**先厂商、再模型**。

              原来只有一个下拉，列的是 ai_models 里已配置的记录 ——
              于是「我想用 Command Code 的某个模型」必须先去模型管理页建一条
              记录、再回来选。而用户此刻的意图是「建一个机器人」。

              两级之后，第二个下拉给出两种情况：
                · 该厂商**已配置的**模型（用户自定义的）
                · 该厂商**接口读回来的**模型（选中后在提交时自动建记录）

              第二种**必须来自接口**而不是内置静态列表：聚合网关的内置列表是空的，
              照静态列表做出来的下拉在那些厂商上会一个模型都不显示。
            */}
            <Field label="模型厂商">
              <Select
                value={providerId}
                onChange={(e) => {
                  // 换厂商就把模型清掉 —— 上一个厂商的模型在这里毫无意义。
                  setProviderId(e.target.value);
                  setModelChoice("");
                  setAiModelId("");
                }}
              >
                <option value="">请选择厂商</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="模型"
              hint={
                !providerId
                  ? "先选一个模型厂商。"
                  : discovering
                    ? "正在读取该厂商当前可用的模型…"
                    : availableModels.live
                      ? configuredModels.length > 0
                        ? "已配置的在前，该厂商当前可用的在后（选后者会自动建一条记录）。"
                        : "来自该厂商接口的实时列表（选中后会自动建一条记录）。"
                      : configuredModels.length > 0
                        ? "已配置的。未能从该厂商接口读取模型列表。"
                        : "该厂商还没有可选模型。"
              }
            >
              <Select
                value={modelChoice}
                disabled={!providerId}
                onChange={(e) => {
                  const value = e.target.value;
                  setModelChoice(value);
                  /*
                   * 已配置的：编码就是它的数字 id，直接填 aiModelId。
                   * 读回来的：编码是 new:<模型id>，**提交时才建记录** ——
                   * 不在 onChange 里建，否则用户每试一个型号都会留下一条
                   * 用不上的记录。
                   */
                  setAiModelId(value.startsWith("new:") ? "" : Number(value));
                }}
              >
                <option value="">请选择模型</option>
                {configuredModels.length > 0 && (
                  <optgroup label="已配置">
                    {configuredModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label} · {model.model}
                      </option>
                    ))}
                  </optgroup>
                )}
                {availableModels.ids.length > 0 && (
                  <optgroup label={availableModels.live ? "厂商可用模型" : "厂商建议"}>
                    {availableModels.ids.map((id) => (
                      <option key={id} value={"new:" + id}>
                        {id}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
              {/*
                读不到原因必须说出来。一个空下拉配上"该厂商还没有可选模型"，
                会让用户以为这个厂商真的没模型 —— 而实际原因可能是密钥没配、
                或者密钥被拒。两种情况要做的事完全不同。
              */}
              {providerId && !discovering && providerDiscovery && !providerDiscovery.ok && (
                <p className="mt-1 text-xs text-warn">{providerDiscovery.message}</p>
              )}
              {providerId && !discovering && !providerDiscovery && !canDiscover && (
                <p className="mt-1 text-xs text-ink-faint">
                  该厂商还没有带密钥的记录，无法读取它的模型列表 —— 到「AI 模型」页添加一条并填上 API
                  Key，回来就会自动列出。
                </p>
              )}
            </Field>
          </div>

          {/*
            运行模式。
            
            AI 托管**不是一个策略** —— 策略是"一组固定参数"，而 AI 模式的意思是
            "没有固定参数"。所以它是机器人自己的一个属性，在创建时选。
          */}
          <Field
            label="运行模式"
            hint="AI 托管下参数由 AI 自己设定并持续调整，交易提示词也是它的一部分 —— 一份固定不变的提示词称不上智能。"
          >
            <div className="flex flex-col gap-1.5">
              <label className="flex cursor-pointer items-start gap-2 text-base">
                <input
                  type="radio"
                  name="trader-mode"
                  className="mt-0.5"
                  checked={mode === 'strategy'}
                  onChange={() => setMode('strategy')}
                />
                <span>
                  <span className="font-medium">按策略参数</span>
                  <span className="block text-xs text-ink-faint">
                    用下面选中的策略里的固定参数跑。行为与以前完全一致。
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-base">
                <input
                  type="radio"
                  name="trader-mode"
                  className="mt-0.5"
                  checked={mode === 'ai_managed'}
                  onChange={() => setMode('ai_managed')}
                />
                <span>
                  <span className="font-medium">AI 智能托管（全自动）</span>
                  <span className="block text-xs text-ink-faint">
                    参数与交易提示词全部由 AI 自主设定并实时调整：周期、标的池、杠杆、仓位、
                    止损止盈、节流与冷却。以盈利为唯一目标，并根据真实交易结果不断反思、迭代。
                  </span>
                </span>
              </label>
            </div>
          </Field>

          <Field
            label="策略"
            hint={
              mode === 'ai_managed'
                ? 'AI 托管模式下这项被忽略 —— 参数来自 AI 自己（每个机器人独立一份）。仍需选一个是为了保留数据库约束，它不会影响 AI 的决策。'
                : undefined
            }
          >
            <Select
              value={strategyId}
              onChange={(e) => setStrategyId(Number(e.target.value))}
              disabled={mode === 'ai_managed'}
            >
              {strategyList?.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="周期间隔（分钟）" hint="多久向模型请求一次决策。">
            <NumberInput value={cycleIntervalMinutes} onValueChange={setCycleIntervalMinutes} step={1} />
          </Field>

          {/* 起始权益 is read from the selected credential, not typed -------- */}
          <EquitySourceField state={equity} />

          {baselineWarning && (
            <div className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-base text-warn">
              <span className="font-semibold">权益基准为 0。</span> {baselineWarning}
            </div>
          )}

          {error && <ErrorNote>{error}</ErrorNote>}

          <p className="text-xs leading-relaxed text-ink-faint">
            创建机器人并不会启动它。启动时会要求你确认模拟或实盘模式，并在循环开始前展示预检项。
          </p>
        </div>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Start a trader — paper by default, preflight results rendered              */
/* -------------------------------------------------------------------------- */

export function StartTraderModal({
  trader,
  open,
  onClose,
  onStarted,
  initialDryRun = true,
}: {
  trader: TraderRow | null;
  open: boolean;
  onClose: () => void;
  onStarted: (status: TraderStatus) => void;
  initialDryRun?: boolean;
}) {
  const [dryRun, setDryRun] = useState(initialDryRun);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null);
  const [started, setStarted] = useState(false);

  const environmentLabel = useApp((s) => s.system?.environmentLabel ?? 'Binance USDⓈ-M Futures');

  useEffect(() => {
    if (open) {
      setDryRun(initialDryRun);
      setError(null);
      setChecks(null);
      setStarted(false);
    }
  }, [open, initialDryRun]);

  if (!trader) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.startTrader(trader.id, dryRun);
      setChecks(result.preflight ?? []);
      setStarted(true);
      onStarted('running');
    } catch (err) {
      const apiError = err as Error & { payload?: unknown };
      const payload = apiError.payload as { preflight?: PreflightCheck[] } | null;
      if (payload?.preflight) setChecks(payload.preflight);
      setError(apiError.message);
    } finally {
      setBusy(false);
    }
  };

  const blocking = (checks ?? []).some((check) => !check.ok && check.blocking);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`启动“${trader.name}”`}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>{started ? '关闭' : '取消'}</Button>
          {!started && (
            <Button variant={dryRun ? 'primary' : 'warn'} onClick={run} busy={busy}>
              {dryRun ? '以模拟模式启动' : '实盘启动 — 真实资金'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setDryRun(true)}
            aria-pressed={dryRun}
            className={`rounded-md border px-3 py-2.5 text-left transition ${
              dryRun ? 'border-accent/70 bg-accent/10' : 'border-base-700 bg-base-850 hover:border-base-600'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-ink-hi">模拟</span>
              <Badge tone="accent">dryRun: true</Badge>
              <Badge tone="muted">推荐</Badge>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-ink-lo">
              订单基于实时行情模拟撮合，不涉及任何交易所凭证，也不会产生真实盈亏。
            </p>
          </button>

          <button
            type="button"
            onClick={() => setDryRun(false)}
            aria-pressed={!dryRun}
            className={`rounded-md border px-3 py-2.5 text-left transition ${
              !dryRun ? 'border-warn/70 bg-warn/10' : 'border-base-700 bg-base-850 hover:border-base-600'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-ink-hi">实盘</span>
              <Badge tone="warn">dryRun: false</Badge>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-ink-lo">
              在 {environmentLabel} 上用真实资金下真实订单。每次开仓都会带上交易所侧止损。
            </p>
          </button>
        </div>

        {!dryRun && (
          <div className="rounded-md border border-warn/60 bg-warn/10 px-3 py-2 text-base text-warn">
            <span className="font-semibold">你即将使用真实资金交易。</span>{' '}
            风控引擎仍会限制杠杆与仓位并要求止损，但亏损是真实且不可逆的 — 启动后该循环会持续下单，直到你停止它。
          </div>
        )}

        {error && <ErrorNote>{error}</ErrorNote>}

        {checks && checks.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="panel-title">预检项</span>
              <Badge tone={blocking ? 'down' : 'up'}>{blocking ? '被阻断' : '已通过'}</Badge>
            </div>
            <CheckList checks={checks} />
          </div>
        )}

        {started && !blocking && (
          <div className="rounded-md border border-up/50 bg-up/10 px-3 py-2 text-base text-up">
            循环正在启动。实时状态、委托与决策将流入面板。
          </div>
        )}

        {!checks && (
          <p className="text-xs leading-relaxed text-ink-faint">
            启动会执行完整预检：时钟漂移、交易所连通性、交易对目录、凭证权限与模型可达性。策略中的回撤与
            单日亏损熔断从第一个周期起生效。
          </p>
        )}

        {trader.lastError && (
          <div className="rounded-md border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
            最近错误： <span className="num">{trader.lastError}</span>
          </div>
        )}

        <div className="num flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-base-800 pt-2 text-xs text-ink-faint">
          <span>每 {trader.cycleIntervalMinutes}m 一个周期</span>
          <span title="创建时从交易所读取的基准，用于计算总收益率。">
            起始权益 {fmtUsd(trader.initialEquity, 0)}
          </span>
          <span>已运行周期 {trader.lastCycleNumber}</span>
        </div>
      </div>
    </Modal>
  );
}
