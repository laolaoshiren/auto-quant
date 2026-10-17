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
  /**
   * **上一次成功读到 `system` 的时刻**（epoch ms）；`null` = 从来没成功过。
   *
   * ## 为什么要有它（2026-10-17 · 台账 FRD-01）
   *
   * `refreshSystem()` 失败时**保留上一份快照**是刻意的（弹一个"读不到"比把顶栏
   * 清空更接近事实），但它原来连**失败这件事**都不记：`catch {}` 里什么都不写。
   * 于是后端不可达之后，顶栏继续显示「实盘」「推送在线」、状态栏继续显示「运行 1」——
   * **真实资金场景下「看起来还活着」**，而界面自己不知道它手里的数是旧的。
   *
   * 现在失败写 `systemError`、成功清它；外壳据此算"停更了多少秒"（见
   * `lib/staleness.ts`，阈值是 3 × 轮询间隔）。
   */
  systemsLoadedAt: number | null;
  /** 最近一次系统状态刷新失败的原因；`null` = 最近一次是成功的。 */
  systemError: string | null;

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
  systemsLoadedAt: null,
  systemError: null,

  /** Verify a stored token and load the shell prerequisites in one pass. */
  bootstrap: async () => {
    setUnauthorizedHandler(() => {
      clearToken();
      set({ status: 'anonymous', user: null });
      /*
       * ⚠️ **会话失效时把推送也关掉**（台账 FRD-03）。
       *
       * 401 原来只清 token、不动 socket，于是 `socket.status` 停在 `'closed'`
       * （`onclose` 里那句 `if (!getToken()) return;` 让重连**永远不发生**）——
       * 界面显示"推送断开 · 轮询兜底"，而实际上**没有任何机制能让它恢复**：
       * 重新登录后 `bootstrap()` 也不会再 `connect()`。
       * 这里显式 disconnect：状态回到 `idle`（= 还没连、不是"连过又断了"），
       * 并给出原因，登录成功后由下面的 `connect()` 重新建立。
       */
      useEvents.getState().disconnect('会话已失效，请重新登录');
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
      /*
       * 认证成功 = "现在可以连推送了"。**这里必须主动连**：那个连接的生命周期
       * 归外壳的 `useEffect`（`[connect, disconnect]` 引用稳定 → 只跑一次），
       * 而它跑的时候可能还没有 token（首屏 `bootstrap()` 还没回来）——
       * 那种情况下 `connect()` 会早返回，之后就再也没人叫它了（台账 FRD-03）。
       */
      useEvents.getState().connect();
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
    /* 登出必须把推送也关掉并说明原因 —— 否则界面会一直显示"正在重连"（台账 FRD-03）。 */
    useEvents.getState().disconnect('已退出登录，推送已关闭');
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
      /* 成功：清错误并记下时刻 —— 外壳据此回答"这份读数有多旧"。 */
      set({ system, systemsLoadedAt: Date.now(), systemError: null });
    } catch (error) {
      /*
       * 保留上一份快照（刻意），但**必须把失败记下来** —— 见 `systemsLoadedAt`
       * 的说明。只留一份"看起来正常"的旧快照是本条缺陷的全部内容。
       */
      set({ systemError: (error as Error).message });
    }
  },

  refreshTraders: async () => {
    try {
      const traders = await api.traders();
      set({ traders });
    } catch (error) {
      /* 与 `refreshSystem` 同一条纪律：失败必须留痕（同一个轮询周期里两者一起失败）。 */
      set({ systemError: (error as Error).message });
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
  /**
   * **这一轮正在做的事，逐条累积**（`cycle_step` 事件）。
   *
   * ## 为什么放在 `liveCycle` 里而不是 `TraderLive` 上
   *
   * 它属于**某一轮**，轮次结束就该跟着消失 —— 挂在 `liveCycle` 上，
   * 就自动继承了 `clearLiveCycle` 已有的三条清理路径（`decision` / `cycle_end` /
   * 断开连接）。挂在外面则要再造一套"什么时候清"的判断，而那正是
   * `clearLiveCycle` 那段注释警告过的坑：**漏一条就留下一个与真实状态无关的残留**。
   *
   * ## 为什么只留最近 N 条
   *
   * 一轮可能推几十条。界面折叠时只显示**最后一条**（"现在在做什么"），
   * 展开才看全 —— 所以留一个够看的窗口即可，不无限增长。
   */
  steps: { at: string; level: 'info' | 'warn' | 'error'; message: string }[];
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
/** 一轮在界面上保留的**步骤**条数上限 —— 折叠时只看最后一条，展开看这一窗也够。 */
const MAX_CYCLE_STEPS = 60;
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
  /**
   * **"没能连上"的原因**（`null` = 没这回事）。
   *
   * 台账 FRD-03：`connect()` 原来在拿不到 token 时**静默 return** ——
   * 不置状态、不发事件、不留痕迹。于是界面显示的是"推送断开 · 轮询兜底"，
   * 而真相是"**根本还没登录**，连都没连过"。这两句话对操作员的意义相反：
   * 前者意味着等一会儿会自己好，后者意味着需要他去登录。
   */
  blockedReason: string | null;

  connect: () => void;
  /** `reason` = 这次断开是**有原因**的（会话失效 / 登出），界面上要说出来。 */
  disconnect: (reason?: string | null) => void;
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
  blockedReason: null,

  connect: () => {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    const token = getToken();
    if (!token) {
      /*
       * ⚠️ **不能静默 return**（台账 FRD-03）。
       *
       * 这是"从未连过"与"连过又断了"的分界：前者要操作员去登录，后者等重连即可。
       * 状态置 `closed` 而不是留在 `idle`：`idle` 表示"还没打算连"，
       * 而这里已经打算连了、只是缺凭据。
       */
      set({ status: 'closed', blockedReason: '未登录，推送不可用' });
      return;
    }

    set({ status: 'connecting', blockedReason: null });
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
      if (!getToken()) {
        /* 没凭据了（会话失效 / 登出）：说清原因，别显示成"等重连就好"。 */
        set({ blockedReason: '未登录，推送不可用' });
        return;
      }
      // Exponential backoff capped at 15s, so a backend restart is transparent.
      const attempts = get().attempts + 1;
      set({ attempts, blockedReason: null });
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

  disconnect: (reason = null) => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
    set({
      status: 'idle',
      attempts: 0,
      blockedReason: reason,
      byTrader: clearAllLiveCycles(get().byTrader),
    });
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

    /*
     * ⚠️ **重放的历史事件不弹通知、也不追加日志。**
     *
     * 服务端在连接建立时重放最近 30 条事件（免得新打开的页面是空的），而它们是
     * 几分钟甚至几小时前发生的。原来客户端一视同仁 —— 于是**每刷新一次页面，
     * 右下角就弹一轮「已平仓 ETHUSDT」「委托 · 平仓」，内容还是过时的**。
     * 操作员实测到的正是这个（"每次刷新都弹，弹的全是旧消息"）。
     *
     * 只跳过这三类**会留下痕迹**的事件：
     *
     *   · `log` / `order` / `trade` —— 会往列表里追加、或弹通知；
     *   · 而 `positions` / `equity` / `trader_status` / `decision` **照常处理** ——
     *     它们的作用正是给新开的页面一个初值，跳过反而让页面空着。
     *
     * 区别不在内容，**在它是不是刚刚发生的** —— 而那正是界面做不做提示的依据。
     */
    if (event.replay === true && (event.type === 'log' || event.type === 'order' || event.type === 'trade')) {
      return;
    }

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
        )} · ${closeReasonLabel(trade.closeReason, net)}`,
        traderId: event.traderId,
      });
    }

    if (event.type === 'trader_status') {
      const status = event.status;
      /*
       * ⚠️ **重放的历史不弹通知 —— 但状态照常更新。**
       *
       * 这一类与上面三类不同，所以**不能**在 `ingest` 开头一并 `return`：
       * `trader_status` 除了弹通知，还要更新 `byTrader[id].status`（在下面的
       * reducer 里）—— 那是新开页面拿到"这台机器人现在是什么状态"的初值来源，
       * 跳过它会让界面停在上一次会话的旧状态上。
       *
       * 实测：每次刷新页面都会看到「机器人 #9 → 启动中」和「→ 运行中」两条提示，
       * 而它们是**几小时前那次服务重启**留下的历史 —— 重放的 30 条里就带着这一对，
       * 于是每刷新一次就播一遍。
       */
      if (event.replay !== true) {
        pushToast(set, {
          kind: status === 'error' ? 'error' : 'info',
          title: `机器人 #${event.traderId} → ${traderStatusLabel(status)}`,
          body: event.detail ?? '',
          traderId: event.traderId,
        });
      }
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
            steps: [],
          };
          break;
        /*
         * 一轮**内部**的每一步 —— 用户 2026-10-10 要的"能展开看系统到底在做什么"。
         *
         * 只认**同一轮**的步骤：迟到的旧轮步骤不该混进新一轮的列表里
         *（与 `clearLiveCycle` 的 `cycleNumber` 校验同一个理由）。
         */
        case 'cycle_step':
          if (next.liveCycle && next.liveCycle.cycleNumber === event.cycleNumber) {
            /*
             * ⚠️ **必须替换 `liveCycle` 的引用，不能原地改**（外部 issue #157）。
             *
             * 原来写的是 `next.liveCycle.steps = [...]` —— 换了数组、**没换 `liveCycle`**。
             * 而 `next` 本身是浅拷贝（上面的 `{ ...current }`），所以 `liveCycle`
             * 的引用与改动前**完全相同**。
             *
             * zustand 用 `Object.is` 比较**选择器的返回值**，而 `useLiveCycle` 的选择器是：
             *
             * ```ts
             * useEvents((state) => state.byTrader[traderId]?.liveCycle)   // 见文件末尾
             * ```
             *
             * 引用不变 → 判定相等 → **不通知订阅者**。
             *
             * ## 影响面（issue 报的"静默不重渲染"目前看不到，但它是潜伏缺陷）
             *
             * `TraderPage` 订阅的是整个 `byTrader[traderId]`，而那个对象每次都被替换，
             * 所以步骤**照样刷新**。可是一旦有人给 `DecisionFeed` 加 `memo`、
             * 或改成只订阅 `useLiveCycle`（都是正常重构），**立刻变成真故障**。
             *
             * ## 更本质的代价：它破坏"历史快照不可变"
             *
             * 原地改会让**改动前拿到的引用也看到新数据** —— 任何依赖"我拿到的是那一刻的状态"
             * 的代码（`useMemo` 依赖比较、将来的 diff/undo）都会拿到错的东西。
             *
             * 对照：同一个函数里的 `case 'cycle_start'` 用的就是
             * `next.liveCycle = { ... }` —— **替换引用**。两者必须一致。
             */
            next.liveCycle = {
              ...next.liveCycle,
              steps: [...next.liveCycle.steps, {
                at: event.at,
                level: event.level,
                message: event.message,
                /* 团队模式会带角色与阶段；其他模式是 `undefined`（界面据此判断）。 */
                ...(event.role !== undefined ? { role: event.role } : {}),
                ...(event.phase !== undefined ? { phase: event.phase } : {}),
              }].slice(-MAX_CYCLE_STEPS),
            };
          }
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

/**
 * ⚠️ **这两个是 hook，名字必须以 `use` 开头。**
 *
 * 它们内部调用 `useEvents`（zustand 的 hook），所以**只能在组件的顶层调用**。
 * 原来的名字是 `selectTraderLive` / `selectLiveCycle` —— 读起来像普通选择器，
 * 调用方没有任何线索知道"把它放进 `if` 里会崩"。
 *
 * 而更糟的是机制层面的后果：`react-hooks/rules-of-hooks` 只认 `use` 前缀，
 * 名字不带前缀时**这条规则根本不会检查它们的调用点**（它以为那是普通函数）。
 * 也就是说这个命名把一整类崩溃挡在了检查之外 —— 是 `npm run lint` 把它翻出来的。
 */
export function useTraderLive(traderId: number | null): TraderLive {
  return useEvents((state) => (traderId === null ? undefined : state.byTrader[traderId])) ?? emptyTraderLive();
}

/**
 * 正在请求模型的那一轮，或者 `undefined`。
 *
 * 单独一个选择器（而不是让调用方自己 `useTraderLive`）是有意的：它返回的是
 * 一个**引用稳定**的对象 —— `cycle_start` 时才换一次。决策流因此不会因为
 * 隔壁的持仓、订单、权益事件而重渲染，转圈的秒数也不会被别的事件打断。
 */
export function useLiveCycle(traderId: number): LiveCycle | undefined {
  return useEvents((state) => state.byTrader[traderId]?.liveCycle);
}
