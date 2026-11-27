import type { Decision, ExecutionLogEntry } from '@aq/shared';
import { isOpenAction } from '../components/DecisionAudit';
import { fmtPriceUsd, fmtQty, fmtUsd, isNum } from './format';

export type FigureKey =
  | 'size'
  | 'margin'
  | 'entry'
  | 'stop'
  | 'target'
  | 'reward'
  | 'leverage'
  | 'reduce';

export interface Figure {
  key: FigureKey;
  /** 短标签；数量、风险回报比、杠杆等配合悬停说明解释。 */
  label: string;
  value: string;
  /** 紧跟主值后的补充增减/百分比信息（如 `(-1.34%)`、`(+330.00 / +0.54%)`）。 */
  sub?: string;
  /** 精细悬停说明（优先于默认 `FIGURE_TITLE[key]`）。 */
  tooltip?: string;
}

export interface FigureContext {
  previousStopLoss?: number | null;
  previousTakeProfit?: number | null;
  entryPrice?: number | null;
}

export const FIGURE_TITLE: Record<FigureKey, string> = {
  size: '名义价值（USDT）',
  margin: '预计保证金占用 = 仓位名义价值 ÷ 杠杆倍数（USDT）',
  entry: '入场参考价（限价单取挂单价，市价单取当前价）',
  stop: '止损触发价（USDT）与距开仓价百分比',
  target: '止盈触发价（USDT）与距开仓价百分比',
  reward: '风险回报比 = |止盈 - 入场| ÷ |入场 - 止损|',
  leverage: '杠杆倍数（影响所需保证金）',
  reduce: '减仓幅度：百分比按持仓数量计，数值形式则是要卖出的数量',
};

export const FIGURE_PILL_STYLE: Record<FigureKey, { box: string; label: string; value: string }> = {
  size: {
    box: "border-slate-500/30 bg-slate-500/10 [[data-skin='light']_&]:border-slate-400/45 [[data-skin='light']_&]:bg-slate-200/60",
    label: 'text-ink-lo',
    value: 'text-ink-hi',
  },
  margin: {
    box: "border-amber-400/35 bg-amber-500/12 [[data-skin='light']_&]:border-amber-700/30 [[data-skin='light']_&]:bg-amber-500/12",
    label: "text-amber-300/80 [[data-skin='light']_&]:text-amber-800/80",
    value: "text-amber-300 [[data-skin='light']_&]:text-amber-800",
  },
  entry: {
    box: "border-sky-400/35 bg-sky-500/12 [[data-skin='light']_&]:border-sky-700/30 [[data-skin='light']_&]:bg-sky-500/12",
    label: "text-sky-300/80 [[data-skin='light']_&]:text-sky-800/80",
    value: "text-sky-300 [[data-skin='light']_&]:text-sky-800",
  },
  stop: {
    box: 'border-down/35 bg-down/12',
    label: 'text-down/80',
    value: 'text-down',
  },
  target: {
    box: 'border-up/35 bg-up/12',
    label: 'text-up/80',
    value: 'text-up',
  },
  reward: {
    box: "border-violet-400/35 bg-violet-500/12 [[data-skin='light']_&]:border-violet-700/30 [[data-skin='light']_&]:bg-violet-500/12",
    label: "text-violet-300/80 [[data-skin='light']_&]:text-violet-800/80",
    value: "text-violet-300 [[data-skin='light']_&]:text-violet-800",
  },
  leverage: {
    box: "border-orange-400/35 bg-orange-500/12 [[data-skin='light']_&]:border-orange-700/30 [[data-skin='light']_&]:bg-orange-500/12",
    label: "text-orange-300/80 [[data-skin='light']_&]:text-orange-800/80",
    value: "text-orange-300 [[data-skin='light']_&]:text-orange-800",
  },
  reduce: {
    box: 'border-warn/35 bg-warn/12',
    label: 'text-warn/80',
    value: 'text-warn',
  },
};

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 计算 `target` 相对 `base` 的带符号百分比（与持仓表 `PositionsTable` 口径保持完全一致）。 */
export function formatPctOffset(target: number, base: number | null | undefined): string | null {
  if (!isFiniteNum(target) || !isFiniteNum(base) || base <= 0) return null;
  const pct = ((target - base) / base) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

/** 按参考价位量级格式化带符号价格增减量（如 `+330.00`、`-0.00140`、`+0.0500`）。 */
export function formatSignedPriceDelta(delta: number, refPrice: number): string {
  const abs = Math.abs(delta);
  const scale = Math.max(Math.abs(refPrice), abs);
  let digits = 2;
  if (scale < 0.01) digits = 6;
  else if (scale < 1) digits = 5;
  else if (scale < 10) digits = 4;
  else if (scale < 100) digits = 3;
  else digits = 2;
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  return `${sign}${abs.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从周期 `userPrompt` 的「当前持仓」段落回溯提取调整前的均价、原止损、原止盈。
 * 既支持智能托管 2.0 战术面板格式（`- **BTCUSDT 多 10x** | ... · 均价 61330.0 ... · SL=60970.0 · TP=62400.0`），
 * 也兼容常规策略模板的持仓行，使历史旧记录也能完整展示「从多少到多少 · 增减 · 百分比」。
 */
export function extractPromptPositionContext(
  userPrompt: string | null | undefined,
  symbol: string,
): FigureContext | null {
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

    const entryMatch = line.match(/(?:均价|开仓价?|entry)\s*[=:]?\s*\$?([\d,]+(?:\.\d+)?)/i);
    const slMatch = line.match(/(?:\bSL|止损)\s*[=:]\s*\$?([\d,]+(?:\.\d+)?|无|none)/i);
    const tpMatch = line.match(/(?:\bTP|止盈)\s*[=:]\s*\$?([\d,]+(?:\.\d+)?|无|none)/i);

    const parseVal = (m: RegExpMatchArray | null): number | null | undefined => {
      if (!m) return undefined;
      const token = m[1]!.replace(/,/g, '').trim();
      if (token === '无' || token.toLowerCase() === 'none') return null;
      const n = Number(token);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };

    const entryPrice = parseVal(entryMatch);
    const previousStopLoss = parseVal(slMatch);
    const previousTakeProfit = parseVal(tpMatch);

    if (entryPrice !== undefined || previousStopLoss !== undefined || previousTakeProfit !== undefined) {
      return {
        ...(entryPrice !== undefined ? { entryPrice } : {}),
        ...(previousStopLoss !== undefined ? { previousStopLoss } : {}),
        ...(previousTakeProfit !== undefined ? { previousTakeProfit } : {}),
      };
    }
  }
  return null;
}

/** 合并执行日志结构化字段（新记录权威）与 `userPrompt` 持仓摘要（历史记录兜底）。 */
export function resolveFigureContext(
  userPrompt: string | null | undefined,
  symbol: string,
  outcome?: ExecutionLogEntry | null,
): FigureContext | null {
  const fromPrompt = extractPromptPositionContext(userPrompt, symbol);
  const previousStopLoss =
    outcome?.previousStopLoss !== undefined ? outcome.previousStopLoss : fromPrompt?.previousStopLoss;
  const previousTakeProfit =
    outcome?.previousTakeProfit !== undefined ? outcome.previousTakeProfit : fromPrompt?.previousTakeProfit;
  const entryPrice = outcome?.entryPrice !== undefined ? outcome.entryPrice : fromPrompt?.entryPrice;

  if (
    previousStopLoss === undefined &&
    previousTakeProfit === undefined &&
    entryPrice === undefined
  ) {
    return null;
  }
  return { previousStopLoss, previousTakeProfit, entryPrice };
}

function buildProtectionAdjustmentFigure(params: {
  key: 'stop' | 'target';
  name: '止损' | '止盈';
  nextPrice: number;
  prevPrice: number | null | undefined;
  entryPrice: number | null | undefined;
  explicitArrowWhenUnknown: boolean;
}): Figure {
  const { key, name, nextPrice, prevPrice, entryPrice, explicitArrowWhenUnknown } = params;
  const entryPct = formatPctOffset(nextPrice, entryPrice);

  if (isFiniteNum(prevPrice) && prevPrice > 0) {
    const delta = nextPrice - prevPrice;
    const pct = ((nextPrice - prevPrice) / prevPrice) * 100;
    const unchanged = Math.abs(delta) <= Math.max(prevPrice, nextPrice) * 1e-9;

    if (unchanged) {
      const tipLines = [
        `${name}维持不变：${fmtPriceUsd(nextPrice)}`,
        ...(entryPct && isFiniteNum(entryPrice)
          ? [`· 距开仓价(${fmtPriceUsd(entryPrice)})：${entryPct}`]
          : []),
      ];
      return {
        key,
        label: name,
        value: fmtPriceUsd(nextPrice),
        sub: '(未变)',
        tooltip: tipLines.join('\n'),
      };
    }

    const deltaStr = formatSignedPriceDelta(delta, prevPrice);
    const pctStr = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
    const direction = delta > 0 ? '上调' : '下调';
    const tipLines = [
      `${name}${direction}：${fmtPriceUsd(prevPrice)} → ${fmtPriceUsd(nextPrice)}`,
      `· 变动幅度：${deltaStr} (${pctStr})`,
      ...(entryPct && isFiniteNum(entryPrice)
        ? [`· 新${name}距开仓价(${fmtPriceUsd(entryPrice)})：${entryPct}`]
        : []),
    ];
    return {
      key,
      label: name,
      value: `${fmtPriceUsd(prevPrice)} → ${fmtPriceUsd(nextPrice)}`,
      sub: `(${pctStr})`,
      tooltip: tipLines.join('\n'),
    };
  }

  if (prevPrice === null) {
    const tipLines = [
      `新增${name}：未设 → ${fmtPriceUsd(nextPrice)}`,
      ...(entryPct && isFiniteNum(entryPrice)
        ? [`· 距开仓价(${fmtPriceUsd(entryPrice)})：${entryPct}`]
        : []),
    ];
    return {
      key,
      label: name,
      value: `未设 → ${fmtPriceUsd(nextPrice)}`,
      sub: entryPct ? `(${entryPct})` : undefined,
      tooltip: tipLines.join('\n'),
    };
  }

  return {
    key,
    label: explicitArrowWhenUnknown ? `${name} →` : name,
    value: fmtPriceUsd(nextPrice),
    sub: entryPct ? `(${entryPct})` : undefined,
    tooltip:
      entryPct && isFiniteNum(entryPrice)
        ? `${name}：${fmtPriceUsd(nextPrice)}\n· 距开仓价(${fmtPriceUsd(entryPrice)})：${entryPct}`
        : undefined,
  };
}

/**
 * 构建一条决策的关键数字胶囊（供决策流与单轮审计详情页共用同一口径）。
 */
export function figureParts(
  decision: Decision,
  price: number | null,
  context?: FigureContext | null,
): Figure[] {
  const num = isFiniteNum;

  if (decision.action === 'add_to_position') {
    const entryRef = isFiniteNum(context?.entryPrice) ? context.entryPrice : price;
    const parts: Figure[] = [
      { key: 'size', label: '加仓', value: fmtUsd(decision.positionSizeUsd, 2) },
    ];
    if (num(decision.positionSizeUsd) && decision.positionSizeUsd > 0 && num(decision.leverage) && decision.leverage > 0) {
      parts.push({ key: 'margin', label: '保证金', value: fmtUsd(decision.positionSizeUsd / decision.leverage, 2) });
    }
    if (decision.leverage > 0) parts.push({ key: 'leverage', label: '杠杆', value: `${decision.leverage}x` });
    if (num(decision.stopLoss)) {
      parts.push(
        buildProtectionAdjustmentFigure({
          key: 'stop',
          name: '止损',
          nextPrice: decision.stopLoss,
          prevPrice: context?.previousStopLoss,
          entryPrice: entryRef,
          explicitArrowWhenUnknown: false,
        }),
      );
    }
    if (num(decision.takeProfit)) {
      parts.push(
        buildProtectionAdjustmentFigure({
          key: 'target',
          name: '止盈',
          nextPrice: decision.takeProfit,
          prevPrice: context?.previousTakeProfit,
          entryPrice: entryRef,
          explicitArrowWhenUnknown: false,
        }),
      );
    }
    return parts;
  }

  if (decision.action === 'reduce_position') {
    const entryRef = isFiniteNum(context?.entryPrice) ? context.entryPrice : price;
    const parts: Figure[] = [];
    if (num(decision.reducePercent)) {
      parts.push({ key: 'reduce', label: '减仓', value: `${decision.reducePercent.toFixed(1)}%` });
    } else if (num(decision.reduceQuantity)) {
      parts.push({ key: 'reduce', label: '减仓', value: fmtQty(decision.reduceQuantity) });
    }
    if (num(decision.stopLoss)) {
      parts.push(
        buildProtectionAdjustmentFigure({
          key: 'stop',
          name: '止损',
          nextPrice: decision.stopLoss,
          prevPrice: context?.previousStopLoss,
          entryPrice: entryRef,
          explicitArrowWhenUnknown: false,
        }),
      );
    }
    if (num(decision.takeProfit)) {
      parts.push(
        buildProtectionAdjustmentFigure({
          key: 'target',
          name: '止盈',
          nextPrice: decision.takeProfit,
          prevPrice: context?.previousTakeProfit,
          entryPrice: entryRef,
          explicitArrowWhenUnknown: false,
        }),
      );
    }
    return parts;
  }

  if (decision.action === 'adjust_protection') {
    /* 调整保护位只使用真实开仓均价 `context.entryPrice`，绝不拿实时跳动的行情价冒充开仓价。 */
    const entryRef = isFiniteNum(context?.entryPrice) ? context.entryPrice : null;
    const adjusted: Figure[] = [];
    if (num(decision.stopLoss)) {
      adjusted.push(
        buildProtectionAdjustmentFigure({
          key: 'stop',
          name: '止损',
          nextPrice: decision.stopLoss,
          prevPrice: context?.previousStopLoss,
          entryPrice: entryRef,
          explicitArrowWhenUnknown: true,
        }),
      );
    }
    if (num(decision.takeProfit)) {
      adjusted.push(
        buildProtectionAdjustmentFigure({
          key: 'target',
          name: '止盈',
          nextPrice: decision.takeProfit,
          prevPrice: context?.previousTakeProfit,
          entryPrice: entryRef,
          explicitArrowWhenUnknown: true,
        }),
      );
    }
    return adjusted;
  }

  if (!isOpenAction(decision.action)) return [];

  const limitEntry = decision.entryType === 'limit' && num(decision.limitPrice) ? decision.limitPrice : null;
  const entryRef = limitEntry ?? (isFiniteNum(context?.entryPrice) ? context.entryPrice : price);
  const parts: Figure[] = [
    {
      key: 'size',
      label: '仓位',
      value: fmtUsd(num(decision.positionSizeUsd) ? decision.positionSizeUsd : null, 2),
    },
  ];
  if (num(decision.positionSizeUsd) && decision.positionSizeUsd > 0 && num(decision.leverage) && decision.leverage > 0) {
    parts.push({
      key: 'margin',
      label: '保证金',
      value: fmtUsd(decision.positionSizeUsd / decision.leverage, 2),
    });
  }
  if (entryRef !== null) {
    parts.push({ key: 'entry', label: limitEntry !== null ? '限价' : '开仓', value: fmtPriceUsd(entryRef) });
  }
  if (num(decision.stopLoss)) {
    const pct = formatPctOffset(decision.stopLoss, entryRef);
    const delta = entryRef !== null ? formatSignedPriceDelta(decision.stopLoss - entryRef, entryRef) : null;
    parts.push({
      key: 'stop',
      label: '止损',
      value: fmtPriceUsd(decision.stopLoss),
      sub: pct ? `(${pct})` : undefined,
      tooltip:
        pct && entryRef !== null && delta !== null
          ? `止损触发价：${fmtPriceUsd(decision.stopLoss)}\n· 距${limitEntry !== null ? '限价' : '开仓价'}(${fmtPriceUsd(entryRef)})：${delta} (${pct})`
          : undefined,
    });
  }
  if (num(decision.takeProfit)) {
    const pct = formatPctOffset(decision.takeProfit, entryRef);
    const delta = entryRef !== null ? formatSignedPriceDelta(decision.takeProfit - entryRef, entryRef) : null;
    parts.push({
      key: 'target',
      label: '止盈',
      value: fmtPriceUsd(decision.takeProfit),
      sub: pct ? `(${pct})` : undefined,
      tooltip:
        pct && entryRef !== null && delta !== null
          ? `止盈触发价：${fmtPriceUsd(decision.takeProfit)}\n· 距${limitEntry !== null ? '限价' : '开仓价'}(${fmtPriceUsd(entryRef)})：${delta} (${pct})`
          : undefined,
    });
  }
  if (entryRef !== null && num(decision.stopLoss) && num(decision.takeProfit)) {
    const risk = Math.abs(entryRef - decision.stopLoss);
    const reward = Math.abs(decision.takeProfit - entryRef);
    if (risk > 0) parts.push({ key: 'reward', label: '盈亏比', value: `1:${(reward / risk).toFixed(2)}` });
  }
  if (isNum(decision.leverage) && decision.leverage > 0) {
    parts.push({ key: 'leverage', label: '杠杆', value: `${decision.leverage}x` });
  }

  return parts;
}
