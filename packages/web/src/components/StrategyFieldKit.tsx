import type { ReactNode } from 'react';
import { Field, NumberInput, TextInput } from './ui';

/* -------------------------------------------------------------------------- */
/*  Shared scaffolding for the Strategy Studio field groups                    */
/* -------------------------------------------------------------------------- */

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
    <div className="rounded border border-base-800 bg-base-850/30">
      <div className="flex items-center justify-between border-b border-base-800 px-3 py-1.5">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-mid">{title}</h3>
          {hint && <p className="text-2xs text-ink-faint">{hint}</p>}
        </div>
        {right}
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 p-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>
    </div>
  );
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <span className="mt-1 block text-2xs text-down">{message}</span>;
}

/** A labelled numeric input with an inline range hint. */
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
  return (
    <div>
      <Field label={label} hint={hint}>
        <NumberInput value={value} onValueChange={onChange} step={step} min={min} max={max} />
      </Field>
      {(min !== undefined || max !== undefined) && !error && (
        <span className="mt-0.5 block text-2xs text-ink-faint">
          {min !== undefined ? `最小 ${min}` : ''}
          {min !== undefined && max !== undefined ? ' · ' : ''}
          {max !== undefined ? `最大 ${max}` : ''}
        </span>
      )}
      <FieldError message={error} />
    </div>
  );
}

/** Comma-separated numeric list ↔ `number[]`. */
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
  return (
    <div>
      <Field label={label} hint={hint ?? '逗号分隔，例如 20, 50'}>
        <TextInput
          className="num"
          value={values.join(', ')}
          onChange={(event) => {
            const parsed = event.target.value
              .split(/[,\s]+/)
              .map((token) => Number(token.trim()))
              .filter((token) => Number.isFinite(token) && token > 0);
            onChange(parsed);
          }}
        />
      </Field>
      <FieldError message={error} />
    </div>
  );
}
