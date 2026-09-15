/**
 * 风控、保护与提示词。
 *
 * 排版上只有一条主张：**决定单笔亏损上限的那几个数字要最大、最靠前**。
 * 杠杆、仓位、强制止损、盈亏比直接决定账户能亏多少；K线根数、指标周期只影响
 * 模型看得多清楚。它们不该长得一样大，更不该混在一起。
 */
import type { ReactNode } from 'react';
import type { StrategyConfig } from '@aq/shared';
import { Badge, Field, TextArea, TextInput, Toggle, cn } from './ui';
import { FieldError, NumField, Section } from './StrategyFieldKit';

/* -------------------------------------------------------------------------- */
/*  Risk control                                                               */
/* -------------------------------------------------------------------------- */

/** 一组风控参数的卡片。底色比 Section 更亮，读起来是"浮在上面"的重点区。 */
function RiskCell({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-base-700 bg-base-850/80 p-3">
      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-lo">{title}</div>
      {hint && <p className="mt-1 text-xs leading-relaxed text-ink-faint">{hint}</p>}
      <div className="mt-2.5 space-y-2.5">{children}</div>
    </div>
  );
}

/**
 * 风控限制。
 *
 * 字段顺序被重排过：杠杆 → 仓位 → 止损 → 盈亏比 → 置信度。
 * 原来的顺序是 schema 的声明顺序，`最大同时持仓数` 排在最前、`最小仓位规模`
 * 夹在中间，用起来要来回找。**字段本身一个没增没减，提交的内容完全一致。**
 *
 * `[&_input]:text-lg` 把这一整块的输入框抬大一档：这是全表单唯一一处数字直接等于钱的区域。
 */
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
  const unprotected = !risk.requireStopLoss;

  return (
    <Section
      title="核心风控"
      hint="模型给出决策后由代码强制执行 —— 模型无法覆盖这些限制。"
      right={
        <Badge tone={unprotected ? 'down' : 'up'}>
          {unprotected ? '未强制止损' : '强制止损已开启'}
        </Badge>
      }
    >
      <div className="md:col-span-2 xl:col-span-3">
        <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2 3xl:grid-cols-4 [&_input]:py-2.5 [&_input]:text-lg">
          <RiskCell title="杠杆上限（倍）" hint="模型想要更高杠杆时会被压到这里，而不是拒绝整笔交易。">
            <NumField
              label="默认杠杆（倍）"
              value={risk.defaultLeverage}
              onChange={(v) => onChange({ ...risk, defaultLeverage: v })}
              min={1}
              max={125}
              hint="模型未给出时使用"
              error={errors['riskControl.defaultLeverage']}
            />
            <NumField
              label="BTC/ETH 杠杆上限（倍）"
              value={risk.btcEthMaxLeverage}
              onChange={(v) => onChange({ ...risk, btcEthMaxLeverage: v })}
              min={1}
              max={125}
              error={errors['riskControl.btcEthMaxLeverage']}
            />
            <NumField
              label="山寨币杠杆上限（倍）"
              value={risk.altcoinMaxLeverage}
              onChange={(v) => onChange({ ...risk, altcoinMaxLeverage: v })}
              min={1}
              max={125}
              error={errors['riskControl.altcoinMaxLeverage']}
            />
          </RiskCell>

          <RiskCell title="最大仓位（倍权益）" hint="名义价值 ÷ 账户权益。1 表示最多用一倍权益开仓。">
            <NumField
              label="BTC/ETH 仓位上限（倍权益）"
              value={risk.btcEthMaxPositionValueRatio}
              onChange={(v) => onChange({ ...risk, btcEthMaxPositionValueRatio: v })}
              step={0.5}
              min={0.01}
              max={50}
              error={errors['riskControl.btcEthMaxPositionValueRatio']}
            />
            <NumField
              label="山寨币仓位上限（倍权益）"
              value={risk.altcoinMaxPositionValueRatio}
              onChange={(v) => onChange({ ...risk, altcoinMaxPositionValueRatio: v })}
              step={0.5}
              min={0.01}
              max={50}
              error={errors['riskControl.altcoinMaxPositionValueRatio']}
            />
            <NumField
              label="同时持仓上限（个）"
              value={risk.maxPositions}
              onChange={(v) => onChange({ ...risk, maxPositions: v })}
              min={1}
              max={20}
              error={errors['riskControl.maxPositions']}
            />
            <NumField
              label="保证金占用上限（%）"
              value={risk.maxMarginUsage}
              onChange={(v) => onChange({ ...risk, maxMarginUsage: v })}
              min={1}
              max={100}
              error={errors['riskControl.maxMarginUsage']}
            />
            <NumField
              label="最小仓位规模（USDT）"
              value={risk.minPositionSize}
              onChange={(v) => onChange({ ...risk, minPositionSize: v })}
              min={1}
              hint="低于该值的订单会被拒绝，不会向上取整"
              error={errors['riskControl.minPositionSize']}
            />
          </RiskCell>

          <RiskCell title="强制止损 / 止盈（%）" hint="交易所侧挂单，即使程序挂掉也仍然有效。">
            <Toggle
              checked={risk.requireStopLoss}
              onChange={(v) => onChange({ ...risk, requireStopLoss: v })}
              label="每次开仓都要求交易所侧止损"
              hint="强烈建议开启：即使循环挂了，止损依然保护持仓。"
            />
            <NumField
              label="兜底止损（%）"
              value={risk.fallbackStopLossPercent}
              onChange={(v) => onChange({ ...risk, fallbackStopLossPercent: v })}
              step={0.1}
              min={0.05}
              max={50}
              hint="模型未给止损时使用"
              error={errors['riskControl.fallbackStopLossPercent']}
            />
            <Toggle
              checked={risk.requireTakeProfit}
              onChange={(v) => onChange({ ...risk, requireTakeProfit: v })}
              label="每次开仓都要求交易所侧止盈"
            />
            <NumField
              label="兜底止盈（%）"
              value={risk.fallbackTakeProfitPercent}
              onChange={(v) => onChange({ ...risk, fallbackTakeProfitPercent: v })}
              step={0.1}
              min={0.05}
              max={200}
              hint="模型未给止盈目标时使用"
              error={errors['riskControl.fallbackTakeProfitPercent']}
            />
          </RiskCell>

          <RiskCell title="最小盈亏比与置信度" hint="低于门槛的提案会被整条拒掉，而不是打折执行。">
            <NumField
              label="最小盈亏比（1:N）"
              value={risk.minRiskRewardRatio}
              onChange={(v) => onChange({ ...risk, minRiskRewardRatio: v })}
              step={0.1}
              min={0}
              max={50}
              hint="止盈距离至少是止损距离的 N 倍"
              error={errors['riskControl.minRiskRewardRatio']}
            />
            <NumField
              label="最小置信度（0–100）"
              value={risk.minConfidence}
              onChange={(v) => onChange({ ...risk, minConfidence: v })}
              min={0}
              max={100}
              hint="模型自评的把握程度下限"
              error={errors['riskControl.minConfidence']}
            />
          </RiskCell>
        </div>
      </div>

      {unprotected && (
        <div className="md:col-span-2 xl:col-span-3">
          <div className="rounded-md border border-down/50 bg-down/10 px-3 py-2 text-xs leading-relaxed text-down">
            未强制止损：模型可以开出一个没有交易所侧止损的仓位。一旦决策循环中断，这个仓位将无人看管。
          </div>
        </div>
      )}
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
          hint="浮盈超过该值后守卫才开始盯"
          error={errors['drawdownGuard.activationPercent']}
        />
        <NumField
          label="回吐比例（0–1）"
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
        <NumField
          label="最短持仓（分钟）"
          value={throttle.minHoldMinutes}
          onChange={(v) => onChange({ throttle: { ...throttle, minHoldMinutes: v } })}
          min={0}
          max={1440}
          error={errors['throttle.minHoldMinutes']}
        />
        <NumField
          label="再次开仓冷却（分钟）"
          value={throttle.reentryCooldownMinutes}
          onChange={(v) => onChange({ throttle: { ...throttle, reentryCooldownMinutes: v } })}
          min={0}
          max={1440}
          hint="平仓后按交易对计算"
          error={errors['throttle.reentryCooldownMinutes']}
        />
        <NumField
          label="每周期最大开仓数（个）"
          value={throttle.maxEntriesPerCycle}
          onChange={(v) => onChange({ throttle: { ...throttle, maxEntriesPerCycle: v } })}
          min={1}
          max={20}
          error={errors['throttle.maxEntriesPerCycle']}
        />
        <NumField
          label="每小时最大开仓数（个）"
          value={throttle.maxEntriesPerHour}
          onChange={(v) => onChange({ throttle: { ...throttle, maxEntriesPerHour: v } })}
          min={1}
          max={60}
          error={errors['throttle.maxEntriesPerHour']}
        />
      </Section>

      <Section
        title="熔断器"
        hint="最后一道防线：停止新开仓并降低模型调用频率。触发后只能等人工处理。"
        right={<Badge tone="warn">风控触发</Badge>}
      >
        <NumField
          label="单日最大亏损（%）"
          value={circuitBreaker.maxDailyLossPercent}
          onChange={(v) => onChange({ circuitBreaker: { ...circuitBreaker, maxDailyLossPercent: v } })}
          step={0.5}
          min={0}
          max={100}
          error={errors['circuitBreaker.maxDailyLossPercent']}
        />
        <NumField
          label="最大总回撤（%）"
          value={circuitBreaker.maxTotalDrawdownPercent}
          onChange={(v) => onChange({ circuitBreaker: { ...circuitBreaker, maxTotalDrawdownPercent: v } })}
          step={0.5}
          min={0}
          max={100}
          error={errors['circuitBreaker.maxTotalDrawdownPercent']}
        />
        <NumField
          label="连续失败 N 次后进入安全模式（次）"
          value={circuitBreaker.safeModeAfterFailures}
          onChange={(v) => onChange({ circuitBreaker: { ...circuitBreaker, safeModeAfterFailures: v } })}
          min={1}
          max={50}
          error={errors['circuitBreaker.safeModeAfterFailures']}
        />
        <NumField
          label="安全模式探测间隔（周期）"
          value={circuitBreaker.safeModeProbeCycles}
          onChange={(v) => onChange({ circuitBreaker: { ...circuitBreaker, safeModeProbeCycles: v } })}
          min={1}
          max={100}
          error={errors['circuitBreaker.safeModeProbeCycles']}
        />
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

/** 字符数越接近上限越刺眼 —— 提交时会因为超长直接被 schema 拒掉。 */
function CharCount({ used, max }: { used: number; max: number }) {
  const near = used > max * 0.9;
  return (
    <span className={cn('num text-xs', near ? 'text-warn' : 'text-ink-faint')}>
      {used.toLocaleString('en-US')} / {max.toLocaleString('en-US')} 字符
    </span>
  );
}

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
  const emptyCount = PROMPT_FIELDS.filter((field) => !promptSections[field.key].trim()).length;

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2.5 text-xs leading-relaxed text-ink-mid">
        提示词段落<span className="font-semibold text-ink-hi">就是</span>策略本身。上方的数字限定模型可以做什么，
        而这些文字决定它想做什么。这里的内容会原样嵌入每个周期的系统提示词，并可在决策审计链中查看。
        {emptyCount > 0 && (
          <span className="mt-1 block font-semibold text-warn">
            有 {emptyCount} 个段落是空的 —— 模型在这些维度上不会收到任何指令。
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {PROMPT_FIELDS.map((field) => {
          const value = promptSections[field.key];
          return (
            <div key={field.key} className="min-w-0 rounded-md border border-base-750 bg-base-850/40 p-3">
              <Field label={field.label} hint={field.hint}>
                <TextArea
                  rows={9}
                  value={value}
                  onChange={(event) =>
                    onChange({ promptSections: { ...promptSections, [field.key]: event.target.value } })
                  }
                  placeholder={`描述${field.label}…`}
                />
              </Field>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <FieldError message={errors[`promptSections.${field.key}`]} />
                {!value.trim() && <span className="text-xs text-warn">段落为空</span>}
                <CharCount used={value.length} max={20_000} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-md border border-base-750 bg-base-850/40 p-3">
        <Field label="自定义提示词（原样附加）" hint="你希望在结构化段落之后重复出现的硬性规则。">
          <TextArea
            rows={6}
            value={customPrompt}
            onChange={(event) => onChange({ customPrompt: event.target.value })}
            placeholder="例如：绝不向亏损中的持仓加仓。没有充分理由，不在资金费结算时点前交易。"
          />
        </Field>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <FieldError message={errors.customPrompt} />
          <CharCount used={customPrompt.length} max={20_000} />
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
        <TextInput
          value={config.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="例如：稳健多因子"
          maxLength={80}
        />
      </Field>

      <div className="md:col-span-2">
        <Field label="描述" hint="策略列表里的一句话说明。">
          <TextInput
            value={config.description}
            onChange={(event) => onChange({ description: event.target.value })}
            placeholder="这套策略在什么行情下该出手？"
            maxLength={500}
          />
        </Field>
        <div className="mt-1 flex items-center justify-between gap-2">
          <FieldError message={errors.description} />
          <CharCount used={config.description.length} max={500} />
        </div>
      </div>

      <div className="md:col-span-2 xl:col-span-3">
        <span className="field-label">交易模式</span>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
          {MODES.map((mode) => {
            const active = config.tradingMode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                aria-pressed={active}
                onClick={() => onChange({ tradingMode: mode.id })}
                className={cn(
                  'rounded-md border px-2.5 py-2 text-left transition',
                  active
                    ? 'border-accent/70 bg-accent/10 shadow-[inset_2px_0_0_0_theme(colors.accent)]'
                    : 'border-base-700 bg-base-850 hover:border-base-600 hover:bg-base-800',
                )}
              >
                <div className={cn('text-base font-semibold', active ? 'text-accent' : 'text-ink-hi')}>{mode.label}</div>
                <div className="mt-0.5 text-xs text-ink-lo">{mode.hint}</div>
              </button>
            );
          })}
        </div>
      </div>
    </Section>
  );
}
