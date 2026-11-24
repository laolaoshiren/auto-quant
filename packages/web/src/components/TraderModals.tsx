import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AI_MANAGED_PRESET_MODEL,
  DEFAULT_MANAGED_RISK_PROFILE,
  isAiDriven,
  usesModelPicker as modeUsesModelPicker,
  type ManagedRiskProfileId,
  type TraderMode,
} from '@aq/shared';
import {
  api,
  type AiModelRow,
  type DiscoverModelsResult,
  type ExchangeAccountRow,
  type TraderRow,
} from '../lib/api';
import { MODE_LABEL } from '../lib/glossary';
import { exchangeShortLabel } from './ExchangeAccountChip';
import { Badge, Button, ErrorNote, Field, Modal, NumberInput, Select, Spinner3, TextInput } from './ui';
import { EquitySourceField, equityPayload, useExchangeEquity } from './EquitySourceField';
import { ManagedRiskProfileCards } from './ManagedRiskProfileControl';
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
  /*
   * ⚠️ **用共享的 `isAiDriven`，不要写死 `'ai_managed'`**（2026-10-12 复核发现的 P0）。
   *
   * 原来写死单模式名，于是加了 `ai_team` 之后：
   *
   *   strategy   -> 返回选中的策略 id
   *   ai_managed -> null
   *   ai_team    -> **返回选中的策略 id** ← 前端把真实策略 id 提交上去
   *
   * 而服务端对所有 AI 驱动模式都会拒绝非 null 的 `strategyId`
   *（「AI 托管模式不引用任何策略」）→ **`ai_team` 机器人在界面上根本创建不出来**，
   * 报错信息还指向"策略"，与用户实际做的事（选了个 AI 团队）完全对不上。
   *
   * 这与 2026-10-03 报过的「创建不了机器人」是**同一个 bug**，
   * 只是换到了新模式的路径上 —— 因为两处规则各自写了一遍模式名。
   */
  return isAiDriven(mode) ? null : selected;
}

/**
 * 创建成功但服务端回 `equitySource: 'unavailable'` 时给操作员看的说明。
 *
 * ⚠️ **按"有没有绑账户"区分文案**（2026-11-10 审计 #2）：原来无条件说
 * 「未能从交易所读取钱包余额」—— 而不绑账户的纯模拟盘**根本没有交易所**，
 * 它走到这里只是因为模拟盘起始余额留空；运行时 `manager.paperStartingBalanceOf()`
 * 会回落到默认模拟余额。与 `TraderConfigModal` 按 `exchangeAccountId` 区分的做法一致。
 */
export function baselineWarningFor(paperOnly: boolean): string {
  return paperOnly
    ? '机器人已创建，但没有填写模拟盘起始余额，起始权益被记为 0（运行时按默认模拟余额开仓）。补上起始余额之前，该机器人的收益率等业绩指标都没有意义。'
    : '机器人已创建，但未能从交易所读取钱包余额，起始权益被记为 0。在凭证可用之前，该机器人的收益率等业绩指标都没有意义。';
}

/**
 * 「厂商建议」模型（`new:<modelId>`）在**本次弹窗里**已经建过的记录 id。
 *
 * 审计 #2：原来每次提交只要 `modelChoice` 以 `new:` 开头就先 `createAiModel` ——
 * 于是"模型建好了、机器人那一步失败后重试"会留下一条条重复的模型记录。
 * 建过一次就记住，同一个选择再提交时复用它。
 */
export function reusableModelId(
  createdModels: Readonly<Record<string, number>>,
  modelChoice: string,
): number | undefined {
  return modelChoice.startsWith('new:') ? createdModels[modelChoice] : undefined;
}

/**
 * 选中「厂商可用模型 / 建议」（`new:<modelId>`）需要临时创建模型记录时，决定它的 `baseUrl`。
 *
 * `custom` 等厂商的内置 `descriptor.baseUrl` 为空串 —— 直接传空会被服务端拒绝（400）。
 * 优先继承同厂商已有记录（尤其是带密钥的那条）的 `baseUrl`，再回落到厂商内置默认值。
 */
export function resolveNewModelBaseUrl(
  providerId: string,
  descriptorBaseUrl: string | undefined,
  existingModels: ReadonlyArray<Pick<AiModelRow, 'provider' | 'baseUrl' | 'hasKey'>>,
): string {
  const sameProvider = existingModels.filter((m) => m.provider === providerId && m.baseUrl.trim() !== '');
  const withKey = sameProvider.find((m) => m.hasKey);
  return (withKey?.baseUrl ?? sameProvider[0]?.baseUrl ?? descriptorBaseUrl ?? '').trim();
}

/**
 * 选中交易所凭证后，运行模式（模拟盘 / 实盘）的默认与约束规则。
 *
 * - 不绑账户：强制纯模拟盘（`dryRun = true`）；
 * - Gate 正式网（`gate && !testnet`）：无本地模拟盘，强制实盘（`dryRun = false`），禁用模拟盘；
 * - Gate 测试网（`gate && testnet`）：同样无本地模拟盘，测试网本身即假钱真实撮合，
 *   强制 `dryRun = false` 并禁用「本地模拟」，确保运行期与停机期展示口径与后端一致。
 */
export function accountDryRunPolicy(account: Pick<ExchangeAccountRow, 'exchange' | 'testnet'> | null): {
  defaultDryRun: boolean;
  paperDisabled: boolean;
  liveDisabled: boolean;
  isGateMainnet: boolean;
  isGateTestnet: boolean;
} {
  if (!account) {
    return {
      defaultDryRun: true,
      paperDisabled: false,
      liveDisabled: true,
      isGateMainnet: false,
      isGateTestnet: false,
    };
  }
  const isGateMainnet = account.exchange === 'gate' && !account.testnet;
  const isGateTestnet = account.exchange === 'gate' && account.testnet;
  return {
    defaultDryRun: account.exchange === 'gate' ? false : true,
    paperDisabled: account.exchange === 'gate',
    liveDisabled: false,
    isGateMainnet,
    isGateTestnet,
  };
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
  /**
   * 绑定的交易所账户。
   *
   * ⚠️ **`''` 现在是一个有意义的取值**（用户 2026-10-27 需求）：
   * 它表示"不绑账户"= 纯模拟盘机器人。这类机器人不下真实订单、余额由本地台账
   * 折算，所以不需要任何真实交易所账户。
   *
   * 原先 `''` 只是"还没选"的中间态，而提交按钮会因为 `missing` 里有
   * 「交易所凭证」而禁用 —— 于是"想先拿模拟盘试试"被卡在"先去交易所注册"。
   */
  const [exchangeAccountId, setExchangeAccountId] = useState<number | ''>('');
  /**
   * **模拟盘起始余额**（USDT）。空字符串 = 用默认值（1000）。
   *
   * 用户原话：「模拟盘不应该根据真实钱包的余额，而应该可以自定义模拟盘的余额」。
   *
   * 只有模拟盘会用它 —— 实盘机器人读交易所余额，这个输入框在实盘下不显示。
   */
  const [paperBalance, setPaperBalance] = useState<string>('1000');
  /**
   * **运行模式：模拟盘 / 实盘 —— 创建时固定**（2026-11-10 用户要求）。
   *
   * 用户原话：「应该是由创建机器人的时候决定固定，而不是运行启动机器人的时候来决定」。
   *
   * 默认 `true`（模拟盘）：危险的那条路要操作员自己走过去。
   * 选实盘必须已绑定交易所账户（没有账户的机器人在服务端会被拒绝）。
   */
  const [dryRun, setDryRun] = useState(true);
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
   * **模型搜索词**（用户 2026-11-10：「模型选择里面要有快速搜索定位功能」）。
   *
   * 网关下挂着两百多个模型，而模型下拉是原生 `<select>` —— 不能输入、只能滚。
   * 这里加一个搜索框，按"标签 / 模型 id"过滤两个分组里的选项。
   */
  const [modelQuery, setModelQuery] = useState<string>('');
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
  /** 智能托管 2.0 风险护栏档位（默认平衡档：主流 20x / 山寨 10x）。 */
  const [managedRiskProfile, setManagedRiskProfile] = useState<ManagedRiskProfileId>(
    DEFAULT_MANAGED_RISK_PROFILE,
  );
  const [cycleIntervalMinutes, setCycleIntervalMinutes] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the server could not seed the baseline from the exchange. */
  const [baselineWarning, setBaselineWarning] = useState<string | null>(null);
  /**
   * **已经建好、但还没交给父页面的那台机器人**（审计 #2）。
   *
   * `equitySource === 'unavailable'` 时弹窗要留着把警告给人看 —— 但机器人
   * 其实已经建好了。原来这时「创建机器人」按钮仍可点，再点一次就建出同名的
   * 第二台。现在：按钮变成「完成」（交给父页面刷新列表并关弹窗），
   * 关闭弹窗同样把它交出去，**不能再提交一次**。
   */
  const [createdPending, setCreatedPending] = useState<TraderRow | null>(null);
  /** 本次弹窗里已建的「厂商建议」模型记录：`new:<modelId>` → id。见 `reusableModelId`。 */
  const createdModelsRef = useRef<Record<string, number>>({});

  const selectedAccountId = exchangeAccountId === '' ? 0 : Number(exchangeAccountId);
  // The credential's own read error, so the field explains the failure even
  // before our own `?refresh=1` probe comes back.
  const selectedAccount = accounts?.find((row) => row.id === selectedAccountId) ?? null;
  const runPolicy = accountDryRunPolicy(selectedAccount);
  const usesModelPicker = modeUsesModelPicker(mode);
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
    setCreatedPending(null);
    createdModelsRef.current = {};
    void Promise.all([api.exchangeAccounts(), api.aiModels(), api.strategies(), api.catalog()])
      .then(([accountRows, modelRows, strategyRows, catalog]) => {
        if (!alive) return;
        setAccounts(accountRows);
        setModels(modelRows);
        setStrategyList(strategyRows.map((s) => ({ id: s.id, name: s.name })));
        setCatalog(catalog);
        /*
         * ⚠️ **默认不绑账户（纯模拟盘）**（用户 2026-10-27 需求）。
         *
         * 原来这里是 `if (accountRows[0]) setExchangeAccountId(accountRows[0].id)` ——
         * 自动选中第一条真实凭证。而模拟盘是**默认的运行模式**（启动时才选，
         * 默认 dryRun=true），于是一个"默认配置"的机器人会绑上一个它根本不会
         * 用的账户，还让操作员以为余额来自那里。
         *
         * 现在默认是"不绑账户"，要绑账户由操作员显式选 ——
         * 与"实盘必须显式要求"是同一条纪律：**危险的那条路要人自己走过去**。
         */
        setExchangeAccountId('');
        /* 运行模式也回到默认的模拟盘（创建时固定，见状态说明）。 */
        setDryRun(true);
        /* 模型搜索词也清空（否则上次的过滤会让默认模型"消失"）。 */
        setModelQuery('');
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
  const allProviders = catalog?.providers ?? [];
  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **厂商下拉只列「实际添加过的」**（2026-10-19 用户报 BUG）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 用户原话
   *
   * > 「新建机器人页面 模型厂商BUG了，根本没有读实际的模型厂商……
   * >   新建机器人和修改机器人配置里面模型厂商选项应该保持一致，
   * >   并且**只读取 AI 模型里面添加过的**（也就是说和 /models 里面的保持一致才对，
   * >   不应该出现那些没添加的和缺少添加的）」
   *
   * ## 原来的 bug（已实测确认）
   *
   * 下拉用的是 `catalog.providers`，而它来自服务端的 **`LLM_PROVIDERS` 静态常量**
   *（`api/server.ts:1287`）—— 一份**代码里写死的 15 个厂商清单**，
   * 与 `ai_models` 表里实际有什么**毫无关系**。
   *
   * 线上实测的后果（`ai_models` 实际只有 4 个厂商：`commandcode` / `deepseek` /
   * `custom` / `opencode`）：
   * ```
   *   ❌ 下拉里出现了 DeepSeek / OpenAI / Claude / Gemini / Grok / Kimi / MiniMax /
   *      OpenRouter / 通义千问 —— 用户一个都没添加
   *   ❌ 用户的 magpie 与 CPA 模型（都在 `custom` 下）没有独立条目
   *   ⇒ 用户根本找不到自己配过的那个厂商
   * ```
   *
   * ## 现在的口径
   *
   * **`(models ?? [])` 里出现过的 provider，才算可选。** 顺序按静态清单排
   *（让熟悉的厂商在前），清单里没有的（例如纯自定义）排后面。
   *
   * ⚠️ **一个模型都没配置时不显示空的厂商列表** —— 那会让用户对着一个
   * 空下拉发呆。下面会提示"请先去 AI 模型里添加"。
   */
  const configuredProviderIds = new Set((models ?? []).map((m) => m.provider));
  const providers = allProviders
    .filter((p) => configuredProviderIds.has(p.id))
    .concat(
      /* 静态清单里没有、但数据库里有的（防御性：将来加了新 provider 也不会被藏起来）。 */
      [...configuredProviderIds]
        .filter((id) => !allProviders.some((p) => p.id === id))
        .map((id) => ({ id, label: id, models: [] as string[] })) as typeof allProviders,
    );
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

  /*
   * **模型搜索过滤**（用户 2026-11-10：「模型选择里面要有快速搜索定位功能」）。
   *
   * 原生 `<select>` 不能输入，而网关下挂着两百多个模型 —— 只能滚。这里先按
   * "标签 / 模型 id"过滤两个分组，再在过滤后的列表里选。
   */
  const modelQueryText = modelQuery.trim().toLowerCase();
  const shownConfigured = modelQueryText
    ? configuredModels.filter(
        (m) => m.label.toLowerCase().includes(modelQueryText) || m.model.toLowerCase().includes(modelQueryText),
      )
    : configuredModels;
  const shownAvailable = modelQueryText
    ? availableModels.ids.filter((id) => id.toLowerCase().includes(modelQueryText))
    : availableModels.ids;

  const missing = useMemo(() => {
    const gaps: string[] = [];
    /*
     * ⚠️ **交易所凭证不再是"缺少"项**（用户 2026-10-27 需求）。
     * 模拟盘不需要账户，所以凭证是可选的。
     *
     * ⚠️ **JEV / AI 团队模式走独立网关，不强制依赖隐藏的模型选择器**。
     */
    if (usesModelPicker && models && models.length === 0) gaps.push('AI 模型');
    if (!isAiDriven(mode) && strategyList && strategyList.length === 0) gaps.push('策略');
    return gaps;
  }, [models, strategyList, mode, usesModelPicker]);

  /** 把"已建好但带警告"的机器人交给父页面（父页面会关弹窗并刷新列表）。 */
  const finishPending = () => {
    if (!createdPending) return;
    const trader = createdPending;
    setCreatedPending(null);
    setBaselineWarning(null);
    setName('');
    onCreated(trader);
  };

  const submit = async () => {
    /* 机器人已经建好（只是带警告）—— 绝不能再建一次。 */
    if (createdPending) return finishPending();
    setError(null);
    setBaselineWarning(null);
    if (!name.trim()) return setError('请为机器人起个名字。');
    /*
     * 校验按 `modelChoice` 而不是 `aiModelId` —— 选了"厂商建议"里的模型时
     * `aiModelId` 还是空的（它的记录要等到下面才建）。
     * JEV / AI 团队模式隐藏了模型选择器（走 magpie 网关），不要求选择。
     */
    if (usesModelPicker && modelChoice === '') return setError('请选择 AI 模型。');
    /* ⚠️ 只有固定策略模式才要求策略 —— 见上面 `missing` 里的说明。 */
    if (!isAiDriven(mode) && strategyId === '') return setError('请选择策略。');
    /* 实盘模式必须有交易所账户 —— 服务端同样会拒（在这里先拦住，不用等一次往返）。 */
    if (!dryRun && exchangeAccountId === '') {
      return setError('实盘模式必须绑定交易所账户。没有账户的机器人只能以模拟盘运行。');
    }
    /* Gate 正式网无本地模拟盘 —— 服务端同样会拒，前端提前拦住。 */
    if (runPolicy.isGateMainnet && dryRun) {
      return setError('Gate 正式网无本地模拟盘 —— 请切换为实盘，或绑定 Gate 测试网账户 / 不绑账户（纯模拟盘）。');
    }
    /* 模拟余额仅在未绑定交易所账户（纯模拟盘）时参与校验与提交。 */
    const paperAmount =
      exchangeAccountId === '' && paperBalance.trim() !== '' ? Number(paperBalance) : 0;
    if (exchangeAccountId === '' && paperBalance.trim() !== '') {
      if (!Number.isFinite(paperAmount) || paperAmount <= 0) {
        return setError('模拟盘起始余额必须是一个大于 0 的数字。');
      }
      if (paperAmount < 10) {
        return setError('模拟盘起始余额太小（至少 10 USDT）—— 低于这个数任何仓位都会被最小下单量拒绝。');
      }
      if (paperAmount > 1_000_000_000) {
        return setError('模拟盘起始余额过大（上限 10 亿）。');
      }
    }

    setBusy(true);
    try {
      let resolvedModelId: number | undefined;
      if (usesModelPicker) {
        resolvedModelId = Number(aiModelId);
        const reused = reusableModelId(createdModelsRef.current, modelChoice);
        if (reused !== undefined) {
          resolvedModelId = reused;
        } else if (modelChoice.startsWith('new:')) {
          const modelId = modelChoice.slice(4);
          const existingSame = configuredModels.find((m) => m.model === modelId);
          if (existingSame) {
            resolvedModelId = existingSame.id;
          } else {
            const resolvedBaseUrl = resolveNewModelBaseUrl(providerId, descriptor?.baseUrl, models ?? []);
            const created = await api.createAiModel({
              provider: providerId,
              label: `${descriptor?.label ?? providerId} · ${modelId}`,
              model: modelId,
              baseUrl: resolvedBaseUrl,
              apiKey: '',
            });
            resolvedModelId = created.id;
            createdModelsRef.current = { ...createdModelsRef.current, [modelChoice]: created.id };
          }
        }
      }

      const manualEquity = equityPayload(equity);
      const trader = await api.createTrader({
        name: name.trim(),
        /*
         * `''` → `null`：不绑账户 = 纯模拟盘机器人（用户 2026-10-27 需求）。
         * 传 `null` 而不是省略，是为了让"我没有账户"这件事**显式**地送到服务端
         * （省略与 null 在创建语义上等价，但显式写出来，读代码的人不用猜）。
         */
        exchangeAccountId: exchangeAccountId === '' ? null : Number(exchangeAccountId),
        ...(resolvedModelId !== undefined ? { aiModelId: resolvedModelId } : {}),
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
        ...(mode === 'ai_managed' ? { managedRiskProfile } : {}),
        cycleIntervalMinutes,
        // Omitted unless the operator took over: the server then reads the real
        // wallet balance itself. `undefined` drops the key from the JSON body.
        ...(manualEquity !== undefined ? { initialEquity: manualEquity } : {}),
        /*
         * 模拟盘本金（用户 2026-10-27 需求）。
         * 只在**不绑账户**时发送 —— 绑了账户的机器人仍按原来的方式读真实余额，
         * 那样它的收益率分母与账户一致（既有行为一个字节都不变）。
         */
        ...(exchangeAccountId === '' && paperAmount > 0
          ? { paperStartingBalance: paperAmount }
          : {}),
        /* **运行模式在创建时固定**（2026-11-10）：true = 模拟盘，false = 实盘。 */
        dryRun,
      });

      if (trader.equitySource === 'unavailable') {
        // The trader exists, but its return baseline is 0 — every performance
        // percentage derived from it will be meaningless. Say so and let the
        // operator act, without throwing their work away.
        // ⚠️ 但机器人**已经建好**：记下来，按钮改成「完成」，不能再提交一次（审计 #2）。
        setCreatedPending({ ...trader, isRunning: false });
        setBaselineWarning(baselineWarningFor(exchangeAccountId === ''));
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
      onClose={createdPending ? finishPending : onClose}
      title="新建机器人"
      /* 两列表单 + 2×2 卡片需要更宽：`max-w-xl`（576）下两列只剩 260px，
         卡片式选项会挤成两行。`max-w-2xl`（672）在 1024 宽的窗口里仍有余量。 */
      width="max-w-2xl"
      footer={
        <>
          {createdPending ? (
            /* 机器人已建好（带警告）：只剩「完成」，关闭也等同完成 —— 列表必须刷新。 */
            <Button variant="primary" onClick={finishPending}>
              完成
            </Button>
          ) : (
            <>
              <Button onClick={onClose}>取消</Button>
              <Button variant="primary" onClick={submit} busy={busy} disabled={!ready || missing.length > 0}>
                创建机器人
              </Button>
            </>
          )}
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
        <div className="space-y-4">
          {/* Step 1: 运行方式 —— 决定后续需要填写什么配置 */}
          <section className="space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="num flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                1
              </span>
              <h3 className="text-xs font-semibold tracking-wider text-ink-mid">运行方式</h3>
              <span aria-hidden className="h-px flex-1 bg-base-800" />
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(
                [
                  {
                    id: 'ai_managed' as const,
                    label: MODE_LABEL.ai_managed,
                    desc: 'AI 自主选币与调参',
                    badge: '推荐',
                    full: '参数与交易提示词全部由 AI 自主设定并实时调整：周期、标的池、杠杆、仓位、止损止盈。',
                  },
                  {
                    id: 'strategy' as const,
                    label: MODE_LABEL.strategy,
                    desc: '按固定策略参数运行',
                    badge: null,
                    full: '按选定策略的固定参数与风控规则运行。',
                  },
                  {
                    id: 'ai_team' as const,
                    label: MODE_LABEL.ai_team,
                    desc: '多智能体协作（暂缓）',
                    badge: null,
                    full: '多智能体协作模式（当前开发中暂缓）。',
                  },
                ] as const
              ).map((option) => {
                const active = mode === option.id;
                return (
                  <label
                    key={option.id}
                    title={option.full}
                    className={`relative flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 transition ${
                      active
                        ? 'border-accent bg-accent/10 shadow-sm'
                        : 'border-base-700 bg-base-850/60 hover:border-base-600'
                    }`}
                  >
                    <input
                      type="radio"
                      name="trader-mode"
                      className="sr-only"
                      checked={active}
                      onChange={() => setMode(option.id)}
                    />
                    <span className="flex items-center justify-between gap-1.5">
                      <span className="flex items-center gap-1.5">
                        <span
                          aria-hidden
                          className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                            active ? 'border-accent' : 'border-base-600'
                          }`}
                        >
                          {active && <span className="h-2 w-2 rounded-full bg-accent" />}
                        </span>
                        <span className="text-sm font-semibold text-ink-hi">{option.label}</span>
                      </span>
                      {option.badge && <Badge tone="accent">{option.badge}</Badge>}
                    </span>
                    <span className="truncate pl-5 text-xs text-ink-lo">{option.desc}</span>
                  </label>
                );
              })}
            </div>

            {mode === 'ai_managed' && (
              <div className="space-y-2.5 rounded-lg border border-base-750 bg-base-850/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-ink-mid">风险护栏档位（运行中可随时在线切换）</span>
                  <span className="inline-flex items-center gap-1.5 text-ink-lo">
                    预设模型
                    <span className="num rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent">
                      {AI_MANAGED_PRESET_MODEL}
                    </span>
                  </span>
                </div>
                <ManagedRiskProfileCards
                  value={managedRiskProfile}
                  onChange={setManagedRiskProfile}
                />
              </div>
            )}

            {mode === 'ai_team' && (
              <p className="rounded-lg border border-base-750 bg-base-850/40 px-3 py-2 text-xs leading-relaxed text-ink-lo">
                <span className="font-medium text-ink-mid">模型由系统 magpie 网关统一调度</span>
                {' · '}不使用「AI 模型」列表。
              </p>
            )}

            {!isAiDriven(mode) && (
              <div className="space-y-3 rounded-lg border border-base-750 bg-base-850/40 p-3">
                <Field label="交易策略">
                  <Select value={strategyId} onChange={(e) => setStrategyId(Number(e.target.value))}>
                    {strategyList?.map((strategy) => (
                      <option key={strategy.id} value={strategy.id}>
                        {strategy.name}
                      </option>
                    ))}
                  </Select>
                </Field>

                {usesModelPicker && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="模型厂商">
                      <Select
                        value={providerId}
                        onChange={(e) => {
                          setProviderId(e.target.value);
                          setModelChoice('');
                          setModelQuery('');
                          setAiModelId('');
                        }}
                      >
                        <option value="">请选择厂商</option>
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.label}
                            {(() => {
                              const n = (models ?? []).filter((m) => m.provider === provider.id).length;
                              return n > 0 ? `（已配 ${n} 个）` : '';
                            })()}
                          </option>
                        ))}
                      </Select>
                      {providers.length === 0 && (
                        <p className="mt-1 text-xs text-warn">
                          还没有 AI 模型，请先到「AI 模型」页面添加。
                        </p>
                      )}
                    </Field>

                    <Field
                      label="模型"
                      hint={
                        !providerId
                          ? '先选模型厂商'
                          : discovering
                            ? '正在读取可用模型…'
                            : availableModels.live
                              ? '已配置在前，厂商可用在后（选后者自动建记录）'
                              : undefined
                      }
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <TextInput
                            value={modelQuery}
                            onChange={(event) => setModelQuery(event.target.value)}
                            placeholder={providerId ? '快速筛选模型…' : '先选厂商'}
                            disabled={!providerId}
                            aria-label="搜索模型"
                          />
                          {modelQuery && (
                            <Button size="sm" onClick={() => setModelQuery('')}>
                              清空
                            </Button>
                          )}
                        </div>
                        <Select
                          value={modelChoice}
                          disabled={!providerId}
                          onChange={(e) => {
                            const value = e.target.value;
                            setModelChoice(value);
                            setAiModelId(value.startsWith('new:') ? '' : Number(value));
                          }}
                        >
                          <option value="">请选择模型</option>
                          {shownConfigured.length > 0 && (
                            <optgroup label="已配置">
                              {shownConfigured.map((model) => (
                                <option key={model.id} value={model.id}>
                                  {model.label} · {model.model}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          {shownAvailable.length > 0 && (
                            <optgroup label={availableModels.live ? '厂商可用模型' : '厂商建议'}>
                              {shownAvailable.map((id) => (
                                <option key={id} value={'new:' + id}>
                                  {id}
                                </option>
                              ))}
                            </optgroup>
                          )}
                        </Select>
                      </div>
                      {modelQuery && shownConfigured.length === 0 && shownAvailable.length === 0 && (
                        <p className="mt-1 text-xs text-ink-faint">没有匹配「{modelQuery}」的模型。</p>
                      )}
                      {providerId && !discovering && providerDiscovery && !providerDiscovery.ok && (
                        <p className="mt-1 text-xs text-warn">{providerDiscovery.message}</p>
                      )}
                      {providerId && !discovering && !providerDiscovery && !canDiscover && (
                        <p className="mt-1 text-xs text-ink-faint">
                          该厂商尚未配置密钥，无法拉取实时模型列表。
                        </p>
                      )}
                    </Field>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Step 2: 账户与资金模式 */}
          <section className="space-y-2.5 border-t border-base-800 pt-3.5">
            <div className="flex items-center gap-2">
              <span className="num flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                2
              </span>
              <h3 className="text-xs font-semibold tracking-wider text-ink-mid">账户与资金模式</h3>
              <span aria-hidden className="h-px flex-1 bg-base-800" />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="交易所凭证" hint="不绑账户则自动运行纯本地模拟盘。">
                <Select
                  value={exchangeAccountId}
                  onChange={(e) => {
                    if (e.target.value === '') {
                      setExchangeAccountId('');
                      setDryRun(true);
                      return;
                    }
                    const nextId = Number(e.target.value);
                    setExchangeAccountId(nextId);
                    const nextAccount = accounts?.find((row) => row.id === nextId) ?? null;
                    const policy = accountDryRunPolicy(nextAccount);
                    if (policy.paperDisabled || policy.isGateTestnet) {
                      setDryRun(policy.defaultDryRun);
                    }
                  }}
                >
                  <option value="">不绑账户（纯模拟盘）</option>
                  {accounts?.map((account) => (
                    <option key={account.id} value={account.id}>
                      {exchangeShortLabel(account.exchange)} · {account.label} ·{' '}
                      {account.testnet ? '测试网' : '主网'}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="资金模式（创建后固定）"
                hint={
                  runPolicy.isGateMainnet
                    ? 'Gate 正式网无本地模拟盘，仅支持实盘。'
                    : runPolicy.isGateTestnet
                      ? 'Gate 测试网使用虚拟资金真实撮合。'
                      : '实盘需先选择交易所凭证。'
                }
              >
                <div className="grid h-[34px] grid-cols-2 gap-1 rounded-lg border border-base-700 bg-base-950 p-0.5">
                  <button
                    type="button"
                    onClick={() => setDryRun(true)}
                    aria-pressed={dryRun}
                    disabled={runPolicy.paperDisabled}
                    className={`flex items-center justify-center gap-1.5 rounded-md text-xs font-semibold transition ${
                      dryRun
                        ? 'bg-accent/20 text-accent shadow-sm'
                        : 'text-ink-lo hover:text-ink-hi'
                    } ${runPolicy.paperDisabled ? 'cursor-not-allowed opacity-40' : ''}`}
                  >
                    <span>{runPolicy.isGateTestnet ? '本地模拟' : '模拟盘'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDryRun(false)}
                    aria-pressed={!dryRun}
                    disabled={runPolicy.liveDisabled}
                    className={`flex items-center justify-center gap-1.5 rounded-md text-xs font-semibold transition ${
                      !dryRun
                        ? runPolicy.isGateTestnet
                          ? 'bg-accent/20 text-accent shadow-sm'
                          : 'bg-warn/20 text-warn shadow-sm'
                        : 'text-ink-lo hover:text-ink-hi'
                    } ${runPolicy.liveDisabled ? 'cursor-not-allowed opacity-40' : ''}`}
                  >
                    <span>{runPolicy.isGateTestnet ? '测试网' : '实盘'}</span>
                    {!runPolicy.isGateTestnet && !dryRun && (
                      <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />
                    )}
                  </button>
                </div>
              </Field>
            </div>
          </section>

          {/* Step 3: 名称与节奏 */}
          <section className="space-y-2.5 border-t border-base-800 pt-3.5">
            <div className="flex items-center gap-2">
              <span className="num flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                3
              </span>
              <h3 className="text-xs font-semibold tracking-wider text-ink-mid">名称、节奏与本金</h3>
              <span aria-hidden className="h-px flex-1 bg-base-800" />
            </div>

            <Field label="机器人名称">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：印钞机 / BTC 动量 · 模拟"
                autoFocus
              />
            </Field>

            <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
              <Field label="决策周期（分钟）" hint="每轮向模型请求决策的间隔。">
                <NumberInput value={cycleIntervalMinutes} onValueChange={setCycleIntervalMinutes} step={1} />
              </Field>

              {exchangeAccountId === '' ? (
                <Field label="模拟盘起始余额（USDT）" hint="纯模拟盘本金，收益率以此为基准。">
                  <TextInput
                    value={paperBalance}
                    onChange={(e) => setPaperBalance(e.target.value)}
                    inputMode="decimal"
                    placeholder="1000"
                  />
                </Field>
              ) : (
                <EquitySourceField state={equity} />
              )}
            </div>

            {baselineWarning && (
              <div className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-sm text-warn">
                <span className="font-semibold">权益基准为 0。</span> {baselineWarning}
              </div>
            )}
          </section>

          {error && <ErrorNote>{error}</ErrorNote>}

          <p className="text-xs text-ink-faint">
            创建后默认处于停止状态；点击「启动」时会自动执行时钟、连通性与模型预检。
          </p>
        </div>
      )}
    </Modal>
  );
}

