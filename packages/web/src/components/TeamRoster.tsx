/**
 * **团队看板** —— `ai_team` 模式专用的决策可视化。
 *
 * ## 用户的要求（2026-10-12，这是本组件存在的理由）
 *
 * > 「既然现在有 3 种模式了（普通、智能、团队），那么 UI 上面也要加上相应的显示，
 * >  并且 **3 种模式进去以后看板 UI 显示内容什么的也应该是要分开的**……
 * >  团队模式下，**决策看板应该很大区别于前两种了**，看板应该直观显示
 * >  **有哪些智能体，都是什么分工，都在做什么，时间、决策**，
 * >  等等一切你觉得有必要的显示在上面，UI 界面应该是**大改版**了」
 *
 * ## 与另外两种模式的根本差别（为什么不是"加几个组件"）
 *
 * | 维度 | 普通/智能托管 | **团队模式** |
 * |---|---|---|
 * | 决策主体 | **一个**模型 | **一支**分工的团队 |
 * | 时间结构 | 一条线性流水 | **并行**（4 个分析师同时）+ 串行（辩论/裁决）|
 * | 界面的第一问题 | "它做了什么决策" | "**谁在做什么**" |
 * | 失败形态 | 模型返回错 | **某个角色挂了**（要能看出是哪个）|
 *
 * 所以这个看板的组织方式是**按角色 × 阶段**，而不是按时间。
 * 用户明确说「根本逻辑有冲突变动」—— 指的正是这件事。
 *
 * ## 角色编制（与 `routedModel.ts` 的 `ROLE_TIERS` 对应）
 *
 * 界面上显示的"分工"必须与后端**同一份定义** —— 否则会漂移成
 * "界面说它是分析师、后端让它做裁决"那种对不上的状态。
 * 这里只放**给人看的标签**，档位与调用由后端决定。
 */

import { useEffect, useState } from 'react';

import type { TraderRow } from '../lib/api';
import { HumanMessage } from './TeamBoard/humanText';

/** 角色的展示信息（与后端 `ROLE_TIERS` 的角色名一一对应）。 */
interface RoleMeta {
  /** 与后端一致的 role id。 */
  id: string;
  /** 中文名（界面上显示的"分工"）。 */
  label: string;
  /** 一句话职责 —— 用户要求"都是什么分工"。 */
  duty: string;
  /** 编排阶段：`parallel` = 与其他分析师并行；`serial` = 独占串行。 */
  mode: 'parallel' | 'serial';
}

/**
 * 交易台的编制表（与设计文档 §二 一致）。
 *
 * ⚠️ **只放展示信息**。模型档位、候选链、提示词全在后端 ——
 * 界面不该复制那些逻辑（复制就会漂移，本项目已经踩过两次同类坑）。
 */
const DESK_ROLES: readonly RoleMeta[] = [
  { id: 'supervisor', label: '调度官', duty: '统筹分工、控制预算与轮次、强制推进', mode: 'serial' },
  { id: 'market_analyst', label: '行情分析师', duty: '看市场整体结构与值得关注的位置', mode: 'parallel' },
  { id: 'technical', label: '技术面', duty: '只描述指标与形态，不给交易建议', mode: 'parallel' },
  { id: 'newscaster', label: '新闻', duty: '把快讯整理成结构化事件卡', mode: 'parallel' },
  { id: 'sentiment', label: '情绪', duty: '给情绪分与样本量，样本不足要明说', mode: 'parallel' },
  { id: 'bull', label: '多头研究员', duty: '为做多构建最强论证 + 失效条件', mode: 'serial' },
  { id: 'bear', label: '空头研究员', duty: '为做空/不行动构建最强论证', mode: 'serial' },
  { id: 'judge', label: '裁决官', duty: '汇总辩论，给出唯一结论与置信度', mode: 'serial' },
];

/** 阶段的中文名（与后端 `phase` 字段对应）。 */
const PHASE_LABEL: Record<string, string> = {
  dispatch: '派发',
  analysis: '并行分析',
  debate: '对抗辩论',
  verdict: '裁决',
  execute: '执行',
};

/** 一个角色在当前这一轮的实时状态。 */
export interface RoleLiveState {
  role: string;
  /** 已经发生的步骤（按时间序）。 */
  steps: { at: string; message: string; phase: string | null; level: string }[];
  /** 最后一次动作的时刻。 */
  lastAt: string | null;
  /** 是否已"完成"（看到过完成/失败类的消息）。 */
  done: boolean;
  /** 是否失败过。 */
  failed: boolean;
}

/**
 * 把 `cycle_step` 流**按角色归并**。
 *
 * ## 为什么不按时间顺序显示
 *
 * 因为团队是**并行**的：4 个分析师的步骤会交错出现
 *（`technical` 完成 → `sentiment` 完成 → `newscaster` 完成…）。
 * 按时间排会让每个角色的过程被切碎，看不出"这个角色在干什么"。
 *
 * 按角色归并之后，界面能显示成**一张编制表**：每个角色一行，
 * 各自的状态、最近动作、耗时一目了然 —— 这才是"团队在开会"的样子。
 */
export function groupByRole(
  steps: ReadonlyArray<{ at: string; message: string; role?: string | null; phase?: string | null; level: string }>,
): RoleLiveState[] {
  const byRole = new Map<string, RoleLiveState>();

  for (const s of steps) {
    const role = s.role ?? null;
    if (role === null) continue; /* 不属于任何角色的步骤不进编制表 */
    let state = byRole.get(role);
    if (!state) {
      state = { role, steps: [], lastAt: null, done: false, failed: false };
      byRole.set(role, state);
    }
    state.steps.push({ at: s.at, message: s.message, phase: s.phase ?? null, level: s.level });
    state.lastAt = s.at;
    if (s.level === 'error') state.failed = true;
    /* 判据是消息里的措辞 —— 后端在完成/失败时就是这么写的（见 tradingDesk）。 */
    if (/完成|已出|已裁决/.test(s.message)) state.done = true;
    if (/失败|抛错|不可用/.test(s.message)) state.failed = true;
  }

  /*
   * 输出顺序按**编制表**（而不是"谁先出现"）——
   * 这样即使某一轮少派了某个角色，界面的位置也稳定，不会跳来跳去。
   */
  const ordered: RoleLiveState[] = [];
  for (const meta of DESK_ROLES) {
    const s = byRole.get(meta.id);
    if (s) ordered.push(s);
  }
  /* 编制表之外的（未来新增的角色）追加在后面，不丢信息。 */
  for (const [role, s] of byRole) {
    if (!DESK_ROLES.some((m) => m.id === role)) ordered.push(s);
  }
  return ordered;
}

/** 角色状态灯。 */
function StatusDot({ state }: { state: RoleLiveState }): React.ReactElement {
  if (state.failed) {
    return <span className="inline-block h-2 w-2 rounded-full bg-down" title="失败" />;
  }
  if (state.done) {
    return <span className="inline-block h-2 w-2 rounded-full bg-up" title="已完成" />;
  }
  return (
    <span
      className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent"
      title="进行中"
    />
  );
}

/** 把 ISO 时刻显示成 `HH:MM:SS`。 */
function clock(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/**
 * **团队编制表** —— 看板的主体。
 *
 * 显示：角色名 · 分工 · 状态灯 · 最近动作 · 时刻 · 已跑步骤数。
 */
export function TeamRoster({
  steps,
  cycleNumber,
  startedAt,
}: {
  steps: ReadonlyArray<{ at: string; message: string; role?: string | null; phase?: string | null; level: string }>;
  cycleNumber: number;
  startedAt: number;
}): React.ReactElement {
  const states = groupByRole(steps);
  const [now, setNow] = useState(() => Date.now());

  /* 计时器每秒刷新 —— 让"这一轮跑了多久"是活的。 */
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsedSec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mmss = `${String(Math.floor(elapsedSec / 60)).padStart(2, '0')}:${String(elapsedSec % 60).padStart(2, '0')}`;

  if (states.length === 0) {
    return (
      <div className="rounded-md border border-base-700 bg-base-850 px-3 py-3 text-base text-ink-faint">
        团队正在组建 —— 还没有角色开始工作。
      </div>
    );
  }

  return (
    <div className="rounded-md border border-base-700">
      <div className="flex items-center justify-between border-b border-base-700 px-3 py-2">
        <span className="text-base font-medium">交易台 · 第 {cycleNumber} 轮</span>
        <span className={`text-base ${elapsedSec >= 120 ? 'text-accent' : 'text-ink-faint'}`}>
          {mmss}
        </span>
      </div>
      <table className="w-full text-base">
        <thead>
          <tr className="border-b border-base-700 text-left text-xs text-ink-faint">
            <th className="px-3 py-1.5 font-normal">智能体</th>
            <th className="px-3 py-1.5 font-normal">分工</th>
            <th className="px-3 py-1.5 font-normal">最近动作</th>
            <th className="px-3 py-1.5 text-right font-normal">时刻</th>
          </tr>
        </thead>
        <tbody>
          {states.map((s) => {
            const meta = DESK_ROLES.find((m) => m.id === s.role);
            const last = s.steps[s.steps.length - 1];
            return (
              <tr key={s.role} className="border-b border-base-700/50 last:border-0">
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className="mr-2">
                    <StatusDot state={s} />
                  </span>
                  <span className="font-medium">{meta?.label ?? s.role}</span>
                  {meta?.mode === 'parallel' && (
                    <span className="ml-1.5 text-xs text-ink-faint">并行</span>
                  )}
                </td>
                <td className="px-3 py-2 text-ink-soft">{meta?.duty ?? '（未登记分工）'}</td>
                <td className="px-3 py-2 text-ink-soft">
                  {last ? (
                    <div className={last.level === 'error' ? 'border-l-2 border-down pl-2' : last.level === 'warn' ? 'border-l-2 border-warn pl-2' : 'border-l-2 border-transparent pl-2'}>
                      {last.phase !== null && PHASE_LABEL[last.phase] !== undefined && (
                        <span className="mr-1.5 rounded bg-base-800 px-1 text-xs text-ink-faint">
                          {PHASE_LABEL[last.phase]}
                        </span>
                      )}
                      {/*
                        ⚠️ **这里原来是 `{last.message}`**（2026-10-17 · 用户实测同一族）：
                        **连 `plainText()` 都没过** —— markdown 星号与 JSON 都原样显示。
                        现在走共用渲染层（与 `TeamBoard` 同一个入口，避免两套实现漂移）。
                      */}
                      <HumanMessage text={last.message} level={last.level} />
                    </div>
                  ) : (
                    '—'
                  )}
                  {s.steps.length > 1 && (
                    <span className="ml-1.5 text-xs text-ink-faint">（{s.steps.length} 步）</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap text-ink-faint">{clock(s.lastAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 模式徽章 —— **每种模式在界面上都要能一眼区分**（用户要求）。
 *
 * ## ⚠️ 这里曾经是 `if/if/return` 的兜底写法（2026-10-19 用户报 BUG）
 *
 * 原实现：
 * ```tsx
 *   if (mode === 'ai_team') → 「团队」
 *   if (mode === 'ai_managed') → 「智能托管」
 *   return 「固定策略」          ← 所有其它值都落到这里
 * ```
 * 加 `'jev'` 之后，一台 `mode=jev` 的机器人（线上实测 `#13 JEV测试`）
 * **被显示成「固定策略」** —— 用户截图指出「显示不对啊」。
 *
 * ## 为什么现在用 `Record<TraderMode, …>` 而不是继续 if 链
 *
 * 兜底 `return` 是**静默错误**：它让"没处理的新值"看起来像"固定策略"，
 * 而那是一个**语义完全不同**的模式。改成 `Record` 之后，
 * 少写一个键就**编译不过** —— 与 `glossary.ts` 的 `MODE_LABEL` 同一条纪律
 *（那里写着"把静默降级变成编译期就红"）。
 *
 * ⚠️ 徽章的**视觉样式**仍按模式区分（团队用 accent、托管用 ink-soft、
 * 其余用 ink-faint），所以不能直接复用 `MODE_LABEL` 的字符串
 *（那个是给下拉框用的长名字，徽章里要短）。
 */
export const MODE_BADGE: Record<TraderRow['mode'], { text: string; className: string }> = {
  ai_team: { text: '团队', className: 'bg-accent/15 text-accent' },
  ai_managed: { text: '智能托管', className: 'bg-base-800 text-ink-soft' },
  strategy: { text: '固定策略', className: 'bg-base-800 text-ink-faint' },
  /*
   * ⚠️ **必须标明实验性**（用户明确要求这个模式是实验性）。
   * 用 warn 色让它在列表里显眼 —— 它的盈利表现完全未知，
   * 不该和另外三种看起来一样。
   */
  jev: { text: 'JEV 实验', className: 'bg-warn/15 text-warn' },
};

export function ModeBadge({ mode }: { mode: TraderRow['mode'] }): React.ReactElement {
  const badge = MODE_BADGE[mode];
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${badge.className}`}>
      {badge.text}
    </span>
  );
}
