import {
  beijingDayStartIso,
  calculateTokenCost,
  extractPromptPositionContext,
  type ExecutionLogEntry,
  type PositionView,
  type Trader,
  type TraderTokenBillingSummary,
} from '@aq/shared';
import type { ExchangeConnection } from '../../binance/bootstrap.js';
import { paperAccountState, paperPositionTotals } from '../../binance/paperWallet.js';
import { env } from '../../env.js';
import type { GateConnection } from '../../gate/connection.js';
import { createLogger } from '../../logger.js';
import { managedNotesStore } from '../../managed/notes.js';
import { managedRadarStore } from '../../managed/radarStore.js';
import { evaluateTraderManagedReadiness } from '../../managed/readiness.js';
import { managedThesisStore } from '../../managed/thesis.js';
import { managedAttributionStore } from '../../radar/attribution.js';
import {
  agentExperiments as agentStoreExperiments,
  agentMemory as agentStoreMemory,
  agentRuns as agentStoreRuns,
} from '../../store/agentStore.js';
import {
  aiModels,
  computeTraderStats,
  DECISION_PAGE_DEFAULT,
  decisions,
  decisions as decisionStore,
  equity as equityStore,
  exchanges,
  normalizeMarginMode,
  ORDER_PAGE_DEFAULT,
  orders as orderStore,
  ownUnrealizedPnlOf,
  positions as positionStore,
  runtimeLogs,
  RUNTIME_LOG_CAP,
  RUNTIME_LOG_PAGE_DEFAULT,
  settings,
  traders,
  TRADE_PAGE_DEFAULT,
  trades as tradeStore,
} from '../../store/repositories.js';
import { resolveModelTokenPricing } from '../../trader/manager.js';
import { runSelfCheck } from '../../trader/selfcheckRunner.js';
import { mergeRoleLastSeen, parseCotTraceRoles, parseTeamStepLine, type RoleLastSeen } from '../health.js';
import type {
  ExchangeAccountState,
  LiveAccountViewResult,
  LivePositionsViewResult,
  RouteContext,
} from './context.js';

const log = createLogger('api');

export function registerTraderDataRoutes(ctx: RouteContext): void {
  const { app, deps, authed, idOf, getPublicGateMarket } = ctx;
  const {
    liveViewCacheTtlMs,
    liveAccountCache,
    liveAccountInFlight,
    livePositionsCache,
    livePositionsInFlight,
  } = ctx.liveView;

  /* --- Trader data ------------------------------------------------------- */

  /**
   * **这份 `positions` 是从哪儿来的** —— 前端据此区分「交易所真的没有仓」与「这是模拟仓」。
   *
   * ## 为什么必须有这个字段（用户实测 ×2 的 BUG）
   *
   * 模拟盘（`dry_run=1`）机器人的持仓**只存在于本地台账**：它的成交是本地模拟的，
   * 从来不会真的发到交易所（`broker.ts:663` 的 `if (this.dryRun) return this.simulateStandard(...)`）。
   * 而控制台卡片读的 `/account` 之前一律给交易所读数的 `positions` —— 于是它恒为
   * 空数组，卡片显示「持仓 0 / 保证金占用 0.00 / 当前无持仓」，
   * **而同一张卡里的「浮动」却有值**（那个数字走的是本地台账 + 行情标记价）。
   *
   * 「0 持仓却有浮盈」这个自相矛盾，根子就是这两路数字来源不同而界面上看不出来。
   * 所以修完必须让调用方能判定：**不必猜**。
   *
   * · `'exchange'`     —— 交易所实时读数（实盘机器人在跑）
   * · `'local_mirror'` —— 本机器人自己的**本地台账**（模拟盘；交易所对它本来就不存在这些仓）
   * · `'none'`         —— 这次没有可用的持仓读数（机器人没在跑，或交易所读失败）
   */
  type PositionsSource = 'exchange' | 'local_mirror' | 'none';

  /**
   * **某个机器人此刻是不是纸面模式**（模拟盘）。
   *
   * 判据分两级，**顺序不能反**：
   *
   * 1. `deps.manager.dryRunOf(id)` —— 正在跑的那个实例用的就是它，这是**运行时事实**。
   *    `null` 表示"它没在跑"，此时这个值此刻不存在（不是 `false` —— 见那个方法的说明）。
   * 2. 落库的 `traders.dry_run`（迁移 18）—— 它是**机器人自己的属性**，跨重启有效。
   *    三态：`true` / `false` / `undefined`（从未显式指定过）。
   *
   * ⚠️ `undefined` **不能**当成实盘：那时要回落到进程级的 `env.dryRun` ——
   * 与 `manager.resumePersisted(env.dryRun)` 同一条口径。把它读成 `false`
   * 会让一个"没在跑的模拟盘机器人"被当成实盘去读交易所，于是又回到空持仓。
   */
  const exchangeOfTrader = (trader: Trader | null | undefined): 'binance' | 'gate' => {
    if (!trader || trader.exchangeAccountId === null) return 'binance';
    const acc = exchanges.get(trader.exchangeAccountId);
    return acc?.exchange === 'gate' ? 'gate' : 'binance';
  };

  const isPaperTrader = (traderId: number): boolean => {
    const trader = traders.get(traderId);
    /*
     * Gate 的「模拟」= Gate 官方合约测试网（假钱、真实撮合，见 `gate/broker.ts` 文件头），
     * 没有本地纸面撮合分支；因此 Gate 机器人（无论测试网还是正式网）的账户/持仓真相都在 Gate 侧。
     */
    if (exchangeOfTrader(trader) === 'gate') return false;
    const runtime = deps.manager.dryRunOf(traderId);
    if (runtime !== null) return runtime;
    return trader?.dryRun ?? env.dryRun;
  };

  /**
   * 本地台账 → `PositionView[]`。
   *
   * ## 为什么抽出来（而不是在调用点各写一份 map）
   *
   * 这条映射有**两个调用点**，而它们只差一件事：**拿不拿得到标记价**。
   *
   * · `/positions` 的"机器人没在跑"那条路**按设计不读交易所**，所以标记价与浮盈
   *   都是**占位零**（见那段「一个会闪烁的表格比一个说读不到的表格更糟」的注释）；
   * · 模拟盘机器人在跑时，标记价可以从**行情**拿到（行情是事实，与哪个机器人无关 ——
   *   与 `ownUnrealizedPnlOf` 借用标记价同一条理由），于是浮盈是真值。
   *
   * 两处各写一份 map 的话，"哪些字段该给什么"迟早会在一边被改而另一边没跟上。
   * 所以这里用**可选的 `markPriceOf`** 表达那唯一的差别：给得出就算真值，
   * 给不出就回落成占位零（与改动前逐字段一致）。
   */
  /*
   * ⚠️⚠️ **模拟盘的保证金模式从开仓单里取**（2026-10-18 修）
   *
   * ## 用户报的问题
   *
   * 持仓页「保证金模式」一列永远显示 `—`（用户截图指出）。
   *
   * ## 根因
   *
   * 真实盘走 `liveExchangeView`，那里的 `marginType` 读自交易所
   * （`/fapi/v2/positionRisk`，实时值）。**而模拟盘走这条 `localPositionsFor`，
   * 它只读本地 `positions` 表 —— 那张表没有 `margin_type` 列**（只有 `margin_used`），
   * 所以 `marginType` 恒为 `undefined`，前端只能显示 `—`。
   *
   * ## 为什么 `#11` 一直是 `—`
   *
   * `#11`（团队测试）= `dry_run = 1` ⇒ 它是**模拟盘**，交易所那边**根本没有持仓**
   * （实测账户 2「gaoshou3」在 `positionRisk` 里返回空）。
   * 所以"实时读交易所"这条路对它永远读不到东西 —— 不是交易所没返回，
   * 而是**这条路径压根不该用它**。
   *
   * ## 取值来源
   *
   * `orders.margin_type` —— 开仓那一刻由服务端记下的值（`setMarginType` 成功后才写）。
   * `orderStore.latestMarginTypeBySymbol()` 取每个标的**最新一条带模式的订单**，
   * 这正是"该标的当前的模式"最接近的事实。
   *
   * ⚠️ 取不到时保持 `undefined`（界面 `—`），**绝不默认成 `'cross'`** ——
   * 与 `normalizeMarginMode()` 的约定一致：认不出就是不知道。
   */
  const paperMarginTypes = (traderId: number): Map<string, string> => {
    try {
      return orderStore.latestMarginTypeBySymbol(traderId);
    } catch {
      /* 读不到就当没有 —— 界面显示 `—`，比显示一个猜的值好。 */
      return new Map<string, string>();
    }
  };

  /**
   * **保护单是否还在挂载中**（2026-10-19 用户要求）。
   *
   * ## 为什么需要它
   *
   * 用户原话：
   * > 「我刚才看到这单开单的时候提示没有止损，后面又有了好像是系统自动补上，
   * >  但是这显示是不是有问题？…显示要正常不要让我产生误会」
   *
   * 市场价开仓到保护单挂好之间有约 2 秒的窗口：
   * ```
   *   t+0s  成交（持仓已存在，stopLoss 在本地也已算好）
   *   t+2s  两张条件单挂上
   * ```
   * 窗口内界面说「无止损」是**把"还不知道"说成了"没有"** —— 两件事不一样。
   *
   * ## 判据
   *
   * ```
   *   开仓不足 60 秒  &&  该标的一条 NEW 保护单都没有  ⇒ 挂载中
   * ```
   * 60 秒远大于实测的 2 秒，留足余量；超过 60 秒还缺，
   * 那就是**真的缺**（由 `ensureStopsOnOpenPositions()` 下一轮补），
   * 这时界面该如实说"无止损"。
   *
   * ⚠️ 只在**本地持仓**上算（模拟盘/未运行机器人）。实盘走交易所挂单列表，
   * 那里本来就是真相，不需要这个猜测。
   */
  const PROTECTION_PENDING_MS = 60_000;
  const protectionPendingOf = (
    traderId: number,
    row: { symbol: string; opened_at: string },
  ): boolean => {
    const age = Date.now() - new Date(row.opened_at).getTime();
    if (!(age >= 0 && age < PROTECTION_PENDING_MS)) return false;
    try {
      /* 有任何一张 NEW 的保护单就不算"挂载中" —— 已经在挂了。 */
      const orderTypes = orderStore.openProtectionTypes(traderId, row.symbol);
      return orderTypes.length === 0;
    } catch {
      /* 读不到订单表时**不猜**：当作不在挂载中，让界面按实际情况显示。 */
      return false;
    }
  };

  const localPositionsFor = (
    traderId: number,
    markPriceOf?: ReadonlyMap<string, number>,
  ): PositionView[] => {
    const marginBySymbol = paperMarginTypes(traderId);
    return positionStore.open(traderId).map((row) => {
      const mark = markPriceOf?.get(row.symbol);
      const hasMark = typeof mark === 'number' && Number.isFinite(mark) && mark > 0;
      /*
       * ⚠️ **不给标记价时，这里必须与改动前的 `/positions` 回退分支逐字段一致**
       * （`markPrice = entry_price`、浮盈 0、`marginUsed = row.margin_used`、
       * 名义按**入场价**算）。那条路径服务的是"机器人没在跑"，它按设计**不读
       * 交易所、也不读行情** —— 自行推算保证金会静默改掉它的数字。
       */
      if (!hasMark) {
        return {
          id: row.id,
          traderId,
          symbol: row.symbol,
          /*
           * ⚠️ **`side` 必须显式收窄成 `'long' | 'short'`**（`PositionRow.side` 是
           * `string`，而 `PositionView.side` 是联合类型）。
           * 口径与 `autoTrader.ts` 的 `toPositionView()` 完全一致 —— 本表里这一列
           * 只由交易循环写入，取值只有这两个；两处用同一种收法，将来才不会分叉。
           */
          side: row.side === 'long' ? 'long' : 'short',
          quantity: row.quantity,
          entryPrice: row.entry_price,
          markPrice: row.entry_price,
          leverage: row.leverage,
          liquidationPrice: row.liquidation_price,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          peakPnlPercent: row.peak_pnl_percent,
          marginUsed: row.margin_used,
          /* 模拟盘的保证金模式来自开仓单 —— 见 `localPositionsFor` 函数头那段说明。 */
          marginType: normalizeMarginMode(marginBySymbol.get(row.symbol)) ?? undefined,
          notional: row.quantity * row.entry_price,
          stopLoss: row.stop_loss,
          takeProfit: row.take_profit,
          openedAt: row.opened_at,
          openReasoning: row.open_reasoning,
        };
      }
      const markPrice = mark as number;
      /*
       * 方向由 `side` 承载、数量恒为正 —— 与 `ownUnrealizedPnlOf()` 同一个算式。
       */
      const isLong = row.side === 'long';
      const unrealizedPnl =
        (isLong ? markPrice - row.entry_price : row.entry_price - markPrice) * row.quantity;
      /*
       * 保证金口径：真实占用优先，缺失时按「价 × 量 ÷ 杠杆」推。
       * 与 `liveExchangeView` 里那条（`live.marginUsed`）以及
       * `unrealizedPnlPercent` 的分母保持一致 —— 界面同屏出现这三个数时口径必须相同。
       */
      const marginUsed =
        row.margin_used > 0
          ? row.margin_used
          : (row.entry_price * row.quantity) / Math.max(1, row.leverage);
      return {
        id: row.id,
        traderId,
        symbol: row.symbol,
        side: row.side === 'long' ? 'long' : 'short',
        quantity: row.quantity,
        entryPrice: row.entry_price,
        markPrice,
        leverage: row.leverage,
        liquidationPrice: row.liquidation_price,
        unrealizedPnl,
        unrealizedPnlPercent: marginUsed > 0 ? (unrealizedPnl / marginUsed) * 100 : 0,
        peakPnlPercent: row.peak_pnl_percent,
        marginUsed,
        /* 模拟盘的保证金模式来自开仓单 —— 见 `localPositionsFor` 函数头那段说明。 */
        marginType: normalizeMarginMode(marginBySymbol.get(row.symbol)) ?? undefined,
        notional: row.quantity * markPrice,
        stopLoss: row.stop_loss,
        takeProfit: row.take_profit,
        /* 刚开仓且保护单还没挂好 —— 界面显示「挂单中」而不是「无止损」。 */
        protectionPending: protectionPendingOf(traderId, row),
        openedAt: row.opened_at,
        openReasoning: row.open_reasoning,
      };
    });
  };

  /** 这条只读连接拿到的账户读数形状（`AccountState` 不引新 import）。 */
  const openReadOnlyFor = async (trader: Trader): Promise<ExchangeConnection | GateConnection | null> => {
    if (deps.openReadOnlyConnection) return deps.openReadOnlyConnection();
    /*
     * 优先复用运行中实盘机器人已经建立好的连接：避免每次前端轮询都重建连接、
     * 重复请求 `/fapi/v1/time` 与 600KB `exchangeInfo`。只读查询不会改变连接状态。
     */
    const active = deps.manager.activeLiveConnectionOf?.(trader.id);
    if (active) return active;
    /*
     * 纯模拟盘机器人没有交易所账户（用户 2026-10-27 需求）——
     * 没有凭据行就是"读不到账户事实"，返回 null，由调用方按"读不到"处理
     * （模拟盘的持仓本来就来自本地台账，不依赖这条连接）。
     */
    if (trader.exchangeAccountId === null) return null;
    const row = exchanges.getWithSecret(trader.exchangeAccountId);
    if (!row) return null;
    /*
     * ⚠️ **按交易所分派**（2026-11-11 端到端联调实测）：原来这里无条件走币安 ——
     * Gate 机器人的"账户/持仓"视图会拿 Gate 凭据去打币安端点，回报
     * 「币安错误 -2014：API-key format invalid」，界面上看起来像凭据坏了。
     * 两个连接对象在只读视图用到的三个方法（getAccountState/getPositions/
     * getOpenOrders）形状一致，所以返回类型收成 union 即可。
     */
    if (row.exchange === 'gate') {
      const { connectGate, gateEnvironmentOf } = await import('../../gate/connection.js');
      return connectGate({
        apiKey: row.api_key,
        apiSecret: deps.vault.decrypt(row.api_secret_enc),
        environment: gateEnvironmentOf(row.testnet === 1),
      });
    }
    const { connectExchange } = await import('../../binance/bootstrap.js');
    return connectExchange({
      environment: row.testnet === 1 ? 'demo' : 'production',
      apiKey: row.api_key,
      apiSecret: deps.vault.decrypt(row.api_secret_enc),
      /*
       * ⚠️ **只读视图必须传 `dryRun: false`（2026-11-23 P0 修复）**：
       * 2026-11-09 `BinanceBroker.getPositions`/`getOpenOrders` 加上了 `if (this.dryRun) return []`
       * 守卫后，这里继续传 `dryRun: true` 会把实盘币安机器人的实时持仓与挂单数全部短路为空数组。
       * 本连接只在 `liveExchangeView` 中做只读查询，永不调用任何下单/撤单方法。
       */
      dryRun: false,
      /*
       * 这条连接是**一次性**的：控制台每次轮询都会重建它，只为拿到交易所
       * 真实持仓（而不是本地镜像）。不加这个开关时，`loaded 528 tradable...`
       * 会每 44 秒写一条 —— 30 分钟 41 条，而同期只有 11 个周期。
       */
      quiet: true,
    });
  };

  /**
   * **账户读数（尽力而为）** —— 读不到就 `null`，绝不让它影响持仓那一路。
   *
   * ## 模拟盘读本地钱包，实盘读交易所（用户 2026-10-27 需求）
   *
   * 原来的注释写的是"模拟盘的持仓不来自交易所，但账户余额仍然只能问交易所" ——
   * 那是旧的设计。用户明确要求「模拟盘不应该根据真实钱包的余额，而应该可以
   * 自定义模拟盘的余额」，所以现在模拟盘的账户读数由**本地台账**折算：
   *
   * ```
   *   walletBalance = 模拟起始余额 + 已实现净盈亏
   *   unrealizedPnl = Σ 各持仓按标记价算出的浮盈
   * ```
   *
   * 这与交易循环里 `paperAccountStateOf()` 用的是**同一套数字**，所以控制台看到的
   * 余额与机器人决策时看到的余额不会打架。
   *
   * ⚠️ 纯模拟盘（`exchangeAccountId === null`）**根本没有账户可问** ——
   * 走旧路径会永远返回 `null`，界面上显示成"读不到余额"，看起来像坏了。
   */
  const readAccountBestEffort = async (trader: Trader): Promise<ExchangeAccountState | null> => {
    try {
      if (isPaperTrader(trader.id)) {
        /*
         * 浮盈要按标记价算 —— 与 `paperMarkPrices()` 同一来源（公开行情，
         * 不需要该账户有凭据）。
         */
        const local = positionStore.open(trader.id);
        const marks = await paperMarkPrices(local, exchangeOfTrader(trader));
        const starting = deps.manager.paperStartingBalanceOf(trader.id);
        const realized = tradeStore.lifetimeNetPnl(trader.id);
        /*
         * 折算与控制台/决策同源：`paperPositionTotals()` 是那唯一一份实现
         * （原先这里与 manager 各写一份，其中一份方向判断写错了大小写）。
         */
        const { unrealizedPnl, marginUsed } = paperPositionTotals(local, marks);
        return paperAccountState({ startingBalance: starting, realizedPnl: realized, unrealizedPnl, marginUsed });
      }
      const connection = await openReadOnlyFor(trader);
      if (!connection) return null;
      return await connection.broker.getAccountState();
    } catch (error) {
      /*
       * 不静默：账户读数失败要留下原因。
       * 原来这里是空 `catch`，于是"为什么余额是空的"完全无法从日志判断 ——
       * 而这正是模拟盘刚接上本地钱包时最容易出错的地方（字段名、单位、空值）。
       */
      log.warn(`[trader ${trader.id}] 账户读数失败：${(error as Error).message}`);
      return null;
    }
  };

  /**
   * 用**公共行情**给本地台账配标记价（模拟盘专用）。
   *
   * ⚠️ 走 `deps.publicConnection` 而**不是**用凭据建的那条只读连接：标记价是
   * **公开行情**，不需要签名，也不需要该账户有凭据。顺带避免"为了给一个模拟仓
   * 算浮盈而去解密交易所密钥"这种越界。
   *
   * 读不到就让浮盈按 0 计，并由调用方把标的报出来（不静默 —— 见 `ownUnrealizedPnlOf`）。
   */
  const paperMarkPrices = async (
    local: ReadonlyArray<{ symbol: string }>,
    exchange: 'binance' | 'gate' = 'binance',
  ): Promise<Map<string, number>> => {
    const marks = new Map<string, number>();
    if (local.length === 0) return marks;
    const want = new Set(local.map((p) => p.symbol));
    const premiums =
      exchange === 'gate'
        ? await getPublicGateMarket()
            .then(({ market }) => market.premiumIndex())
            .catch(() => [])
        : await deps.publicConnection.market.premiumIndex().catch(() => []);
    for (const premium of premiums) {
      if (!want.has(premium.symbol)) continue;
      const value = Number(premium.markPrice);
      if (Number.isFinite(value) && value > 0) marks.set(premium.symbol, value);
    }
    return marks;
  };

  /**
   * 将交易所实时持仓与本地台账元数据（止盈止损、峰值浮盈、入场理由）叠加为 `PositionView[]`。
   * `/positions` 与 `/account` 两条路由共用同一套映射逻辑，保证口径完全一致。
   */
  const mapExchangePositions = (
    traderId: number,
    livePositions: Awaited<ReturnType<ExchangeConnection['broker']['getPositions']>>,
  ): PositionView[] => {
    const local = positionStore.open(traderId);
    const bySymbol = new Map(local.map((p) => [p.symbol, p]));
    return livePositions.map((live) => {
      const record = bySymbol.get(live.symbol);
      return {
        id: record?.id ?? 0,
        traderId,
        symbol: live.symbol,
        side: live.side,
        quantity: live.quantity,
        entryPrice: live.entryPrice,
        markPrice: live.markPrice,
        leverage: live.leverage,
        liquidationPrice: live.liquidationPrice,
        unrealizedPnl: live.unrealizedPnl,
        unrealizedPnlPercent: live.unrealizedPnlPercent,
        peakPnlPercent: record?.peak_pnl_percent ?? 0,
        marginUsed: live.marginUsed,
        marginType: normalizeMarginMode(live.marginType) ?? undefined,
        notional: live.notional,
        stopLoss: record?.stop_loss ?? null,
        takeProfit: record?.take_profit ?? null,
        openedAt: record?.opened_at ?? new Date().toISOString(),
        openReasoning: record?.open_reasoning ?? '',
      };
    });
  };

  /**
   * 轻量版实时持仓读取（供 `GET /api/traders/:id/positions` 专用）。
   *
   * 相比 `liveExchangeView`：
   *   1. 实盘分支**只调用 `getPositions()`（5 权重）**，不再附带 40 权重的全量
   *      `getOpenOrders()` 与 5 权重的 `getAccountState()` —— 每次轮询直降 90% 权重；
   *   2. 带 `liveViewCacheTtlMs` 短缓存 + 并发合并（in-flight 去重），多标签页/多组件
   *      同时轮询只向交易所发 1 次请求；失败结果永不缓存。
   */
  const livePositionsView = async (traderId: number): Promise<LivePositionsViewResult> => {
    const trader = traders.get(traderId);
    if (!trader || !deps.manager.isRunning(traderId)) {
      return {
        live: false,
        positions: [] as PositionView[],
        positionsSource: 'none' as PositionsSource,
        error: undefined,
      };
    }
    if (isPaperTrader(traderId)) {
      const local = positionStore.open(traderId);
      const marks = await paperMarkPrices(local, exchangeOfTrader(trader));
      return {
        live: true,
        positions: localPositionsFor(traderId, marks),
        positionsSource: 'local_mirror' as PositionsSource,
        error: undefined,
      };
    }
    const now = Date.now();
    if (liveViewCacheTtlMs > 0) {
      const cachedPos = livePositionsCache.get(traderId);
      if (cachedPos && now - cachedPos.at < liveViewCacheTtlMs) {
        return cachedPos.value;
      }
      const cachedAcc = liveAccountCache.get(traderId);
      if (cachedAcc && now - cachedAcc.at < liveViewCacheTtlMs && cachedAcc.value.live) {
        return {
          live: true,
          positions: cachedAcc.value.positions,
          positionsSource: cachedAcc.value.positionsSource,
          error: undefined,
        };
      }
      const inFlight = livePositionsInFlight.get(traderId);
      if (inFlight) return inFlight;
    }

    const run = async (): Promise<LivePositionsViewResult> => {
      try {
        const connection = await openReadOnlyFor(trader);
        if (!connection) {
          return {
            live: false,
            positions: [] as PositionView[],
            positionsSource: 'none' as PositionsSource,
            error: '找不到该凭据',
          };
        }
        const livePositions = await connection.broker.getPositions();
        const exchangePositions = mapExchangePositions(traderId, livePositions);
        const paper = isPaperTrader(traderId);
        const result: LivePositionsViewResult = {
          live: true,
          positions: paper ? localPositionsFor(traderId) : exchangePositions,
          positionsSource: (paper ? 'local_mirror' : 'exchange') as PositionsSource,
          error: undefined,
        };
        if (liveViewCacheTtlMs > 0) {
          livePositionsCache.set(traderId, { at: Date.now(), value: result });
        }
        return result;
      } catch (error) {
        log.warn(`机器人 #${traderId} 的交易所持仓读数失败，本轮不回退到本地镜像：${(error as Error).message}`);
        return {
          live: false,
          positions: [] as PositionView[],
          positionsSource: 'none' as PositionsSource,
          error: (error as Error).message,
        };
      }
    };

    if (liveViewCacheTtlMs <= 0) return run();
    const pending = run();
    livePositionsInFlight.set(traderId, pending);
    try {
      return await pending;
    } finally {
      if (livePositionsInFlight.get(traderId) === pending) {
        livePositionsInFlight.delete(traderId);
      }
    }
  };

  /**
   * Read the exchange directly for a trader's live account and positions.
   *
   * Uses the running live connection when available (otherwise a read-only connection),
   * with short TTL caching + in-flight deduplication so multiple browser tabs never
   * hammer Binance's 2400 weight/min budget.
   *
   * ⚠️ **一个例外：模拟盘（`dry_run`）机器人。** 交易所对它**不是**真相来源 ——
   * 它的仓位在交易所根本不存在，用它只会得到"空持仓"。见 `PositionsSource` 的说明。
   */
  const liveExchangeView = async (traderId: number): Promise<LiveAccountViewResult> => {
    const trader = traders.get(traderId);
    if (!trader || !deps.manager.isRunning(traderId)) {
      return {
        live: false,
        account: null,
        positions: [] as PositionView[],
        positionsSource: 'none' as PositionsSource,
        error: undefined as string | undefined,
      };
    }
    if (isPaperTrader(traderId)) {
      const local = positionStore.open(traderId);
      const marks = await paperMarkPrices(local, exchangeOfTrader(trader));
      const own = ownUnrealizedPnlOf(local, (symbol) => marks.get(symbol));
      if (own.missingMarkPrice.length > 0) {
        log.warn(
          `[trader ${traderId}] 这些标的有本地持仓但拿不到标记价，其浮盈未计入首页数字：${own.missingMarkPrice.join('、')}`,
        );
      }
      return {
        live: true,
        account: await readAccountBestEffort(trader),
        positions: localPositionsFor(traderId, marks),
        positionsSource: 'local_mirror' as PositionsSource,
        ownUnrealizedPnl: own.unrealizedPnl,
        openOrderCount: positionStore.pending(traderId).length,
        error: undefined as string | undefined,
      };
    }

    if (liveViewCacheTtlMs > 0) {
      const cached = liveAccountCache.get(traderId);
      if (cached && Date.now() - cached.at < liveViewCacheTtlMs) {
        return cached.value;
      }
      const inFlight = liveAccountInFlight.get(traderId);
      if (inFlight) return inFlight;
    }

    const run = async (): Promise<LiveAccountViewResult> => {
      try {
        /*
         * 建一条**只读**交易所连接（或复用运行中连接）。`deps.openReadOnlyConnection` 是**测试用**的
         * 注入口 —— 见 `ApiDependencies` 上那个字段的说明（不传时行为与改动前相同）。
         */
        const connection = await openReadOnlyFor(trader);
        if (!connection)
          return {
            live: false,
            account: null,
            positions: [] as PositionView[],
            positionsSource: 'none' as PositionsSource,
            error: '找不到该凭据',
          };
        const [account, livePositions, liveOrders] = await Promise.all([
          connection.broker.getAccountState(),
          connection.broker.getPositions(),
          /*
           * ⚠️ **挂单数必须由这里给，不能让界面用 WebSocket 镜像去数。**
           * 判断"有没有东西占着保证金"这件事，**必须问交易所，不能问镜像**。
           */
          connection.broker.getOpenOrders(),
        ]);
        const local = positionStore.open(traderId);
        const exchangePositions = mapExchangePositions(traderId, livePositions);
        const markPriceOf = new Map(livePositions.map((live) => [live.symbol, live.markPrice]));
        const missingMark = local.map((p) => p.symbol).filter((symbol) => !markPriceOf.has(symbol));
        if (missingMark.length > 0) {
          const want = new Set(missingMark);
          const premiums = await connection.market.premiumIndex().catch(() => []);
          for (const premium of premiums) {
            if (!want.has(premium.symbol)) continue;
            const value = Number(premium.markPrice);
            if (Number.isFinite(value) && value > 0) markPriceOf.set(premium.symbol, value);
          }
        }
        const own = ownUnrealizedPnlOf(local, (symbol) => markPriceOf.get(symbol));
        if (own.missingMarkPrice.length > 0) {
          log.warn(
            `[trader ${traderId}] 这些标的有本地持仓但拿不到标记价，其浮盈未计入首页数字：${own.missingMarkPrice.join('、')}`,
          );
        }
        const ownUnrealizedPnl = own.unrealizedPnl;
        const paper = isPaperTrader(traderId);
        const positions: PositionView[] = paper
          ? localPositionsFor(traderId, markPriceOf)
          : exchangePositions;
        const openOrderCount = paper ? positionStore.pending(traderId).length : liveOrders.length;
        const result: LiveAccountViewResult = {
          live: true,
          account,
          positions,
          positionsSource: (paper ? 'local_mirror' : 'exchange') as PositionsSource,
          ownUnrealizedPnl,
          openOrderCount,
          error: undefined as string | undefined,
        };
        if (liveViewCacheTtlMs > 0) {
          const ts = Date.now();
          liveAccountCache.set(traderId, { at: ts, value: result });
          livePositionsCache.set(traderId, {
            at: ts,
            value: {
              live: true,
              positions: result.positions,
              positionsSource: result.positionsSource,
              error: undefined,
            },
          });
        }
        return result;
      } catch (error) {
        log.warn(`机器人 #${traderId} 的交易所读数失败，本轮不回退到本地镜像：${(error as Error).message}`);
        return {
          live: false,
          account: null,
          positions: [] as PositionView[],
          positionsSource: 'none' as PositionsSource,
          error: (error as Error).message,
        };
      }
    };

    if (liveViewCacheTtlMs <= 0) return run();
    const pending = run();
    liveAccountInFlight.set(traderId, pending);
    try {
      return await pending;
    } finally {
      if (liveAccountInFlight.get(traderId) === pending) {
        liveAccountInFlight.delete(traderId);
      }
    }
  };

  /**
   * 统计 + **熔断器的当前读数**。
   *
   * ## 熔断读数为什么挂在响应上、而不是进 `TraderStats`
   *
   * `TraderStats` 是**仓储层**算出来的纯统计（只读数据库）。而熔断读数依赖
   * **运行时真实生效的那份配置**（AI 托管下来自 `traders.agent_config_json`，
   * 与策略表里那份可能不同）与进程内的最新权益 —— 让仓储去重算它，既多两趟查询，
   * 又可能算出与交易循环不一致的答案。
   *
   * ## 它回答的是哪一个问题
   *
   * 熔断生效时交易循环会**跳过整个周期**（连模型都不问），所以操作员看到的是：
   * 状态 running、权益一动不动、决策流里一条 `skipped` —— 而**没有任何一处说
   * "它被熔断了、以及怎么解除"**。这个字段就是那一处。
   *
   * 机器人在**停止**时是 `null`（那时没有内存里的配置可用来判定），
   * 客户端据此不渲染那一行 —— 而不是渲染成"没有熔断"。
   */
  app.get('/api/traders/:id/stats', authed, async (request, reply) => {
    const id = idOf(request);
    /*
     * ⚠️ **不存在的机器人必须回 404，不能回 200 + 全零**（外部 issue #162）。
     *
     * 原来这里不检查存在性：`computeTraderStats()` 走的是 SQL 聚合
     *（`aggregateTrades()` 的 `COUNT(*)` / `SUM(...)`），一个不存在的 id 会得到
     * `COUNT = 0` 与 `SUM = NULL`（被兜底成 0）—— 于是响应是
     * **200 + 权益 0 / 收益 0% / 胜率 0%**。
     *
     * 而同一个资源族的 `/api/traders/:id/account`（下方几行）**是回 404 的**。
     * 两者不一致的后果不是"不好看"：**"权益 0"会被读成"这个机器人亏光了"** ——
     * 一个打错的 id、或一个刚被删掉的机器人，在界面上表现为"账户归零"。
     * 这个项目下的是真实订单，"权益 0"是最需要被当真的一类读数。
     *
     * 对齐 `/account` 的写法（同一句话、同一个状态码），
     * 这样两个端点在"机器人不存在"这件事上给出同一个答案。
     */
    const trader = traders.get(id);
    if (!trader) return reply.code(404).send({ error: '找不到该机器人' });
    return {
      ...computeTraderStats(id),
      circuitBreaker: deps.manager.readCircuitBreaker(id),
      /*
       * 有效杠杆表盘的刻度。`null` = 读不到，前端显示"不知道"而不是 0 ——
       * 见 `manager.leverageCap()` 的说明。
       */
      maxLeverage: deps.manager.leverageCap(id),
      /*
       * 这个机器人自己在不在纸面模式。
       *
       * 与 `circuitBreaker` 同一个理由挂在响应上，而不是进 `TraderStats`：
       * 它是**运行时**的事实（`dryRun` 是启动参数、不落库），仓储层算不出来。
       *
       * `null` = 它没在运行 —— 客户端据此**不渲染**那一行，而不是渲染成「实盘」。
       * 顶栏那个徽章读的是进程级的 `env.dryRun`，两者可以不一致，所以必须分开说。
       */
      dryRun: deps.manager.dryRunOf(id),
    };
  });

  app.get('/api/traders/:id/positions', authed, async (request, reply) => {
    const id = idOf(request);
    const live = await livePositionsView(id);

    /*
     * ── 读得到交易所就用交易所的；**读不到时不要拿本地镜像冒充** ──────────
     *
     * `live.live === false` 有**两个完全不同的原因**，而它们原来被当成了一回事：
     *
     *   1. **机器人没在跑** —— 此时本地镜像是唯一的真相，必须返回它；
     *   2. **读交易所失败**（网络抖动、限流、连接超时）—— 此时本地镜像**可能已经过期**：
     *      仓位刚在交易所平掉、而对账还没跑，本地那一行还写着 `open`。
     *
     * 第二种情况下把镜像返回出去，界面就会**先显示一个已经不存在的持仓、几秒后又
     * 让它消失**（用户的原话：「会显示不存在的订单（实际是没有的，会出现几秒钟
     * 然后又突然消失）」）。而本地镜像是**回退值**：它的权益、标记价、浮盈全是
     * 占位零（见 `localPositionsFor` 不给标记价的那条回落），也就是说那份"持仓"
     * 从数字上就不可信。
     *
     * ⚠️ **模拟盘（`dry_run`）不在"回退值"那一类里**：它的交易所读数恒为空，
     * 本地台账才是**它自己的真相**。所以 `liveExchangeView` 在那种情况下直接返回
     * 本地台账（`positionsSource: 'local_mirror'`），到这里 `live.live` 已经是 `true` ——
     * 下面那条 503 与"没在跑"的分支都不该被走到。
     *
     * **一个会闪烁的表格比一个说"读不到"的表格更糟** —— 前者让人怀疑整张表，
     * 后者只说明这一次读数没成功。所以这里回 503：前端拿到非 2xx 会**保留上一次
     * 成功的交易所读数**（`usePolled` 的既有行为），界面于是停在"最后一次真实读数"
     * 上，而不是跳到一个本地猜的版本。
     */
    if (live.live) return live.positions;

    if (live.error) {
      reply.code(503);
      return { error: `暂时读不到交易所持仓：${live.error}` };
    }

    /* 机器人没在跑 —— 本地镜像是唯一的真相，照旧返回。 */
    /*
     * ⚠️ **这条路上没有 `marginType`，那是刻意的**（不是漏了）。
     *
     * 保证金模式只存在于**交易所的逐标的配置**里：本地 `positions` 表从来没有这一列，
     * 而这条路径按设计**不读交易所**（机器人停了，读它没有意义）。所以这里给不出值，
     * 结果是 `undefined` → 界面显示 `—`。
     *
     * **不要用币安的默认值把它填成 `'cross'`**：那会让"读不到"与"确实是全仓"在界面上
     * 长得一模一样，而这个界面在别处（`marginUsed`、熔断读数、`dryRun`）已经明确
     * 选择了"不知道就说不知道"。
     */
    return localPositionsFor(id);
  });

  /** Live exchange view, so the console can show truth rather than our mirror. */
  app.get('/api/traders/:id/account', authed, async (request, reply) => {
    const trader = traders.get(idOf(request));
    if (!trader) return reply.code(404).send({ error: '找不到该机器人' });
    return liveExchangeView(trader.id);
  });

  /**
   * 账户上的**外部交易活动** —— 不属于本平台任何机器人的成交。
   *
   * ## 为什么是独立端点而不是塞进 `/account`
   *
   * `/account` 是**实时**读交易所的，而这个结论来自**最近一次对账**
   * （每 10 轮一次深扫）。两者时效性不同、失败方式也不同：交易所读不到时
   * `/account` 报错，而这个检测的结论**仍然有效**（来自上一次成功的对账）。
   * 混在一个响应里会让「哪个是实时、哪个是上次的」变得说不清。
   *
   * 机器人**停止之后**这个端点仍然能返回结论 —— 那正是最需要它的时刻：
   * 操作员看到余额不对，而机器人已经停了、不会再跑对账。
   */
  app.get('/api/traders/:id/foreign-activity', authed, (request, reply) => {
    const trader = traders.get(idOf(request));
    if (!trader) return reply.code(404).send({ error: '找不到该机器人' });
    return readForeignActivityFor(trader.id);
  });

  /**
   * M3.4：智能托管 2.0 雷达评分、活跃持仓论点 `thesis` 与反例衰减笔记只读视图。
   * 仅从本地 SQLite 读取，不触发任何交易所或模型请求。
   */
  app.get('/api/traders/:id/managed-intel', authed, (request, reply) => {
    const trader = traders.get(idOf(request));
    if (!trader) return reply.code(404).send({ error: '找不到该机器人' });
    return {
      radar: managedRadarStore.get(trader.id),
      theses: managedThesisStore.listActive(trader.id),
      notes: managedNotesStore.listActive(trader.id),
      attribution: managedAttributionStore.get(trader.id),
      readiness: evaluateTraderManagedReadiness(trader.id),
    };
  });

  /**
   * 订单记录，**分页**返回；响应体是 `OrderRecord[]`，**形状没有变**
   * （老客户端与 `docs/API.md` 都照旧）。
   *
   * | 参数 | 说明 |
   * |---|---|
   * | `limit` | 一页多少条。默认 100，上限 `ORDER_PAGE_MAX`（200）——**钳制不报错** |
   * | `before` | 游标：只返回 `id` 比它更小的订单。第一页不传 |
   *
   * 上限的钳制在仓储层（`clampOrderLimit`），所以这里不做验证：
   * 一个手写的 `?limit=999999` 最坏也只是拿到 200 条，而不是把整张订单表
   * 拼成响应 —— 这张表随机器人运行无限增长，正是操作者说的"一次加载上万条卡死"。
   */
  app.get('/api/traders/:id/orders', authed, async (request) => {
    const query = request.query as { limit?: string; before?: string };
    const limit = Number(query.limit ?? ORDER_PAGE_DEFAULT);
    // `before` 是非数字/缺失时按"第一页"处理：发不出正确游标的调用方应该拿到
    // 最新的一页，而不是一个 400（与 `limit` 的钳制同一个取舍）。
    const before = Number(query.before);
    return orderStore.list(idOf(request), limit, Number.isFinite(before) ? before : null);
  });

  /**
   * 成交记录，**分页**返回；响应体是 `TradeRecord[]`，**形状没有变**。
   *
   * 参数与 `/orders` 基本一致（`limit` 默认 100、上限 `TRADE_PAGE_MAX`），
   * 但**多一个 `beforeClosedAt`** —— 见下。
   *
   * ## 为什么成交要多一个游标参数（`/orders` 不需要）
   *
   * 用户报过：「**历史成交里面日期显示错乱（不是完全按时间排序）**」。
   *
   * 根因是 `trades.id` 是**插入顺序**，而**对账补录的行 id 更大、成交时刻却更早**
   * 实测 18 行里 4 处乱序。修法是**按 `closed_at` 排序**，而按时间排序之后，
   * 只用 `id` 做游标会让页边界漏行（补录行 id 大、时间早，会被 `id < cursor`
   * 整个跳过）。
   *
   * 所以成交列表用**复合游标** `(closed_at, id)`：`before` 给 id、
   * `beforeClosedAt` 给那一行的成交时刻。**两个都给才启用新行为**，只给
   * `before` 时退回按 id 分页 —— 老调用方（以及任何只发一个游标的脚本）
   * 行为与以前完全一致。
   */
  /**
   * ── **智能体审计**（`agent_runs` / `agent_experiments` / `agent_memory`）──
   *
   * ## 为什么要有这个端点（用户 2026-10-12 的要求）
   *
   * 用户理想中的团队要有「**汇报工作的**」角色，而团队模式的看板要能显示
   * 「有哪些智能体、都是什么分工、都在做什么」。
   *
   * 但这三张表**此前在前端完全不可见** —— 仓储层写得很完整
   *（`agentStore.recent()` 三个方法都有），**却没有任何 API 暴露它们**，
   * 于是 `web/src` 里对这三张表的引用是 **0 处**（考古报告 §5.2 记的就是这件事）。
   *
   * 结果是：AI 改了什么参数、反思出了什么教训、每个角色跑得怎么样 ——
   * **全都在库里，但操作员一条都看不到**。那等于没有审计。
   *
   * ## 一次返回三张表
   *
   * 合成一个响应而不是三个端点：界面上一块面板就要同时显示它们
   *（"这一轮做了什么 + 学到了什么 + 之前试过什么"），
   * 分三个请求会让面板出现三次加载闪烁。
   */
  app.get('/api/traders/:id/agent-audit', authed, (request) => {
    const traderId = idOf(request);
    const query = request.query as { limit?: string };
    const parsed = Number(query.limit ?? 20);
    /* 钳制而不报错 —— 与 `clampDecisionLimit` 同一个原则（界面传错不该 500）。 */
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(1, Math.trunc(parsed)), 100) : 20;

    return {
      /** 每次角色运行（谁跑了、用了多少 token、多久）。 */
      runs: agentStoreRuns.recent(traderId, limit),
      /** 参数实验（改了什么 + 真实结果）。**这是"自我迭代"的审计线索。** */
      experiments: agentStoreExperiments.recent(traderId, limit),
      /** 教训记忆（按标的）。 */
      memory: agentStoreMemory.recent(traderId, limit),
      /** 待结算的实验数 —— 界面可以据此说"还有 N 个在等结果"。 */
      pendingExperiments: agentStoreExperiments.pending(traderId).length,
      /** 累计运行次数 —— 判断"这个机器人到底跑过多少次"。 */
      runCount: agentStoreRuns.countSince(traderId, '1970-01-01T00:00:00Z'),
    };
  });

  /*
   * ══════════════════════════════════════════════════════════════════════════
   *  ⭐ **一个岗位"最近什么时候干过活" + "它干过的历史"**（2026-10-17 · t111）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 用户报的问题（这是他看到的原话）
   *
   * > 「我观察到**很多岗位，似乎从未真正运行过**，页面上也没有显示他们**最新运行时间**」
   *
   * ## 根因：界面只读了**一半**的数据源
   *
   * `TeamBoard` 的"最近活跃于 X 分钟前"原来只从 `decision_records.cot_trace` 里抽
   * （`lastSeenOf` 的正则 `- <role>（<model>）：`）。而**只有进了 `<team>` 块的角色**
   * 才有那种行 —— 实测只有分析师 / `bull` / `bear` / `judge`
   * （`agent/deskOutput.ts` 里 `lines.push` 的那四处）。
   *
   * 于是这三类角色在界面上**永远显示"待命"**，而它们在 `runtime_logs` 里出现得很频繁：
   * ```
   *   supervisor     ← 派发阶段，写的是 note('supervisor', …) → runtime_logs(scope='team')
   *   risk_officer   ← 风控阶段，onStep → runtime_logs(scope='team')
   *   reporter       ← 汇报阶段，onStep → runtime_logs(scope='team')
   * ```
   * 线上实测 `supervisor` 在 team 域出现 **31 次**（全系统最多），界面上却写"待命" ——
   * **界面在说谎，不是角色没跑**。
   *
   * ## 为什么在这里解析 `runtime_logs` 的文本，而不是新加一张表
   *
   * 团队每一步都会写一行 `[<phase>] <role>：<note>`（见 `manager.ts` 的 `onStep`），
   * 自检写的是 `[自检/<source>] …`（`scope='selfcheck'`）。
   * **两个数据源都已经存在、都已经带 traderId 与时刻** —— 加表或加列意味着迁移，
   * 而这次要的只是"把已有的东西读出来"。
   *
   * ⚠️ 代价是**解析文本**，所以下面两个正则都写成了**锚定形状**而不是"包含子串"：
   * 团队行的 `role` 段只允许 `[a-z_]+`（角色 id 的既有形状），
   * 这样 `[调研] 新闻未产出：…`（同样以 `[` 开头的另一种行）不会被误认成角色。
   *
   * ## 负向校准（这条判据本身也要可证伪）
   *
   * 只有"能解析出角色"才算数：解析不出就**返回空**，让界面退回它原来的判断，
   * 而不是拿一个猜出来的角色名去点亮编制表 —— 那会造出新的假出勤。
   */

  /*
   * 解析与合并逻辑都在**模块级**（`parseTeamStepLine` / `parseCotTraceRoles` /
   * `mergeRoleLastSeen`）—— 那里是纯函数、可被单元测试直接调用。
   * 这里不再重复定义（重复就会有两份判据，迟早漂移）。
   */

  /** 一个岗位最近一次被观察到干活的时刻（含来源，便于核对）。 */
  type RoleLastSeenLocal = RoleLastSeen;

  /**
   * 汇总"每个岗位最后一次露面"。
   *
   * 合并规则见模块级 `mergeRoleLastSeen()`（那里是纯函数、有单元测试）。
   * 这里只负责**取数**：把 `runtime_logs` 与 `decision_records` 里
   * 与本机器人相关的部分挑出来。
   */
  const collectLastSeen = (traderId: number, logLimit: number): RoleLastSeenLocal[] => {
    /*
     * ① `runtime_logs`：团队步骤 + 自检。
     *
     * ⚠️ `runtimeLogs.list()` 是**全局**的（全表最近 N 条），所以必须按
     * `traderId` 过滤 —— 多机器人共用一个进程时不过滤会把别人的出勤算到这个头上。
     * 同时接受 `traderId === null` 的行（进程级日志），与 `selfcheckRunner` 的口径一致。
     */
    const logs: Array<{ message: string; createdAt: string }> = [];
    let systemEngineerAt: string | null = null;
    for (const line of runtimeLogs.list(logLimit)) {
      if (line.traderId !== traderId && line.traderId !== null) continue;
      if (line.scope !== 'team' && line.scope !== 'selfcheck') continue;
      if (line.scope === 'selfcheck') {
        /*
         * 自检行没有角色名，但**它确实是 `system_engineer` 在干活**
         * （`manager.buildSelfCheckAsk()` 用 `tierForRole('system_engineer')`）。
         * 单独取最大时刻 —— 不能把整行文本塞给 `parseTeamStepLine`，
         * 那会命中 `[自检/ai] …` → 解析成 null，白跑一遍。
         */
        if (systemEngineerAt === null || line.createdAt > systemEngineerAt) {
          systemEngineerAt = line.createdAt;
        }
        continue;
      }
      logs.push({ message: line.message, createdAt: line.createdAt });
    }

    /* ② `decision_records.cot_trace`：进了 `<team>` 块的那些角色。 */
    const cots: Array<{ trace: string; timestamp: string }> = [];
    for (const record of decisionStore.list(traderId, DECISION_PAGE_DEFAULT)) {
      if (typeof record.cotTrace !== 'string' || record.cotTrace.length === 0) continue;
      cots.push({ trace: record.cotTrace, timestamp: record.timestamp });
    }

    return mergeRoleLastSeen(logs, cots, systemEngineerAt);
  };

  /**
   * 一个岗位的历史工作详情（**只读**）。
   *
   * 用户原话：「每个角色**增加一个可点击按钮，点击去以后能看他历史工作详情**」。
   *
   * 数据源与 `collectLastSeen` 同两个，但这里**保留全部条目**（不只是最后一次），
   * 且标明来源：`log` = 服务端直写的步骤日志；`cot` = 那一轮审计块里的产出摘要。
   */
  app.get('/api/traders/:id/agent/last-seen', authed, (request) => {
    const traderId = idOf(request);
    const parsed = Number((request.query as { limit?: string }).limit ?? RUNTIME_LOG_PAGE_DEFAULT);
    /* 钳制而不报错 —— 与其它端点同一原则（界面传错不该 500）。 */
    const logLimit = Number.isFinite(parsed)
      ? Math.min(Math.max(1, Math.trunc(parsed)), RUNTIME_LOG_CAP)
      : RUNTIME_LOG_PAGE_DEFAULT;

    return { roles: collectLastSeen(traderId, logLimit) };
  });

  app.get('/api/traders/:id/agent/:role/steps', authed, (request) => {
    const traderId = idOf(request);
    const role = String((request.params as { role: string }).role);
    /*
     * 角色 id 只允许 `[a-z_]+`：这条**不是安全边界**（参数是走 SQL 参数化的），
     * 而是**判据的诚实性** —— 一个含中文/空格的 role 必然匹配不到任何真实行，
     * 提前返回空比让它去扫一遍表更清楚。
     */
    if (!/^[a-z][a-z_]*$/.test(role)) {
      return { role, steps: [], lastSeenAt: null };
    }

    const parsed = Number((request.query as { limit?: string }).limit ?? 50);
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(1, Math.trunc(parsed)), 200) : 50;

    type Step = { at: string; phase: string | null; message: string; source: 'log' | 'cot' };
    const steps: Step[] = [];

    /* ① 服务端步骤日志（团队 + 自检）。 */
    for (const line of runtimeLogs.list(RUNTIME_LOG_CAP)) {
      if (line.traderId !== traderId && line.traderId !== null) continue;
      if (line.scope !== 'team' && line.scope !== 'selfcheck') continue;
      const step = parseTeamStepLine(line.message);
      if (step !== null) {
        if (step.role === role) {
          steps.push({ at: line.createdAt, phase: step.phase, message: step.note, source: 'log' });
        }
        continue;
      }
      /* 自检行归到 `system_engineer`（理由见 `collectLastSeen`）。 */
      if (line.scope === 'selfcheck' && role === 'system_engineer') {
        steps.push({ at: line.createdAt, phase: 'selfcheck', message: line.message, source: 'log' });
      }
    }

    /*
     * ══════════════════════════════════════════════════════════════════════
     *  ②-b **`dispatch` scope 的按币并行产出**（2026-10-18 · 用户实测）
     * ══════════════════════════════════════════════════════════════════════
     *
     * ## 用户看到的现象
     *
     * > 「标的侦查员」在岗，历史工作详情显示「共 0 条」「它在岗，但确实一次都没被叫到过」
     *
     * ## 真相
     *
     * 它**每一轮都在跑**，`runtime_logs` 里明确写着：
     * ```
     *   [dispatch] supervisor：按币并行：18 个标的，并发 4
     *   [dispatch] supervisor：按币并行完成：成功 16 · 失败 2 · 并发峰值 4
     * ```
     * 但这个端点只扫 `scope IN ('team','selfcheck')` ⇒ 把 `dispatch` 全漏了。
     *
     * ⇒ **"0 条"是查询漏了一张表，不是它没工作。** 这类假警报比没有面板更糟：
     *   它让人去查一个不存在的问题。
     */
    if (role === 'symbol_scout' || role === 'per_symbol') {
      for (const line of runtimeLogs.list(RUNTIME_LOG_CAP)) {
        if (line.traderId !== traderId && line.traderId !== null) continue;
        /*
         * ⚠️ **它的 scope 是 `team`，`[dispatch]` 只是消息前缀**（2026-10-18 实测纠正）。
         *
         * 我第一版写成 `line.scope !== 'dispatch'`，于是永远匹配不到 —— 实测
         * `SELECT scope FROM runtime_logs WHERE message LIKE '%按币并行%'` 得到的
         * 20 条全部是 `team`。判据要按**消息前缀**，不是 scope。
         */
        if (!line.message.startsWith('[dispatch]')) continue;
        steps.push({ at: line.createdAt, phase: 'dispatch', message: line.message, source: 'log' });
      }
    }

    /*
     * ②-c 复盘员的产出在 `agent_memory`（每笔平仓后的教训），不在 `agent_runs`。
     *      实测 #11 有 52 条，而面板显示 0 —— 同一个"查错表"问题。
     */
    if (role === 'reviewer' || role === 'memory_curator') {
      for (const m of agentStoreMemory.recent(traderId, 50)) {
        steps.push({
          at: m.createdAt,
          phase: 'lesson',
          message:
            `${m.symbol} · ${m.closeReason} · 净 ${m.netPnl >= 0 ? '+' : ''}${m.netPnl.toFixed(4)} USDT\n` +
            m.lesson,
          source: 'log',
        });
      }
    }

    /*
     * ②-d 策略师的产出在 `agent_experiments`（每次调参与者与结果），不在 `agent_runs`。
     *      实测 #11 有 29 条实验。
     */
    if (role === 'strategist') {
      for (const e of agentStoreExperiments.recent(traderId, 50)) {
        const outcome =
          e.outcomeNetPnl === null
            ? ''
            : `（${e.outcomeTrades ?? 0} 笔后结果 ${e.outcomeNetPnl >= 0 ? '+' : ''}${e.outcomeNetPnl.toFixed(4)} USDT）`;
        steps.push({
          at: e.createdAt,
          phase: 'experiment',
          message: `${e.reason || e.trigger || '参数实验'}${outcome}`,
          source: 'log',
        });
      }
    }

    /* ③ 审计块里的角色产出（那一轮它交出的原文摘要）。 */
    for (const record of decisionStore.list(traderId, DECISION_PAGE_DEFAULT)) {
      if (typeof record.cotTrace !== 'string' || record.cotTrace.length === 0) continue;
      for (const line of record.cotTrace.split('\n')) {
        const m = /^- ([a-z_]+)（[^）]*）：([\s\S]*)$/.exec(line);
        if (m === null || m[1] !== role) continue;
        steps.push({ at: record.timestamp, phase: null, message: m[2]!, source: 'cot' });
      }
    }

    /*
     * ══════════════════════════════════════════════════════════════════════
     *  ⚠️ **丢掉正文为空的条目**（2026-10-18 · 用户：「大片空白的，是给人看的吗？」）
     * ══════════════════════════════════════════════════════════════════════
     *
     * `cotTrace` 里有一批行是 `- judge（模型）：` 后面**什么都没有**（模型这一轮
     * 只调了工具、没产出文字）。端点把它们当正常条目推出去，界面上就只剩一个时间戳 ——
     * 实测 12 条里有 9 条是空的，整页几乎全是空白。
     *
     * ⇒ 在这里过滤，**不要靠前端隐藏**：空条目会占掉 `limit` 的名额，
     *   把真正有内容的记录挤出去（用户看到的是"最近 12 条"，
     *   而其中 9 条是空的、更早的有内容的反而看不到）。
     *
     * 判据是"去掉空白后长度为 0" —— 只含换行/空格的也算空。
     */
    const nonEmpty = steps.filter((s) => s.message.trim().length > 0);

    /* 新的在前 —— 界面点开先看"最近发生了什么"。 */
    nonEmpty.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const trimmed = nonEmpty.slice(0, limit);

    return {
      role,
      /*
       * `total` 让界面能如实说"还有 N 条更早的"（而不是假装这就是全部）。
       * **它数的是过滤后的**：空条目不是"看不到的内容"，它本来就没内容。
       */
      total: nonEmpty.length,
      steps: trimmed,
      lastSeenAt: trimmed.length > 0 ? trimmed[0]!.at : null,
    };
  });

  /**
   * **跑一次自检**（用户需求 #6）。
   *
   * ## 用户的原话（这是本端点存在的理由）
   *
   * > 「你迭代更新系统得搞智能体团队**持续观察、测试**，然后反馈给你做相应得处理，
   * >  **不要有任何 BUG，也不要老让我来测试和发现问题，你要自己发现问题自己解决**」
   *
   * > 「本地开发 + 服务器运行都要有 **AI 自检、问题留痕**」
   *
   * ## 为什么是 POST 而不是 GET
   *
   * 它会**写库**（发现落进 `runtime_logs` 的 `selfcheck` scope）——
   * GET 不该有副作用。而且它是一次真实的检查动作，不是读既有结果。
   *
   * ## 为什么既返回结果又写日志
   *
   * 两处都要：
   *   · **返回结果** → 调用方（界面按钮、我的脚本）能立刻看到；
   *   · **写日志** → 留痕。用户要"下次唤醒时能快速定位"，
   *     而日志是唯一**跨会话持久**的地方（进程重启也在）。
   *
   * ## 目前只跑确定性层
   *
   * 不依赖模型 —— 因为**模型挂掉的时候恰恰最需要自检**。
   * AI 层建在这一层之上，见 `selfcheckRunner.runSelfCheck` 的 `ask` 参数。
   */
  app.post('/api/traders/:id/selfcheck', authed, async (request) => {
    const traderId = idOf(request);
    const query = request.query as { windowHours?: string };
    const parsed = Number(query.windowHours ?? 6);
    /* 钳制而不报错 —— 与其它端点同一原则。 */
    const windowHours = Number.isFinite(parsed) ? Math.min(Math.max(1, Math.trunc(parsed)), 168) : 6;

    const result = await runSelfCheck(traderId, { windowHours });
    return {
      windowHours: result.evidence.windowHours,
      deterministic: result.deterministic,
      ai: result.ai,
      evidence: result.evidence,
    };
  });

  app.get('/api/traders/:id/trades', authed, async (request) => {
    const query = request.query as { limit?: string; before?: string; beforeClosedAt?: string };
    const limit = Number(query.limit ?? TRADE_PAGE_DEFAULT);
    const before = Number(query.before);
    return tradeStore.list(
      idOf(request),
      limit,
      Number.isFinite(before) ? before : null,
      typeof query.beforeClosedAt === 'string' && query.beforeClosedAt.length > 0
        ? query.beforeClosedAt
        : null,
    );
  });

  /**
   * 决策记录，**分页**返回；响应体是 `DecisionRecord[]`，**形状没有变**
   * （老客户端、`docs/API.md` 与"全部记录"页都照旧）。
   *
   * | 参数 | 说明 |
   * |---|---|
   * | `limit` | 一页多少条。默认 50，上限 `DECISION_PAGE_MAX`（200）——**钳制不报错** |
   * | `before` | 游标：只返回 `id` 比它更小的记录。第一页不传 |
   *
   * 上限的钳制在仓储层（`clampDecisionLimit`），所以这里不做验证：
   * 一个手写的 `?limit=999999` 最坏也只是拿到 200 条，
   * 而不是把整个决策史（含完整提示词）一次性拼成响应。
   */
  app.get('/api/traders/:id/decisions', authed, async (request) => {
    const query = request.query as { limit?: string; before?: string };
    const limit = Number(query.limit ?? DECISION_PAGE_DEFAULT);
    // `before` 是新参数，非数字/缺失一律按"第一页"处理：发不出正确游标的调用方
    // 应该拿到最新的一页，而不是一个 400。
    const before = Number(query.before);
    const records = decisionStore.list(idOf(request), limit, Number.isFinite(before) ? before : null);
    /*
     * ⚠️ **列表绝不返回提示词全文。**
     *
     * 用户 2026-10-07 报"页面加载几十秒"。实测：`decision_records` 只有 910 行，
     * 但 `user_prompt` 一个字段就 **81.6 MB**（单条最大 283 KB）。而这一页返回
     * 30 条，每条约 90 KB → **一次列表 ≈ 2.7 MB JSON**，浏览器下载 + 解析几十秒。
     *
     * 数据库本身不慢（元数据 30 条 4ms、含全文 62ms，索引齐全）——
     * 慢的是**把不该传的东西传到了浏览器**。
     *
     * 提示词只在用户点开「提示词」标签时才需要，那时由
     * `GET /traders/:id/decisions/:recordId` 单条取（详情接口本来就有）。
     */
    return records.map((record) => {
      const hydratedLog = hydrateAdjustmentContextFromPrompt(record.userPrompt, record.executionLog);
      return { ...record, executionLog: hydratedLog, systemPrompt: '', userPrompt: '' };
    });
  });

  app.get('/api/traders/:id/decisions/:recordId', authed, async (request, reply) => {
    const recordId = Number((request.params as { recordId: string }).recordId);
    const record = decisionStore.get(recordId);
    if (!record || record.traderId !== idOf(request)) {
      return reply.code(404).send({ error: '找不到该决策记录' });
    }
    return record;
  });

  app.get('/api/traders/:id/token-billing', authed, async (request, reply) => {
    const traderId = idOf(request);
    const trader = traders.get(traderId);
    if (!trader) {
      return reply.code(404).send({ error: '找不到该机器人' });
    }
    const modelRow = trader.aiModelId !== null ? aiModels.get(trader.aiModelId) : undefined;
    const modelName = modelRow?.model ?? '';
    const pricing = resolveModelTokenPricing(modelName);
    const all = decisionStore.tokenUsageStats(traderId);
    const today = decisionStore.tokenUsageStats(traderId, beijingDayStartIso());
    const allCost = pricing ? calculateTokenCost(all, pricing) : null;
    const todayCost = pricing ? calculateTokenCost(today, pricing) : null;
    const summary: TraderTokenBillingSummary = {
      traderId,
      model: modelName,
      pricing,
      totalCycles: all.totalCycles,
      meteredCycles: all.meteredCycles,
      promptTokens: all.promptTokens,
      cachedTokens: all.cachedTokens,
      completionTokens: all.completionTokens,
      reasoningTokens: all.reasoningTokens,
      totalCostUsd: allCost ? allCost.totalCostUsd : null,
      savedByCacheUsd: allCost ? allCost.savedByCacheUsd : null,
      todayCycles: today.totalCycles,
      todayPromptTokens: today.promptTokens,
      todayCachedTokens: today.cachedTokens,
      todayCompletionTokens: today.completionTokens,
      todayCostUsd: todayCost ? todayCost.totalCostUsd : null,
    };
    return summary;
  });

  app.get('/api/traders/:id/equity', authed, async (request) => {
    /*
     * ⚠️ **`limit` 必须钳成正数。**
     *
     * 原来只做了 `Number.isFinite` 兜底，于是 `?limit=-1` 会原样透传到 SQL ——
     * 而在 SQLite 里 **`LIMIT -1` 的意思是"不限行"**。`equity_snapshots`
     * 又没有保留策略（3 分钟一个周期，半年约 8.6 万行），一次请求就能把
     * 全部历史快照拉回来，压在**驱动交易循环的同一个事件循环**上。
     *
     * 上限与仓储层的窗口（`EQUITY_CURVE_WINDOW`）对齐：再多也没有消费者。
     */
    const raw = Number((request.query as { limit?: string }).limit ?? 500);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 5000) : 500;
    return equityStore.list(idOf(request), limit);
  });

}

/**
 * 读最近一次对账检测到的外部交易活动**与账本差额**。
 *
 * 返回 `rounds: 0` 而不是 `null`：**「检测过，没有外部活动」和
 * 「从来没检测过」对操作员的含义不同** —— 前者是"账户干净"，
 * 后者是"我们还不知道"。用 `detectedAt` 区分。
 *
 * ## ⚠️ 2026-10-14：补上 `ledgerGap`（用户报"列表页和详情页数据对不上"）
 *
 * ### 现象
 *
 * 列表页「盈亏」显示 **+4.84**（本地记账），详情页「账户余额」显示 **92.34**
 * （交易所真实值），两者差 **12.55** —— 而界面上**没有任何地方解释这个差**。
 *
 * ### 根因：两个数字口径不同，而界面没说
 *
 * ```
 *   本地记账（trades 净额合计）   = 起始 + 已实现净额 = 104.89  ← 列表页
 *   交易所真实权益               = 92.34                        ← 详情页
 *   差额（ledger_check.gap）     = 12.55                        ← 只在后端台账里
 * ```
 *
 * 差额的来源是**对账重建的已知缺陷**（窗口起点落在持仓中间 → 开/平判反，
 * 见 `reconstructRoundTrips()` 的说明）—— 系统**每轮都在检测它**，
 * 但那个数字**只进了 `ledger_check:` 台账与给模型看的提示词**，
 * 没有进任何界面。于是操作员看到两个数字对不上，而**无处可知为什么**。
 *
 * ### 为什么在这里补，而不是新开端点
 *
 * 这个端点本来就是为"账户余额不对"建的（见上面那段注释），
 * 而 `gap` 正是那个问题的**量化答案**。分成两个端点会让
 * 「外部活动」与「账本差额」这两件相关的事在界面上被拆到两处。
 *
 * ⚠️ 读不到时**不带这个字段**（不是 `0`）—— 「我们不知道」和「账没问题」
 * 对操作员的含义完全不同（同 `readForeignActivity` 的说明）。
 */
function readForeignActivityFor(traderId: number): {
  rounds: number;
  net: number;
  symbols: string[];
  firstAt: string | null;
  lastAt: string | null;
  detectedAt: string | null;
  /** 平台账本与交易所流水的差额（`undefined` = 没读到，不代表 0）。 */
  ledgerGap?: number;
  /** 对账检查的时刻（`undefined` = 从没跑过对账）。 */
  ledgerCheckedAt?: string;
} {
  const empty = {
    rounds: 0,
    net: 0,
    symbols: [] as string[],
    firstAt: null,
    lastAt: null,
    detectedAt: null,
  };
  /*
   * ⚠️ 账本差额**独立读**（同 `readForeignActivity` 的做法）：
   * 两个台账是分别写的，任一个缺失不该让另一个也丢。
   */
  const gap = (() => {
    try {
      const raw = settings.get(`ledger_check:${traderId}`);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as { gap?: number; incomeReadFailed?: boolean; checkedAt?: string };
      /*
       * ⚠️ 读流水失败那一轮的 `gap` 是**假差额**（等于整个 platformNet）——
       * 与 `readForeignActivity` 里同一条判据，不能只修一处。
       */
      if (parsed.incomeReadFailed) return {};
      return {
        ...(typeof parsed.gap === 'number' ? { ledgerGap: parsed.gap } : {}),
        ...(typeof parsed.checkedAt === 'string' ? { ledgerCheckedAt: parsed.checkedAt } : {}),
      };
    } catch {
      return {};
    }
  })();
  try {
    const raw = settings.get(`foreign_activity:${traderId}`);
    if (!raw) return { ...empty, ...gap };
    const parsed = JSON.parse(raw) as Partial<ReturnType<typeof readForeignActivityFor>>;
    return {
      rounds: typeof parsed.rounds === "number" ? parsed.rounds : 0,
      net: typeof parsed.net === "number" ? parsed.net : 0,
      symbols: Array.isArray(parsed.symbols) ? parsed.symbols : [],
      firstAt: typeof parsed.firstAt === "string" ? parsed.firstAt : null,
      lastAt: typeof parsed.lastAt === "string" ? parsed.lastAt : null,
      detectedAt: typeof parsed.detectedAt === "string" ? parsed.detectedAt : null,
      ...gap,
    };
  } catch {
    return { ...empty, ...gap };
  }
}

/**
 * `/api/traders/:id/decisions` 列表接口为节省带宽会裁掉 `userPrompt` 全文。
 * 对升级前的历史 `adjust_protection` / `add_to_position` / `reduce_position` 记录，
 * 裁剪前先从 `userPrompt` 的「当前持仓」行提取调整前 `previousStopLoss`/`previousTakeProfit`/`entryPrice`
 * 回填到对应执行日志项，使决策流与单轮审计详情页展现完全一致且不增加响应体积。
 */
const HYDRATE_ACTIONS = new Set(['adjust_protection', 'add_to_position', 'reduce_position']);

function hydrateAdjustmentContextFromPrompt(
  userPrompt: string | null | undefined,
  log: ExecutionLogEntry[],
): ExecutionLogEntry[] {
  if (!userPrompt || log.length === 0) return log;
  let needsHydrate = false;
  for (const entry of log) {
    if (
      entry.status !== 'data' &&
      HYDRATE_ACTIONS.has(entry.action) &&
      entry.previousStopLoss === undefined &&
      entry.previousTakeProfit === undefined &&
      entry.entryPrice === undefined
    ) {
      needsHydrate = true;
      break;
    }
  }
  if (!needsHydrate) return log;

  return log.map((entry) => {
    if (
      entry.status === 'data' ||
      !HYDRATE_ACTIONS.has(entry.action) ||
      entry.previousStopLoss !== undefined ||
      entry.previousTakeProfit !== undefined ||
      entry.entryPrice !== undefined
    ) {
      return entry;
    }
    const ctx = extractPromptPositionContext(userPrompt, entry.symbol);
    return ctx ? { ...entry, ...ctx } : entry;
  });
}

