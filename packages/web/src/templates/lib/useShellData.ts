/**
 * 外壳要用的**数据**（纯读，无副作用）。
 *
 * 和它配套的是 `ShellRuntime` —— 那个负责**行为**（连推送、起轮询、渲染
 * toast）。两者分开是因为行为必须在 React 树里恰好发生一次，而数据可以
 * 被任意多个组件读。
 */
import { useEffect, useMemo, useState } from 'react';
import { useApp, useEvents } from '../../lib/store';
import { staleWakeDelayMs, staleness } from '../../lib/staleness';
import { NAV_GROUPS, NAV_ITEMS, type NavGroup, type NavItem } from '../../components/nav';

/**
 * 系统状态 / 机器人列表的**兜底轮询间隔**（毫秒）。
 *
 * 推送在线时 10 秒一次，断了就 4 秒一次 —— 断线时页面什么都没说会让人以为
 * 数据是新的，快一点翻新比弹横幅更省事。
 *
 * ⚠️ 这两个数**只在这里定义一次**：`ShellRuntime` 用它起定时器，
 * 而"停更多久算停更"（3 × 它）也从同一个值算出来。两处各写一个数的话，
 * 改了轮询节奏而忘了改阈值，状态栏就会在正常工作时报"停更"。
 */
export const SYSTEM_POLL_OPEN_MS = 10_000;
export const SYSTEM_POLL_CLOSED_MS = 4_000;

export function systemPollMs(socketOpen: boolean): number {
  return socketOpen ? SYSTEM_POLL_OPEN_MS : SYSTEM_POLL_CLOSED_MS;
}

export interface ShellData {
  user: ReturnType<typeof useApp.getState>['user'];
  system: ReturnType<typeof useApp.getState>['system'];
  traders: ReturnType<typeof useApp.getState>['traders'];
  socketStatus: ReturnType<typeof useEvents.getState>['status'];
  /**
   * 推送**没能连上**的原因（`null` = 没这回事）。
   *
   * 与 `socketStatus` 分开：`closed` 有两种完全不同的意思 ——
   * "连过又断了，正在重连"vs"压根没登录，连都没连过"。
   * 后者要操作员去登录，把它显示成前者就是让他干等（台账 FRD-03）。
   */
  socketBlockedReason: string | null;
  runningCount: number;
  clockWarn: boolean;
  weightPercent: number;
  weightWarn: boolean;
  /** 系统状态是否已经陈旧（超过 3 × 当前轮询间隔）。 */
  statusStale: boolean;
  /** 陈旧时可直接渲染的一句话（`状态停更 N 秒 · 最后成功 HH:MM:SS`）；否则 `null`。 */
  statusStaleLabel: string | null;
  /** 上一次成功读到系统状态的时刻（没有过就是 `null`）。 */
  statusLastLoadedAt: number | null;
  /** 最近一次系统状态刷新失败的原因（`null` = 最近一次是成功的）。 */
  statusError: string | null;
  navItems: NavItem[];
  navGroups: NavGroup[];
}

/**
 * 仅在真正进入停更态后才每秒跳动的时钟。
 *
 * 之前这里无条件调用 `useTicker(1000)`，导致 `<ShellRuntime>` 即使在系统正常时
 * 也每秒重建一次 `ShellContext` 并驱动整棵外壳树无效重渲染。
 * 现在正常期间只挂一个在 `3 × pollMs` 阈值处触发的单次定时器（每次轮询成功都会重置，
 * 平时永不触发）；只有真停更时才启动 1 秒 interval 让"状态停更 N 秒"持续更新。
 */
function useStaleClock(loadedAt: number | null, pollMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const delay = staleWakeDelayMs(loadedAt, pollMs, Date.now());
    if (delay === null) return;

    let intervalId: number | null = null;
    const timeoutId = window.setTimeout(() => {
      setNow(Date.now());
      intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    }, delay);

    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, [loadedAt, pollMs]);

  return now;
}

export function useShellData(): ShellData {
  const user = useApp((s) => s.user);
  const system = useApp((s) => s.system);
  const traders = useApp((s) => s.traders);
  const systemsLoadedAt = useApp((s) => s.systemsLoadedAt);
  const systemError = useApp((s) => s.systemError);
  const socketStatus = useEvents((s) => s.status);
  const socketBlockedReason = useEvents((s) => s.blockedReason);

  const pollMs = systemPollMs(socketStatus === 'open');
  const now = useStaleClock(systemsLoadedAt, pollMs);
  const stale = staleness(systemsLoadedAt, systemError, pollMs, now);

  const runningCount = system?.runningTraders.length ?? traders.filter((t) => t.isRunning).length;

  /*
   * 两个诊断阈值。
   *
   * 时钟取**绝对值** —— 交易所的时钟快于本地同样会导致 -1021，
   * 只看正数会漏掉一半情况。
   *
   * 权重用 70% 而不是 100%：请求权重是**按分钟滚动**的，等到 100% 就已经在
   * 被拒绝了。代码里的软上限是 75%，留一点提前量。
   */
  const clockWarn = Math.abs(system?.clockOffsetMs ?? 0) > 2000;
  const weightPercent =
    system?.weightLimit && system.weightLimit > 0
      ? Math.round(((system?.weightUsed ?? 0) / system.weightLimit) * 100)
      : 0;
  /*
   * API 权重告警门槛设为 90%（原 70% 过低）：
   * 70%–89% 属于系统内部 `BinanceRest` 软限速自动退避可消化的正常区间，不该在顶栏
   * 挂黄色感叹号制造噪音；只有实时衰减后的同 IP 占用逼近 90%（真正有 418 封 IP 风险，
   * 常见于同机其它程序共享 IP 配额）时才需要通知操作员。
   */
  const weightWarn = weightPercent >= 90;

  return useMemo<ShellData>(
    () => ({
      user,
      system,
      traders,
      socketStatus,
      socketBlockedReason,
      runningCount,
      clockWarn,
      weightPercent,
      weightWarn,
      statusStale: stale.stale,
      statusStaleLabel: stale.label,
      statusLastLoadedAt: systemsLoadedAt,
      statusError: systemError,
      navItems: NAV_ITEMS,
      navGroups: NAV_GROUPS,
    }),
    [
      user,
      system,
      traders,
      socketStatus,
      socketBlockedReason,
      runningCount,
      clockWarn,
      weightPercent,
      weightWarn,
      stale.stale,
      stale.label,
      systemsLoadedAt,
      systemError,
    ],
  );
}
