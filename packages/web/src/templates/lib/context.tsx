/**
 * 外壳的**运行时**：副作用、以及给模板用的 context。
 *
 * ## 为什么要有这一层
 *
 * 每套模板都会写一遍"连 WebSocket、起轮询、渲染 toast、渲染命令面板"是
 * 重复劳动，而且**错一处就是一个真 bug**：轮询忘了清会把定时器泄漏到
 * 下一个模板上；toast 漏渲染会让所有提示消失；`connect()` 调两次会连两条
 * WebSocket。
 *
 * 所以这些东西**不交给模板**。模板只管画；需要数据就读 context，
 * 需要触发行为就调 context 里的函数。
 *
 * ## 顺序上的一件事
 *
 * `<ShellRuntime>` 必须在模板**外面**（见 `Layout.tsx`），因为它的副作用
 * 要在模板挂载/卸载时保持稳定 —— 切模板时如果把 WebSocket 也断开重连，
 * 用户会看到"切个皮肤，推送断了两秒"。
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp, useEvents } from '../../lib/store';
import { CommandPalette } from '../../components/CommandPalette';
import { Toaster } from '../../components/Toaster';
import type { ShellState } from '../types';
import { systemPollMs, useShellData } from './useShellData';

const ShellContext = createContext<ShellState | null>(null);

/**
 * 读外壳数据。**模板里用这个**。
 *
 * 拿到的对象里有导航表、运行状态、退出登录、命令面板开关 —— 见 `ShellState`。
 */
export function useShell(): ShellState {
  const value = useContext(ShellContext);
  if (!value) {
    throw new Error(
      'useShell() 必须在 <ShellRuntime> 内部使用。模板的外壳组件由 Layout 包在它里面渲染，',
    );
  }
  return value;
}

/**
 * 模板选择：**由 `Layout` 传进来，不在这里 import store**。
 *
 * ## ⚠️ 为什么这一层必须只收 prop、不 import
 *
 * `templates/store.ts` 在模块求值期就要读 localStorage（拿初始模板），
 * 那条路径要经过 `registry.ts`。而 `registry.ts` 会静态 import 每一套外壳，
 * 外壳又会 import 本文件 —— 所以本文件一旦 import `store`，就形成
 *
 *     store → registry → 外壳 → context → store
 *
 * 的环，并且会在**求值期**闭合：`registry.ts` 撞上
 * `Cannot access 'BUILT_IN' before initialization`，整个应用白屏。
 * 实测踩过一次（顶栏加模板切换器的时候），所以这条记在这里。
 */
export interface TemplateRuntime {
  id: ShellState['templateId'];
  set: ShellState['setTemplateId'];
  list: ShellState['templates'];
}

export function ShellRuntime({
  children,
  template,
}: {
  children: ReactNode;
  template: TemplateRuntime;
}) {
  const data = useShellData();

  const logout = useApp((s) => s.logout);
  const refreshSystem = useApp((s) => s.refreshSystem);
  const refreshTraders = useApp((s) => s.refreshTraders);
  const sessionStatus = useApp((s) => s.status);
  const connect = useEvents((s) => s.connect);
  const disconnect = useEvents((s) => s.disconnect);
  const socketStatus = data.socketStatus;

  const navigate = useNavigate();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);

  /*
   * 推送连接的生命周期归外壳管：它是"这个应用活着"的一部分，不是某个页面的。
   *
   * ⚠️ 它**不在模板里**，而是在这里。切模板时这个组件不重新挂载
   * （模板在外面换，runtime 不动），所以连接不会断。
   */
  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  /*
   * ⚠️ **登录成功之后必须再叫一次 `connect()`**（2026-10-17 · 台账 FRD-03）。
   *
   * 上面那个 effect 只在挂载时跑一次（`connect`/`disconnect` 是 zustand 的稳定引用），
   * 而它跑的时候**可能还没有 token**：首屏的 `bootstrap()` 还在路上，或者用户是
   * 从"会话失效"里重新登录回来的。那时 `connect()` 会因为没有 token 早返回，
   * 而**之后再没有任何东西会叫它** —— 推送永久冻结，页面却显示"轮询兜底"。
   *
   * 认证状态是那个"再叫一次"的信号：`authenticated` 出现时连，
   * 掉回 `anonymous` 时由 401/登出路径负责 `disconnect()`。
   */
  useEffect(() => {
    if (sessionStatus === 'authenticated') connect();
  }, [sessionStatus, connect]);

  /*
   * 兜底轮询。推送正常时 10 秒一次，断了就 4 秒一次 ——
   * 断线时页面**什么都没说**会让人以为数据是新的，快一点翻新比弹一个
   * "连接断开"的横幅更省事（横幅在标题栏/状态栏里已经有了）。
   *
   * 间隔取自 `useShellData` 的同一个常量：状态栏那句话里的"N 秒"是按同一个数
   * 算阈值的（3 × 间隔）。
   */
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        void refreshSystem();
        void refreshTraders();
      },
      systemPollMs(socketStatus === 'open'),
    );
    return () => window.clearInterval(timer);
  }, [refreshSystem, refreshTraders, socketStatus]);

  /*
   * 路由变化时把命令面板收起来。
   *
   * 面板自己会在"选中一项"时关闭，但用户也可能通过别的方式跳页（浏览器
   * 前进/后退、页面里的链接）。不关的话面板会盖住刚跳过去的页面，
   * 而它看起来像是"卡住了"。
   */
  useEffect(() => setPaletteOpen(false), [location.pathname]);

  const value = useMemo<ShellState>(
    () => ({
      ...data,
      signOut: () => {
        logout();
        navigate('/login');
      },
      paletteOpen,
      setPaletteOpen,
      templateId: template.id,
      setTemplateId: template.set,
      templates: template.list,
    }),
    // `data` 每次渲染都是新对象，但它的字段全都来自 store 订阅 —— 这里逐项列出
    // 反而是维护负担。用整体依赖，代价只是一次浅比较。
    [data, logout, navigate, paletteOpen, template],
  );

  return (
    <ShellContext.Provider value={value}>
      {children}
      {/*
        toast 与命令面板由 runtime 渲染，**不由模板渲染**。

        理由：它们是"应用级"的浮层，位置固定在屏幕角上/中央，和外壳的形状
        无关。交给模板渲染的话，每套模板都要记得加这两个组件，而漏掉的那个
        表现是"某些提示再也看不到了" —— 一个只有出问题时才发现的缺口。
      */}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <Toaster />
    </ShellContext.Provider>
  );
}
