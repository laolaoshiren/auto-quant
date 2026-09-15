/**
 * 策略表单的共用骨架。
 *
 * 三个组件同时被 `StrategyFields`（币种 / 指标）与 `StrategyRiskFields`（风控 / 熔断 / 提示词）使用，
 * 所以 **prop 签名是公开 API**：只改外观，不加不减字段。
 *
 * 一处刻意的分工：`NumField` / `PeriodListField` 自己渲染下方那行说明和错误，
 * 而不是交给 `Field` —— 因为 `Field` 的 label 是字符串，塞不进「范围 1–125」这种右对齐的元信息。
 */
import { useState, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Field, NumberInput, TextInput } from './ui';

/* -------------------------------------------------------------------------- */
/*  Section                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 一组字段的容器。
 *
 * 内容区固定 `md:2 列 / xl:3 列`：调用方会用 `md:col-span-2 xl:col-span-3`
 * 把整行字段（币种列表、开关组）铺满，列数变了那些跨列就会错位。
 */
export function Section({
  title,
  hint,
  children,
  right,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-base-750 bg-base-850/40">
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-b border-base-800 bg-base-850/70 px-3 py-2.5 sm:px-4">
        <div className="min-w-0">
          <h3 className="text-md font-semibold leading-tight text-ink-hi">{title}</h3>
          {/* 说明文字用 ink-lo 而不是 ink-faint：它是"这组字段是什么意思"，不是装饰 */}
          {hint && <p className="mt-0.5 text-xs leading-relaxed text-ink-lo">{hint}</p>}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </header>
      <div className="grid grid-cols-1 gap-x-4 gap-y-4 p-3 sm:p-4 md:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** 字段级错误。带 `role="alert"`，屏幕阅读器在保存失败时能读到它。 */
export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <span role="alert" className="mt-1 flex items-start gap-1 text-xs leading-relaxed text-down">
      <TriangleAlert aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Numeric field                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 带标签与取值范围提示的数字输入。
 *
 * 输入框右对齐（`text-right`）是设计规范 §3 的硬要求：数字列左对齐时，
 * 位数一变整列就会跟着晃，用户比较两个值时要重新找位置。
 */
export function NumField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  hint,
  error,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number | string;
  min?: number;
  max?: number;
  hint?: string;
  error?: string;
}) {
  const range =
    min !== undefined && max !== undefined
      ? `${min} – ${max}`
      : min !== undefined
        ? `≥ ${min}`
        : max !== undefined
          ? `≤ ${max}`
          : null;

  return (
    <div className="min-w-0">
      <Field label={label}>
        <NumberInput
          className="text-right"
          value={value}
          onValueChange={onChange}
          step={step}
          min={min}
          max={max}
          aria-invalid={error ? true : undefined}
        />
      </Field>
      <div className="mt-1 flex items-baseline justify-between gap-x-2">
        <span className="min-w-0 break-words text-xs text-ink-faint">{hint}</span>
        {range && <span className="num shrink-0 text-xs text-ink-faint" title="允许的取值范围">{range}</span>}
      </div>
      <FieldError message={error} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Period list                                                                */
/* -------------------------------------------------------------------------- */

/** `20, 50` → `[20, 50]`，非正数与 NaN 直接丢掉（schema 里的 min 会兜底报错）。 */
function parsePeriods(text: string): number[] {
  return text
    .split(/[,\s]+/)
    .map((token) => Number(token.trim()))
    .filter((token) => Number.isFinite(token) && token > 0);
}

/**
 * 逗号分隔的数字列表 ↔ `number[]`。
 *
 * 这里必须保留一份「正在输入的原文」（`draft`），不能直接把 `values.join(', ')`
 * 塞回输入框：用户敲下「20,」时解析结果是 `[20]`，若立刻回写就变成 `"20"`，
 * **逗号被吞掉，第二个周期永远敲不进去**。draft 只在聚焦期间存在，
 * 失焦后清空并重新与外部值对齐 —— 与 `ui.tsx` 里 `NumberInput` 同一套做法。
 */
export function PeriodListField({
  label,
  values,
  onChange,
  hint,
  error,
}: {
  label: string;
  values: number[];
  onChange: (values: number[]) => void;
  hint?: string;
  error?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? values.join(', ');

  return (
    <div className="min-w-0">
      <Field label={label} hint={hint ?? '逗号分隔，例如 20, 50'}>
        <TextInput
          className="num"
          value={shown}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            onChange(parsePeriods(event.target.value));
          }}
          onBlur={() => setDraft(null)}
        />
      </Field>

      {/* 解析结果回显：让"我敲的逗号到底生效了没有"一眼可见 */}
      {values.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-xs text-ink-faint">解析为</span>
          {values.map((period, index) => (
            <span key={`${period}-${index}`} className="num rounded border border-base-700 bg-base-800 px-1.5 text-xs text-ink-mid">
              {period}
            </span>
          ))}
        </div>
      )}
      {draft !== null && values.length === 0 && (
        <p className="mt-1 text-xs text-warn">没有解析出任何正数周期。</p>
      )}

      <FieldError message={error} />
    </div>
  );
}
