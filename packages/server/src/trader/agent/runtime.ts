/**
 * 智能体运行时：`AutoTrader` 与智能体模块之间的**唯一接缝**。
 *
 * ## 为什么单独一层，而不是直接写进 `autoTrader.ts`
 *
 * `autoTrader.ts` 有 3000+ 行，而且它是这个项目里**最安全攸关**的文件 ——
 * 每一处改动都在动真实资金。把智能体逻辑摊进去有两个代价：
 *
 * 1. **风险**：一个 3000 行的文件里再插一层控制流，出错的概率和排查的难度都上升。
 * 2. **耦合**：智能体成了"交易循环的一部分"，而不是"挂在交易循环上的一个能力"。
 *
 * 所以 `AutoTrader` 只在**两个点**认识它：进周期时问一次"要不要审视"、
 * 平仓之后请它"复盘这笔"。其余全在这一层里。
 *
 * ## 三条它自己必须遵守的纪律
 *
 * 1. **绝不抛穿。** 智能体是**附加**能力。它坏了、模型欠费了、端口读不到数据 ——
 *    都不该让机器人停止交易。所有对外方法都吞掉异常并记一行日志。
 * 2. **绝不阻塞交易循环太久。** 一次审视要跑工具循环（可能十几秒到几十秒）。
 *    调用方用 `void` 触发、不 `await`，避免把 3 分钟的周期撑长。
 * 3. **只在 AI 模式下动作。** `agent_config_json` 为空时它整个是空转的 ——
 *    老机器人不该因为这一层存在而有任何行为变化。
 */

import { closeReasonLabel, marginPercentToPricePercent, type StrategyConfig } from '@aq/shared';

import type { ReviewTradeFacts } from '../autoTrader.js';

import { createLogger } from '../../logger.js';
import { agentMemory } from '../../store/agentStore.js';
import { decisions as decisionStore } from '../../store/repositories.js';
import { traders } from '../../store/repositories.js';
import type { LoopModel } from './loop.js';
import { hasAgentConfig, readAgentConfig } from './config.js';
import { markStrategyReview, markWoken, makeAgentPorts } from './ports.js';
import { reviewClosedTrade, runStrategyReview, settlePending } from './orchestrator.js';
import { DEFAULT_WAKE_POLICY, type WakePolicy } from './wake.js';

const log = createLogger('trader:agent');

export interface AgentRuntimeDeps {
  traderId: number;
  /** 策略里的配置 —— AI 还没写过配置时的基准。 */
  strategyConfig: () => StrategyConfig;
  /**
   * 这个机器人选的策略是不是「全自动智能托管」预设。
   *
   * ⚠️ **这是启动死锁的解药。** 见 `isEnabled()` 的注释。
   */
  isAiStrategy: () => boolean;
  /** 与交易循环同一个模型客户端（`DecisionModel` 的形状正好满足 `LoopModel`）。 */
  model: LoopModel;
  /** 当前权益，用来在唤醒时打基线（判回撤用）。 */
  equityNow: () => number | null;
  /**
   * 某个标的从指定时刻到现在的涨跌幅（百分数）；取不到时 `null`。
   *
   * 由 `TraderManager` 注入（它手上有 `MarketDataService`）—— 这一层不碰网络，
   * 见 `AgentPortDeps.priceChangeSince` 的说明。
   */
  priceChangeSince: (symbol: string, sinceIso: string) => Promise<number | null>;
  policy?: WakePolicy;
}

/**
 * 一次智能体运行时。
 *
 * 生命周期跟随 `AutoTrader` 实例 —— 它自己不持有定时器，
 * 节奏由交易循环决定（这正是"事件驱动"的含义）。
 */
export class AgentRuntime {
  /**
   * 正在进行的那一轮审视。
   *
   * 存在的唯一理由是**防重入**：一次审视要跑几十秒，而周期是 3 分钟 ——
   * 如果它正好跨过两个周期，第二个周期会再触发一次，于是两轮审视
   * **读到同一份数据、各自改一遍参数**，结果取决于谁后写。
   */
  private reviewing: Promise<void> | null = null;

  constructor(private readonly deps: AgentRuntimeDeps) {}

  /**
   * 这个机器人是不是 AI 托管模式。
   *
   * ## 两个条件满足任一即为真，而且**缺一不可**
   *
   * 1. `agent_config_json` 非空 —— AI 已经接手（它自己调过参）
   * 2. **策略是「全自动智能托管」预设** —— 用户要求 AI 托管，AI 还没接手
   *
   * ## 为什么必须有第二条（这是一个启动死锁）
   *
   * 我最初只写了第一条。那样会死锁：
   *
   *     isEnabled()            ← 判据是 agent_config_json 非空
   *     agent_config_json 非空  ← 由 set_params 写入
   *     set_params 被调用       ← 需要 AI 在跑
   *     AI 在跑                ← 需要 isEnabled() 为真
   *
   * **一个刚建的 AI 机器人会安静地什么都不做** —— 它看起来在正常运行、
   * 周期照跑、日志干净，**但智能体一次都不会被调用**。这是最难发现的一类缺陷：
   * 没有任何东西报错。
   *
   * 第二条打破死锁：选了那个预设就等于"要求 AI 托管"，哪怕它还没改过任何参数。
   * 之后 AI 第一次调参写入 `agent_config_json`，第一条也开始为真 —— 两条互为补充。
   */
  isEnabled(): boolean {
    const raw = traders.get(this.deps.traderId)?.agentConfigJson;
    if (typeof raw === 'string' && raw.length > 0) return true;
    return this.deps.isAiStrategy();
  }

  /**
   * AI 模式下应当使用的配置；否则返回 null（调用方继续用策略配置）。
   *
   * **这是"AI 下发的参数真的被用上"的唯一出口** —— 没有它，
   * 前面所有模块都只是写了一堆没人读的记录。
   */
  configOverride(): StrategyConfig | null {
    if (!this.isEnabled()) return null;
    /*
     * ⚠️ **不要在这里 `JSON.parse(raw) as StrategyConfig`。**
     *
     * 断言式读取把 schema 校验留在了"写入那一刻"（`patch.ts`），于是将来给
     * `StrategyConfigSchema` 加一个**带默认值的安全字段**时，老配置读出来是
     * `undefined` —— 代码里 `x > 0` 形式的判据会**静默变成 false**，也就是
     * 把那条风控关掉，而且没有任何报错。
     *
     * 共用的 `readAgentConfig` 过 zod 并回落到策略配置。`hasAgentConfig`
     * 单独判一次是为了保住本函数的 `null` 语义：**"AI 还没写过配置"应当返回
     * null 让调用方走策略配置**，而不是把 fallback 伪装成一份"AI 配置"。
     */
    if (!hasAgentConfig(this.deps.traderId)) return null;
    /*
     * 兜底传 `null` 而不是策略配置：本函数的契约是"没有可用的 AI 配置就返回
     * null"，由调用方那句 `?? strategyConfig` 完成回落。配置坏掉时与"没写过"
     * 走同一条路 —— 行为与改动前一致，只是**多了一道 schema 校验**。
     */
    return readAgentConfig(this.deps.traderId, null);
  }

  /**
   * 进周期时问一次"要不要审视"。
   *
   * **不 await**：调用方触发它就走，避免把交易周期撑长。
   * 重入由 `reviewing` 挡住。
   */
  triggerReview(reason: 'cycle' | 'manual' = 'cycle'): void {
    if (!this.isEnabled()) return;
    if (this.reviewing) return;

    this.reviewing = this.runReview(reason)
      .catch((error) => {
        // 纪律 1：绝不抛穿。智能体坏了不该让机器人停止交易。
        log.warn(`机器人 #${this.deps.traderId} 的策略审视失败（不影响交易）：${(error as Error).message}`);
      })
      .finally(() => {
        this.reviewing = null;
      });
  }

  /**
   * 结算等待中的实验。
   *
   * 与审视分开是因为它有**第二个调用点**：每笔平仓入账后最该结算 ——
   * 那一刻刚产生真实结果。结算晚了会让策略师看到过期的历史。
   */
  settleOnly(): void {
    if (!this.isEnabled()) return;
    try {
      const r = settlePending(makeAgentPorts({
        traderId: this.deps.traderId,
        strategyConfig: this.deps.strategyConfig,
        hourlyBudget: (this.deps.policy ?? DEFAULT_WAKE_POLICY).hourlyBudget,
        priceChangeSince: this.deps.priceChangeSince,
      }));
      if (r.settled > 0) {
        log.info(`机器人 #${this.deps.traderId} 结算了 ${r.settled} 条参数实验。`);
      }
    } catch (error) {
      log.warn(`实验结算失败（不影响交易）：${(error as Error).message}`);
    }
  }

  /**
   * 一笔平仓之后请复盘员写因果结论。
   *
   * **不 await**：复盘是附加动作，不该拖慢平仓路径。
   */
  reviewTrade(input: ReviewTradeFacts): void {
    if (!this.isEnabled()) return;
    void (async () => {
      try {
        const recent = agentMemory.forSymbol(this.deps.traderId, input.symbol, 5);

        /*
         * 组装复盘素材。
         *
         * ⚠️ **这几个数字是实测逼出来的。** 最初这里只有「symbol + 平仓原因 + 净额」，
         * 于是复盘员的结论只能是「**数据不足**，无法判定盈亏归因」——
         * 而它列的缺口（持仓时间、浮盈回撤轨迹、成本占比）**全都在手边**。
         *
         * 尤其 `peakPnlPercent`：它是区分
         * 「正常波动的保护性离场」与「止盈过晚导致利润回吐」的唯一依据，
         * 而这两者的改法完全相反 —— 没有它，复盘员只能含糊其辞。
         *
         * **让 AI 说「数据不足」是这一侧的责任。**
         */
        const feeShare = input.grossPnl !== 0 ? (input.fee / Math.abs(input.grossPnl)) * 100 : null;
        const priceMove = ((input.exitPrice - input.entryPrice) / input.entryPrice) * 100;

        /*
         * 回查**入场那一轮的决策记录**，取出这笔的入场理由。
         *
         * 实测复盘员明确指出「缺少入场逻辑、周期与当时的趋势/关键位背景，
         * 无法判定这次止损是设得过紧被正常波动打掉，还是入场方向本就错误」——
         * **而那个理由就在 `decisions[].reasoning` 里，只是没被传过去。**
         *
         * 做法：在开仓时刻**之前**的决策记录里，找最近一条包含这个标的、
         * 且动作是开仓的那一轮。**找不到就明说找不到，不用别的轮次凑** ——
         * 那会让复盘员基于错误的入场理由下结论，比没有理由更糟。
         */
        const entry = (() => {
          try {
            const openedMs = new Date(input.openedAt).getTime();
            if (!Number.isFinite(openedMs)) return { kind: 'missing' as const };
            const candidates = decisionStore
              .list(this.deps.traderId, 200)
              .filter((d) => {
                const t = new Date(d.timestamp).getTime();
                return Number.isFinite(t) && t <= openedMs + 1000;
              })
              .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

            for (const rec of candidates) {
              const hit = rec.decisions.find(
                (dec) => dec.symbol === input.symbol && /^(open_long|open_short)$/.test(dec.action),
              );
              if (hit) {
                return {
                  kind: 'found' as const,
                  cycle: rec.cycleNumber,
                  action: hit.action,
                  confidence: hit.confidence,
                  reasoning: hit.reasoning,
                  adjustments: hit.adjustments,
                };
              }
            }
            return { kind: 'missing' as const };
          } catch {
            return { kind: 'failed' as const };
          }
        })();

        const lines = [
          `标的：${input.symbol}`,
          `方向与价位：开仓 ${input.entryPrice} → 平仓 ${input.exitPrice}（价格变动 ${priceMove.toFixed(3)}%）`,
          `毛盈亏 ${input.grossPnl.toFixed(4)}　手续费 ${input.fee.toFixed(4)}　净盈亏 ${input.netPnl.toFixed(4)}`,
          feeShare === null
            ? '成本占比：毛盈亏为 0，无法计算占比。'
            : `成本占比：手续费占毛盈亏绝对值的 ${feeShare.toFixed(1)}%` +
              (feeShare >= 50 ? ' —— **成本吃掉了大部分毛收益**，这笔交易在扣费前就已经很薄。' : ''),
          `持仓时长：${input.holdMinutes.toFixed(1)} 分钟（${input.openedAt} 开仓）`,
          /*
           * ⚠️ **必须走 `closeReasonLabel`，不能直接印机器码。**
           *
           * `close_reason: 'stop_loss'` 配上「平仓价高于开仓价」在复盘员眼里
           * 就是**自相矛盾的数据** —— 而它已经这么说过至少三次（都写进了记忆）：
           *
           *     ETHUSDT  「平仓价 2789.5 高于开仓价 2762.21 却标记为 stop_loss…
           *               推测为移动止损上移触发…但数据不足以确认」
           *     BNBUSDT  「平仓价高于开仓价却标记 stop_loss，离场机制数据不足，
           *               无法确认是移动止损保护还是止盈管理失误」
           *
           * **而真相是确定的**：那些止损位被保本守卫/`adjust_protection`
           * 上移到了成本价之上，触发的结果就是保本或小赚离场 ——
           * 这正是提示词要求它做的事。`closeReasonLabel` 就是为这件事写的
           * （它把「止损触发 + 盈利」说成「移动止损（保本离场）」），
           * 而且 `prompt.ts` 早就用上了。
           *
           * 只有这里一直印机器码，于是同一个困惑从操作员身上搬到了复盘员身上。
           */
          `平仓原因：${closeReasonLabel(input.closeReason, input.netPnl)}`,
          /*
           * ⚠️ **开仓时计划的保护位 —— 必须有，否则复盘员只能去历史里猜。**
           *
           * `#104`（WLDUSDT）的复盘写的是：
           *
           *   「记录的开仓止损应为 0.5440，实际平仓价却是 0.5516，两者相差约 1.2%，
           *     说明实际止损位被收紧/挂错……**本次亏损无法区分是『趋势判断错』
           *     还是『止损设置/执行错』**。」
           *
           * 而它引用的 `0.544` 是**同一标的上一笔**（`#275`）的止损，本笔是 `0.552`
           * （决策、挂单触发价、成交滑点三者一致，没有挂错）——**它把两笔混了**，
           * 因为以前这几项事实里**根本没有"计划的止损"**。
           *
           * 这行把两个数字并排给出，它就能自己判断"是被正常回踩扫出"还是"挂错了"。
           * 两个价位都用**价格口径**，与上面那行的"价格变动"一致；
           * 而"对保证金的口径"只在浮盈轨迹那一行出现，别混。
           */
          `计划保护位：止损 ${input.stopLoss ?? '（未设置）'}、止盈 ${input.takeProfit ?? '（未设置）'}` +
            `（价格口径。对比它们与入场价/平仓价即可判断这次离场是"按计划被打掉"还是"保护位挂错了" —— ` +
            '不要再从同标的的历史记忆里找止损价，那是**别的交易**的值）',
          /*
           * 浮盈轨迹这一行刻意写成"峰值 vs 最终"，因为复盘员要判断的正是
           * "曾经赚到多少、又还回去多少"。
           *
           * ⚠️ **口径必须写出来，而且必须和上一行的「价格变动」区分开。**
           *
           * 上面那行是**价格**口径（`(exit-entry)/entry`，不含杠杆），
           * 这一行是**对保证金**的口径（含杠杆）。两行紧挨着、数字长得一样，
           * 而它差一个杠杆倍数 —— 实测就是这么被读错的：
           * `#95`（XRPUSDT 5x）记下 3.146%，模型拿它当价格涨幅去反算目标价，
           * 得到 1.5606（真实最高 1.5318），于是判定一张**从未被触及**的
           * 止盈单"应该兑现却没兑现"，并据此去改离场逻辑。
           *
           * 所以这里同时给两个口径，并明说"不要把它当价格"。
           */
          `浮盈轨迹：持仓期间最大浮盈 ${input.peakPnlPercent.toFixed(3)}%` +
            `（**对保证金的口径，含 ${input.leverage}x 杠杆 —— 折合价格约 ${marginPercentToPricePercent(input.peakPnlPercent, input.leverage).toFixed(3)}%**；` +
            '上一行的「价格变动」是价格口径，两个数不是一个东西，别拿这个去和止盈/止损价比较）' +
            (input.peakPnlPercent > 0 && input.netPnl <= 0
              ? ' —— **曾经浮盈但最终没赚到，这是"止盈/移动止损是否设晚"的直接证据。**'
              : ''),
          /*
           * 入场理由是复盘员区分「止损太紧」与「方向就错」的唯一依据，
           * 而这两种结论对应的改法完全相反。**三种状态要分清**：
           * 查到了 / 查不到（记录已轮转）/ 查出错（不是"当时没有理由"）。
           */
          entry.kind === 'found'
            ? `入场理由（第 #${entry.cycle} 轮，动作 ${entry.action}，置信度 ${entry.confidence}）：` +
              `${entry.reasoning}` +
              (entry.adjustments.length > 0
                ? `\n  风控当时记下的调整：${entry.adjustments.join('；')}`
                : '')
            : entry.kind === 'failed'
              ? '入场理由：**回查决策记录时出错**（这不等于"当时没有理由"，别据此判断）。'
              : input.closeReason === 'external'
                ? /*
                   * ⚠️ **外部平仓本来就没有我们的入场理由。**
                   *
                   * 这个仓位不是本平台开的（操作员手工下的、或别的程序下的），
                   * 所以找不到那一轮的决策记录是**正确的结果**，不是数据缺失。
                   *
                   * 原来这里一律说"可能已被轮转清理"，把复盘员引去怀疑一个不存在的
                   * 问题 —— 实测记忆 #24 就是这么写的：
                   *   「…**但入场理由缺失，无法判断是方向本就错、还是止损/出场过紧。**」
                   * 这是在一个"外部平仓"上追一个永远不会有的东西。
                   */
                  '入场理由：**这个仓位不是本平台开的**（外部交易 / 手工下单），' +
                  '所以本来就没有我们的入场理由 —— 这不是数据缺失，别据此认为记录丢了。'
                : '入场理由：**查不到对应那一轮的决策记录**（可能已被轮转清理）。' +
                  '缺少入场理由时无法区分"止损设得过紧"与"入场方向本就错误" —— 请以此为限下结论。',
        ];

        const facts =
          lines.join('\n') +
          '\n' +
          (recent.length > 0
            ? `\n这个标的历史上的记录：\n${recent.map((m) => `- ${m.lesson}`).join('\n')}`
            : '\n这个标的历史上没有记录。');

        const r = await reviewClosedTrade({
          model: this.deps.model,
          trade: input,
          facts,
          save: (m) => {
            agentMemory.insert({
              traderId: this.deps.traderId,
              tradeId: input.tradeId,
              symbol: m.symbol,
              closeReason: m.closeReason,
              netPnl: m.netPnl,
              lesson: m.lesson,
              tags: m.tags,
            });
          },
        });
        if (r.ok) log.info(`机器人 #${this.deps.traderId} 复盘 ${input.symbol}：${r.lesson}`);
      } catch (error) {
        log.warn(`复盘失败（不影响交易）：${(error as Error).message}`);
      }
    })();
  }

  /* ---------------------------------------------------------------------- */

  private async runReview(reason: 'cycle' | 'manual'): Promise<void> {
    const ports = makeAgentPorts({
      traderId: this.deps.traderId,
      strategyConfig: this.deps.strategyConfig,
      hourlyBudget: (this.deps.policy ?? DEFAULT_WAKE_POLICY).hourlyBudget,
      priceChangeSince: this.deps.priceChangeSince,
    });

    const outcome = await runStrategyReview({
      ports,
      model: this.deps.model,
      policy: this.deps.policy ?? DEFAULT_WAKE_POLICY,
      force: reason === 'manual',
    });

    if (!outcome.ran) {
      // 没醒是常态（冷却、预算、没有值得醒的事）—— 用 debug 级别，
      // 免得日志被"这一轮为什么没醒"刷满。
      log.debug(`机器人 #${this.deps.traderId} 本轮未审视：${outcome.skippedBecause}`);
      return;
    }

    /*
     * ⚠️ 顺序要紧：**先落"醒过"的时间，再打权益基线**。
     *
     * 这两个状态是冷却与回撤判据的依据。落晚了的话，如果审视过程很慢，
     * 下一轮的 `minutesSinceLastWake` 会算大，可能立刻又醒一次 —— 那就是抖动。
     */
    markWoken(this.deps.traderId, this.deps.equityNow());
    markStrategyReview(this.deps.traderId);

    log.info(
      `机器人 #${this.deps.traderId} 完成策略审视（触发 ${outcome.trigger} / ${outcome.intensity}）：` +
        `${outcome.loop?.outcome}，${outcome.loop?.steps.length ?? 0} 步`,
    );
  }
}
