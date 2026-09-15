/**
 * 币种来源与指标配置。
 *
 * 这一层只负责"把 schema 里的字段摊开"，不做任何派生计算 —— 所有值都直接来自
 * `config`，所有改动都直接回写。唯一的例外是下面两个逗号列表输入：它们各自保留
 * 一份「正在输入的原文」，否则解析结果会立刻覆盖用户的半截输入。
 */
import { useState, type ReactNode } from 'react';
import type { CoinPoolRank, CoinSourceType, StrategyConfig, Timeframe } from '@aq/shared';
import { TIMEFRAMES } from '@aq/shared';
import { Badge, Field, NumberInput, Select, TextInput, Toggle, cn } from './ui';
import { FieldError, NumField, PeriodListField, Section } from './StrategyFieldKit';

/* -------------------------------------------------------------------------- */
/*  Coin source                                                                */
/* -------------------------------------------------------------------------- */

const SOURCE_TYPES: Array<{ id: CoinSourceType; label: string; hint: string }> = [
  { id: 'static', label: '静态列表', hint: '仅使用你在下方列出的交易对。' },
  { id: 'coinpool', label: '动态币种池', hint: '每个周期在全交易所范围内排名。' },
  { id: 'oi_top', label: '持仓量领先', hint: '持仓量增长最快的交易对。' },
  { id: 'mixed', label: '混合（并集）', hint: '静态列表加上动态来源，自动去重。' },
];

const RANKS: Array<{ id: CoinPoolRank; label: string }> = [
  { id: 'quote_volume', label: '24h 成交额（流动性）' },
  { id: 'gainers', label: '涨幅榜' },
  { id: 'losers', label: '跌幅榜' },
  { id: 'volatility', label: '24h 波动率 (最高−最低)/最低' },
  { id: 'funding_extreme', label: '|资金费率| 最大' },
];

/** 币种列表最多预览这么多标签，再多就折叠成「+N」——不渲染无上限的列表。 */
const COIN_CHIP_LIMIT = 24;

/** `btc, eth/usdt` → `['BTCUSDT', 'ETHUSDT']`，大写、去重、去掉分隔符。 */
function parseCoins(text: string): string[] {
  const coins = text
    .split(/[,\s]+/)
    .map((token) => token.trim().toUpperCase().replace(/[-_/]/g, ''))
    .filter(Boolean);
  return [...new Set(coins)];
}

/**
 * 静态币种列表。
 *
 * 必须保留输入原文：`value={coins.join(', ')}` 会让用户在敲下「BTCUSDT, 」
 * 的逗号后被立刻回写的 `"BTCUSDT"` 吞掉分隔符，**第二个币种永远输不进去**。
 */
function CoinListField({
  coins,
  onChange,
  error,
}: {
  coins: string[];
  onChange: (next: string[]) => void;
  error?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? coins.join(', ');
  const overflow = coins.length - COIN_CHIP_LIMIT;

  return (
    <div className="min-w-0">
      <Field
        label={`静态币种列表（${coins.length} 个）`}
        hint="逗号分隔，统一转为大写 — 例如 BTCUSDT、ETHUSDT、SOLUSDT。"
      >
        <TextInput
          className="num"
          value={shown}
          placeholder="BTCUSDT, ETHUSDT"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            onChange(parseCoins(event.target.value));
          }}
          onBlur={() => setDraft(null)}
        />
      </Field>

      {coins.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {coins.slice(0, COIN_CHIP_LIMIT).map((coin) => (
            <span key={coin} className="num rounded border border-base-700 bg-base-800 px-1.5 text-xs text-ink-mid">
              {coin}
            </span>
          ))}
          {overflow > 0 && <span className="num text-xs text-ink-faint">+{overflow}</span>}
        </div>
      ) : (
        <p className="mt-1.5 text-xs text-warn">
          列表为空 —— 静态模式下没有任何标的可交易。至少填一个交易对，或改用动态币种池。
        </p>
      )}

      <FieldError message={error} />
    </div>
  );
}

export function CoinSourceSection({
  config,
  onChange,
  errors,
}: {
  config: StrategyConfig;
  onChange: (next: StrategyConfig['coinSource']) => void;
  errors: Record<string, string>;
}) {
  const source = config.coinSource;
  const isStatic = source.sourceType === 'static';
  const usesPool = source.sourceType === 'coinpool' || source.sourceType === 'mixed';
  const usesOi = source.sourceType === 'oi_top' || source.sourceType === 'mixed';

  return (
    <Section
      title="币种来源"
      hint="每个周期哪些交易对会成为候选 —— 候选越少，每次模型调用越便宜也越快。"
      right={<Badge tone="muted">{source.sourceType}</Badge>}
    >
      <div className="md:col-span-2 xl:col-span-3">
        <span className="field-label">币种池模式</span>
        {/* aria-pressed：这四个是"选中态"而不是"跳转"，屏幕阅读器要能读出当前选中哪个 */}
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
          {SOURCE_TYPES.map((type) => {
            const active = source.sourceType === type.id;
            return (
              <button
                key={type.id}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  onChange({
                    ...source,
                    sourceType: type.id,
                    staticCoins: source.staticCoins,
                    useCoinPool: type.id === 'coinpool' || type.id === 'mixed',
                    useOITop: type.id === 'oi_top' || type.id === 'mixed',
                  })
                }
                className={cn(
                  'rounded-md border px-2.5 py-2 text-left transition',
                  active
                    ? 'border-accent/70 bg-accent/10 shadow-[inset_2px_0_0_0_theme(colors.accent)]'
                    : 'border-base-700 bg-base-850 hover:border-base-600 hover:bg-base-800',
                )}
              >
                <div className={cn('text-base font-semibold', active ? 'text-accent' : 'text-ink-hi')}>{type.label}</div>
                <div className="mt-0.5 text-xs leading-snug text-ink-lo">{type.hint}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="md:col-span-2 xl:col-span-3">
        <CoinListField
          coins={source.staticCoins}
          onChange={(next) => onChange({ ...source, staticCoins: next })}
          error={errors['coinSource.staticCoins']}
        />
      </div>

      {usesPool && (
        <>
          <NumField
            label="币种池数量（个）"
            value={source.coinPoolLimit}
            onChange={(value) => onChange({ ...source, coinPoolLimit: value })}
            min={1}
            max={200}
            hint="按下面的排名依据取前 N 名"
            error={errors['coinSource.coinPoolLimit']}
          />
          <Field label="币种池排名依据">
            <Select
              value={source.coinPoolRank}
              onChange={(event) => onChange({ ...source, coinPoolRank: event.target.value as CoinPoolRank })}
            >
              {RANKS.map((rank) => (
                <option key={rank.id} value={rank.id}>
                  {rank.label}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}

      {usesOi && (
        <>
          <NumField
            label="持仓量领先数量（个）"
            value={source.oiTopLimit}
            onChange={(value) => onChange({ ...source, oiTopLimit: value })}
            min={1}
            max={100}
            error={errors['coinSource.oiTopLimit']}
          />
          <NumField
            label="持仓量窗口（小时）"
            value={source.oiTopWindowHours}
            onChange={(value) => onChange({ ...source, oiTopWindowHours: value })}
            min={1}
            max={24}
            hint="与多久之前的持仓量相比"
            error={errors['coinSource.oiTopWindowHours']}
          />
        </>
      )}

      <NumField
        label="最小 24h 成交额（USDT）"
        value={source.minQuoteVolume24h}
        onChange={(value) => onChange({ ...source, minQuoteVolume24h: value })}
        step={1_000_000}
        min={0}
        hint="低于该流动性的交易对会被剔除"
        error={errors['coinSource.minQuoteVolume24h']}
      />
      <NumField
        label="最小持仓量（USDT）"
        value={source.minOpenInterestUsd}
        onChange={(value) => onChange({ ...source, minOpenInterestUsd: value })}
        step={1_000_000}
        min={0}
        error={errors['coinSource.minOpenInterestUsd']}
      />

      {isStatic && (
        <div className="md:col-span-2 xl:col-span-3">
          <div className="rounded-md border border-base-700 bg-base-850/50 px-3 py-2 text-xs leading-relaxed text-ink-lo">
            静态模式会忽略币种池设置。成交额与持仓量下限仍作为安全网，剔除流动性流失的交易对。
          </div>
        </div>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Indicators                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 单个指标的开关 + 参数。
 *
 * 关闭时**不隐藏**参数输入：值仍然会随配置提交，藏起来只会让人以为参数丢了；
 * 用底色和徽标把「已关闭」说清楚就够了。
 */
function IndicatorBlock({
  enabled,
  onToggle,
  label,
  hint,
  children,
}: {
  enabled: boolean;
  onToggle: (value: boolean) => void;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-md border px-2.5 py-2 transition',
        enabled ? 'border-base-700 bg-base-850/60' : 'border-base-800 bg-base-850/20',
      )}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Toggle checked={enabled} onChange={onToggle} label={label} hint={hint} />
        </div>
        <Badge tone={enabled ? 'up' : 'muted'} className="shrink-0">
          {enabled ? '启用' : '关闭'}
        </Badge>
      </div>
      <div className="mt-2 border-t border-base-800 pt-2">{children}</div>
    </div>
  );
}

export function IndicatorsSection({
  config,
  onChange,
  errors,
}: {
  config: StrategyConfig;
  onChange: (next: StrategyConfig['indicators']) => void;
  errors: Record<string, string>;
}) {
  const indicators = config.indicators;

  const toggleTimeframe = (timeframe: Timeframe) => {
    const selected = indicators.kline.selectedTimeframes.includes(timeframe)
      ? indicators.kline.selectedTimeframes.filter((item) => item !== timeframe)
      : [...indicators.kline.selectedTimeframes, timeframe];
    const ordered = TIMEFRAMES.filter((item) => selected.includes(item));
    onChange({ ...indicators, kline: { ...indicators.kline, selectedTimeframes: ordered } });
  };

  return (
    <div className="space-y-3">
      <Section
        title="K线与周期"
        hint="模型能看到的价位序列。周期越多、K线越多，提示词越大，也越容易超出模型预算。"
        right={<Badge tone="muted">{indicators.kline.selectedTimeframes.length} 个周期</Badge>}
      >
        <Field label="主周期" hint="与价格并排内联展示的指标。">
          <Select
            value={indicators.kline.primaryTimeframe}
            onChange={(event) =>
              onChange({
                ...indicators,
                kline: { ...indicators.kline, primaryTimeframe: event.target.value as Timeframe },
              })
            }
          >
            {TIMEFRAMES.map((timeframe) => (
              <option key={timeframe} value={timeframe}>
                {timeframe}
              </option>
            ))}
          </Select>
        </Field>

        <NumField
          label="每周期K线数（根）"
          value={indicators.kline.primaryCount}
          onChange={(value) => onChange({ ...indicators, kline: { ...indicators.kline, primaryCount: value } })}
          min={10}
          max={1000}
          hint="必须大于最长指标的回看长度"
          error={errors['indicators.kline.primaryCount']}
        />

        <div className="md:col-span-2 xl:col-span-3">
          <span className="field-label">已选周期（提示词中由旧到新）</span>
          <div className="flex flex-wrap gap-1" role="group" aria-label="要纳入提示词的K线周期">
            {TIMEFRAMES.map((timeframe) => {
              const active = indicators.kline.selectedTimeframes.includes(timeframe);
              return (
                <button
                  key={timeframe}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleTimeframe(timeframe)}
                  className={cn(
                    'num rounded border px-2.5 py-1 text-xs transition',
                    active
                      ? 'border-accent/70 bg-accent/15 font-semibold text-accent'
                      : 'border-base-700 bg-base-850 text-ink-lo hover:border-base-600 hover:text-ink-mid',
                  )}
                >
                  {timeframe}
                </button>
              );
            })}
          </div>
          <FieldError message={errors['indicators.kline.selectedTimeframes']} />
        </div>
      </Section>

      <Section title="指标周期" hint="只有已启用的指标会被计算并写进提示词（单位：根）。">
        <div className="md:col-span-2 xl:col-span-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <IndicatorBlock
              enabled={indicators.enableEma}
              onToggle={(value) => onChange({ ...indicators, enableEma: value })}
              label="EMA"
              hint="指数移动平均"
            >
              <PeriodListField
                label="EMA 周期（根）"
                values={indicators.emaPeriods}
                onChange={(values) => onChange({ ...indicators, emaPeriods: values })}
                hint="逗号分隔，例如 20, 50"
              />
            </IndicatorBlock>

            <IndicatorBlock
              enabled={indicators.enableMacd}
              onToggle={(value) => onChange({ ...indicators, enableMacd: value })}
              label="MACD"
              hint="快慢均线差"
            >
              <div className="space-y-2">
                <NumField
                  label="快线（根）"
                  value={indicators.macdFast}
                  onChange={(value) => onChange({ ...indicators, macdFast: value })}
                  min={2}
                  error={errors['indicators.macdFast']}
                />
                <NumField
                  label="慢线（根）"
                  value={indicators.macdSlow}
                  onChange={(value) => onChange({ ...indicators, macdSlow: value })}
                  min={3}
                  error={errors['indicators.macdSlow']}
                />
                <NumField
                  label="信号线（根）"
                  value={indicators.macdSignal}
                  onChange={(value) => onChange({ ...indicators, macdSignal: value })}
                  min={2}
                  error={errors['indicators.macdSignal']}
                />
              </div>
            </IndicatorBlock>

            <IndicatorBlock
              enabled={indicators.enableRsi}
              onToggle={(value) => onChange({ ...indicators, enableRsi: value })}
              label="RSI"
              hint="相对强弱"
            >
              <PeriodListField
                label="RSI 周期（根）"
                values={indicators.rsiPeriods}
                onChange={(values) => onChange({ ...indicators, rsiPeriods: values })}
                hint="逗号分隔，例如 7, 14"
              />
            </IndicatorBlock>

            <IndicatorBlock
              enabled={indicators.enableAtr}
              onToggle={(value) => onChange({ ...indicators, enableAtr: value })}
              label="ATR"
              hint="真实波幅（止损定位用）"
            >
              <PeriodListField
                label="ATR 周期（根）"
                values={indicators.atrPeriods}
                onChange={(values) => onChange({ ...indicators, atrPeriods: values })}
                hint="逗号分隔，例如 14"
              />
            </IndicatorBlock>
          </div>
        </div>
      </Section>

      <Section title="衍生品数据" hint="这些内容会附加到每个候选交易对的提示词中。">
        <div className="md:col-span-2 xl:col-span-3">
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            <Toggle
              checked={indicators.enableVolume}
              onChange={(value) => onChange({ ...indicators, enableVolume: value })}
              label="成交量"
              hint="K线成交量相对其均值"
            />
            <Toggle
              checked={indicators.enableOi}
              onChange={(value) => onChange({ ...indicators, enableOi: value })}
              label="持仓量"
              hint="当前值以及 1h / 4h / 24h 变化"
            />
            <Toggle
              checked={indicators.enableFundingRate}
              onChange={(value) => onChange({ ...indicators, enableFundingRate: value })}
              label="资金费率"
              hint="当前费率与下次资金费时间"
            />
            <Toggle
              checked={indicators.enableQuantData}
              onChange={(value) => onChange({ ...indicators, enableQuantData: value })}
              label="主动买卖流（量化数据）"
              hint="主动买卖净流入，替代付费数据源"
            />
            <Toggle
              checked={indicators.enableOiRanking}
              onChange={(value) => onChange({ ...indicators, enableOiRanking: value })}
              label="横截面持仓量排名"
              hint="覆盖全部币种池的排名表"
            />
          </div>
        </div>
      </Section>
    </div>
  );
}
