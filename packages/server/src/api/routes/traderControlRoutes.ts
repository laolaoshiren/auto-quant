import {
  AI_MANAGED_PRESET_MODEL,
  DEFAULT_MANAGED_RISK_PROFILE,
  MANAGED_RISK_PROFILES,
  StrategyConfigSchema,
  applyManagedRiskProfile,
  defaultAiTeamConfig,
  inferManagedRiskProfile,
  isAiDriven,
  unboundedAiManagedConfig,
  usesModelPicker,
  type ManagedRiskProfileId,
  type StrategyConfig,
  type Trader,
} from '@aq/shared';
import { validateStartingBalance } from '../../binance/paperWallet.js';
import { env } from '../../env.js';
import { createLogger } from '../../logger.js';
import {
  aiModels,
  exchanges,
  settings,
  strategies,
  traders,
} from '../../store/repositories.js';
import { requireAnyModelIdForGateway } from '../health.js';
import { TraderInputSchema, TraderPatchSchema } from '../schemas.js';
import type { RouteContext } from './context.js';

const log = createLogger('api');

export function registerTraderControlRoutes(ctx: RouteContext): void {
  const { app, deps, authed, idOf, guard } = ctx;
  const { invalidateLiveView } = ctx.liveView;

  /* --- Traders ----------------------------------------------------------- */

  /**
   * 最近一次账目校验的结论（`settings.ledger_check:<id>`）。
   *
   * 交易循环每轮都会把「账本净额 vs 交易所流水净额」算一遍并存下来，
   * 但**从来没有送到界面上** —— 操作员因此只能看到一个可能错的值。
   * 这里只做读取，不改变任何东西。
   */
  function ledgerCheckOf(traderId: number): {
    platformNet: number;
    exchangeNet: number;
    gap: number;
    checkedAt: string;
    incomeReadFailed?: boolean;
  } | null {
    const raw = settings.get(`ledger_check:${traderId}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        platformNet: Number(parsed.platformNet ?? 0),
        exchangeNet: Number(parsed.exchangeNet ?? 0),
        gap: Number(parsed.gap ?? 0),
        checkedAt: String(parsed.checkedAt ?? ''),
        ...(typeof parsed.incomeReadFailed === 'boolean'
          ? { incomeReadFailed: parsed.incomeReadFailed }
          : {}),
      };
    } catch {
      return null;
    }
  }

  function parseAgentConfig(raw: string | null | undefined): StrategyConfig | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
      const parsed = StrategyConfigSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  function managedRiskProfileOf(trader: Pick<Trader, 'mode' | 'agentConfigJson'>): ManagedRiskProfileId | null {
    if (trader.mode !== 'ai_managed') return null;
    return inferManagedRiskProfile(parseAgentConfig(trader.agentConfigJson));
  }

  app.get('/api/traders', authed, async () => {
    const running = new Set(deps.manager.runningIds());
    const runningSince = deps.manager.runningSince();
    return traders.list().map((trader) => {
      const isRunning = running.has(trader.id);
      const persistedStart = isRunning ? settings.get(`trader_started_at:${trader.id}`)?.trim() : '';
      const memStartMs = isRunning ? runningSince.get(trader.id) : undefined;
      return {
        ...trader,
        managedRiskProfile: managedRiskProfileOf(trader),
        // The live loop is the source of truth for status, not the stored value.
        status: isRunning ? deps.manager.statusOf(trader.id) : ('stopped' as const),
        isRunning,
        startedAt: isRunning
          ? (persistedStart || (memStartMs !== undefined ? new Date(memStartMs).toISOString() : null))
          : null,
        /*
         * ⚠️ **账本与交易所的差额必须发到界面上。**
         *
         * 用户 2026-10-07 报的：「起始权益 100.05，现在 100.84，为什么显示 +$1.29？」
         *
         * 首页那个"交易盈亏"来自 `trades.net_pnl` 求和（账本），而这个机器人**一直在漏记
         * 平仓手续费**（33 张已成交的平仓单 `fee=0`），账本只好拿开仓费顶上
         * —— 11 笔呈现精确的 `fee = 2 × entry_fee`。差额就是这个字段。
         *
         * 系统的账目校验（`ledger_check:<id>`）**每轮都算出这个 gap 并写进 settings**，
         * 却**从来没有一条路径把它送到界面上**。于是操作员看到一个错数、且没有任何提示。
         *
         * 带出去，让界面能说"账本与交易所差了多少"，而不是继续假装账本是准的。
         */
        ledger: ledgerCheckOf(trader.id),
        /*
         * **下一轮决策的预定时刻**（epoch 毫秒）—— 界面据此显示倒计时。
         *
         * 用户 2026-10-07：「能在这里加入一个倒计时吗？让我明显知道下一轮决策剩余周期」。
         *
         * 由 `AutoTrader.nextCycleAt` 提供：它记的是**定时器真正被排到的那一刻**，
         * 已经把"模型自己要求的间隔"（`requestedMinutes`）与"失败短重试"算进去了。
         * **界面不要自己拿"上一轮时间 + 配置周期"推算** —— 那会忽略这两件事，
         * 显示一个骗人的倒计时（模型说 5 分钟、界面显示 60 分钟）。
         */
        nextCycleAt: deps.manager.nextCycleAtOf(trader.id),
      };
    });
  });

  app.post('/api/traders', authed, guard(async (body: unknown) => {
    const parsed = TraderInputSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid trader');
    /*
     * **账户是可选的**（用户 2026-10-27 需求）：不传 = 纯模拟盘机器人，
     * 它不需要任何真实交易所账户。传了就必须真实存在 —— 一个打错的 id
     * 会让"绑了账户"这件事变成一句空话。
     */
    const requestedAccountId = parsed.data.exchangeAccountId ?? null;
    const account =
      requestedAccountId === null ? null : exchanges.get(requestedAccountId);
    if (requestedAccountId !== null && !account) throw new Error('未知的交易所账户');
    /*
     * ⚠️ **团队模式不校验 `ai_model_id`** —— 它**不使用**这个字段（用户 2026-10-12 要求）。
     *
     * 用户原话：
     * > 「团队多智能体模式，在创建/修改的时候就不应该采用 AI 模型列表里面的，
     * >  而是直接采用系统的 magpie，（系统 AI 列表里面添加的那些不应该给这个模式使用）」
     *
     * 团队模式的模型出口来自**独立的 magpie 网关配置**（见 `teamGateway.ts`），
     * 所以「AI 模型」列表里有什么、那条记录是不是 magpie、有没有被改过，
     * **都与团队模式无关**。
     *
     * ## 为什么数据库那一列仍然保留
     *
     * `traders.ai_model_id` 是 `NOT NULL`（建表时就定了），改成可空要一次迁移，
     * 而迁移的风险（重建表、影响正在跑的实盘机器人）**远大于收益**。
     *
     * 所以：**列保留、写入一个占位值、团队模式不读它**。
     * 这比"为了语义干净去做一次有风险的迁移"更符合本项目"不碰实盘"的纪律。
     */
    const needsModelPicker = usesModelPicker(parsed.data.mode);
    if (needsModelPicker) {
      if (parsed.data.aiModelId === undefined) throw new Error('固定策略模式必须选择一个 AI 模型');
      if (!aiModels.get(parsed.data.aiModelId)) throw new Error('未知的 AI 模型');
    }

    /*
     * ── 策略：**两种模式的要求正好相反** ────────────────────────────────
     *
     * 用户的原话：「智能托管模式完全独立出来……就算策略工坊里面默认策略 —
     * 稳健就算删除、没有任何策略，都不影响智能托管模式（做到完全独立）」。
     *
     *   · **AI 托管**：**不引用任何策略** —— 参数整份在 `agent_config_json` 里。
     *     所以连"必须选一个"这个动作都取消了，`strategyId` 直接写 `null`。
     *   · **固定策略**：**必须**有一个 —— 否则它没有任何可用的参数。
     *
     * 两个方向都要拦：只拦一边的话，要么建出"没有配置的固定策略机器人"，
     * 要么又把 AI 托管绑回一个它用不上的策略（这正是要修的那个问题）。
     */
    /*
     * ⚠️ 用 `isAiDriven` 而不是 `=== 'ai_managed'` —— **加新模式时这里必须自动生效**。
     *
     * 写死单个模式名的话，新建 `ai_team` 机器人时会被下面那个 `else` 分支
     * 要求"必须选一个策略"，而 AI 团队模式的参数**整份由团队自己管**，
     * 根本没有可选策略 —— 于是新模式一建就报错。
     *
     * 这正是共享包把 `AI_DRIVEN_MODES` 导出来的理由：**让"哪些模式由 AI 驱动"
     * 只有一个定义处**，而不是散在各层的字符串比较里。
     */
    const isAiDrivenMode = isAiDriven(parsed.data.mode);
    const requestedStrategyId = parsed.data.strategyId ?? null;
    if (isAiDrivenMode) {
      if (requestedStrategyId !== null) {
        throw new Error('AI 托管模式不引用任何策略 —— 请不要为它选择策略。');
      }
    } else {
      if (requestedStrategyId === null) throw new Error('固定策略模式必须选择一个策略。');
      if (!strategies.get(requestedStrategyId)) throw new Error('未知的策略');
    }

    /*
     * ── 起始权益 / 模拟盘本金 ────────────────────────────────────────────
     *
     * 两条**互相独立**的路径：
     *
     *   · **模拟盘**（没有账户，或操作员填了 `paperStartingBalance`）：
     *     本金就是操作员填的那个数 —— **不去读任何真实钱包**。这正是用户说的
     *     「模拟盘不应该根据真实钱包的余额」。
     *   · **实盘**：沿用原来的行为，从交易所读真实余额做收益率分母。
     */
    const paperStartingBalance = parsed.data.paperStartingBalance ?? 0;
    const isPaperOnly = account === null;

    /*
     * ⚠️ **`paperStartingBalance` 必须真的被校验，不能只靠 zod 的 `min(0)`。**
     *
     * zod 只挡住负数。而这两个值都会**静默造成故障**：
     *
     *   · `0`     → 本地钱包余额 0，每一笔开仓都被「保证金不足」拒掉。
     *               界面表现是「机器人 running、每轮成功、但从不交易」——
     *               本仓反复记录的那类静默失能。
     *   · `1e12`  → 手滑多按几个 0。之后所有收益率都变成无限接近 0 的百分比，
     *               而界面上**看不出任何异常**。
     *
     * ## 判据是「有没有传这个字段」，不是「值是否 > 0」
     *
     * 早先这里写的是 `if (paperStartingBalance > 0)` —— 于是 0 绕过校验。
     * 而 0 的实际后果是**界面说了假话**：操作员填 0（意思是「我就要 0 本金」），
     * 系统把它当成「没填」，静默回落到 1000 并**按 1000 开仓**。
     *
     * 实测形态（2026-10-27）：POST `paperStartingBalance: 0` 返回 200，
     * 落库 `paper_starting_balance=0`，但启动后 `initialEquity` 被改写成 1000、
     * 钱包余额也是 1000 —— **他填的数字在界面上再也找不到**。
     *
     * 所以：省略 = 用默认值（合法）；显式传 0 = 明确要求一个做不到的余额
     *（拒绝并说明）。
     *
     * 校验函数在 `binance/paperWallet.ts`（含上下限与面向操作员的中文原因）。
     * 必须先于 `traders.create()`，否则会留下一条余额荒谬的记录。
     */
    if (parsed.data.paperStartingBalance !== undefined) {
      const invalid = validateStartingBalance(paperStartingBalance);
      if (invalid) throw new Error(invalid);
    }

    let initialEquity = parsed.data.initialEquity ?? 0;
    let equitySource: 'exchange' | 'manual' | 'paper' | 'unavailable' = 'manual';

    if (isPaperOnly) {
      /*
       * 没有账户 → **不可能**读真实余额。用操作员填的模拟本金；
       * 没填就留 0，由 `manager` 在首次启动时回落到默认值。
       */
      if (initialEquity <= 0) initialEquity = paperStartingBalance;
      equitySource = initialEquity > 0 ? 'paper' : 'unavailable';
    } else if (account && initialEquity <= 0) {
      const live = await deps.balance.walletBalanceOf(account.id);
      if (live !== null && live > 0) {
        initialEquity = live;
        equitySource = 'exchange';
      } else {
        equitySource = 'unavailable';
      }
    }

    /* 模拟本金没单独填时，用 `initialEquity` 兜底 —— 两者语义不同，但都比 0 好。 */
    const effectivePaperBalance = paperStartingBalance > 0 ? paperStartingBalance : initialEquity;

    /*
     * ══════════════════════════════════════════════════════════════════════
     *  **运行模式（模拟 / 实盘）在创建时固定**（2026-11-10 用户要求）
     * ══════════════════════════════════════════════════════════════════════
     *
     * 用户的原话：
     * > 「实盘/模拟 的根本逻辑得改一下：应该是由创建机器人的时候决定固定，
     * >   而不是运行启动机器人的时候来决定。」
     *
     * 所以：创建请求里的 `dryRun` 决定这台机器人**永远**是模拟还是实盘，
     * 之后 `POST /traders/:id/start` **不再接受**这个选择（传了也不生效）。
     *
     * 默认 `true`（模拟盘）—— 与"危险的那条路要人自己走过去"同一条纪律：
     * 实盘必须由操作员在创建时显式选。
     */
    const fixedDryRun =
      parsed.data.dryRun !== undefined
        ? parsed.data.dryRun
        : account?.exchange === 'gate'
          ? false
          : true;
    if (requestedAccountId === null && !fixedDryRun) {
      throw new Error('没有绑定交易所账户的机器人只能以模拟盘运行 —— 要实盘请先绑定账户再创建。');
    }
    /*
     * ⚠️ **提前拦截「Gate + 本地模拟盘」（2026-11-23 P0 修复）**。
     * Gate 没有本地模拟撮合引擎（`GateBroker` 恒发单到所绑 Gate 环境）：
     *   · Gate 正式网：禁止 `dryRun: true`（避免误动真钱或造出无法启动的死机器人）；
     *   · Gate 测试网：测试网本身即假钱真实撮合，也不支持本地模拟盘，必须用 `dryRun: false`
     *     以保持运行期、停机期与舰队汇总口径一致。
     */
    if (account && account.exchange === 'gate' && fixedDryRun) {
      throw new Error(
        account.testnet
          ? 'Gate 测试网本身即假钱真实撮合，不支持本地模拟盘；请选择「测试网」运行模式（dryRun: false）。'
          : 'Gate 正式网账户不支持本地模拟盘（避免误动真实资金）。如需模拟测试，请绑定 Gate 测试网账户；如需正式交易，请选择「实盘」。',
      );
    }

    const trader = traders.create({
      name: parsed.data.name,
      /* `null` = 纯模拟盘机器人（没有真实交易所账户）。 */
      exchangeAccountId: requestedAccountId,
      /*
       * ⚠️ **团队模式写入一个占位 `aiModelId`** —— 因为 `traders.ai_model_id` 是
       * `NOT NULL` + 外键（建表时就定了），而团队模式**不使用**这个字段
       *（它的模型出口来自独立的 magpie 网关配置，见 `teamGateway.ts`）。
       *
       * 为什么不做迁移把它改成可空：那要重建表，而这张表上挂着**正在跑的实盘机器人**
       * —— 迁移风险远大于"语义干净"带来的收益。本项目的纪律是"不碰实盘"。
       *
       * ## ⚠️ 占位值**不能硬编码成 `1`**（本地实测踩到）
       *
       * 第一版写的是 `? 1 : ...`，理由是"建表时必然有 id=1 的模型"。
       * **那个假设不成立**：本地实测库里模型 id 是 `4/5/8/9`（没有 1），
       * 于是建团队机器人直接 `FOREIGN KEY constraint failed` ——
       * 而错误信息完全指不到"占位值选错了"这个原因。
       *
       * 正确做法：**取一个真实存在的模型 id**。团队模式从不读它，
       * 所以取哪一条都行，只要满足外键。
       *
       * 一条模型都没有时（全新库）→ 抛一个说人话的错误，而不是外键报错。
       */
      /*
       * ⚠️ **智能托管 / 团队统一走系统 magpie 网关，不读 `ai_models` 列表**（2026-11-24）。
       *   · `ai_managed` → 固定预设模型 `workbuddy/deepseek-v4.1-flash`（magpie 网关）
       *   · `ai_team`    → 角色路由在运行时决定模型名（magpie 网关）
       * 数据库列 `traders.ai_model_id` 仍保留外键，这里写入一个真实存在的占位 id。
       */
      aiModelId: needsModelPicker
        ? parsed.data.aiModelId!
        : requireAnyModelIdForGateway(),
      strategyId: requestedStrategyId,
      cycleIntervalMinutes: parsed.data.cycleIntervalMinutes,
      initialEquity,
      paperStartingBalance: effectivePaperBalance,
      mode: parsed.data.mode,
      /* **运行模式在创建时固定** —— 之后启动不再选择（见上面的说明）。 */
      dryRun: fixedDryRun,
    });

    /*
     * ── AI 托管的机器人**自带一份完整配置** ─────────────────────────────
     *
     * ⚠️ 这一步是"完全独立"的实质所在。
     *
     * `agent_config_json` 原来**只在 AI 自己改参数时**才被写入（`ports.ts` 的
     * `setAgentConfig`）—— 也就是说一个刚建好的 AI 托管机器人身上是 `NULL`，
     * 它第一轮跑起来读的是**策略的配置**。于是"策略没了"就等于"它没有配置"，
     * 这正是用户要修的那个依赖。
     *
     * 现在建号时就写入一份完整配置。从这一刻起它的参数只属于它自己，
     * 策略（乃至"没有任何策略"）与它再无关系。
     *
     * ⚠️ **用 `unboundedAiManagedConfig()` 而不是 `parse({})`**（2026-10-03）。
     *
     * `parse({})` 走的是 schema 的**保守默认值**（3 个持仓、5x 杠杆、逐仓、
     * 75 分门槛）—— 而 AI 托管的机器人**不引用策略**，模型改这些只能靠自己
     * 想起来改，界面上根本没有入口。于是"完全交给模型"实际变成了
     * "系统先替它定死一组保守边界"。用户的原话：
     *
     *   「既然完全交给模型，那么怎么操作都由模型决定啊，而不是系统就提前写死了，
     *     模型改还有什么意义呢？？」
     *
     * 所以智能托管的起点改成**不设边界**（见 `unboundedAiManagedConfig()`）：
     * 上限顶格、门槛归零，唯一的例外是 `requireStopLoss`（那是结构要求，
     * 不是策略偏好）。**已有机器人不会被追溯修改** —— 它们的参数已经在自己的
     * `agent_config_json` 里，怎么调由模型与操作员决定。
     *
     * ---
     *
     * ⚠️ **`ai_team` 用【自己那份】配置，不借用智能托管的。**
     *
     * `unboundedAiManagedConfig` 是**单智能体**的参数集；团队模式有**风控官**在
     * 裁决之后把关，语义不同（见设计 §二/§三）。
     *
     * 但上一轮我**漏了给团队模式播种**（只写了注释说"留给 S3"），于是实测踩到：
     *
     *     机器人 #11 的配置里没有任何候选标的（静态列表为空、也没开动态候选池）
     *     —— 它不会交易任何东西。
     *
     * 也就是说：团队模式**跑得起来、界面显示"运行中"，但永远不会开任何仓**。
     * 而用户要的正是「然后做相应的动作（**开仓、平仓、调仓**等等）」。
     *
     * 所以现在**每种 AI 驱动模式各自播种自己那份**：
     *   · `ai_managed` → `unboundedAiManagedConfig()`（单智能体口径）
     *   · `ai_team`    → `defaultAiTeamConfig()`（含**动态标的池**）
     */
    let initialManagedProfile: ManagedRiskProfileId | null = null;
    if (parsed.data.mode === 'ai_managed') {
      initialManagedProfile = parsed.data.managedRiskProfile ?? DEFAULT_MANAGED_RISK_PROFILE;
      traders.setAgentConfig(trader.id, JSON.stringify(unboundedAiManagedConfig(initialManagedProfile)));
    } else if (parsed.data.mode === 'ai_team') {
      traders.setAgentConfig(trader.id, JSON.stringify(defaultAiTeamConfig()));
    }

    const fresh = traders.get(trader.id) ?? trader;
    return { ...fresh, managedRiskProfile: managedRiskProfileOf(fresh) ?? initialManagedProfile, equitySource };
  }));

  app.patch('/api/traders/:id', authed, guard(async (body: unknown, request, reply) => {
    const id = idOf(request);
    /*
     * ⚠️ "启动中"仍必须拦（2026-11-11 审查）：启动要十几秒，这期间 `isRunning`
     * 还是 false，改动会写进库，而正在启动的实例用的是启动那一刻读到的旧值。
     */
    if (deps.manager.isStarting(id)) {
      /* 文案单列：点了停止后界面已显示"已停止"，而启动还没收尾 —— 再说"请先停止"会让人无从下手。 */
      return reply
        .code(409)
        .send({ error: '这台机器人正在启动（或正在取消启动），请稍等几秒再修改它的配置。' });
    }
    const isCurrentlyRunning = deps.manager.isRunning(id);
    const parsed = TraderPatchSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid trader');
    const current = traders.get(id);
    if (!current) return reply.code(404).send({ error: `找不到机器人 ${id}` });

    if (parsed.data.dryRun !== undefined && parsed.data.dryRun !== (current.dryRun ?? true)) {
      return reply.code(400).send({
        error:
          '运行模式（模拟盘 / 实盘）在创建时就已固定，不能通过编辑修改。' +
          '要换模式请新建一台机器人（当前这台可以停掉保留历史）。',
      });
    }

    if (parsed.data.mode !== undefined && parsed.data.mode !== current.mode) {
      return reply.code(400).send({
        error: '机器人的模式在创建时就已固定，不能通过编辑修改。要换模式请新建一台机器人。',
      });
    }
    if (parsed.data.strategyId !== undefined) {
      const requestedStrategyId = parsed.data.strategyId;
      if (isAiDriven(current.mode)) {
        if (requestedStrategyId !== null) {
          throw new Error('AI 托管模式不引用任何策略 —— 请不要为它选择策略。');
        }
      } else {
        if (requestedStrategyId === null) throw new Error('固定策略模式必须选择一个策略。');
        if (!strategies.get(requestedStrategyId)) throw new Error('未知的策略');
      }
    }
    if (parsed.data.managedRiskProfile !== undefined && current.mode !== 'ai_managed') {
      return reply.code(400).send({
        error: '只有智能托管（ai_managed）模式支持风险护栏档位。',
      });
    }
    /* 只校验"换成的新值"：原样带回当前值（含网关模式的占位 id）不受影响。 */
    const modelChanged = parsed.data.aiModelId !== undefined && parsed.data.aiModelId !== current.aiModelId;
    if (modelChanged) {
      if (!usesModelPicker(current.mode)) {
        const modeHint =
          current.mode === 'ai_managed'
            ? `智能托管模式统一使用预设模型 ${AI_MANAGED_PRESET_MODEL}（系统 magpie 网关），不支持单独修改 AI 模型。`
            : '当前模式统一由系统 magpie 网关调度模型，不支持单独修改 AI 模型。';
        throw new Error(modeHint);
      }
      if (isCurrentlyRunning) {
        return reply.code(409).send({
          error: '切换 AI 模型需要先停止该机器人；名称、周期、策略与风险档位等配置可直接在线修改。',
        });
      }
      if (!aiModels.get(parsed.data.aiModelId!)) {
        throw new Error('未知的 AI 模型');
      }
    }

    if (parsed.data.paperStartingBalance !== undefined) {
      const invalid = validateStartingBalance(parsed.data.paperStartingBalance);
      if (invalid) throw new Error(invalid);
    }

    const requestedAccountId = (parsed.data as { exchangeAccountId?: number | null })
      .exchangeAccountId;
    if (requestedAccountId !== undefined && requestedAccountId !== current.exchangeAccountId) {
      return reply.code(400).send({
        error:
          '暂不支持通过编辑修改交易所账户。要换账户，请新建一个机器人' +
          '（当前这个可以停掉保留历史）。',
      });
    }

    const { managedRiskProfile, ...dbPatch } = parsed.data;
    traders.update(id, dbPatch);

    let nextLiveConfig: StrategyConfig | undefined;
    const notes: string[] = [];

    if (managedRiskProfile !== undefined && current.mode === 'ai_managed') {
      const baseCfg = parseAgentConfig(current.agentConfigJson) ?? unboundedAiManagedConfig(managedRiskProfile);
      const updatedCfg = applyManagedRiskProfile(baseCfg, managedRiskProfile);
      traders.setAgentConfig(id, JSON.stringify(updatedCfg));
      nextLiveConfig = updatedCfg;
      const spec = MANAGED_RISK_PROFILES[managedRiskProfile];
      notes.push(
        `风险护栏已切换为「${spec.label}」（BTC/ETH ≤ ${spec.btcEthMaxLeverage}x · 山寨 ≤ ${spec.altcoinMaxLeverage}x · 保证金 ≤ ${spec.maxMarginUsage}% · 日亏熔断 ${spec.maxDailyLossPercent}%）`,
      );
    } else if (
      current.mode === 'strategy' &&
      parsed.data.strategyId !== undefined &&
      parsed.data.strategyId !== null &&
      parsed.data.strategyId !== current.strategyId
    ) {
      const nextStrategy = strategies.get(parsed.data.strategyId);
      if (nextStrategy) {
        nextLiveConfig = nextStrategy.config;
        notes.push(`策略已切换为「${nextStrategy.name}」`);
      }
    }

    if (
      parsed.data.cycleIntervalMinutes !== undefined &&
      parsed.data.cycleIntervalMinutes !== current.cycleIntervalMinutes
    ) {
      notes.push(`决策周期调整为 ${parsed.data.cycleIntervalMinutes} 分钟`);
    }

    if (isCurrentlyRunning) {
      deps.manager.applyLiveUpdate?.(id, {
        name: parsed.data.name,
        cycleIntervalMinutes: parsed.data.cycleIntervalMinutes,
        initialEquity: parsed.data.initialEquity,
        strategyId: parsed.data.strategyId,
        config: nextLiveConfig,
        note:
          notes.length > 0
            ? `操作员在线热更新配置：${notes.join('；')} —— 下一轮决策立即生效，不影响当前持仓与挂单。`
            : undefined,
      });
    }

    const updated = traders.get(id);
    if (!updated) return reply.code(404).send({ error: `找不到机器人 ${id}` });
    return { ...updated, managedRiskProfile: managedRiskProfileOf(updated) };
  }));

  /** 删除时最多等在途启动收尾多久。见下面路由里的说明。 */
  const DELETE_WAIT_FOR_START_MS = 4_000;
  app.delete('/api/traders/:id', authed, guard(async (_body: unknown, request, reply) => {
    const id = idOf(request);
    invalidateLiveView(id);
    await deps.manager.stopTrader(id);
    /*
     * ⚠️ **等在途的启动收尾，再删行**（2026-11-11 审查）。
     *
     * 启动途中 `stopTrader` 取不到实例，只能立一面取消旗，由 `attemptStart`
     * 在下一个检查点放弃。在那之前就把 `traders` 行删掉，启动流程剩下的
     * 几步（落状态、写日志、记账）会对着一个不存在的机器人执行。
     * 取消通常在几秒内生效；等不到就让操作员稍后重试，而不是硬删。
     *
     * ⚠️ 上限必须**明显短于前端的请求超时**（`web/src/lib/api.ts` 的 12 秒）：
     * 否则界面先报"超时"，这里随后才把行删掉 —— 操作员看到失败，机器人却没了。
     */
    const deadline = Date.now() + DELETE_WAIT_FOR_START_MS;
    while (deps.manager.isStarting(id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (deps.manager.isStarting(id) || deps.manager.isRunning(id)) {
      return reply.code(409).send({ error: '这台机器人还在启动收尾中，请稍等几秒再删除。' });
    }
    traders.remove(id);
    return { ok: true };
  }));

  app.post('/api/traders/:id/start', authed, async (request, reply) => {
    const id = idOf(request);
    if (env.globalTradingDisabled) {
      return reply.code(503).send({
        error: '交易已被 GLOBAL_TRADING_DISABLED 全局禁用。要启动机器人请先移除该设置。',
        preflight: [],
      });
    }
    /*
     * ⚠️⚠️ **运行模式由创建时决定并固定**（2026-11-10 用户要求）
     *
     * 用户原话：「实盘/模拟 的根本逻辑得改一下：应该是由创建机器人的时候决定固定，
     * 而不是运行启动机器人的时候来决定。」
     *
     * 所以启动接口**不再接受**这个选择：
     *   · 已固定 → 直接用库里的值（请求体里的 `dryRun` 被忽略）；
     *   · 老数据（`dry_run = NULL`，创建时还没有这个概念）→ 用这次请求的值固定一次
     *     （默认模拟盘），从此不再变。这是给历史数据的一次性补写，不是"每次启动可选"。
     */
    const current = traders.get(id);
    if (!current) return reply.code(404).send({ error: `找不到机器人 ${id}`, preflight: [] });
    const body = (request.body ?? {}) as { dryRun?: unknown };
    let dryRun = current.dryRun;
    if (dryRun === undefined) {
      /* 严格只认布尔值，防止传 0 / "" 等 falsy 非布尔值把老机器人意外固化为实盘。 */
      dryRun = typeof body.dryRun === 'boolean' ? body.dryRun : true;
      traders.setDryRun(id, dryRun);
      log.info(
        `机器人 #${id} 的运行模式在本次启动时固定为「${dryRun ? '模拟盘' : '实盘'}」（老数据一次性补写；之后不再由启动决定）。`,
      );
    }
    /* ⚠️ 同步返回，不等启动跑完 —— 建连接/拉持仓/对账都要等，界面会像"点了没反应"（2026-10-10）。 */
    invalidateLiveView(id);
    const result = deps.manager.startTraderAsync(id, dryRun);
    if (!result.ok) return reply.code(400).send(result);
    return result;
  });

  app.post('/api/traders/:id/stop', authed, async (request) => {
    const id = idOf(request);
    invalidateLiveView(id);
    /* ⚠️ 不 await：stopTrader 已先把状态翻成 stopped 并掐断在途 AI 请求（2026-10-10）。 */
    void deps.manager.stopTrader(id);
    return { ok: true };
  });

  /** Force one decision cycle immediately instead of waiting for the interval. */
  /*
   * 手工平仓 —— **操作员的最高权限**。
   *
   * ## 为什么不加任何前置检查
   *
   * 这里原本**根本没有这条路由**：控制台上的「平仓」按钮只弹一个说明弹窗。
   * 那个设计的理由是"机器人自己在管理持仓，控制台不该和它抢"。
   *
   * **那个理由把"代码整洁"放在了"操作员对自己资金的控制权"前面。**
   *
   * 所以这条路由**不检查机器人是否在运行、不检查是否 dryRun、不检查全局开关**
   * —— 那些检查都属于"机器人要不要开仓"，而这条是"人要退出"。
   * **一个止不住手的操作员是被困住的。**
   *
   * 唯一的前置条件是"本地有这个持仓"，由 `closePosition` 内部判断。
   */
  /*
   * 全部平仓。
   *
   * **这条路由必须在 `:symbol` 那条之前**，否则 `/positions/close-all`
   * 会被当成 `symbol = 'CLOSE-ALL'` 吃掉。
   *
   * 与单币种平仓同样**不做任何前置检查** —— 见上面那条的说明。
   */
  app.post('/api/traders/:id/positions/close-all', authed, async (request, reply) => {
    const id = idOf(request);
    try {
      const result = await deps.manager.closeAllPositions(id);
      invalidateLiveView(id);
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message });
    }
  });

  app.post('/api/traders/:id/positions/:symbol/close', authed, async (request, reply) => {
    const id = idOf(request);
    const symbol = String((request.params as { symbol: string }).symbol).toUpperCase();
    try {
      const result = await deps.manager.closePosition(id, symbol);
      invalidateLiveView(id);
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message });
    }
  });

  app.post('/api/traders/:id/run-once', authed, async (request, reply) => {
    const id = idOf(request);
    if (env.globalTradingDisabled) {
      return reply.code(503).send({ error: '交易已被全局禁用。' });
    }
    try {
      const summary = await deps.manager.runCycleNow(id);
      return { ok: true, summary };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message });
    }
  });

  /**
   * 让 AI **现在**审视一次策略（不等事件、不等兜底超时）。
   *
   * ## 与 `/run-once` 的区别（别混）
   *
   *   `/run-once`      跑一个**决策周期** —— 机器人按当前参数决策一次
   *   `/agent-review`  跑一次**策略审视** —— AI 反思并决定要不要改参数
   *
   * ## 为什么不受全局熔断限制
   *
   * 审视**不下任何订单** —— 它只读绩效、复盘与实验记录，然后可能写一份新参数。
   * 而"交易被禁用时正该能做的事"恰恰包括"让 AI 想想我们哪里做错了"，
   * 与 `/reconcile` 同一条理由。
   *
   * 参数写回后**不会**立刻变成订单：下单是决策周期的事，而周期在熔断下不跑。
   */
  app.post('/api/traders/:id/agent-review', authed, async (request, reply) => {
    const id = idOf(request);
    try {
      const result = deps.manager.requestAgentReview(id);
      /*
       * 拒绝原因同时放进 `error`（审计 #21）：前端 `request()` 以 `error` 为准，
       * 只给 `note` 时页面只能显示「请求失败：HTTP 409」，操作员看不到原因。
       */
      if (!result.accepted) return reply.code(409).send({ ok: false, error: result.note, ...result });
      return { ok: true, ...result };
    } catch (error) {
      const note = (error as Error).message;
      return reply.code(400).send({ ok: false, error: note, note });
    }
  });

  /**
   * Rebuild a trader's ledger from the exchange's own history.
   *
   * Deliberately **not** gated by the global trading kill switch: it places no
   * orders and only corrects the books, which is exactly what you want to be
   * able to do while trading is disabled.
   */
  app.post('/api/traders/:id/reconcile', authed, async (request, reply) => {
    const id = idOf(request);
    try {
      const result = await deps.manager.reconcileTrader(id);
      invalidateLiveView(id);
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message });
    }
  });

}
