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
}

const MAX_LOGS = 600;
const MAX_PER_TRADER = 120;

function emptyTraderLive(): TraderLive {
  return { status: null, positions: [], orders: [], trades: [], decisions: [], equity: [], lastEventAt: null };
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
      set({ status: 'closed' });
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
    set({ status: 'idle', attempts: 0 });
  },

  ingest: (event) => {
    const now = Date.now();

    if (event.type === 'log') {
      const line: LiveLogLine = {
        id: logSeq++,
        traderId: event.traderId,
        level: event.level,
        message: event.message,
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

    set((state) => {
      const current = state.byTrader[event.traderId] ?? emptyTraderLive();
      const next: TraderLive = { ...current, lastEventAt: now };

      switch (event.type) {
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
