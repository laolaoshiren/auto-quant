import type { CoinPoolRank, CoinSourceType, StrategyConfig, Timeframe } from '@aq/shared';
import { TIMEFRAMES } from '@aq/shared';
import { Field, NumberInput, Select, TextInput, Toggle } from './ui';
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
    <Section title="币种来源" hint="每个周期哪些交易对会成为候选。">
      <div className="md:col-span-2 xl:col-span-3">
        <span className="field-label">币种池模式</span>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
          {SOURCE_TYPES.map((type) => (
            <button
              key={type.id}
              type="button"
              onClick={() =>
                onChange({
                  ...source,
                  sourceType: type.id,
                  staticCoins: source.staticCoins,
                  useCoinPool: type.id === 'coinpool' || type.id === 'mixed',
                  useOITop: type.id === 'oi_top' || type.id === 'mixed',
                })
              }
              className={`rounded border px-2 py-1.5 text-left transition ${
                source.sourceType === type.id
                  ? 'border-accent/70 bg-accent/10'
                  : 'border-base-700 bg-base-850 hover:border-base-600'
              }`}
            >
              <div className="text-xs font-semibold text-ink-hi">{type.label}</div>
              <div className="text-2xs leading-snug text-ink-faint">{type.hint}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="md:col-span-2 xl:col-span-3">
        <Field
          label={`静态币种列表（${source.staticCoins.length}）`}
          hint="逗号分隔，统一转为大写 — 例如 BTCUSDT、ETHUSDT、SOLUSDT。"
        >
          <TextInput
            className="num"
            value={source.staticCoins.join(', ')}
            onChange={(event) => {
              const coins = event.target.value
                .split(/[,\s]+/)
                .map((token) => token.trim().toUpperCase().replace(/[-_/]/g, ''))
                .filter(Boolean);
              onChange({ ...source, staticCoins: [...new Set(coins)] });
            }}
          />
        </Field>
        <FieldError message={errors['coinSource.staticCoins']} />
      </div>

      {usesPool && (
        <>
          <NumField
            label="币种池数量"
            value={source.coinPoolLimit}
            onChange={(value) => onChange({ ...source, coinPoolLimit: value })}
            min={1}
            max={200}
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
            label="持仓量领先数量"
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
          <div className="rounded border border-base-700 bg-base-850/50 px-2.5 py-1.5 text-2xs text-ink-lo">
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
      <Section title="K线与周期" hint="模型能看到的价位序列。">
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
          label="每周期K线数"
          value={indicators.kline.primaryCount}
          onChange={(value) => onChange({ ...indicators, kline: { ...indicators.kline, primaryCount: value } })}
          min={10}
          max={500}
          error={errors['indicators.kline.primaryCount']}
        />

        <div className="md:col-span-2 xl:col-span-3">
          <span className="field-label">已选周期（提示词中由旧到新）</span>
          <div className="flex flex-wrap gap-1">
            {TIMEFRAMES.map((timeframe) => {
              const active = indicators.kline.selectedTimeframes.includes(timeframe);
              return (
                <button
                  key={timeframe}
                  type="button"
                  onClick={() => toggleTimeframe(timeframe)}
                  className={`num rounded border px-2 py-0.5 text-2xs transition ${
                    active
                      ? 'border-accent/70 bg-accent/15 text-accent'
                      : 'border-base-700 bg-base-850 text-ink-lo hover:border-base-600'
                  }`}
                >
                  {timeframe}
                </button>
              );
            })}
          </div>
          <FieldError message={errors['indicators.kline.selectedTimeframes']} />
        </div>
      </Section>

      <Section title="指标周期" hint="仅计算并渲染已启用的指标。">
        <div className="space-y-2">
          <Toggle checked={indicators.enableEma} onChange={(value) => onChange({ ...indicators, enableEma: value })} label="EMA" />
          <PeriodListField
            label="EMA 周期"
            values={indicators.emaPeriods}
            onChange={(values) => onChange({ ...indicators, emaPeriods: values })}
          />
        </div>

        <div className="space-y-2">
          <Toggle checked={indicators.enableMacd} onChange={(value) => onChange({ ...indicators, enableMacd: value })} label="MACD" />
          <div className="grid grid-cols-3 gap-2">
            <NumField label="快线" value={indicators.macdFast} onChange={(value) => onChange({ ...indicators, macdFast: value })} min={2} />
            <NumField label="慢线" value={indicators.macdSlow} onChange={(value) => onChange({ ...indicators, macdSlow: value })} min={3} />
            <NumField
              label="信号线"
              value={indicators.macdSignal}
              onChange={(value) => onChange({ ...indicators, macdSignal: value })}
              min={2}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Toggle checked={indicators.enableRsi} onChange={(value) => onChange({ ...indicators, enableRsi: value })} label="RSI" />
          <PeriodListField
            label="RSI 周期"
            values={indicators.rsiPeriods}
            onChange={(values) => onChange({ ...indicators, rsiPeriods: values })}
          />
        </div>

        <div className="space-y-2">
          <Toggle checked={indicators.enableAtr} onChange={(value) => onChange({ ...indicators, enableAtr: value })} label="ATR" />
          <PeriodListField
            label="ATR 周期"
            values={indicators.atrPeriods}
            onChange={(values) => onChange({ ...indicators, atrPeriods: values })}
          />
        </div>
      </Section>

      <Section title="衍生品数据" hint="这些内容会附加到每个候选交易对的提示词中。">
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
      </Section>
    </div>
  );
}
