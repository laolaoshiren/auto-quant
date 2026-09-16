import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { Badge, Button, Field, NumberInput, Spinner, Toggle } from './ui';
import { DEFAULT_SETTLE_ASSET, fmtTime } from '../lib/format';

/* -------------------------------------------------------------------------- */
/*  Reading the starting equity from the exchange                              */
/* -------------------------------------------------------------------------- */

export interface EquitySourceState {
  /** Current field value — meaningless while `loading`. */
  value: number;
  setValue: (value: number) => void;
  /** Operator chose to type the baseline instead of having it read. */
  manual: boolean;
  setManual: (manual: boolean) => void;
  /** The exchange read is in flight; the field must not show a stale number. */
  loading: boolean;
  /** Why the read failed, if it did. */
  error: string | null;
  /** True when `value` came from a successful exchange read. */
  verified: boolean;
  /** ISO timestamp of the reading currently in the field. */
  readAt: string | null;
  /** Margin asset the reading is denominated in. */
  asset: string;
  /** Force a fresh read (`?refresh=1`). */
  refresh: () => void;
}

/**
 * Shared state for the 起始权益 field.
 *
 * New-trader and edit-trader dialogs both need the same thing — "what is the
 * wallet balance of the credential this bot will trade" — and the subtle part is
 * deciding what reaches the server:
 *
 *  - the reading succeeded and the operator left the field alone → **omit**
 *    `initialEquity`, so the server re-reads the exchange itself;
 *  - the operator turned on 手动指定, or the read failed and they typed a
 *    number → send it, because there is nothing trustworthy to read.
 *
 * Both dialogs call this hook and then use `equityPayload()` to build the body,
 * so the rule lives in exactly one place.
 */
export function useExchangeEquity({
  open,
  exchangeAccountId,
  /** Stored value when editing an existing trader; ignored for creation. */
  prefill,
  /** Credential-reported read error, shown until our own read answers. */
  fallbackError,
}: {
  open: boolean;
  exchangeAccountId: number;
  prefill?: number | null;
  fallbackError?: string | null;
}): EquitySourceState {
  const [value, setValue] = useState(prefill ?? 0);
  const [manual, setManual] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(fallbackError ?? null);
  const [verified, setVerified] = useState(false);
  const [readAt, setReadAt] = useState<string | null>(null);
  const [asset, setAsset] = useState(DEFAULT_SETTLE_ASSET);
  const [readId, setReadId] = useState(0);

  // The dialog opens with a stored baseline in edit mode; the operator may type
  // over it, and a failed read must not clobber that typed value.
  const touched = useRef(false);
  const prefillRef = useRef(prefill ?? 0);
  prefillRef.current = prefill ?? 0;
  /**
   * Which credential / open-run the current field belongs to.
   *
   * The editor is reused for different traders, so the stored baseline can
   * change under us. Re-running the reset effect on every `prefill` change would
   * loop (the effect writes the value it depends on), so the reset is keyed on
   * identity instead and reads the freshest prefill through the ref.
   */
  const resetKey = `${open ? 'open' : 'shut'}:${exchangeAccountId}`;
  const lastKey = useRef(resetKey);

  const setValueTracked = useCallback((next: number) => {
    touched.current = true;
    setValue(next);
  }, []);

  /** Only the exchange read writes through here, so it never counts as typing. */
  const applyRead = useCallback((next: number) => {
    setValue(next);
  }, []);

  const setManualTracked = useCallback((next: boolean) => {
    setManual(next);
    // Choosing "type it myself" retracts any read we had, and vice versa: the
    // caption must never claim a number is exchange-verified while the operator
    // is editing it by hand.
    if (next) setVerified(false);
  }, []);

  // Open / credential change: drop everything read for the previous account and
  // start from that trader's stored baseline.
  useEffect(() => {
    if (lastKey.current === resetKey) return;
    lastKey.current = resetKey;
    if (!open) return;
    touched.current = false;
    setValue(prefillRef.current);
    setManual(false);
    setVerified(false);
    setReadAt(null);
    setError(fallbackError ?? null);
  }, [resetKey, open, fallbackError]);

  // On open, show the exchange number straight away rather than an empty field.
  useEffect(() => {
    if (!open || manual) return;
    setReadId((n) => n + 1);
  }, [open, exchangeAccountId, manual]);

  useEffect(() => {
    if (!open || manual || readId === 0 || !Number.isFinite(exchangeAccountId) || exchangeAccountId <= 0) return;
    let alive = true;
    setReading(true);
    setError(null);
    void api
      .exchangeBalance(exchangeAccountId, true)
      .then((result) => {
        if (!alive) return;
        if (!result.ok) {
          // HTTP 200 with `ok: false` — the status code is never the signal.
          setError(result.error);
          setVerified(false);
          // Keep a stored baseline visible, but never invent one.
          if (!touched.current && prefillRef.current <= 0) applyRead(0);
          return;
        }
        const { balance } = result;
        setAsset(balance.asset?.trim() || DEFAULT_SETTLE_ASSET);
        setReadAt(balance.readAt);
        applyRead(balance.walletBalance);
        setVerified(true);
      })
      .catch((err: Error) => {
        if (!alive) return;
        setError(err.message);
        setVerified(false);
      })
      .finally(() => {
        if (alive) setReading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, manual, readId, exchangeAccountId]);

  const refresh = useCallback(() => {
    touched.current = false;
    setReadId((n) => n + 1);
  }, []);

  return {
    value,
    setValue: setValueTracked,
    manual,
    setManual: setManualTracked,
    // The very first read has not started yet on the render that opens the
    // dialog; treating that as loading keeps a stale "0" off the screen.
    loading:
      !manual &&
      (reading || (readId === 0 && open && Number.isFinite(exchangeAccountId) && exchangeAccountId > 0)),
    error,
    verified,
    readAt,
    asset,
    refresh,
  };
}

/* -------------------------------------------------------------------------- */
/*  The field itself                                                           */
/* -------------------------------------------------------------------------- */

/**
 * 起始权益（钱包余额） input.
 *
 * Why wallet balance and not equity: this number becomes the **return baseline**,
 * so every later performance percentage is measured against it. Reading it from
 * the exchange rather than asking the operator to type it is the whole point —
 * a fat-fingered baseline makes every future figure wrong in a way that looks
 * plausible.
 *
 * 这里没有"元信息网格"要排：它是对话框里的一行字段，所以只做密度清理 ——
 * 旧的 `text-2xs` 兼容别名换成正式档位 `text-xs`，刷新动作的 `⟳` 文字符号
 * 换成 `lucide-react` 图标（`DESIGN.md` §5：不用文字符号当图标）。
 */
export function EquitySourceField({
  state,
  /** Swaps the read action's label for the edit dialog. */
  editing = false,
  /** No credential exists at all — the modal is unusable until one is added. */
  disabled = false,
}: {
  state: EquitySourceState;
  editing?: boolean;
  disabled?: boolean;
}) {
  const { value, setValue, manual, setManual, loading, error, verified, readAt, asset, refresh } = state;

  const refreshButton = (label: string) => (
    <Button size="icon" variant="ghost" aria-label={label} title={label} onClick={refresh}>
      <RefreshCw aria-hidden className="h-3.5 w-3.5" />
    </Button>
  );

  return (
    <div className="space-y-1.5">
      <Field label="起始权益（钱包余额）">
        {loading ? (
          <div className="input flex items-center gap-2 text-ink-lo">
            <Spinner />
            <span className="text-xs">正在从交易所读取钱包余额</span>
          </div>
        ) : (
          <NumberInput
            value={value}
            onValueChange={setValue}
            step={100}
            disabled={disabled || !manual}
            title={manual ? undefined : '关闭“手动指定”后可自行填写'}
          />
        )}
      </Field>

      {/* Caption: where this number came from, and how to re-read it -------- */}
      {!loading && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {manual && (
            <span className="flex items-center gap-1.5 text-ink-faint">
              <Badge tone="warn">手动指定</Badge>
              <span>该值将直接作为收益率基准，不会与交易所核对。</span>
            </span>
          )}

          {!manual && verified && (
            <span className="flex items-center gap-1.5 text-up">
              <span className="num">
                已从交易所实时读取（{asset}，读取于 {fmtTime(readAt)}）
              </span>
              {refreshButton('重新从交易所读取钱包余额')}
            </span>
          )}

          {!manual && !verified && error && (
            <span className="flex items-start gap-1.5 text-warn">
              <span className="min-w-0 flex-1">
                未能读取交易所余额：{error}
                <span className="mt-0.5 block text-ink-faint">
                  可打开“手动指定”自行填写；留空创建时基准为 0，收益率将没有意义。
                </span>
              </span>
              {refreshButton('重试读取交易所余额')}
            </span>
          )}

          {!manual && !verified && !error && (
            <span className="flex items-center gap-1.5 text-ink-faint">
              <span>{editing ? '重新从交易所读取：' : '立即从交易所读取：'}</span>
              <Button size="sm" variant="ghost" onClick={refresh}>
                <RefreshCw aria-hidden className="h-3.5 w-3.5" />
                {editing ? '重新读取' : '读取'}
              </Button>
            </span>
          )}
        </div>
      )}

      <Toggle
        checked={manual}
        onChange={setManual}
        label="手动指定"
        hint={
          editing
            ? '重新从交易所读取会覆盖这里的数值。'
            : '默认从交易所读取；无法读取时才需要手动填写。'
        }
      />

      <p className="text-xs leading-relaxed text-ink-faint">
        这个数字是机器人收益率的基准：填错会让之后每一项业绩指标都算错，所以默认从交易所读取，而不是手填。
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Payload rule                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The `initialEquity` a create/save request should carry.
 *
 * Returning `undefined` means "omit the key" — the server then reads the real
 * wallet balance itself, which is what should happen whenever the operator did
 * not deliberately supply the baseline.
 */
export function equityPayload(state: EquitySourceState): number | undefined {
  if (state.manual) return state.value;
  // A read failed and the operator typed something: respect the number, but
  // only when it is a real positive baseline.
  if (state.error && state.value > 0) return state.value;
  return undefined;
}
