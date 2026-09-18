/**
 * Global app state: session, operators, watchlist and the live event socket.
 *
 * Split into two stores on purpose — `useApp` holds slow-moving REST data, while
 * `useEvents` is written to on every socket frame (orders, logs, positions) so a
 * busy stream only re-renders the panels that actually read it.
 */
import { create } from 'zustand';
import {
  api,
  clearToken,
  eventStreamUrl,
  getStoredUser,
  getToken,
  setStoredUser,
  setToken,
  setUnauthorizedHandler,
  type Catalog,
  type Health,
  type SystemStatus,
  type TraderRow,
} from './api';
import type {
  DecisionRecord,
  EquitySnapshot,
  OrderRecord,
  PositionView,
  ServerEvent,
  TradeRecord,
  TraderStatus,
  User,
} from '@aq/shared';
import { orderPurposeLabel, orderStatusLabel, traderStatusLabel } from '@aq/shared';
import { closeReasonLabel } from './summaries';
import { fmtSigned, sideLabel } from './format';

/* -------------------------------------------------------------------------- */
/*  Session / REST store                                                       */
/* -------------------------------------------------------------------------- */

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated';

interface SessionState {
  status: SessionStatus;
  user: User | null;
  health: Health | null;
  catalog: Catalog | null;
  system: SystemStatus | null;
  traders: TraderRow[];
  lastError: string | null;

  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  loadCatalog: () => Promise<void>;
  refreshSystem: () => Promise<void>;
  refreshTraders: () => Promise<void>;
  setTraders: (traders: TraderRow[]) => void;
}

export const useApp = create<SessionState>((set, get) => ({
  status: 'loading',
  user: null,
  health: null,
  catalog: null,
  system: null,
  traders: [],
  lastError: null,

  /** Verify a stored token and load the shell prerequisites in one pass. */
  bootstrap: async () => {
    setUnauthorizedHandler(() => {
      clearToken();
      set({ status: 'anonymous', user: null });
    });

    if (!getToken()) {
      try {
        const health = await api.health();
        set({ health, status: 'anonymous' });
      } catch {
        set({ status: 'anonymous' });
      }
      return;
    }

    try {
      const [{ user }, health] = await Promise.all([api.me(), api.health().catch(() => null)]);
      set({ user, health, status: 'authenticated' });
      setStoredUser(user);
      await Promise.all([get().loadCatalog(), get().refreshSystem(), get().refreshTraders()]);
    } catch {
      clearToken();
      let health: Health | null = null;
      try {
        health = await api.health();
      } catch {
        health = null;
      }
      set({ status: 'anonymous', user: null, health });
    }
  },

  login: async (username, password) => {
    const result = await api.login(username, password);
    setToken(result.token);
    setStoredUser(result.user);
    set({ user: result.user, status: 'authenticated', lastError: null });
    await get().bootstrap();
  },

  logout: () => {
    clearToken();
    set({ status: 'anonymous', user: null, traders: [], catalog: null, system: null });
  },

  loadCatalog: async () => {
    try {
      const catalog = await api.catalog();
      set({ catalog });
    } catch (error) {
      set({ lastError: (error as Error).message });
    }
  },

  refreshSystem: async () => {
    try {
      const system = await api.system();
      set({ system });
    } catch {
      /* keep the previous snapshot; the banner will show a stale reading */
    }
  },

  refreshTraders: async () => {
    try {
      const traders = await api.traders();
      set({ traders });
    } catch {
      /* transient — the next poll will retry */
    }
  },

  setTraders: (traders) => set({ traders }),
}));

/** The user restored from localStorage, shown while `bootstrap()` is in flight. */
export const cachedUser = getStoredUser;

/* -------------------------------------------------------------------------- */
/*  Live event store                                                           */
/* -------------------------------------------------------------------------- */

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface LiveLogLine {
  id: number;
  traderId: number | null;
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  scope?: string;
}

export interface Toast {
  id: number;
  kind: 'order' | 'trade' | 'error' | 'info' | 'ok';
  title: string;
  body: string;
  traderId: number | null;
  at: number;
}

/**
 * 一个正在执行中的周期。
 *
 * 服务器已经按周期推了 `cycle_start` / `cycle_end`（`ServerEvent`），但界面以前只处理
 * 后者 —— 于是一轮 12 秒（实测 6.8–18.3 秒）的窗口里决策流什么都不显示，
 * 看起来就像"界面卡住了"。这里记住这一轮的身份与开始时刻，让决策流能把
 * 「正在请求模型」这一条钉在最上面。
 *
 * `startedAt` 用**事件自带的时间戳**而不是本地收到的时间：用本地时间的话，
 * 页面重连后补收到的 `cycle_start` 会被算成"刚刚开始"，等了 15 秒的那一轮
 * 会重新从 0 秒数起 —— 而这个读数的全部意义就是回答"它是不是卡住了"。
 */
export interface LiveCycle {
  cycleNumber: number;
  /** epoch ms —— `cycle_start` 事件的时间戳，组件用它算已等待秒数。 */
  startedAt: number;
}

export interface TraderLive {
  /** Last status pushed over the socket, if any. */
  status: TraderStatus | null;
  positions: PositionView[];
  /** Newest first, bounded. */
  orders: OrderRecord[];
  trades: TradeRecord[];
  /** Newest first, bounded — decision headers only. */
  decisions: DecisionRecord[];
  equity: EquitySnapshot[];
  lastEventAt: number | null;
  /** 正在请求模型的那一轮；没有进行中的周期时为 `undefined`。 */
  liveCycle?: LiveCycle;
}

const MAX_LOGS = 600;
const MAX_PER_TRADER = 120;

function emptyTraderLive(): TraderLive {
  return {
    status: null,
    positions: [],
    orders: [],
    trades: [],
    decisions: [],
    equity: [],
    lastEventAt: null,
  };
}

/**
 * 结束这一轮的在途标记。
 *
 * 三条路径都会走到这里（`decision` / `cycle_end` / 连接断开或机器人停止）。
 * 用一个函数而不是各写一遍 `{ liveCycle: undefined }`：**漏掉任何一条**都会留下
 * 一个永远转下去、和真实状态无关的转圈 —— 那比不显示还糟，因为它会让人相信
 * 系统还在工作。
 *
 * `cycleNumber` 只在调用方确实知道是哪一轮时才传：带上它就只会清掉**同一轮**的
 * 标记，一个迟到的旧周期事件不会把刚开始的新周期一起清掉。
 */
function clearLiveCycle(target: TraderLive, cycleNumber?: number): void {
  if (!target.liveCycle) return;
  if (cycleNumber !== undefined && target.liveCycle.cycleNumber !== cycleNumber) return;
  target.liveCycle = undefined;
}

/**
 * 连接断开 / 主动断开时，把所有机器人的在途标记一次清掉。
 *
 * 返回**同一个** `byTrader` 引用（没有标记可清时）：zustand 的 `set` 只要拿到同一个
 * 引用就不会触发重渲染，于是"断线时绝大多数情况下什么都不用做"这件事不需要额外的
 * 判断，也不会让所有读 `byTrader` 的组件白重渲染一次。
 */
function clearAllLiveCycles(byTrader: Record<number, TraderLive>): Record<number, TraderLive> {
  let changed = false;
  const next: Record<number, TraderLive> = {};
  for (const [key, live] of Object.entries(byTrader)) {
    if (!live.liveCycle) {
      next[Number(key)] = live;
      continue;
    }
    changed = true;
    next[Number(key)] = { ...live, liveCycle: undefined };
  }
  return changed ? next : byTrader;
}

interface EventState {
  status: SocketStatus;
  attempts: number;
  logs: LiveLogLine[];
  toasts: Toast[];
  byTrader: Record<number, TraderLive>;
  lastEventAt: number | null;

  connect: () => void;
  disconnect: () => void;
  ingest: (event: ServerEvent) => void;
  /**
   * 用一份 REST 拿到的持仓**覆盖**某个机器人的持仓。
   *
   * 存在的理由：手工平仓之后，界面必须**立刻**不再显示那个仓位。
   * 而 `byTrader` 平时只由 WebSocket 推送更新 —— 用户实测过：
   * 平仓成功了、界面却还留着那一行，于是他会以为没平掉、再按一次。
   * **操作员按下平仓之后的界面状态，不能依赖推送的到达时间。**
   */
  setPositions: (traderId: number, positions: PositionView[]) => void;
  hydrateLogs: (lines: LiveLogLine[]) => void;
  dismissToast: (id: number) => void;
  clearLogs: () => void;
  /** Raise a toast from outside the socket — used for REST-triggered actions. */
  notify: (input: { kind: Toast['kind']; title: string; body?: string; traderId?: number | null }) => void;
}

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let toastSeq = 1;
let logSeq = 1;

export const useEvents = create<EventState>((set, get) => ({
  status: 'idle',
  attempts: 0,
  logs: [],
  toasts: [],
  byTrader: {},
  lastEventAt: null,

  connect: () => {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    const token = getToken();
    if (!token) return;

    set({ status: 'connecting' });
    let ws: WebSocket;
    try {
      ws = new WebSocket(eventStreamUrl());
    } catch {
      set({ status: 'closed' });
      return;
    }
    socket = ws;

    ws.onopen = () => set({ status: 'open', attempts: 0 });

    ws.onmessage = (message) => {
      try {
        const event = JSON.parse(String(message.data)) as ServerEvent;
        get().ingest(event);
      } catch {
        /* malformed frame — ignore rather than tear down the stream */
      }
    };

    ws.onclose = () => {
      /*
       * 断了就必须把"正在请求模型"一起清掉。
       *
       * 周期跑在服务器的循环里，和这条连接无关 —— 连接断掉时那一轮**很可能还在跑**，
       * 但我们再也收不到它的 `cycle_end` 或 `decision` 了。留着这个转圈，
       * 秒数会一直往上走而没有任何东西能让它停：这正是"比不显示还糟"的那种状态。
       * 重连后如果那一轮仍在进行，页面会重新从 REST 拿到结果；拿不到就不显示。
       */
      set((state) => ({
        status: 'closed',
        byTrader: clearAllLiveCycles(state.byTrader),
      }));
      socket = null;
      if (!getToken()) return;
      // Exponential backoff capped at 15s, so a backend restart is transparent.
      const attempts = get().attempts + 1;
      set({ attempts });
      const delay = Math.min(15_000, 800 * 2 ** Math.min(attempts, 5));
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        get().connect();
      }, delay);
    };

    ws.onerror = () => {
      /* onclose always follows; reconnect is handled there */
    };
  },

  disconnect: () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
    set({ status: 'idle', attempts: 0, byTrader: clearAllLiveCycles(get().byTrader) });
  },

  /*
   * 用 REST 的结果覆盖持仓。**与推送无关** —— 见接口上的说明。
   */
  setPositions: (traderId, positions) =>
    set((state) => ({
      byTrader: {
        ...state.byTrader,
        [traderId]: { ...(state.byTrader[traderId] ?? emptyTraderLive()), positions },
      },
    })),

  ingest: (event) => {
    const now = Date.now();

    if (event.type === 'log') {
      const line: LiveLogLine = {
        id: logSeq++,
        traderId: event.traderId,
        level: event.level,
        message: event.message,
        /* 来源单独传 —— 界面用中文标签渲染，见 `logScopeLabel`。 */
        scope: event.scope,
        timestamp: event.timestamp,
      };
      set((state) => ({ logs: [...state.logs.slice(-(MAX_LOGS - 1)), line], lastEventAt: now }));
      return;
    }

    if (event.type === 'order') {
      const order = event.order;
      pushToast(set, {
        kind: 'order',
        // 标签而不是机器码：`purpose` / `status` 是持久化在 orders 表里的英文值，
        // 存储值不动，但界面上必须是中文（`stop_loss` → 止损，`FILLED` → 已成交）。
        title: `${orderPurposeLabel(order.purpose)} · ${sideLabel(order.side)} ${order.symbol}`,
        body: `${orderStatusLabel(order.status)}${order.error ? ` — ${order.error}` : ''} · 数量 ${order.quantity}`,
        traderId: event.traderId,
      });
    }

    if (event.type === 'trade') {
      const trade = event.trade;
      /*
       * 净盈亏, not the gross.
       *
       * The live toast is the first place a close is reported, and it used to
       * quote the gross — so a round-trip whose commission ate the whole move
       * ("+0.0011") was announced as a win. `netPnl` is what the balance did.
       * The fallback keeps a pre-upgrade server payload from throwing inside
       * the socket handler.
       */
      const net = typeof trade.netPnl === 'number' ? trade.netPnl : trade.pnl;
      const percent = typeof trade.pnlPercent === 'number' ? ` (${trade.pnlPercent >= 0 ? '+' : ''}${trade.pnlPercent.toFixed(2)}%)` : '';
      pushToast(set, {
        kind: 'trade',
        title: `已平仓 ${trade.symbol} ${sideLabel(trade.side)}`,
        body: `净 ${net >= 0 ? '+' : '-'}$${Math.abs(net).toFixed(2)}${percent} · 手续费 ${fmtSigned(
          -trade.fee,
          4,
        )} · ${closeReasonLabel(trade.closeReason)}`,
        traderId: event.traderId,
      });
    }

    if (event.type === 'trader_status') {
      const status = event.status;
      pushToast(set, {
        kind: status === 'error' ? 'error' : 'info',
        title: `机器人 #${event.traderId} → ${traderStatusLabel(status)}`,
        body: event.detail ?? '',
        traderId: event.traderId,
      });
    }

    /*
     * 「正在请求模型」的清除。
     *
     * 放在**状态 reducer 之外**、先于它执行，因为这里要清的是上一刻的状态：
     * `cycle_end` 的 reducer 还要用 `current.liveCycle` 之外的信息去补写本轮结果，
     * 两件事混在一个分支里容易漏。先清、再归约，两条路径互不干扰。
     *
     * `decision` 也清（而不是只等 `cycle_end`）：服务器允许在周期结束**之前**
     * 就推送决策记录，那时结果已经到页面上了，占位条必须让位，否则同一轮会出现
     * 两个条目。`cycle_end` 先到（结果稍后单独推）的情况同样被覆盖 ——
     * 这正是"失败周期也要落库"那次服务端改动之后的形态：`cycle_end` 到了、
     * `decision` 没有，占位条仍然必须消失。
     */
    set((state) => {
      const current = state.byTrader[event.traderId];
      if (!current?.liveCycle) return {};

      const next = { ...current };
      if (event.type === 'decision') clearLiveCycle(next, event.record.cycleNumber);
      else if (event.type === 'cycle_end') clearLiveCycle(next, event.cycleNumber);
      else if (event.type === 'trader_status' && event.status === 'stopped') clearLiveCycle(next);

      return next.liveCycle === current.liveCycle ? {} : { byTrader: { ...state.byTrader, [event.traderId]: next } };
    });

    set((state) => {
      const current = state.byTrader[event.traderId] ?? emptyTraderLive();
      const next: TraderLive = { ...current, lastEventAt: now };

      switch (event.type) {
        case 'cycle_start':
          /*
           * 直接用 `=` 赋值而不是比较新旧周期号：服务器在上一轮还没结束时会跳过
           * 本次调度（`cycleInFlight`），所以正常情况下不会出现"新一轮开始时旧的
           * 还没清"。真的出现了（比如 `cycle_end` 那一帧丢了），**新的一轮天然
           * 覆盖旧的一轮** —— 这正是我们要的：宁可只显示最新的那一轮，
           * 也不要留一个属于上一轮的转圈。
           */
          next.liveCycle = {
            cycleNumber: event.cycleNumber,
            startedAt: Number.isFinite(Date.parse(event.timestamp)) ? Date.parse(event.timestamp) : now,
          };
          break;
        case 'trader_status':
          next.status = event.status;
          break;
        case 'positions':
          next.positions = event.positions;
          break;
        case 'equity':
          next.equity = [...current.equity, event.snapshot].slice(-MAX_PER_TRADER * 4);
          break;
        case 'order':
          next.orders = [event.order, ...current.orders].slice(0, MAX_PER_TRADER);
          break;
        case 'trade':
          next.trades = [event.trade, ...current.trades].slice(0, MAX_PER_TRADER);
          break;
        case 'decision':
          next.decisions = [event.record, ...current.decisions].slice(0, MAX_PER_TRADER);
          break;
        case 'cycle_end':
          next.decisions = current.decisions.map((record, index) =>
            index === 0 && record.cycleNumber === event.cycleNumber && !record.success && !record.error
              ? { ...record, success: event.success, error: event.success ? null : event.summary }
              : record,
          );
          break;
        default:
          break;
      }

      return { byTrader: { ...state.byTrader, [event.traderId]: next }, lastEventAt: now };
    });
  },

  hydrateLogs: (lines) => {
    set({
      logs: [...lines]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .slice(-MAX_LOGS)
        .map((line) => ({ ...line, id: logSeq++ })),
    });
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  clearLogs: () => set({ logs: [] }),

  notify: (input) =>
    pushToast(set, {
      kind: input.kind,
      title: input.title,
      body: input.body ?? '',
      traderId: input.traderId ?? null,
    }),
}));

function pushToast(
  set: (updater: (state: EventState) => Partial<EventState>) => void,
  input: Omit<Toast, 'id' | 'at'>,
): void {
  const toast: Toast = { ...input, id: toastSeq++, at: Date.now() };
  set((state) => ({ toasts: [...state.toasts, toast].slice(-6) }));
  window.setTimeout(() => {
    useEvents.getState().dismissToast(toast.id);
  }, 7000);
}

/* -------------------------------------------------------------------------- */
/*  Selection helpers                                                          */
/* -------------------------------------------------------------------------- */

export function selectTraderLive(traderId: number | null): TraderLive {
  return useEvents((state) => (traderId === null ? undefined : state.byTrader[traderId])) ?? emptyTraderLive();
}

/**
 * 正在请求模型的那一轮，或者 `undefined`。
 *
 * 单独一个选择器（而不是让调用方自己 `selectTraderLive`）是有意的：它返回的是
 * 一个**引用稳定**的对象 —— `cycle_start` 时才换一次。决策流因此不会因为
 * 隔壁的持仓、订单、权益事件而重渲染，转圈的秒数也不会被别的事件打断。
 */
export function selectLiveCycle(traderId: number): LiveCycle | undefined {
  return useEvents((state) => state.byTrader[traderId]?.liveCycle);
}
