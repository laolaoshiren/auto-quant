/**
 * **机器人控制**面板（2026-10-18）。
 *
 * 用户的要求：
 * > 「在这边加一个新标签，专门放机器人控制：是实时生效的那种（不受机器人运行影响），
 * >   运行中机器人改了这里配置也会马上生效的，以后我计划放很多功能进去，
 * >   目前只需要做一个功能：JEV 模型开关」
 *
 * ## 这个面板的设计约束（按用户对 UI 的一贯要求）
 *
 * | 要求 | 怎么落实 |
 * |---|---|
 * | 「实时生效」 | 打开确认瞬间落库，**下一次决策轮次就按新值跑**（`isSwitchOn` 每轮重读） |
 * | 「放很多功能」 | 开关列表**从服务端拉**（`RUNTIME_SWITCHES`），这里不硬编码任何一项 |
 * | 「不要莫名其妙的东西」 | 每项显示：标题 + **影响**（关掉会怎样）+ **当前值从哪来** |
 *
 * ## 为什么每项都要显示「来源」
 *
 * 操作员看到「Jev 初筛 已开启」时，如果不知道那是**自己点的**还是**部署时的 `.env`**，
 * 就没法判断：
 * ```
 *   ① 我关掉它，会不会影响别人？
 *   ② 服务器重启后，它会不会变回去？
 * ```
 * 所以每项旁边标一个来源：
 * ```
 *   [界面设置]  → 你点的，重启也保持
 *   [.env 初始] → 部署时就带的，界面上从没点过
 *   [默认值]    → 代码里的默认
 * ```
 *
 * ## 为什么不在前端缓存开关列表
 *
 * 「实时生效」意味着**别人也可能改**（例如另一个人开了另一个标签页）。
 * 每次打开面板都重新拉一次，代价是一个极小请求，换来的是"显示的一定是此刻的值"。
 */
import { useCallback, useEffect, useState } from 'react';

import { api, type ControlSwitch } from '../../lib/api.js';
import { ErrorNote, Spinner3 } from '../ui.js';

/** 来源 → 人话。三种来源对操作员的含义完全不同（见文件头）。 */
const SOURCE_LABEL: Record<ControlSwitch['source'], string> = {
  ui: '界面设置',
  env: '.env 初始',
  default: '默认值',
};

/**
 * 来源的悬停说明。
 *
 * ⚠️ 只对**会让人困惑的**两个给说明（`.env 初始` / `默认值`）——
 * 「界面设置」本身就很清楚，再解释一遍是噪音。
 */
const SOURCE_HINT: Partial<Record<ControlSwitch['source'], string>> = {
  env: '这个值是部署时写在 .env 里的，界面上从没点过。你在这里改一次，就会永久以界面为准。',
  default: '这个值是代码里的默认，.env 里没有写。',
};

export function RobotControl({ traderId }: { traderId: number }) {
  const [switches, setSwitches] = useState<ControlSwitch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const r = await api.traderControl(traderId, signal);
        setSwitches(r.switches);
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

  const toggle = async (key: string, next: boolean): Promise<void> => {
    setBusyKey(key);
    try {
      /*
       * 用返回值直接刷新（服务端回了回读后的完整状态）——
       * 不乐观更新：这个开关会真的改变团队的调用行为，
       * 界面上先假装成功、然后实际失败，是最糟的那种体验。
       */
      const r = await api.setTraderControl(traderId, key, next);
      setSwitches(r.switches);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  if (switches === null && error === null) {
    return <Spinner3 label="正在读取控制项" />;
  }

  return (
    <div className="px-2.5 py-2">
      {error !== null && <ErrorNote className="mb-2">控制项读取失败：{error}</ErrorNote>}

      <p className="mb-2 text-[11px] leading-4 text-ink-faint">
        这里的开关<strong className="font-medium text-ink-lo">立刻生效</strong>
        —— 不需要重启机器人，正在跑的下一轮决策就用新值。
      </p>

      <ul className="space-y-2">
        {(switches ?? []).map((s) => {
          const busy = busyKey === s.key;
          return (
            <li
              key={s.key}
              className="flex items-start justify-between gap-3 rounded border border-base-800 bg-base-850/40 px-2.5 py-2"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium text-ink-hi">{s.label}</span>
                  <span
                    className="rounded bg-base-800 px-1 text-[10px] leading-4 text-ink-faint"
                    title={SOURCE_HINT[s.source]}
                  >
                    {SOURCE_LABEL[s.source]}
                  </span>
                </div>
                {/* 「关掉会怎样」比「它是什么」更重要 —— 这是操作员做决定的依据。 */}
                <p className="mt-0.5 text-[11px] leading-4 text-ink-lo">{s.effect}</p>
              </div>

              {/*
                ⚠️ **开关是 `<button role="switch">`，不是 checkbox**：
                它表示"立即执行一个动作"，而不是"填一个表单等提交"。
                用 checkbox 会让操作员以为改完还要点保存。
              */}
              <button
                type="button"
                role="switch"
                aria-checked={s.on}
                aria-label={`${s.label}：${s.on ? '已开启' : '已关闭'}`}
                disabled={busy}
                onClick={() => void toggle(s.key, !s.on)}
                className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition ${
                  s.on ? 'bg-accent' : 'bg-base-700'
                } ${busy ? 'opacity-50' : ''}`}
              >
                <span
                  aria-hidden
                  className={`h-4 w-4 rounded-full bg-white transition-transform ${
                    s.on ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </li>
          );
        })}
      </ul>

      {(switches ?? []).length === 0 && (
        <p className="text-xs text-ink-faint">目前没有可运行期调整的控制项。</p>
      )}
    </div>
  );
}
