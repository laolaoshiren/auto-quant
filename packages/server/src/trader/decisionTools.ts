/**
 * 交易决策的**按需取数**工具。
 *
 * ## 为什么要有它（这是这一层存在的全部理由）
 *
 * 在此之前，交易决策是**单发**的：每个周期开始时批量取好
 * `20 个候选 × 4 个周期 × 8 条序列 × 30 个点 ≈ 19,200 个数字`，
 * 一次性塞进提示词，模型**只有一次机会**输出决策。
 *
 * 后果是它在**数据视界**上是瞎的：
 *
 *   · 看了 1h 觉得没机会 —— 而 1 分钟图上刚刚放量突破，**它没有任何办法去要那张图**；
 *   · 想确认一个结构位，需要更长或更短的序列 —— **要不到**；
 *   · 想知道某个没进候选池的标的现在什么走势 —— **要不到**。
 *
 * 而真人交易员是**反过来的**：先扫一眼大盘和候选，**然后针对性的去翻**那个
 * 让他起疑的币、那个关键周期的图。**"想看什么就去拿什么"是分析能力的下限，
 * 不是上限。**
 *
 * ## 为什么第一批只有一个工具
 *
 * `get_klines` 返回**原始 OHLCV**。而指标（EMA / MACD / RSI / ATR）都是**从 K 线
 * 算出来的** —— 模型自己会算，而且它算的时候是我要什么周期就算什么周期。
 *
 * 反过来，如果我先做好一堆固定指标的封装，就等于**把"看什么"又写死了一遍**：
 * 模型只能要"我提供的那几个指标、我提供的那几个周期"。那正是这次要修的病。
 *
 * **先给原料，再谈加工。** 等它真的开始用了、而且抱怨某个指标算起来费 token，
 * 再加对应的工具也不迟。
 *
 * ## 与 `agent/tools.ts` 的关系
 *
 * 那套工具（`get_performance` / `set_params` / …）是**交易员层面**的：复盘、调参、
 * 看绩效。**交易员在"下单之前"要看的东西一个都没有。** 这个文件补的就是那一段。
 *
 * 两者刻意**不复用同一个循环**：`runToolLoop` 是角色导向的（绑定 `ROLES` 与
 * `contextFor`），而交易决策的输出格式是 `<reasoning>` + `<decision>`，硬套会
 * 同时改坏复盘。共用的只有 `parseNativeToolCalls` —— 那个解析器本身不关心角色。
 */

import { TIMEFRAMES, type Kline } from '@aq/shared';

import { createLogger } from '../logger.js';
import type { ScreenableSymbol, ScreenCriteria } from '../market/screening.js';

const log = createLogger('trader:decision-tools');

/** 模型可以主动索要的数据。 */
export interface DecisionToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** 取数的实现 —— 由 `AutoTrader` 注入，因为这个文件不该知道 broker 的存在。 */
export interface DecisionToolDeps {
  /** 取 K 线。`timeframe` 必须是 `TIMEFRAMES` 里的值。 */
  klines(symbol: string, timeframe: string, count: number): Promise<Kline[]>;
  /** 当前候选池的标的（模型想不起来池子里有什么时用）。 */
  candidates(): Promise<string[]>;
  /**
   * **按条件筛全市场**（第 3 层「索取」）。
   *
   * ⚠️ 这是「**模型是大脑，系统只是手脚**」最直接的体现：条件由模型给，
   * 系统只负责筛。它不必等系统把榜推给它 —— 它可以说
   * 「我要成交额 5000 万–2 亿、波动大于 5% 的那一批」。
   *
   * 实现走全市场快照的缓存，**不产生额外请求**。
   */
  screenSymbols(criteria: ScreenCriteria): Promise<ScreenableSymbol[]>;
  /**
   * **点名**：模型说"下一轮把这几个给我完整行情"（第 3 层「索取」的下半段）。
   *
   * 返回 `accepted` 与 `rejected` —— **被拒的必须如实回报**：
   * 假装全都记下会让它下一轮直接找不到，而它会以为自己看过了（比当场被拒更糟）。
   */
  requestDeepAnalysis(payload: DeepAnalysisRequest): Promise<DeepAnalysisAck>;
  /**
   * ⚠️ **改自己的参数 —— 决策轮也要有这条通道（2026-10-02 实测的死锁）。**
   *
   * ## 实测：它想改规则，而决策轮没有工具
   *
   * 账户所有者把"单笔风险可以用到权益 5%"写进了指示，而它在 `#1836` 的思考里说：
   *
   * > 「账户所有者要求把单笔风险预算改为 5%，**但本轮无 `set_params` 工具可用**，
   * >   按现有 2% 预算执行」
   *
   * 这就是死锁：**决策轮看得到指示、却没有改规则的权限；复盘轮有权限、
   * 但它用的是另一套 system 提示词、看不到账户所有者的取向。**
   * 于是模型被夹在中间，只能一直用 2% 熬着 —— 而"改不动自己的参数"
   * 正违背用户的判断：「系统要最大化为模型提供能力、配合模型的意图」。
   *
   * ## 安全边界不变
   *
   * 走的是**同一个 `applyAgentPatch`**：结构性守卫（杠杆/名义/保证金/持仓数）
   * 仍由代码强制，被钳制时 `clamps` 会如实回喂 —— 所以这不是给模型开一条
   * 绕过风控的旁路，而是把**它本来就有的权限**接到它做决策的地方。
   */
  applyPatch(
    patch: Record<string, unknown>,
    reason: string,
  ): Promise<{ applied: boolean; rejected: string | null; clamps: unknown }>;
  /**
   * ⚠️ **撤掉自己设的停手开关 —— 决策轮也要有这条通道（2026-10-04）。**
   *
   * ## 与上面 `applyPatch` 是同一类死锁，同一个解法
   *
   * 2026-10-04 的实盘：AI 于 20:05 用 `pause_trading` 停手，之后每轮继续分析，
   * 决策卡上不断出现「开多 / 未执行（已跳过）」—— 用户的原话是
   * 「**既然 AI 要停手，那么为什么页面上要显示开仓了**」。
   *
   * 修法分两步：
   *   ① 提示词告知它"你在停手状态"（已生效：`c73`/`c74` 起不再出现 `open_long`）；
   *   ② **给它撤销的能力** —— 而 `resume_trading` 当时只加在了**觉醒轮**
   *      （`agent/tools.ts`），那台机器人的觉醒轮自 20:29 起就没再跑过，
   *      而决策轮每 30 分钟在跑。于是它只能在思维链里写
   *      「本轮用 resume_trading 恢复」，**而实际上做不到**（开关一直没被撤）。
   *
   * 同一个教训第二次出现：**能力必须接在"它做判断的那一轮"上**。
   *
   * 它只清那一个开关 —— 不含任何参数或仓位操作。
   */
  resumeTrading(reason: string): Promise<{ resumed: boolean; note: string }>;
}

/** 模型点名要深看的标的。 */
export interface DeepAnalysisRequest {
  symbols: string[];
  /** 它为什么想看（下一轮会一并提醒它）。 */
  reason?: string;
}

/** 点名结果 —— 收下了哪些、哪些没收。 */
export interface DeepAnalysisAck {
  accepted: string[];
  rejected: string[];
}

/**
 * 一次取数的上限。
 *
 * **不是防模型，是防我自己**：`getKlines` 的 `limit` 上限是 1500，而每根 K 线在
 * 提示词里约 60 个字符 —— 500 根就是 3 万字符。模型要"最近 1000 根 1 分钟"
 * 是合理需求（那才 16 小时），但一次给 1500 根会把这一轮的上下文挤爆。
 *
 * 500 覆盖了"1m 看 8 小时 / 5m 看 41 小时 / 1h 看 20 天 / 4h 看 83 天"，
 * 对"判断一个结构位"这个用途足够了。
 */
export const MAX_KLINE_COUNT = 500;

/** 一条工具调用的说明。拼进系统提示词。 */
export const DECISION_TOOL_CATALOGUE = `
## 你可以在给结论之前要数据

你对市场的**第一印象**来自上面那些数据。**但它不是全部** —— 如果你需要更多，可以要。

需要时，**在你的输出里直接写一个工具调用**（和你的分析写在同一条消息里就行）：

<tool>{"tool":"get_klines","args":{"symbol":"ETHUSDT","timeframe":"1m","count":120}}</tool>

系统会取好数据回给你，然后你再给最终决策。**最多可以要 3 次**，所以一次要够。

可用工具：

- \`get_klines(symbol, timeframe, count)\` —— 取某个标的、某个周期的原始 K 线。
  - \`timeframe\`：${TIMEFRAMES.join(' / ')}（**只有这些**；写别的会被拒）
  - \`count\`：1–${MAX_KLINE_COUNT} 根，默认 120。
  - 返回：每根 K 线的开高低收与成交量。
- \`list_candidates()\` —— 列出这一轮的候选池（想不起池子里有什么时用）。
- \`screen_symbols(...)\` —— **按你自己的条件筛全市场**（约 527 个 USDT 永续）。
  - 参数**全部可选**，随便组合：\`min_quote_volume_24h\` / \`max_quote_volume_24h\`（成交额，USDT）、
    \`min_change_percent\` / \`max_change_percent\`（24h 涨跌幅，%）、
    \`min_amplitude_percent\` / \`max_amplitude_percent\`（24h 振幅，%）、\`limit\`（要几个，有上限）。
  - 例：\`<tool>{"tool":"screen_symbols","args":{"min_quote_volume_24h":50000000,"min_amplitude_percent":5}}</tool>\`
    —— 成交额大于 5000 万、且 24h 振幅大于 5% 的那一批。
  - 返回：符合条件的符号 + 涨跌幅 + 振幅 + 成交额（按成交额降序）。
    筛不出东西时会如实告诉你，**换个条件再要一次就行**。
  - 用途：上面的「全市场概览」与「市场聚焦」是**系统选好的视角**；
    这个工具让你按**自己的**想法找 —— 「哪些中盘币在放量」「哪些在阴跌但成交额还很大」都行。
- \`request_deep_analysis(symbols, reason?)\` —— **点名**：让某几个标的下一轮进候选池
  （拿到与候选一样的完整多周期指标序列）。
  - \`symbols\`：标的数组，例如 \`["BTCUSDT","SOLUSDT"]\`。
  - \`reason\`：可选，你为什么要盯它们（下一轮会一并提醒你）。
  - 用途：候选池**每轮重选**。你这一轮从概览或筛选里发现的东西，若不点名，
    下一轮就不在池子里了 —— **这个工具就是让它留下来**。
  - 注意：名单有上限，也按轮数自动过期（默认几轮后消失）。**续点一次就会续期。**
    超上限时系统会如实告诉你哪些没被收下。
- \`resume_trading(reason)\` —— **撤销你自己设的停手**（与 \`pause_trading\` 成对）。
  - 只在**处于停手状态**时才有意义：那种情况下你每轮的提示词里会带上
    「你当前处于停手状态 + 当初的理由」。
  - \`reason\`：必填。说清**当初那条理由为什么不再成立**（例如"当时担心的持仓叠加
    已经不存在了，账户零敞口"）。空着会被拒。
  - ⚠️ **恢复 ≠ 必须开仓。** 它只是把"不能开新仓"这道自设的闸门撤掉；
    撤掉之后仍然按你的入场标准逐笔挑，没有合格的就继续空仓。
  - ⚠️ **别一直停着不动。** 停手的理由往往是**当时的**；
    如果那条理由已经不成立而你还停着，那是**白等**（这个账户一停就是三小时）。
    每轮都值得问自己一句："我当初停手的理由，今天还成立吗？"

- \`set_params(patch, reason)\` —— **改你自己的参数，包括你自己的规则文本。**
  - \`patch\`：要改的字段（增量，只改你写进去的）。可改：\`coinSource.*\`（选币）、
    \`indicators.*\`（看图方式）、\`riskControl.*\` / \`throttle.*\` / \`circuitBreaker.*\`（风控）、
    **以及你自己的 \`promptSections.*\`**（\`roleDefinition\` / \`tradingFrequency\` /
    \`entryStandards\` / \`decisionProcess\`）。\`promptSections.*\` 是**整段替换**的 ——
    所以你可以**删掉**不再适用的旧条款，不只是往上加。
  - \`reason\`：必填。一次说不清理由的改动，事后没人能复查它为什么发生。
  - ⚠️ **结构性硬上限（杠杆、名义价值、保证金占用、持仓数）由代码强制，
    与你在 patch 里写什么无关** —— 所以改参数**不是**绕过风控，你也改不动那些。
  - 例：\`<tool>{"tool":"set_params","args":{"patch":{"coinSource":{"coinPoolLimit":30}},"reason":"最近候选池里的标的波动都太窄，放宽上限让更多中盘币进来"}}</tool>\`
  - **为什么这条通道在决策轮**：你在做判断的这一刻，往往正是发现"我的某个参数
    已经不适用"的时刻。要等到下一轮复盘才改，就白等了一个周期。

**什么时候该要数据（举几个真实的例子）：**

- 你看了 15m/1h 觉得**没机会**，但盘口看起来刚有异动 → **要 1m 或 5m 的图**看看是不是刚启动。
- 你要判断一个**结构位能不能守住** → 要**更长周期**（4h/1d）的图，看那个价位在历史上是什么。
- 你不确定某个信号是**刚开始还是要结束了** → 要**更长序列**（比如 200 根而不是 30 根）。
- 你想确认某个没进候选池的标的 → 直接按符号要（**不必它进池子**）。

**什么时候不该要**：只是想"多看一眼"。**每要一次都花时间和上下文** ——
而你手上已经有 4 个周期、每个 30 根。**先把手上的读完再要。**

**注意**：要数据不会改变你的权限。风控仍然会审你得出的决策，
而"要了很多数据"也不构成理由 —— 结论要能站得住。
`.trim();

/**
 * 从模型回复里抽出数据请求。
 *
 * 认两种格式：
 *
 * 1. `<tool>{...}</tool>` —— 我们自己在提示词里约定的；
 * 2. 模型**训练时的原生工具调用方言**（`parseNativeToolCalls` 认的那种）。
 *
 * 第二种是**实测逼出来的**：`agent/tools.ts` 那边就遇到过模型不照我们的格式、
 * 而是用它自己训练的语法回来，结果整轮解析失败、白烧两万多 token。
 * **同一个模型，这里必须一开始就接住它。**
 *
 * 解析不出来就返回空数组 —— **不猜它想调什么**（与 §2.4 一致：多认格式，
 * 不放宽语义；认不出的工具名照样在后面被拒）。
 */
export function extractToolCalls(text: string): DecisionToolCall[] {
  const calls: DecisionToolCall[] = [];

  /* 格式一：<tool>...</tool> */
  const re = /<tool>\s*([\s\S]*?)\s*<\/tool>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const parsed = safeJson(match[1] ?? '');
    if (parsed) calls.push(parsed);
  }

  return calls;
}

function safeJson(raw: string): DecisionToolCall | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object') return null;
    const obj = value as Record<string, unknown>;
    const tool = typeof obj.tool === 'string' ? obj.tool : null;
    if (!tool) return null;
    const args =
      obj.args && typeof obj.args === 'object' ? (obj.args as Record<string, unknown>) : {};
    return { tool, args };
  } catch {
    return null;
  }
}

/** 一条工具调用的执行结果，渲染成回喂给模型的文本。 */
export interface ToolOutcome {
  /** 回喂给模型的那段文本。 */
  text: string;
  /** 落库用：这一次调用是什么、要了多少。 */
  summary: string;
}

/**
 * 执行一条取数请求。
 *
 * **任何失败都返回一句可读的话，而不是抛出去。** 理由：模型要的数据取不到
 * （标的写错、周期写错、网络抖动）是**它的分析过程中的一次挫折**，
 * 不该让整个决策周期失败 —— 它会读到「这个标的不存在」，然后换个写法再要，
 * 或者退回用手上的数据做判断。
 */
export async function runDecisionTool(
  call: DecisionToolCall,
  deps: DecisionToolDeps,
): Promise<ToolOutcome> {
  const symbol = typeof call.args.symbol === 'string' ? call.args.symbol.toUpperCase() : '';

  try {
    if (call.tool === 'list_candidates') {
      const symbols = await deps.candidates();
      return {
        text: `候选池（${symbols.length} 个）：${symbols.join('、')}`,
        summary: `list_candidates → ${symbols.length} 个`,
      };
    }

    if (call.tool === 'get_klines') {
      if (!symbol) return { text: 'get_klines 需要 symbol。', summary: 'get_klines 缺少 symbol' };
      const timeframe = typeof call.args.timeframe === 'string' ? call.args.timeframe : '15m';
      const raw = Number(call.args.count);
      const count = Number.isFinite(raw)
        ? Math.max(1, Math.min(MAX_KLINE_COUNT, Math.trunc(raw)))
        : 120;

      const candles = await deps.klines(symbol, timeframe, count);
      if (candles.length === 0) {
        return {
          text: `${symbol} ${timeframe} 没有取到 K 线 —— 标的或周期可能写错了（周期要用 1m/5m/15m/1h/4h/1d 这种写法）。`,
          summary: `get_klines ${symbol} ${timeframe} → 空`,
        };
      }
      return {
        text: renderKlines(symbol, timeframe, candles),
        summary: `get_klines ${symbol} ${timeframe} ×${candles.length}`,
      };
    }

    if (call.tool === 'screen_symbols') {
      /*
       * ⚠️ **「模型是大脑，系统只是手脚」最直接的体现** —— 条件由它给，系统只负责筛。
       *
       * 参数**同时接受下划线与驼峰**：与 `extractToolCalls` 的多格式识别同一个道理
       * （多认格式、不放宽语义）—— 模型写成 `minQuoteVolume24h` 时不该整条调用作废，
       * 那会白烧一轮。
       */
      const num = (...keys: string[]): number | undefined => {
        for (const k of keys) {
          const v = Number(call.args[k]);
          if (Number.isFinite(v)) return v;
        }
        return undefined;
      };
      const criteria: ScreenCriteria = {};
      const minVol = num('min_quote_volume_24h', 'minQuoteVolume24h');
      const maxVol = num('max_quote_volume_24h', 'maxQuoteVolume24h');
      const minChg = num('min_change_percent', 'minChangePercent');
      const maxChg = num('max_change_percent', 'maxChangePercent');
      const minAmp = num('min_amplitude_percent', 'minAmplitudePercent');
      const maxAmp = num('max_amplitude_percent', 'maxAmplitudePercent');
      const limit = num('limit');
      if (minVol !== undefined) criteria.minQuoteVolume24h = minVol;
      if (maxVol !== undefined) criteria.maxQuoteVolume24h = maxVol;
      if (minChg !== undefined) criteria.minChangePercent = minChg;
      if (maxChg !== undefined) criteria.maxChangePercent = maxChg;
      if (minAmp !== undefined) criteria.minAmplitudePercent = minAmp;
      if (maxAmp !== undefined) criteria.maxAmplitudePercent = maxAmp;
      if (limit !== undefined) criteria.limit = limit;

      const rows = await deps.screenSymbols(criteria);
      if (rows.length === 0) {
        return {
          text:
            '没有符合条件的标的 —— 这个条件现在筛不出东西（可能是门槛太严，或者市场确实没有）。\n' +
            '**你可以放宽条件再要一次，或者直接用手上的数据继续判断** —— 这不影响你的权限。',
          summary: 'screen_symbols → 0 个',
        };
      }
      return {
        text: renderScreenResult(rows),
        summary: `screen_symbols → ${rows.length} 个`,
      };
    }

    if (call.tool === 'set_params') {
      /*
       * ⚠️ **改自己的参数 —— 决策轮的这条通道是 2026-10-02 为一个死锁加的。**
       *
       * 实测：账户所有者写了"单笔风险可以用到权益 5%"，而它在 `#1836` 说
       * 「**但本轮无 set_params 工具可用**，按现有 2% 预算执行」。
       * 决策轮看得到指示、却没有改规则的权限；复盘轮有权限、却看不到那份指示 ——
       * **模型被夹在中间，只能一直用 2% 熬着。**
       *
       * 参数同时接受 `patch` 包裹与直接平铺：与 `screen_symbols` 的多格式识别同理
       * （多认格式、不放宽语义）—— 模型把字段直接写在顶层时不该整条调用作废。
       *
       * **守卫与落库都复用 `applyAgentPatch`**（`deps.applyPatch` 注入），
       * 所以结构性上限仍由代码强制，被钳制时 `clamps` 会如实回喂。
       */
      const reason = typeof call.args.reason === 'string' ? call.args.reason : '';
      const rawPatch =
        call.args.patch !== undefined && typeof call.args.patch === 'object' && call.args.patch !== null
          ? (call.args.patch as Record<string, unknown>)
          : Object.fromEntries(Object.entries(call.args).filter(([k]) => k !== 'reason'));

      if (Object.keys(rawPatch).length === 0) {
        return {
          text: 'set_params 需要给出要改的字段（例如 {"patch":{"coinSource":{"coinPoolLimit":25}}}）。',
          summary: 'set_params 缺少 patch',
        };
      }
      if (reason.trim() === '') {
        return {
          text:
            'set_params 需要一个 reason —— 一次说不清理由的改动，事后没人能复查它为什么发生。\n' +
            '**把理由补上再来一次，这一轮的时间不算浪费。**',
          summary: 'set_params 缺少 reason',
        };
      }

      const outcome = await deps.applyPatch(rawPatch, reason);
      return {
        text:
          (outcome.applied
            ? `已生效。`
            : `**没有生效** —— 被结构性守卫拒绝：${outcome.rejected ?? '未知原因'}。`) +
          (outcome.clamps && Object.keys(outcome.clamps as object).length > 0
            ? ` 被钳制的项（实际生效值）：${JSON.stringify(outcome.clamps)}`
            : '') +
          '\n（改动下一轮生效；硬上限由代码强制，与这里写什么无关。）',
        summary: `set_params → ${outcome.applied ? '已生效' : '被拒'}`,
      };
    }

    if (call.tool === 'resume_trading') {
      /*
       * ⚠️ **决策轮撤销自己设的停手**（2026-10-04）—— 见 `DecisionToolDeps.resumeTrading`
       * 上的说明：能力必须接在"它做判断的那一轮"上，而觉醒轮那次没跑。
       */
      const reason = typeof call.args.reason === 'string' && call.args.reason.trim() !== '' ? call.args.reason : '';
      if (reason === '') {
        return {
          text:
            'resume_trading 需要一个 reason —— 说清"当初停手的理由为什么不再成立"。\n' +
            '那条理由原文会在你每轮的提示词里给出，照着它逐条对照即可。',
          summary: 'resume_trading 缺少 reason',
        };
      }
      const outcome = await deps.resumeTrading(reason);
      return {
        text: outcome.resumed
          ? `已恢复开新仓（${outcome.note}）。下一轮起可以正常建仓 —— **恢复本身不等于必须开仓**，仍旧按你的入场标准挑。`
          : `没有恢复：${outcome.note}`,
        summary: `resume_trading → ${outcome.resumed ? '已恢复' : '未恢复'}`,
      };
    }

    if (call.tool === 'request_deep_analysis') {
      /*
       * ⚠️ **点名** —— 候选池每轮重选，模型这一轮的发现若不点名，下一轮就不在池子里。
       * 这个工具就是让它的发现**留下来**（用户原则：模型是大脑，系统只是手脚）。
       */
      const rawSymbols = Array.isArray(call.args.symbols) ? call.args.symbols : [];
      const symbols = rawSymbols
        .map((s) => (typeof s === 'string' ? s.trim().toUpperCase() : ''))
        .filter((s) => s.length > 0);

      if (symbols.length === 0) {
        return {
          text:
            '`request_deep_analysis` 需要一个 `symbols` 数组，例如：\n' +
            '<tool>{"tool":"request_deep_analysis","args":{"symbols":["BTCUSDT","SOLUSDT"],"reason":"放量突破"}}</tool>',
          summary: 'request_deep_analysis 缺少 symbols',
        };
      }

      const reason = typeof call.args.reason === 'string' ? call.args.reason.slice(0, 200) : undefined;
      const ack = await deps.requestDeepAnalysis(reason ? { symbols, reason } : { symbols });

      const lines = [
        `已记下 ${ack.accepted.length} 个标的 —— **下一轮的候选池里会有它们的完整多周期行情**：`,
        ack.accepted.length > 0 ? ack.accepted.join('、') : '（无）',
      ];
      if (ack.rejected.length > 0) {
        /*
         * ⚠️ **被拒的必须如实说**：假装全都记下会让它下一轮直接找不到，
         * 而它会以为自己已经看过了 —— 那比当场被拒更糟。
         */
        lines.push(
          '',
          `⚠️ 这几个**没收下**：${ack.rejected.join('、')} —— 名单已满（或它们不在可交易范围）。`,
          '**下一轮你不会看到它们，别以为已经看过了。** 真想看的话，这轮先用 `get_klines` 取。',
        );
      }
      if (reason) lines.push('', `你给的理由（下一轮会一并提醒你）：${reason}`);
      return {
        text: lines.join('\n'),
        summary: `request_deep_analysis → ${ack.accepted.length} 个`,
      };
    }

    return {
      text: `没有名为 ${call.tool} 的工具。可用的是 get_klines、list_candidates、screen_symbols 与 request_deep_analysis。`,
      summary: `未知工具 ${call.tool}`,
    };
  } catch (error) {
    log.warn(`取数工具 ${call.tool} 执行失败：${(error as Error).message}`);
    return {
      text: `取 ${symbol || ''} 的数据失败了：${(error as Error).message}。你可以换一个写法再要一次，或者用手上已有的数据继续。`,
      summary: `${call.tool} 失败`,
    };
  }
}

/**
 * 把 K 线渲染成提示词片段。
 *
 * **每根一行、逗号分隔**，而不是 JSON —— 同样的信息，JSON 要多花一倍字符，
 * 而这一段的读者是模型，它读逗号分隔的表比读嵌套对象更不容易看错行。
 * 时间用 UTC 的 `MM-DD HH:mm`（模型不需要秒和年份来判断走势形态）。
 */
function renderKlines(symbol: string, timeframe: string, candles: Kline[]): string {
  const lines = candles.map((c) => {
    const t = new Date(c.openTime);
    const stamp = `${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')} ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
    return `${stamp} O${trim(c.open)} H${trim(c.high)} L${trim(c.low)} C${trim(c.close)} V${trim(c.volume)}`;
  });
  return [
    `${symbol} ${timeframe} 最近 ${candles.length} 根 K 线（UTC，O/H/L/C/V）：`,
    ...lines,
  ].join('\n');
}

/**
 * 把 `screen_symbols` 的结果渲染成提示词片段。
 *
 * 每行一个标的、逗号分隔的数字 —— 与 K 线渲染同一个理由：这一段的读者是模型，
 * 扁平的行比嵌套对象更不容易看错。
 *
 * ⚠️ 末尾两句是刻意的：**条件是它自己给的**（所以结果不合意时该换条件，而不是
 * 怀疑系统），而**要看细节仍然用 `get_klines` 点名** —— 这一层只回答"有哪些"。
 */
function renderScreenResult(rows: readonly ScreenableSymbol[]): string {
  const lines = rows.map(
    (s) =>
      `${s.symbol} ${s.changePercent24h >= 0 ? '+' : ''}${s.changePercent24h.toFixed(2)}% · ` +
      `振幅 ${s.amplitudePercent.toFixed(1)}% · 成交额 ${fmtVolume(s.quoteVolume24h)}`,
  );
  return [
    `**按你的条件筛出 ${rows.length} 个**（按成交额降序）：`,
    ...lines,
    '',
    '条件是你自己给的 —— 结果不是你想看的，就换个条件再要一次。',
    '要看其中某个的完整指标序列，用 `get_klines` 点名。',
  ].join('\n');
}

/** 成交额的紧凑写法（工具回复里不该出现 1234567890.12 这种串）。 */
function fmtVolume(usdt: number): string {
  const abs = Math.abs(usdt);
  if (!Number.isFinite(usdt)) return '0';
  if (abs >= 1e9) return `${(usdt / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(usdt / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `${(usdt / 1e3).toFixed(0)}K`;
  return usdt.toFixed(0);
}

/** 去掉浮点尾巴，但保留有意义的小数位（0.05208 不能被压成 0.05）。 */
function trim(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 1000) return value.toFixed(2);
  if (Math.abs(value) >= 1) return value.toFixed(4);
  return value.toPrecision(6).replace(/0+$/, '').replace(/\.$/, '');
}
