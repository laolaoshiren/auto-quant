import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGY_PRESETS, defaultStrategyConfig, type StrategyConfig } from '@aq/shared';
import {
  candidateBudget,
  estimateCandidateChars,
  estimateTokens,
  PROMPT_TOKEN_BUDGET,
} from './prompt.js';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function configFromPreset(presetId: string): StrategyConfig {
  const preset = STRATEGY_PRESETS.find((p) => p.id === presetId);
  return { ...defaultStrategyConfig(), ...(preset?.patch as Partial<StrategyConfig>) };
}

/* -------------------------------------------------------------------------- */
/*  Token estimation                                                           */
/* -------------------------------------------------------------------------- */

test('the token estimate reflects the measured density, not the English rule of thumb', () => {
  // Ground truth from a real call: 207,328 characters produced 128,073 tokens.
  const measured = 128_073;
  const actualChars = 207_328;
  const estimate = estimateTokens('x'.repeat(actualChars));

  // The usual "4 characters per token" heuristic would say ~52k — less than half
  // the truth, which is precisely how an oversized prompt escaped a size check.
  assert.ok(
    estimate > measured * 0.9 && estimate < measured * 1.15,
    `estimate ${estimate} should be within ~15% of the measured ${measured}`,
  );
  assert.ok(estimate > actualChars / 4, 'must not use the English prose ratio');
});

/* -------------------------------------------------------------------------- */
/*  Per-candidate cost                                                         */
/* -------------------------------------------------------------------------- */

test('a candidate costs more when more timeframes or indicators are enabled', () => {
  const lean: StrategyConfig = {
    ...defaultStrategyConfig(),
    indicators: {
      ...defaultStrategyConfig().indicators,
      kline: { primaryTimeframe: '5m', selectedTimeframes: ['5m', '15m'], primaryCount: 60 },
      enableEma: true,
      enableMacd: false,
      enableRsi: false,
      enableAtr: false,
      enableVolume: false,
    },
  };
  const heavy: StrategyConfig = {
    ...lean,
    indicators: {
      ...lean.indicators,
      kline: { primaryTimeframe: '5m', selectedTimeframes: ['5m', '15m', '1h', '4h'], primaryCount: 60 },
      enableMacd: true,
      enableRsi: true,
      enableAtr: true,
      enableVolume: true,
    },
  };

  assert.ok(
    estimateCandidateChars(heavy) > estimateCandidateChars(lean) * 2,
    'four timeframes with every indicator must cost far more than two with EMA only',
  );
});

test('rendered points are capped, so a huge candle count does not scale the cost linearly', () => {
  const base = configFromPreset('conservative');
  const with60: StrategyConfig = {
    ...base,
    indicators: { ...base.indicators, kline: { ...base.indicators.kline, primaryCount: 60 } },
  };
  const with300: StrategyConfig = {
    ...base,
    indicators: { ...base.indicators, kline: { ...base.indicators.kline, primaryCount: 300 } },
  };
  assert.equal(
    estimateCandidateChars(with60),
    estimateCandidateChars(with300),
    'past the render cap the prompt stops growing, even though indicators still compute over the full window',
  );
});

/* -------------------------------------------------------------------------- */
/*  Budget                                                                     */
/* -------------------------------------------------------------------------- */

test('the scalping preset is the heavy case and gets a small candidate budget', () => {
  // This is the exact configuration that produced a 128k-token prompt and an
  // empty model response: three timeframes, every indicator, 25 candidates.
  const scalping = configFromPreset('scalping');
  const budget = candidateBudget(scalping);

  assert.ok(budget >= 1, 'a strategy must always see at least one symbol');
  assert.ok(
    budget < 25,
    `the scalping config must not be allowed 25 candidates (got ${budget}) — that is what overflowed the context`,
  );
  // Sanity: the budget must actually fit.
  const perCandidate = estimateTokens('x'.repeat(estimateCandidateChars(scalping)));
  assert.ok(
    perCandidate * budget <= PROMPT_TOKEN_BUDGET * 1.1,
    `budget ${budget} × ${perCandidate} tokens must stay near the ${PROMPT_TOKEN_BUDGET} budget`,
  );
});

test('a light strategy is allowed a much larger universe than a heavy one', () => {
  const light: StrategyConfig = {
    ...defaultStrategyConfig(),
    indicators: {
      ...defaultStrategyConfig().indicators,
      kline: { primaryTimeframe: '1h', selectedTimeframes: ['1h'], primaryCount: 60 },
      enableMacd: false,
      enableRsi: false,
      enableAtr: false,
      enableVolume: false,
    },
  };
  assert.ok(
    candidateBudget(light) > candidateBudget(configFromPreset('scalping')),
    'a single-timeframe, single-indicator strategy should afford more candidates',
  );
});

test('every preset produces a budget that fits inside the token ceiling', () => {
  for (const preset of STRATEGY_PRESETS) {
    const config = configFromPreset(preset.id);
    const perCandidate = estimateTokens('x'.repeat(estimateCandidateChars(config)));
    const fitted = perCandidate * candidateBudget(config);
    assert.ok(
      fitted <= PROMPT_TOKEN_BUDGET * 1.1,
      `preset "${preset.id}" would produce ${fitted} tokens, over the ${PROMPT_TOKEN_BUDGET} budget`,
    );
  }
});
