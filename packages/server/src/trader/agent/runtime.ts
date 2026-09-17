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

import type { StrategyConfig } from '@aq/shared';

import type { ReviewTradeFacts } from '../autoTrader.js';

import { createLogger } from '../../logger.js';
import { agentMemory } from '../../store/agentStore.js';
import { traders } from '../../store/repositories.js';
import type { LoopModel } from './loop.js';
import { markStrategyReview, markWoken, makeAgentPorts, readPause } from './ports.js';
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
    const raw = traders.get(this.deps.traderId)!.agentConfigJson as string;
    try {
      return JSON.parse(raw) as StrategyConfig;
    } catch (error) {
      // 坏配置不该让机器人停摆；回落到策略配置，并让这件事可见。
      log.warn(`机器人 #${this.deps.traderId} 的 AI 配置无法解析，回落策略配置：${(error as Error).message}`);
      return null;
    }
  }

  /** 是否被 AI 主动停手。**恢复由操作员决定，模型没有这个工具。** */
  paused(): { at: string; reason: string } | null {
    return readPause(this.deps.traderId);
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

        const lines = [
          `标的：${input.symbol}`,
          `方向与价位：开仓 ${input.entryPrice} → 平仓 ${input.exitPrice}（价格变动 ${priceMove.toFixed(3)}%）`,
          `毛盈亏 ${input.grossPnl.toFixed(4)}　手续费 ${input.fee.toFixed(4)}　净盈亏 ${input.netPnl.toFixed(4)}`,
          feeShare === null
            ? '成本占比：毛盈亏为 0，无法计算占比。'
            : `成本占比：手续费占毛盈亏绝对值的 ${feeShare.toFixed(1)}%` +
              (feeShare >= 50 ? ' —— **成本吃掉了大部分毛收益**，这笔交易在扣费前就已经很薄。' : ''),
          `持仓时长：${input.holdMinutes.toFixed(1)} 分钟`,
          `平仓原因：${input.closeReason}`,
          /*
           * 浮盈轨迹这一行刻意写成"峰值 vs 最终"，因为复盘员要判断的正是
           * "曾经赚到多少、又还回去多少"。
           */
          `浮盈轨迹：持仓期间最大浮盈 ${input.peakPnlPercent.toFixed(3)}%` +
            (input.peakPnlPercent > 0
              ? `，最终净 ${(input.netPnl / (input.entryPrice * 0.01)).toFixed(3)}%（按价格口径近似）`
              : '') +
            (input.peakPnlPercent > 0 && input.netPnl <= 0
              ? ' —— **曾经浮盈但最终没赚到，这是"止盈/移动止损是否设晚"的直接证据。**'
              : ''),
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
