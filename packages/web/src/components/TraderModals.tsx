import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { isAiDriven, type TraderMode } from '@aq/shared';
import {
  api,
  type AiModelRow,
  type DiscoverModelsResult,
  type ExchangeAccountRow,
  type TraderRow,
} from '../lib/api';
import { MODE_LABEL } from '../lib/glossary';
import { Badge, Button, ErrorNote, Field, Modal, NumberInput, Select, Spinner3, TextInput } from './ui';
import { SectionLabel } from './shell';
import { EquitySourceField, equityPayload, useExchangeEquity } from './EquitySourceField';
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
     *
     * 原来这里写的是 `if (accounts.length === 0) gaps.push('交易所凭证')` ——
     * 于是没有凭证就**根本建不了机器人**，连纯模拟盘都不行。
     * 现在模拟盘不需要账户，所以凭证是**可选的**：
     * 下拉里始终有「不绑账户（纯模拟盘）」这一项。
     */
    if (models && models.length === 0) gaps.push('AI 模型');
    /*
     * ⚠️ **只有"固定策略"模式才需要策略**（2026-11 审计发现）。
     *
     * AI 驱动的模式（智能托管 / AI 团队 / JEV）在服务端**必须**传
     * `strategyId: null`，参数各自落在 `agent_config_json` / `defaultJevConfig()` 里。
     * 这里却无条件把「策略」算成缺失项 —— 于是策略表被清空（默认策略可以删，
     * 见 `db/schema.ts` 的 M7 注释：**删到没有任何策略也不影响智能托管**）之后，
     * 控制台**根本建不出 AI 驱动机器人**，而这是服务端明确支持的情形。
     */
    if (!isAiDriven(mode) && strategyList && strategyList.length === 0) gaps.push('策略');
    return gaps;
  }, [models, strategyList, mode]);

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
     */
    /*
     * ⚠️ **`exchangeAccountId` 不再参与校验**（用户 2026-10-27 需求）：
     * 留空 = 纯模拟盘机器人，是合法选择。
     */
    if (modelChoice === '') return setError('请选择 AI 模型。');
    /* ⚠️ 只有固定策略模式才要求策略 —— 见上面 `missing` 里的说明。 */
    if (!isAiDriven(mode) && strategyId === '') return setError('请选择策略。');
    /* 实盘模式必须有交易所账户 —— 服务端同样会拒（在这里先拦住，不用等一次往返）。 */
    if (!dryRun && exchangeAccountId === '') {
      return setError('实盘模式必须绑定交易所账户。没有账户的机器人只能以模拟盘运行。');
    }
    /* 模拟余额填了就必须是个正数 —— 否则静默回落成默认值，用户以为生效了。 */
    const paperAmount = paperBalance.trim() === '' ? 0 : Number(paperBalance);
    /*
     * 边界与服务端 `validateStartingBalance` **必须一致**（上下限都要）。
     *
     * 早先这里只判了 `> 0`，于是"填 999999999999"在前端一路绿灯、到服务端才
     * 被拒 —— 而那种错误在点下"创建"之后才出现，用户已经填完了整个表单。
     * 前端校验的价值就是**在提交之前**说清楚。
     *
     * 下限 10 的理由同服务端：低于它任何仓位都会被最小下单量拒绝。
     */
    if (paperBalance.trim() !== '') {
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
      const reused = reusableModelId(createdModelsRef.current, modelChoice);
      if (reused !== undefined) {
        resolvedModelId = reused;
      } else if (modelChoice.startsWith('new:')) {
        const modelId = modelChoice.slice(4);
        const created = await api.createAiModel({
          provider: providerId,
          label: `${descriptor?.label ?? providerId} · ${modelId}`,
          model: modelId,
          baseUrl: descriptor?.baseUrl ?? '',
          apiKey: '',
        });
        resolvedModelId = created.id;
        createdModelsRef.current = { ...createdModelsRef.current, [modelChoice]: created.id };
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
        /*
         * ⚠️ **分组是这个弹窗最重要的可读性修复。**
         *
         * 之前八个字段一路 `space-y-3` 平铺：名称、凭证、厂商、模型、运行模式、
         * 策略、周期、起始权益 —— 全靠 12px 的间距区分。用户的原话是
         * 「该有的分割线得有」：他滚到「运行模式」时已经看不出前面那四行
         * 属于"选哪个账户和模型"、后面两行属于"怎么跑"。
         *
         * 三组的边界是**用户要做的三个决定**，不是字段类型：
         *
         *   1. 叫什么、用哪个钱包与模型 —— 身份；
         *   2. 怎么跑（按策略参数 / AI 托管）—— 唯一会改变机器人行为的选择；
         *   3. 跑多快、从多少本金起算 —— 参数。
         *
         * 用 `SectionLabel`（页面里同一个区块标题组件）：标题 + 延伸线，
         * 两套模板下都成立，不是这里临时画的样式。
         *
         * ⚠️ 光有标题还不够。用户第二次看的时候说的是「该有的分割线得有」：
         * 三组之间只有 16px 空白，滚到中间时上一组的最后一个字段和下一组的
         * 标题在视觉上仍然是一个段落 —— 延伸线只画在标题右侧，管不到组的
         * 边界。所以第 2、3 组各加一条 `border-t`，让组的起止一眼可辨。
         *
         * 颜色必须是 `base-750` 而不是 `base-800`：弹窗底色就是 `base-900`，
         * 控制台主题下 800 (#1e242c) 和 900 (#1d232b) 只差 1 个色阶，
         * 实测那条线在屏幕上根本看不见（采样出来就是底色）。750 (#2a323b)
         * 在主题里的语义正是「弱分隔线」，两套模板下都够看。
         */
        <div className="space-y-4">
          <section className="space-y-3">
            <SectionLabel title="身份与账户" className="mb-0" />
          <Field label="名称" hint="在控制台与审计记录中显示。">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="BTC 动量 · 模拟"
              autoFocus
            />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="交易所凭证"
              hint="留空 = 纯模拟盘，不需要任何真实账户。"
            >
              <Select
                value={exchangeAccountId}
                onChange={(e) =>
                  setExchangeAccountId(e.target.value === '' ? '' : Number(e.target.value))
                }
              >
                {/*
                  ⚠️ **「不绑账户」必须是第一个选项，且是默认值**（用户 2026-10-27 需求）。
                  它表示纯模拟盘机器人：不下真实订单、余额由本地台账折算。
                  没有这一项时，没有凭证的用户根本进不了创建流程。
                */}
                <option value="">不绑账户（纯模拟盘）</option>
                {accounts?.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label} · {account.testnet ? '测试网' : '主网'}
                  </option>
                ))}
              </Select>
            </Field>

            {/*
             * **运行模式在创建时固定**（2026-11-10 用户要求）。
             *
             * 用户原话：「应该是由创建机器人的时候决定固定，而不是运行启动机器人的时候来决定」。
             * 所以这里是"这台机器人永远用模拟还是实盘"的唯一一次选择；启动入口
             * （列表 / 详情 / 总览 / 命令面板）**点一下就直接启动**，不再弹任何选择框。
             * 实盘必须已绑定账户（没账户的机器人在服务端会被拒，这里提前禁用）。
             *
             * 两张卡**描述都压到一行** —— 原来一张 2 行、一张 3 行，并排时高度不齐，
             * 正是用户说的"两列参差"。更长的解释放 `title`。
             */}
            <Field
              label="运行模式（创建后固定）"
              hint="模拟盘不碰真实资金；实盘用真实资金下单，需要先绑定账户。"
            >
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDryRun(true)}
                  aria-pressed={dryRun}
                  title="订单只在本地按实时行情撮合，不产生任何真实委托。"
                  className={`flex h-[46px] items-center gap-2 rounded-md border px-2.5 text-left transition ${
                    dryRun ? 'border-accent/70 bg-accent/10' : 'border-base-700 bg-base-850 hover:border-base-600'
                  }`}
                >
                  <span className="text-base font-semibold text-ink-hi">模拟盘</span>
                  <Badge tone="accent">推荐</Badge>
                </button>

                <button
                  type="button"
                  onClick={() => setDryRun(false)}
                  aria-pressed={!dryRun}
                  disabled={exchangeAccountId === ''}
                  title={
                    exchangeAccountId === ''
                      ? '需先绑定交易所账户。'
                      : '真实资金下单，亏损不可逆。'
                  }
                  className={`flex h-[46px] items-center gap-2 rounded-md border px-2.5 text-left transition ${
                    !dryRun ? 'border-warn/70 bg-warn/10' : 'border-base-700 bg-base-850 hover:border-base-600'
                  } ${exchangeAccountId === '' ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  <span className="text-base font-semibold text-ink-hi">实盘</span>
                  <Badge tone="warn">真实资金</Badge>
                </button>
              </div>
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
            {/*
              ⚠️ **JEV 模式同样不显示模型选择**（2026-10-19 用户实测踩到）。

              用户报：「第一次我是直接创建，模型乱写的（应该是不可用的），
              运行的时候说失败」—— 而他当时选的模型**根本不会被 JEV 模式使用**：
              ```
                JEV 模式 → 只用 magpie 网关调 /v1/systemone（固定 jev-latest）
                         → 完全不读「AI 模型」列表里的任何记录
              ```
              所以显示那个选择框是**误导**：它让用户以为必须挑一个模型，
              挑错了又会在启动时"看起来失败"（实际那次失败是别的原因，
              但用户无从分辨 —— 这正是"界面说了假话"的典型）。

              ⇒ 与团队模式同一条纪律：**不渲染**，而不是渲染了再禁用。
            */}
            {mode !== 'ai_team' && mode !== 'jev' && (
            <Field label="模型厂商">
              <Select
                value={providerId}
                onChange={(e) => {
                  // 换厂商就把模型清掉 —— 上一个厂商的模型在这里毫无意义。
                  setProviderId(e.target.value);
                  setModelChoice("");
                  setModelQuery("");
                  setAiModelId("");
                }}
              >
                <option value="">请选择厂商</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {/*
                     * ⚠️ **带上该厂商已有的模型数**（2026-10-19）。
                     *
                     * 用户的 magpie 与 CPA 模型都记在 `custom`（「自定义 OpenAI 兼容端点」）
                     * 下面 —— 光看这个名字他认不出"这就是我配的 magpie"。
                     * 显示数量至少让他能对上："哦，这个下面有 4 个，那是我的"。
                     */}
                    {provider.label}
                    {(() => {
                      const n = (models ?? []).filter((m) => m.provider === provider.id).length;
                      return n > 0 ? `（已配 ${n} 个）` : '';
                    })()}
                  </option>
                ))}
              </Select>
              {/*
                ⚠️ **一个模型都没配时要说清"去哪里加"**，而不是让用户对着空下拉发呆。
                这是本仓库一贯的纪律：空状态必须解释原因（不是"没有数据"就完了）。
              */}
              {providers.length === 0 && (
                <p className="mt-1 text-xs text-warn">
                  还没有任何 AI 模型 —— 请先到「AI 模型」页面添加一个，再回来新建机器人。
                </p>
              )}
            </Field>
            )}

            {/*
              ⚠️ **团队模式不显示模型选择**（用户 2026-10-12 明确要求）。

              用户原话：
              > 「团队多智能体模式，在创建/修改的时候就**不应该采用 AI 模型列表里面的**，
              >  而是**直接采用系统的 magpie**，（系统 AI 列表里面添加的那些
              >  **不应该给这个模式使用**），因为这个模式很多东西会和其他的冲突」

              理由（实测确认过）：团队模式的模型出口来自**独立的 magpie 网关配置**
              （见 `teamGateway.ts`），而「AI 模型」列表是给普通机器人用的。
              两者共用会造成"改一条记录去调 A 机器人，连带改掉所有团队机器人" ——
              用户实测发现了这个现象。

              所以这里**不渲染**选择器，而不是渲染了再禁用 ——
              禁用会让用户以为"这里有个选项只是现在不能改"，
              而真相是**这个字段与团队模式无关**。
            */}
            {/*
              ⚠️ **JEV 模式同样不显示模型选择**（2026-10-19 用户实测踩到）。

              用户报：「第一次我是直接创建，模型乱写的（应该是不可用的），
              运行的时候说失败」—— 而他当时选的模型**根本不会被 JEV 模式使用**：
              ```
                JEV 模式 → 只用 magpie 网关调 /v1/systemone（固定 jev-latest）
                         → 完全不读「AI 模型」列表里的任何记录
              ```
              所以显示那个选择框是**误导**：它让用户以为必须挑一个模型，
              挑错了又会在启动时"看起来失败"（实际那次失败是别的原因，
              但用户无从分辨 —— 这正是"界面说了假话"的典型）。

              ⇒ 与团队模式同一条纪律：**不渲染**，而不是渲染了再禁用。
            */}
            {mode !== 'ai_team' && mode !== 'jev' && (
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
              {/*
               * **搜索定位**（用户 2026-11-10 要求）：先输入关键词过滤，再在剩下
               * 的选项里选。没有这一层，两百多个模型只能靠滚。
               */}
              <div className="mb-1.5 flex items-center gap-2">
                <TextInput
                  value={modelQuery}
                  onChange={(event) => setModelQuery(event.target.value)}
                  placeholder={providerId ? '搜索模型（名称 / 模型 id）…' : '先选一个厂商'}
                  disabled={!providerId}
                  aria-label="搜索模型"
                />
                {modelQuery && (
                  <Button small onClick={() => setModelQuery('')}>
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
                  <optgroup label={availableModels.live ? "厂商可用模型" : "厂商建议"}>
                    {shownAvailable.map((id) => (
                      <option key={id} value={"new:" + id}>
                        {id}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
              {modelQuery && shownConfigured.length === 0 && shownAvailable.length === 0 && (
                <p className="mt-1 text-xs text-ink-faint">没有匹配「{modelQuery}」的模型。</p>
              )}
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
            )}
          </div>
          </section>

          <section className="space-y-3 border-t border-base-750 pt-4">
            <SectionLabel title="运行方式" className="mb-0" />

            {/*
              ## 卡片式选择（2026-11-10 用户反馈：「原生 radio 圆点很土」）

              原生 radio 在这里有两个问题：一是**视觉上只有 13px 的圆点**，
              选中的那一项与其它三项几乎没差别；二是每一项后面跟 2–4 行说明，
              四行下来 300px 高，把"创建"按钮推到弹窗外面。

              现在的形态：2×2 卡片，标题 + 一行短说明，选中态用**边框 + 底色 +
              实心圆点**三重标记；完整说明放 `title`（悬停可读）。
              卡片内保留 `<input type="radio">`（sr-only）—— 方向键切换、读屏
              播报"已选中"这些原生语义一个都不丢。
            */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(
                [
                  {
                    id: 'strategy' as const,
                    label: MODE_LABEL.strategy,
                    desc: '按选定策略的固定参数跑，不调用模型。',
                    badge: null,
                    full: '用选定的策略里的固定参数跑，行为与以前完全一致。',
                  },
                  {
                    id: 'ai_managed' as const,
                    label: `${MODE_LABEL.ai_managed}（全自动）`,
                    desc: 'AI 自己设定并调整参数与提示词。',
                    badge: '推荐',
                    full: '参数与交易提示词全部由 AI 自主设定并实时调整：周期、标的池、杠杆、仓位、止损止盈、节流与冷却。以盈利为唯一目标，并根据真实交易结果不断反思、迭代。',
                  },
                  {
                    id: 'ai_team' as const,
                    label: `${MODE_LABEL.ai_team}（多智能体）`,
                    desc: '调度 → 调研 → 辩论 → 裁决 → 风控 → 执行。',
                    badge: null,
                    full: '一支分工协作的智能体团队：调度官统筹，分析师并行调研（行情、新闻、社区情绪），多空研究员对抗辩论，风控官把关，交易员执行。持续工作、事件驱动，每次决策都有完整审计轨迹。',
                  },
                  {
                    id: 'jev' as const,
                    label: MODE_LABEL.jev,
                    desc: '交给 JEV 决策引擎，盈利能力尚未验证。',
                    badge: '实验性',
                    full: '每一个判断都交给 Jev 决策模型：选哪些标的、做多做空、用哪一档仓位与止损止盈。Jev 只回答"选哪个"（它不产生文字、也不擅长算数），所以具体价位与档位由系统按 ATR 与风险预算先算好，再由它挑 —— 挑完照常过风控、照常挂保护单。',
                  },
                ] as const
              ).map((option) => {
                const active = mode === option.id;
                return (
                  <label
                    key={option.id}
                    title={option.full}
                    className={`relative flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 transition ${
                      active
                        ? 'border-accent/70 bg-accent/5'
                        : 'border-base-700 bg-base-850 hover:border-base-600'
                    }`}
                  >
                    <input
                      type="radio"
                      name="trader-mode"
                      className="sr-only"
                      checked={active}
                      onChange={() => setMode(option.id)}
                    />
                    {/* 选中标记：实心圆点 + 主色描边。比 13px 的原生圆点大一圈，
                        也让"选中"与"未选中"在同一张卡上就能分辨。 */}
                    <span
                      aria-hidden
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                        active ? 'border-accent' : 'border-base-600'
                      }`}
                    >
                      {active && <span className="h-2 w-2 rounded-full bg-accent" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-base font-medium text-ink-hi">{option.label}</span>
                        {option.badge && (
                          <Badge tone={option.badge === '推荐' ? 'accent' : 'warn'}>{option.badge}</Badge>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-ink-lo">{option.desc}</span>
                    </span>
                  </label>
                );
              })}
            </div>

            {/*
              团队 / JEV 模式的模型来源说明 —— 保留：它们**不读**「AI 模型」列表，
              不说清会让人以为上面的模型选择器漏了。
            */}
            {mode === 'ai_team' && (
              <p className="rounded-md border border-base-700 bg-base-850 px-2.5 py-2 text-xs leading-relaxed text-ink-lo">
                <span className="font-medium text-ink-mid">模型由系统 magpie 网关统一调度</span>
                　—　不使用「AI 模型」列表；每个智能体按工作内容分到不同档位，额度用尽会自动向下平替。
              </p>
            )}
            {mode === 'jev' && (
              <p className="rounded-md border border-base-700 bg-base-850 px-2.5 py-2 text-xs leading-relaxed text-ink-lo">
                <span className="font-medium text-ink-mid">决策模型由 magpie 网关提供（Jev）</span>
                　—　固定调用 <code>jev-latest</code>，不使用「AI 模型」列表里的任何记录。
              </p>
            )}

            {isAiDriven(mode) ? (
              <p className="text-xs leading-relaxed text-ink-faint">
                策略：AI 驱动的模式不引用策略 —— 参数由 AI 自己设定并持续调整（JEV 模式的参数在机器人页的「JEV
                模式」标签里调）。
              </p>
            ) : (
              <Field label="策略">
                <Select value={strategyId} onChange={(e) => setStrategyId(Number(e.target.value))}>
                  {strategyList?.map((strategy) => (
                    <option key={strategy.id} value={strategy.id}>
                      {strategy.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </section>

          <section className="space-y-3 border-t border-base-750 pt-4">
            <SectionLabel title="节奏与本金" className="mb-0" />
            {/*
              两列：周期与本金各占一半。原来是两个单列字段 —— 在 672px 宽的弹窗里
              每行只放一个输入框，垂直空间白费，而这次的要求是「简单实用」。

              ⚠️ 起始权益的来源分两种（用户 2026-10-27 需求）：
                · 绑了账户 → 从该凭证读真实钱包余额（既有行为，一个字节不变）；
                · 没绑账户 → 操作员自己填模拟盘起始余额。
              两种情况**不能**都显示 —— 一个"读交易所"的只读控件出现在纯模拟盘
              机器人上会让人以为余额仍然来自真实账户。
            */}
            <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
              <Field label="周期间隔（分钟）" hint="多久向模型请求一次决策。">
                <NumberInput value={cycleIntervalMinutes} onValueChange={setCycleIntervalMinutes} step={1} />
              </Field>

              {exchangeAccountId === '' ? (
                <Field
                  label="模拟盘起始余额（USDT）"
                  hint="纯模拟盘的本金，与真实账户无关；收益率以它为分母。"
                >
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
              <div className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-base text-warn">
                <span className="font-semibold">权益基准为 0。</span> {baselineWarning}
              </div>
            )}
          </section>

          {error && <ErrorNote>{error}</ErrorNote>}

          <p className="text-xs leading-relaxed text-ink-faint">
            创建机器人并不会启动它。点「启动」即开始运行 —— 预检（时钟、连通性、凭证与模型可达性）会在启动前自动执行，失败时直接在列表/详情页给出原因。
          </p>
        </div>
      )}
    </Modal>
  );
}

