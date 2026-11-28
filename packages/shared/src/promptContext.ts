export interface PromptPositionContext {
  entryPrice?: number | null;
  previousStopLoss?: number | null;
  previousTakeProfit?: number | null;
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePromptNumber(match: RegExpMatchArray | null): number | null | undefined {
  if (!match) return undefined;
  const token = match[1]!.replace(/,/g, '').trim();
  if (token === '无' || token.toLowerCase() === 'none') return null;
  const value = Number(token);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 从周期 `userPrompt` 的「当前持仓」段落回溯提取调整前的均价、原止损、原止盈。
 * 既支持智能托管 2.0 战术面板格式（`- **BTCUSDT 多 10x** | ... · 均价 61330.0 ... · SL=60970.0 · TP=62400.0`），
 * 也兼容常规策略模板的持仓行，供服务端列表回填与前端决策详情统一复用。
 */
export function extractPromptPositionContext(
  userPrompt: string | null | undefined,
  symbol: string,
): PromptPositionContext | null {
  if (!userPrompt || !symbol) return null;
  const norm = symbol.trim().toUpperCase();
  if (!norm) return null;

  const lines = userPrompt.split('\n');
  const symRe = new RegExp(`(?:^|[\\s*|\\[])\\*{0,2}${escapeRegExp(norm)}\\b`, 'i');

  for (const line of lines) {
    if (!symRe.test(line)) continue;
    // 只匹配包含持仓字段（均价/开仓价 或 SL=/TP=/止损）的持仓摘要行，跳过普通行情候选行
    const hasPosMarkers =
      /(?:均价|开仓价?|entry)\s*[=:]?\s*\d/i.test(line) ||
      /(?:SL|止损)\s*[=:]\s*(?:\d|无|none)/i.test(line) ||
      /(?:TP|止盈)\s*[=:]\s*(?:\d|无|none)/i.test(line);
    if (!hasPosMarkers) continue;

    const entryPrice = parsePromptNumber(
      line.match(/(?:均价|开仓价?|entry)\s*[=:]?\s*\$?([\d,]+(?:\.\d+)?)/i),
    );
    const previousStopLoss = parsePromptNumber(
      line.match(/(?:\bSL|止损)\s*[=:]\s*\$?([\d,]+(?:\.\d+)?|无|none)/i),
    );
    const previousTakeProfit = parsePromptNumber(
      line.match(/(?:\bTP|止盈)\s*[=:]\s*\$?([\d,]+(?:\.\d+)?|无|none)/i),
    );

    if (
      entryPrice !== undefined ||
      previousStopLoss !== undefined ||
      previousTakeProfit !== undefined
    ) {
      return {
        ...(entryPrice !== undefined ? { entryPrice } : {}),
        ...(previousStopLoss !== undefined ? { previousStopLoss } : {}),
        ...(previousTakeProfit !== undefined ? { previousTakeProfit } : {}),
      };
    }
  }
  return null;
}
