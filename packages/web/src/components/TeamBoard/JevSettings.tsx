/**
 * **JEV 模式配置面板**（2026-10-19）。
 *
 * ## 用户的要求
 *
 * > 「我感觉 P3 可以做，这模型成本忽略不计了，但是**要有开关**
 * >  （像团队模式一样，这边增加 P3 选项和其他你觉得必要的选项，**不要全部写死**）」
 *
 * ## 这个面板的设计原则
 *
 * | 原则 | 落实 |
 * |---|---|
 * | **不写死** | 选项列表**从服务端拉**（`JEV_OPTIONS`），这里不硬编码任何一项 |
 * | **要能看懂** | 每一项都显示 `why`（它是什么、改了会怎样）—— 用户不懂 JEV |
 * | **要诚实** | 需要重启才生效的项，明确标注 ⚠️ |
 * | **立刻生效** | 与「机器人控制」同一条纪律：改完落库，下一轮就读到新值 |
 *
 * ## ⚠️ 为什么每项都要显示 `why`
 *
 * 用户原话是「我不懂 JEV 实际用法」。给他一个光秃秃的下拉框（`code` / `hybrid` / `jev`）
 * 等于让他瞎猜 —— 而猜错的代价是**真金白银的交易行为改变**。
 */
import { useCallback, useEffect, useState } from 'react';

import { api, type JevOption } from '../../lib/api.js';
import { ErrorNote, Spinner3 } from '../ui.js';

export function JevSettings({ traderId }: { traderId: number }) {
  const [options, setOptions] = useState<JevOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** 刚改过的项 —— 用来显示"已保存，下一轮生效"的短暂提示。 */
  const [justSaved, setJustSaved] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const r = await api.traderJevOptions(traderId, signal);
        setOptions(r.options);
        setError(null);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setError((err as Error).message);
      }
    },
    [traderId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const save = async (key: string, value: string): Promise<void> => {
    setBusyKey(key);
    try {
      /*
       * 用返回值直接刷新 —— 不乐观更新。这些选项会真的改变交易行为，
       * 界面先假装成功、实际失败，是最糟的那种体验。
       */
      const r = await api.setTraderJevOption(traderId, key, value);
      setOptions(r.options);
      setError(null);
      setJustSaved(key);
      window.setTimeout(() => setJustSaved((k) => (k === key ? null : k)), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  if (options === null && error === null) {
    return <Spinner3 label="正在读取 JEV 选项" />;
  }

  return (
    <div className="px-2.5 py-2">
      {error !== null && <ErrorNote className="mb-2">JEV 选项读取失败：{error}</ErrorNote>}

      <p className="mb-2 text-[11px] leading-4 text-ink-faint">
        这些选项只影响 <strong className="font-medium text-ink-lo">JEV 模式</strong>的机器人。
        改完<strong className="font-medium text-ink-lo">立刻生效</strong>
        （标了「需重启」的除外）。
      </p>

      <ul className="space-y-2">
        {(options ?? []).map((o) => {
          const busy = busyKey === o.key;
          const saved = justSaved === o.key;
          return (
            <li
              key={o.key}
              className="rounded border border-base-800 bg-base-850/40 px-2.5 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-ink-hi">{o.label}</span>
                    {o.source === 'default' && (
                      <span className="rounded bg-base-800 px-1 text-[10px] leading-4 text-ink-faint">
                        默认值
                      </span>
                    )}
                    {o.requiresRestart && (
                      <span
                        className="rounded bg-warn/15 px-1 text-[10px] leading-4 text-warn"
                        title="这一项是在装配决策模型时读的，改完要重启机器人才生效"
                      >
                        ⚠️ 需重启
                      </span>
                    )}
                    {saved && <span className="text-[10px] text-up">已保存</span>}
                  </div>
                  {/* 「它是什么、改了会怎样」—— 用户不懂 JEV，靠这句做决定。 */}
                  <p className="mt-0.5 text-[11px] leading-4 text-ink-lo">{o.why}</p>
                </div>

                <div className="shrink-0 pt-0.5">
                  {o.kind === 'boolean' ? (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={o.value === 'on'}
                      aria-label={`${o.label}：${o.value === 'on' ? '已开启' : '已关闭'}`}
                      disabled={busy}
                      onClick={() => void save(o.key, o.value === 'on' ? 'off' : 'on')}
                      className={`flex h-5 w-9 items-center rounded-full px-0.5 transition ${
                        o.value === 'on' ? 'bg-accent' : 'bg-base-700'
                      } ${busy ? 'opacity-50' : ''}`}
                    >
                      <span
                        aria-hidden
                        className={`h-4 w-4 rounded-full bg-white transition-transform ${
                          o.value === 'on' ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  ) : o.kind === 'enum' ? (
                    <select
                      value={o.value}
                      disabled={busy}
                      onChange={(e) => void save(o.key, e.target.value)}
                      className="rounded border border-base-700 bg-base-900 px-1.5 py-1 text-[11px] text-ink-hi"
                    >
                      {(o.options ?? []).map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={o.value}
                        min={o.range?.min}
                        max={o.range?.max}
                        step={o.range?.step}
                        disabled={busy}
                        /*
                         * ⚠️ 用 `onBlur` 而不是 `onChange` 保存 ——
                         * 边打字边保存会把 "40" 的 "4" 也提交一次，
                         * 于是中间态（4）被写进库、下一轮真的按 4 跑。
                         */
                        onChange={(e) => {
                          const next = e.target.value;
                          setOptions((prev) =>
                            (prev ?? []).map((x) =>
                              x.key === o.key ? { ...x, value: next } : x,
                            ),
                          );
                        }}
                        onBlur={(e) => void save(o.key, e.target.value)}
                        className="w-16 rounded border border-base-700 bg-base-900 px-1.5 py-1 text-right text-[11px] tabular-nums text-ink-hi"
                      />
                      <span className="text-[10px] text-ink-faint">{o.range?.unit ?? ''}</span>
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {(options ?? []).length === 0 && (
        <p className="text-xs text-ink-faint">目前没有可调整的 JEV 选项。</p>
      )}
    </div>
  );
}
