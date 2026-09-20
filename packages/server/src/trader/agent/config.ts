/**
 * 读取一台 AI 托管机器人的**生效配置**。
 *
 * ## 为什么必须过 schema，而不是 `JSON.parse(...) as StrategyConfig`
 *
 * `agent_config_json` 是 AI 自己写进去的一整份 `StrategyConfig`。它在**写入那一刻**
 * 由 `patch.ts` 过了 zod（那是唯一的防线）。但如果读取时只做 JSON 解析再断言类型，
 * 那份防线就只在写入时存在一次 —— 而这几个问题会随之出现：
 *
 * 1. **定时炸弹（最严重）**：`StrategyConfigSchema` 里每个字段都有 `.default()`。
 *    将来给配置加一个**带默认值的安全字段**（比如某条新的上限 `x`）之后，
 *    老配置的 JSON 里没有它 → 读出来是 `undefined` → 代码里所有 `x > 0` 形式的
 *    判据**静默变成 false**。那不是"用了默认值"，那是**把这条风控关掉了**，
 *    而且没有任何报错。同一个字段在 `manager.ts` 里是过了 schema 的，于是
 *    两处对同一份配置得出不同结论。
 * 2. 手改数据库、旧版本残留、跨版本迁移都能把一个未经验证的配置直接送进交易与风控。
 *
 * `manager.ts` 早就按正确的方式读了（`safeParse` + 回落策略配置），
 * 而 `runtime.ts` 与 `ports.ts` 是断言式的 —— 同一个值三种读法。
 * 这个文件把它收敛成一种。
 *
 * ## 坏配置的处置
 *
 * 回落到策略配置（**不是**用 zod 的默认值拼一份出来）：把三处行为统一成
 * "解析不通过就当它没写过"，与 `traders` 表里 `agent_config_json` 为 NULL 时
 * 完全同一条路径。机器人不该因为一份坏配置停摆，但也不该拿一份半解析的
 * 配置去下单。
 */
import { StrategyConfigSchema, type StrategyConfig } from '@aq/shared';

import { createLogger } from '../../logger.js';
import { traders } from '../../store/repositories.js';

const log = createLogger('agent-config');

/**
 * 读出该机器人当前的生效配置。
 *
 * @param traderId 机器人 id
 * @param fallback **没有 AI 配置或配置不可用时**要返回的那份。
 *   调用方给策略配置表示"回落到策略"；给 `null` 表示"让调用方自己决定"
 *   （`configOverride()` 用后者 —— 它的契约是"没有生效的 AI 配置就返回 null"）。
 * @returns 生效配置；`agentConfigJson` 为空或不可解析时返回 `fallback`
 */
export function readAgentConfig(
  traderId: number,
  fallback: StrategyConfig | null,
): StrategyConfig | null {
  const raw = traders.get(traderId)?.agentConfigJson;
  if (typeof raw !== 'string' || raw.length === 0) return fallback;

  try {
    const parsed = StrategyConfigSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    /*
     * 不把 zod 的整棵 error tree 打出来 —— 它对这个用途太长，而且日志里
     * 真正有用的是"哪一份配置不行、回落到什么"。细节在 `patch.ts` 写入时会拦。
     */
    log.warn(
      `机器人 #${traderId} 的 AI 配置没通过 schema（${parsed.error.issues.length} 处问题），已回落到策略配置。`,
    );
  } catch (error) {
    log.warn(
      `机器人 #${traderId} 的 AI 配置不是合法 JSON（${(error as Error).message}），已回落到策略配置。`,
    );
  }
  return fallback;
}

/**
 * AI 是否已经写过配置（不看它是否能解析）。
 *
 * 与 `readAgentConfig` 分开：`isEnabled()` 要回答的是"AI 托管有没有被启用过"，
 * 而一份坏配置**仍然算启用过**（否则一个写坏配置的机器人会安静地退回策略模式，
 * 而操作员以为 AI 还在管）。两者混在一起会让这个判断随解析成败摇摆。
 */
export function hasAgentConfig(traderId: number): boolean {
  const raw = traders.get(traderId)?.agentConfigJson;
  return typeof raw === 'string' && raw.length > 0;
}
