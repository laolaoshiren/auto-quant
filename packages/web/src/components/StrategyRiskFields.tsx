import type { StrategyConfig } from '@aq/shared';
import { Badge, Field, TextArea, TextInput, Toggle } from './ui';
import { FieldError, NumField, Section } from './StrategyFieldKit';

/* -------------------------------------------------------------------------- */
/*  Risk control                                                               */
/* -------------------------------------------------------------------------- */

export function RiskSection({
  config,
  onChange,
  errors,
}: {
  config: StrategyConfig;
  onChange: (next: StrategyConfig['riskControl']) => void;
  errors: Record<string, string>;
}) {
  const risk = config.riskControl;
  return (
    <Section title="风控" hint="模型给出决策后由代码强制执行 — 模型无法覆盖这些限制。">
      <NumField label="最大同时持仓数" value={risk.maxPositions} onChange={(v) => onChange({ ...risk, maxPositions: v })} min={1} max={20} error={errors['riskControl.maxPositions']} />
      <NumField label="BTC/ETH 最大杠杆" value={risk.btcEthMaxLeverage} onChange={(v) => onChange({ ...risk, btcEthMaxLeverage: v })} min={1} max={125} error={errors['riskControl.btcEthMaxLeverage']} />
      <NumField label="山寨币最大杠杆" value={risk.altcoinMaxLeverage} onChange={(v) => onChange({ ...risk, altcoinMaxLeverage: v })} min={1} max={125} error={errors['riskControl.altcoinMaxLeverage']} />
      <NumField label="默认杠杆" value={risk.defaultLeverage} onChange={(v) => onChange({ ...risk, defaultLeverage: v })} min={1} max={125} hint="模型未给出时使用" error={errors['riskControl.defaultLeverage']} />
      <NumField label="BTC/ETH 最大仓位比例" value={risk.btcEthMaxPositionValueRatio} onChange={(v) => onChange({ ...risk, btcEthMaxPositionValueRatio: v })} step={0.5} min={0.01} max={50} hint="名义价值 ÷ 权益" error={errors['riskControl.btcEthMaxPositionValueRatio']} />
      <NumField label="山寨币最大仓位比例" value={risk.altcoinMaxPositionValueRatio} onChange={(v) => onChange({ ...risk, altcoinMaxPositionValueRatio: v })} step={0.5} min={0.01} max={50} hint="名义价值 ÷ 权益" error={errors['riskControl.altcoinMaxPositionValueRatio']} />
      <NumField label="最大保证金占用（%）" value={risk.maxMarginUsage} onChange={(v) => onChange({ ...risk, maxMarginUsage: v })} min={1} max={100} error={errors['riskControl.maxMarginUsage']} />
      <NumField label="最小仓位规模（USDT）" value={risk.minPositionSize} onChange={(v) => onChange({ ...risk, minPositionSize: v })} min={1} hint="低于该值的订单会被拒绝，不会向上取整" error={errors['riskControl.minPositionSize']} />
      <NumField label="最小盈亏比" value={risk.minRiskRewardRatio} onChange={(v) => onChange({ ...risk, minRiskRewardRatio: v })} step={0.1} min={0} max={50} error={errors['riskControl.minRiskRewardRatio']} />
      <NumField label="最小置信度（0-100）" value={risk.minConfidence} onChange={(v) => onChange({ ...risk, minConfidence: v })} min={0} max={100} error={errors['riskControl.minConfidence']} />
      <NumField label="兜底止损（%）" value={risk.fallbackStopLossPercent} onChange={(v) => onChange({ ...risk, fallbackStopLossPercent: v })} step={0.1} min={0.05} max={50} hint="模型未给止损时使用" error={errors['riskControl.fallbackStopLossPercent']} />
      <NumField label="兜底止盈（%）" value={risk.fallbackTakeProfitPercent} onChange={(v) => onChange({ ...risk, fallbackTakeProfitPercent: v })} step={0.1} min={0.05} max={200} hint="模型未给止盈目标时使用" error={errors['riskControl.fallbackTakeProfitPercent']} />

      <div className="space-y-2 md:col-span-2 xl:col-span-3">
        <Toggle
          checked={risk.requireStopLoss}
          onChange={(v) => onChange({ ...risk, requireStopLoss: v })}
          label="每次开仓都要求交易所侧止损"
          hint="强烈建议开启：即使循环挂了，止损依然保护持仓。"
        />
        <Toggle
          checked={risk.requireTakeProfit}
          onChange={(v) => onChange({ ...risk, requireTakeProfit: v })}
          label="每次开仓都要求交易所侧止盈"
        />
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Drawdown guard · throttle · circuit breakers                               */
/* -------------------------------------------------------------------------- */

export function ProtectionSection({
  config,
  onChange,
  errors,
}: {
  config: StrategyConfig;
  onChange: (patch: Partial<Pick<StrategyConfig, 'drawdownGuard' | 'throttle' | 'circuitBreaker'>>) => void;
  errors: Record<string, string>;
}) {
  const { drawdownGuard, throttle, circuitBreaker } = config;

  return (
    <div className="space-y-3">
      <Section
        title="回撤守卫"
        hint="保护已有浮盈：一笔盈利单回吐部分峰值后被平掉。"
        right={<Badge tone={drawdownGuard.enabled ? 'up' : 'muted'}>{drawdownGuard.enabled ? '已启用' : '关闭'}</Badge>}
      >
        <div className="md:col-span-2 xl:col-span-3">
          <Toggle
            checked={drawdownGuard.enabled}
            onChange={(v) => onChange({ drawdownGuard: { ...drawdownGuard, enabled: v } })}
            label="启用浮盈回吐守卫"
          />
        </div>
        <NumField
          label="触发阈值（峰值浮盈 %）"
          value={drawdownGuard.activationPercent}
          onChange={(v) => onChange({ drawdownGuard: { ...drawdownGuard, activationPercent: v } })}
          step={0.1}
          min={0}
          max={1000}
          error={errors['drawdownGuard.activationPercent']}
        />
        <NumField
          label="回吐比例（0-1）"
          value={drawdownGuard.givebackRatio}
          onChange={(v) => onChange({ drawdownGuard: { ...drawdownGuard, givebackRatio: v } })}
          step={0.05}
          min={0.05}
          max={1}
          hint="0.5 表示峰值浮盈回吐一半后平仓"
          error={errors['drawdownGuard.givebackRatio']}
        />
      </Section>

      <Section title="限流" hint="限制模型过度交易的频率上限。">
        <NumField label="最短持仓（分钟）" value={throttle.minHoldMinutes} onChange={(v) => onChange({ throttle: { ...throttle, minHoldMinutes: v } })} min={0} max={1440} error={errors['throttle.minHoldMinutes']} />
        <NumField label="再次开仓冷却（分钟）" value={throttle.reentryCooldownMinutes} onChange={(v) => onChange({ throttle: { ...throttle, reentryCooldownMinutes: v } })} min={0} max={1440} hint="平仓后按交易对计算" error={errors['throttle.reentryCooldownMinutes']} />
        <NumField label="每周期最大开仓数" value={throttle.maxEntriesPerCycle} onChange={(v) => onChange({ throttle: { ...throttle, maxEntriesPerCycle: v } })} min={1} max={20} error={errors['throttle.maxEntriesPerCycle']} />
        <NumField label="每小时最大开仓数" value={throttle.maxEntriesPerHour} onChange={(v) => onChange({ throttle: { ...throttle, maxEntriesPerHour: v } })} min={1} max={60} error={errors['throttle.maxEntriesPerHour']} />
      </Section>

      <Section title="熔断器" hint="最后一道防线：停止新开仓并降低模型调用频率。">
        <NumField label="单日最大亏损（%）" value={circuitBreaker.maxDailyLossPercent} onChange={(v) => onChange({ circuitBreaker: { ...circuitBreaker, maxDailyLossPercent: v } })} step={0.5} min={0} max={100} error={errors['circuitBreaker.maxDailyLossPercent']} />
        <NumField label="最大总回撤（%）" value={circuitBreaker.maxTotalDrawdownPercent} onChange={(v) => onChange({ circuitBreaker: { ...circuitBreaker, maxTotalDrawdownPercent: v } })} step={0.5} min={0} max={100} error={errors['circuitBreaker.maxTotalDrawdownPercent']} />
        <NumField label="连续失败 N 次后进入安全模式" value={circuitBreaker.safeModeAfterFailures} onChange={(v) => onChange({ circuitBreaker: { ...circuitBreaker, safeModeAfterFailures: v } })} min={1} max={50} error={errors['circuitBreaker.safeModeAfterFailures']} />
        <NumField label="安全模式探测间隔（周期）" value={circuitBreaker.safeModeProbeCycles} onChange={(v) => onChange({ circuitBreaker: { ...circuitBreaker, safeModeProbeCycles: v } })} min={1} max={100} error={errors['circuitBreaker.safeModeProbeCycles']} />
      </Section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Prompts — the strategy itself                                              */
/* -------------------------------------------------------------------------- */

const PROMPT_FIELDS: Array<{ key: keyof StrategyConfig['promptSections']; label: string; hint: string }> = [
  { key: 'roleDefinition', label: '角色定义', hint: '模型是谁，以及它优化的目标。' },
  { key: 'tradingFrequency', label: '交易频率', hint: '它该多频繁出手，以及空仓等待是否可接受。' },
  { key: 'entryStandards', label: '入场标准', hint: '一个机会必须满足什么条件才可以交易。' },
  { key: 'decisionProcess', label: '决策流程', hint: '模型每个周期必须遵循的分步方法。' },
];

export function PromptSection({
  config,
  onChange,
  errors,
}: {
  config: StrategyConfig;
  onChange: (patch: Partial<Pick<StrategyConfig, 'promptSections' | 'customPrompt'>>) => void;
  errors: Record<string, string>;
}) {
  const { promptSections, customPrompt } = config;

  return (
    <div className="space-y-3">
      <div className="rounded border border-accent/30 bg-accent/5 px-3 py-2 text-2xs leading-relaxed text-ink-mid">
        提示词段落<span className="font-semibold text-ink-hi">就是</span>策略本身。上方的数字限定模型可以做什么，
        而这些文字决定它想做什么。这里的内容会原样嵌入每个周期的系统提示词，并可在决策审计链中查看。
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {PROMPT_FIELDS.map((field) => (
          <div key={field.key}>
            <Field label={field.label} hint={field.hint}>
              <TextArea
                rows={9}
                value={promptSections[field.key]}
                onChange={(event) =>
                  onChange({ promptSections: { ...promptSections, [field.key]: event.target.value } })
                }
                placeholder={`描述${field.label}…`}
              />
            </Field>
            <div className="mt-0.5 flex items-center justify-between">
              <FieldError message={errors[`promptSections.${field.key}`]} />
              <span className="num text-2xs text-ink-faint">{promptSections[field.key].length} 字符</span>
            </div>
          </div>
        ))}
      </div>

      <div>
        <Field label="自定义提示词（原样附加）" hint="你希望在结构化段落之后重复出现的硬性规则。">
          <TextArea
            rows={6}
            value={customPrompt}
            onChange={(event) => onChange({ customPrompt: event.target.value })}
            placeholder="例如：绝不向亏损中的持仓加仓。没有充分理由，不在资金费结算时点前交易。"
          />
        </Field>
        <div className="mt-0.5 flex items-center justify-between">
          <FieldError message={errors.customPrompt} />
          <span className="num text-2xs text-ink-faint">{customPrompt.length} / 20000 字符</span>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Identity                                                                   */
/* -------------------------------------------------------------------------- */

const MODES: Array<{ id: StrategyConfig['tradingMode']; label: string; hint: string }> = [
  { id: 'conservative', label: '保守', hint: '更少但质量更高的交易' },
  { id: 'aggressive', label: '激进', hint: '突破为主，换手更快' },
  { id: 'scalping', label: '短线', hint: '分钟级动量' },
];

export function StrategyHeaderSection({
  config,
  onChange,
  errors,
}: {
  config: StrategyConfig;
  onChange: (patch: Partial<Pick<StrategyConfig, 'name' | 'description' | 'tradingMode'>>) => void;
  errors: Record<string, string>;
}) {
  return (
    <Section title="标识" hint="该策略在控制台与每条审计记录中的名称。">
      <Field label="策略名称" error={errors.name}>
        <TextInput value={config.name} onChange={(event) => onChange({ name: event.target.value })} />
      </Field>

      <div className="md:col-span-2">
        <Field label="描述" hint="策略列表里的一句话说明。">
          <TextInput value={config.description} onChange={(event) => onChange({ description: event.target.value })} />
        </Field>
        <FieldError message={errors.description} />
      </div>

      <div className="md:col-span-2 xl:col-span-3">
        <span className="field-label">交易模式</span>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => onChange({ tradingMode: mode.id })}
              className={`rounded border px-2 py-1.5 text-left transition ${
                config.tradingMode === mode.id
                  ? 'border-accent/70 bg-accent/10'
                  : 'border-base-700 bg-base-850 hover:border-base-600'
              }`}
            >
              <div className="text-xs font-semibold text-ink-hi">{mode.label}</div>
              <div className="text-2xs text-ink-faint">{mode.hint}</div>
            </button>
          ))}
        </div>
      </div>
    </Section>
  );
}
