import {
  DEFAULT_MANAGED_RISK_PROFILE,
  MANAGED_RISK_PROFILES,
  MANAGED_RISK_PROFILE_IDS,
  type ManagedRiskProfileId,
} from '@aq/shared';
import { Flame, Scale, Shield } from 'lucide-react';
import { cn } from './ui';

const PROFILE_ICON: Record<ManagedRiskProfileId, typeof Shield> = {
  conservative: Shield,
  balanced: Scale,
  aggressive: Flame,
};

/**
 * 深浅主题均满足 WCAG AA（≥ 4.5:1）的三档色彩体系。
 * 统一使用 `[[data-skin='light']_&]:...` 适配 Quill 浅色皮肤。
 */
const PROFILE_BADGE_TONE: Record<ManagedRiskProfileId, string> = {
  conservative:
    "border-emerald-500/35 bg-emerald-500/10 text-emerald-300 [[data-skin='light']_&]:border-emerald-700/30 [[data-skin='light']_&]:bg-emerald-500/12 [[data-skin='light']_&]:text-emerald-800",
  balanced:
    "border-sky-500/35 bg-sky-500/10 text-sky-300 [[data-skin='light']_&]:border-sky-700/30 [[data-skin='light']_&]:bg-sky-500/12 [[data-skin='light']_&]:text-sky-800",
  aggressive:
    "border-amber-500/40 bg-amber-500/12 text-amber-300 [[data-skin='light']_&]:border-amber-700/35 [[data-skin='light']_&]:bg-amber-500/15 [[data-skin='light']_&]:text-amber-800",
};

const PROFILE_SEGMENT_ACTIVE: Record<ManagedRiskProfileId, string> = {
  conservative:
    "border-emerald-500/50 bg-emerald-500/18 text-emerald-200 [[data-skin='light']_&]:border-emerald-700/45 [[data-skin='light']_&]:bg-emerald-500/15 [[data-skin='light']_&]:text-emerald-900",
  balanced:
    "border-sky-500/50 bg-sky-500/18 text-sky-200 [[data-skin='light']_&]:border-sky-700/45 [[data-skin='light']_&]:bg-sky-500/15 [[data-skin='light']_&]:text-sky-900",
  aggressive:
    "border-amber-500/55 bg-amber-500/20 text-amber-200 [[data-skin='light']_&]:border-amber-700/50 [[data-skin='light']_&]:bg-amber-500/18 [[data-skin='light']_&]:text-amber-900",
};

export function managedRiskProfileTitle(profile: ManagedRiskProfileId): string {
  const spec = MANAGED_RISK_PROFILES[profile];
  return (
    `风险护栏 · ${spec.label}档：BTC/ETH ≤ ${spec.btcEthMaxLeverage}x · 山寨 ≤ ${spec.altcoinMaxLeverage}x · ` +
    `保证金 ≤ ${spec.maxMarginUsage}% · 日亏熔断 ${spec.maxDailyLossPercent}% / 总回撤 ${spec.maxTotalDrawdownPercent}%。` +
    '每单具体杠杆由模型在护栏与交易所真实上限内自主决策。'
  );
}

/** 列表页 / 总览页行内展示的紧凑风险档位徽章（仅智能托管模式渲染）。 */
export function ManagedRiskBadge({
  profile,
  className,
}: {
  profile: ManagedRiskProfileId | null | undefined;
  className?: string;
}) {
  const id = profile ?? DEFAULT_MANAGED_RISK_PROFILE;
  const spec = MANAGED_RISK_PROFILES[id];
  const Icon = PROFILE_ICON[id];
  return (
    <span
      title={managedRiskProfileTitle(id)}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none',
        PROFILE_BADGE_TONE[id],
        className,
      )}
    >
      <Icon aria-hidden className="h-3 w-3 shrink-0" />
      <span>{spec.shortLabel}</span>
      <span className="num opacity-85">
        {spec.btcEthMaxLeverage}/{spec.altcoinMaxLeverage}x
      </span>
    </span>
  );
}

/**
 * 机器人详情页外显的在线档位切换条（无需打开设置弹窗即可查看并一键切换，运行中立即热生效）。
 */
export function ManagedRiskInlineSwitcher({
  value,
  busy = false,
  disabled = false,
  feedback,
  onChange,
}: {
  value: ManagedRiskProfileId | null | undefined;
  busy?: boolean;
  disabled?: boolean;
  feedback?: string | null;
  onChange: (next: ManagedRiskProfileId) => void;
}) {
  const current = value ?? DEFAULT_MANAGED_RISK_PROFILE;
  const spec = MANAGED_RISK_PROFILES[current];
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg border border-base-750 bg-base-900/60 px-2.5 py-1.5">
      <span className="text-xs font-medium text-ink-lo">风险护栏</span>
      <div
        role="group"
        aria-label="智能托管风险护栏档位"
        className="inline-flex items-center gap-1 rounded-md border border-base-750 bg-base-950/60 p-0.5"
      >
        {MANAGED_RISK_PROFILE_IDS.map((id) => {
          const item = MANAGED_RISK_PROFILES[id];
          const Icon = PROFILE_ICON[id];
          const active = current === id;
          return (
            <button
              key={id}
              type="button"
              disabled={disabled || busy}
              aria-pressed={active}
              title={managedRiskProfileTitle(id)}
              onClick={() => {
                if (!active) onChange(id);
              }}
              className={cn(
                'inline-flex h-6 items-center gap-1 whitespace-nowrap rounded border px-2 text-xs font-medium transition',
                active
                  ? PROFILE_SEGMENT_ACTIVE[id]
                  : 'border-transparent text-ink-lo hover:bg-base-800/70 hover:text-ink-hi',
                (disabled || busy) && 'cursor-not-allowed opacity-60',
              )}
            >
              <Icon aria-hidden className="h-3 w-3 shrink-0" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
      <span
        className="num text-xs text-ink-lo"
        title="上限护栏，每单实际杠杆由模型结合止损距离、波动率与交易所账户上限自主决策"
      >
        主流 ≤ <strong className="font-semibold text-ink-hi">{spec.btcEthMaxLeverage}x</strong> · 山寨 ≤{' '}
        <strong className="font-semibold text-ink-hi">{spec.altcoinMaxLeverage}x</strong> · 保证金 ≤{' '}
        <strong className="font-semibold text-ink-hi">{spec.maxMarginUsage}%</strong> · 日亏熔断{' '}
        <strong className="font-semibold text-ink-hi">{spec.maxDailyLossPercent}%</strong>
      </span>
      {busy ? (
        <span className="text-xs text-accent">切换中…</span>
      ) : feedback ? (
        <span className="text-xs text-up">{feedback}</span>
      ) : null}
    </div>
  );
}

/** 新建 / 编辑弹窗里使用的 3 档卡片选择器。 */
export function ManagedRiskProfileCards({
  value,
  onChange,
  disabled = false,
}: {
  value: ManagedRiskProfileId;
  onChange: (next: ManagedRiskProfileId) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {MANAGED_RISK_PROFILE_IDS.map((id) => {
        const spec = MANAGED_RISK_PROFILES[id];
        const Icon = PROFILE_ICON[id];
        const active = value === id;
        return (
          <label
            key={id}
            title={managedRiskProfileTitle(id)}
            className={cn(
              'relative flex cursor-pointer flex-col gap-1 rounded-lg border p-2.5 transition',
              active
                ? 'border-accent/70 bg-accent/5'
                : 'border-base-700 bg-base-850 hover:border-base-600',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              type="radio"
              name="managed-risk-profile"
              className="sr-only"
              checked={active}
              disabled={disabled}
              onChange={() => onChange(id)}
            />
            <span className="flex items-center justify-between gap-1.5">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-hi">
                <Icon aria-hidden className="h-3.5 w-3.5 text-ink-lo" />
                {spec.label}
                {id === DEFAULT_MANAGED_RISK_PROFILE && (
                  <span className="rounded bg-accent/15 px-1 py-0.5 text-[10px] font-medium text-accent">
                    默认
                  </span>
                )}
              </span>
              <span
                aria-hidden
                className={cn(
                  'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                  active ? 'border-accent' : 'border-base-600',
                )}
              >
                {active && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
              </span>
            </span>
            <span className="num text-xs font-medium text-ink-mid">
              主流 ≤ {spec.btcEthMaxLeverage}x · 山寨 ≤ {spec.altcoinMaxLeverage}x
            </span>
            <span className="num text-[11px] text-ink-faint">
              保证金 ≤ {spec.maxMarginUsage}% · 日亏 {spec.maxDailyLossPercent}%
            </span>
          </label>
        );
      })}
    </div>
  );
}
