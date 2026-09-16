import WebSocket from 'ws';
import { createLogger } from '../logger.js';
import {
  buildMarketStreamUrl,
  buildUserStreamUrl,
  groupStreamsByRoute,
  stalenessThresholdMs,
  type BinanceEndpoints,
  type WsRoute,
} from './endpoints.js';
import type { BinanceRest } from './rest.js';
import { BinanceApiError } from './types.js';
import type {
  BinanceWsAccountConfigUpdateEvent,
  BinanceWsAccountUpdateEvent,
  BinanceWsKlineEvent,
  BinanceWsListenKeyExpiredEvent,
  BinanceWsMarginCallEvent,
  BinanceWsMarkPriceEvent,
  BinanceWsOrderTradeEvent,
} from './types.js';

const log = createLogger('binance:ws');

/* -------------------------------------------------------------------------- */
/*  Backoff                                                                    */
/* -------------------------------------------------------------------------- */

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 45_000;

/**
 * Full-jitter exponential backoff.
 *
 * Jitter is not decoration: without it, every bot instance that survived a
 * shared Binance outage reconnects in lockstep and stampedes the endpoint,
 * which is exactly how an IP ban starts.
 */
function fullJitterBackoff(attempt: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/*  Base class                                                                 */
/* -------------------------------------------------------------------------- */

export type StreamState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed';

export interface ResilientStreamOptions {
  name: string;
  /** Runs at the start of every connect attempt, before the URL is built. */
  beforeConnect?: () => Promise<void>;
  url: () => string | Promise<string>;
  /** Streams whose liveness is tracked; used to compute the staleness window. */
  watchedStreams?: () => string[];

  /**
   * 这条流的"多久没数据才算坏"窗口。
   *
   * 不传时按 `stalenessThresholdMs()` 从 `watchedStreams` 推导（市场数据流走这条路）。
   * **用户数据流必须显式传** —— 它是事件驱动的，账户空闲时长时间没有消息是正常的，
   * 用市场数据流的判据会不停地把健康连接掐掉（见 `createSocket()` 的说明）。
   */
  stalenessWindowMs?: number;  /** Called once per successfully received data message. */
  onData?: (stream: string, payload: unknown) => void;
  /** Called when the connection becomes live, and again when it is lost. */
  onStateChange?: (state: StreamState, detail: string) => void;
  /**
   * Called after every successful socket open — including the first. This is the
   * hook for reconciliation, which must happen on every (re)connect because
   * nothing guarantees we saw every event while disconnected.
   */
  onOpen?: (reason: string) => void | Promise<void>;
}

/**
 * A WebSocket that stays up.
 *
 * Handles the four things that actually break long-running Binance sockets:
 *
 *  1. **Silent zombie sockets.** A mis-routed URL connects and then never sends
 *     anything. Tracked per stream with `lastMessageAt`, checked by a watchdog.
 *  2. **The 24-hour connection cap.** Rotated proactively at 23 hours rather
 *     than waiting to be dropped mid-order.
 *  3. **Backoff that resets too early.** The attempt counter resets only after a
 *     real data message, never on the handshake — otherwise a permanently empty
 *     socket produces a tight reconnect loop.
 *  4. **Overlapping sockets.** The old socket is fully torn down (with a
 *     timeout) before a new one is dialled, so events are never double-counted.
 */
export class ResilientStream {
  protected socket: WebSocket | null = null;
  protected state: StreamState = 'idle';

  private attempt = 0;
  private stopped = true;
  private lastMessageAt = 0;
  private lastDataByStream = new Map<string, number>();
  private watchdog: NodeJS.Timeout | null = null;
  private rotationTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(protected readonly options: ResilientStreamOptions) {}

  /** Proactive reconnect at 23h, safely inside Binance's 24-hour cap. */
  private static readonly ROTATE_AFTER_MS = 23 * 60 * 60 * 1000;
  private static readonly WATCHDOG_INTERVAL_MS = 10_000;

  get currentState(): StreamState {
    return this.state;
  }

  /** True only when we have received real data recently — not merely on connect. */
  get isLive(): boolean {
    if (this.state !== 'live') return false;
    if (this.lastMessageAt === 0) return false;
    return Date.now() - this.lastMessageAt < this.stalenessWindowMs();
  }

  protected setState(state: StreamState, detail = ''): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state, detail);
  }

  private stalenessWindowMs(): number {
    // 调用方显式声明优先 —— 用户数据流靠这个摆脱市场数据流的判据。
    if (this.options.stalenessWindowMs !== undefined) return this.options.stalenessWindowMs;
    const streams = this.options.watchedStreams?.() ?? [];
    if (streams.length === 0) return 120_000;
    // Tolerate the slowest stream in the set, plus generous headroom.
    return Math.max(...streams.map(stalenessThresholdMs)) * 2;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    await this.connect('startup');
    this.startWatchdog();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.rotationTimer) clearTimeout(this.rotationTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.watchdog = null;
    this.rotationTimer = null;
    this.reconnectTimer = null;
    await this.teardown();
    this.setState('closed', 'stopped by caller');
  }

  private async connect(reason: string): Promise<void> {
    if (this.stopped) return;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting', reason);

    let url: string;
    try {
      // Some streams (user data) need fresh credentials before their URL is valid.
      await this.options.beforeConnect?.();
      url = await this.options.url();
    } catch (error) {
      log.error(`[${this.options.name}] could not prepare stream URL`, error);
      this.scheduleReconnect('url-error');
      return;
    }

    await this.teardown();

    const socket = new WebSocket(url, {
      handshakeTimeout: 15_000,
      // `ws` answers server pings automatically; this keeps our own keepalive
      // explicit and inside the "unsolicited pongs are allowed" allowance.
      followRedirects: true,
    });
    this.socket = socket;
    this.lastMessageAt = 0;

    socket.on('open', () => {
      log.info(`[${this.options.name}] socket open (${reason})`);
      // Deliberately NOT resetting `attempt` here. A routed-URL mistake yields an
      // open socket with no data; resetting now would spin forever.
      void this.options.onOpen?.(reason);
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      // 过期 socket 的数据不再更新状态（见上面对 close 处理器的说明）。
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
      if (this.attempt !== 0) {
        // First real bytes prove the connection is genuinely useful.
        log.info(`[${this.options.name}] stream verified live; backoff reset`);
        this.attempt = 0;
      }
      this.setState('live', 'receiving data');

      let envelope: { stream?: string; data?: unknown };
      try {
        envelope = JSON.parse(raw.toString()) as { stream?: string; data?: unknown };
      } catch {
        log.debug(`[${this.options.name}] ignored unparseable frame`);
        return;
      }

      const stream = envelope.stream ?? this.options.name;
      this.lastDataByStream.set(stream, Date.now());
      this.options.onData?.(stream, envelope.data ?? envelope);
    });

    socket.on('ping', () => {
      // `ws` already replies with a pong; this is only for observability.
      log.debug(`[${this.options.name}] server ping`);
    });

    /*
     * ⚠️ 下面三个处理器都必须先确认「这个事件是不是**当前** socket 发出来的」。
     *
     * 没有这个守卫时会出现**无限重连循环**：`connect()` 第一步就是
     * `await this.teardown()` 关掉上一个 socket（close code 1000），而那个
     * socket 的 `close` 处理器**仍然挂着**、`this.stopped` 也是 false，
     * 于是它触发一次"干净关闭 → 立刻重连"，新的 `connect()` 又关掉刚建好的
     * 那个 socket……每一轮都产生一条 `socket open (clean-close)` 与
     * `close 1000`，实测约每分钟一次，持续不断。
     *
     * 判据用引用相等：事件里的 socket 不是 `this.socket` 就说明它已经被取代，
     * 直接忽略。`message` 同理 —— 过期 socket 的数据不该再更新状态。
     */
    socket.on('error', (error: Error) => {
      if (this.socket !== socket) return;
      log.warn(`[${this.options.name}] socket error: ${error.message}`);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      // 过期 socket 的关闭事件不代表当前连接断了，忽略。
      if (this.socket !== socket) return;
      const detail = `close ${code}${reason.length ? ` ${reason.toString()}` : ''}`;
      if (this.stopped) return;

      // A clean close or a planned rotation deserves an immediate retry;
      // anything else is a fault and backs off.
      const immediate = code === 1000;
      log.warn(`[${this.options.name}] socket closed: ${detail}`);
      this.setState('reconnecting', detail);
      if (immediate) {
        void this.connect('clean-close');
      } else {
        this.scheduleReconnect(detail);
      }
    });

    this.rotationTimer = setTimeout(() => {
      log.info(`[${this.options.name}] proactive 23h rotation`);
      void this.connect('24h-rotation');
    }, ResilientStream.ROTATE_AFTER_MS);
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    const delay = fullJitterBackoff(this.attempt);
    this.attempt += 1;
    log.warn(`[${this.options.name}] reconnecting in ${delay}ms (attempt ${this.attempt}, ${reason})`);
    this.reconnectTimer = setTimeout(() => {
      void this.connect(reason);
    }, delay);
  }

  /**
   * Watchdog for silent failure. A socket can be `OPEN` and deliver nothing —
   * either because the URL is wrong or because a listenKey lapsed. Protocol
   * liveness cannot see this; only the absence of data can.
   */
  private startWatchdog(): void {
    this.watchdog = setInterval(() => {
      if (this.stopped || this.state !== 'live') return;

      const silence = Date.now() - this.lastMessageAt;
      if (silence > this.stalenessWindowMs()) {
        log.error(
          `[${this.options.name}] no data for ${Math.round(silence / 1000)}s — socket is alive but silent; forcing reconnect`,
        );
        this.attempt += 1; // do not treat this as a healthy connection
        void this.connect('watchdog-stale');
        return;
      }

      // Per-stream check catches the case where one stream on a shared socket
      // quietly stops while others keep the socket looking healthy.
      for (const stream of this.options.watchedStreams?.() ?? []) {
        const last = this.lastDataByStream.get(stream);
        if (last === undefined) continue;
        const threshold = stalenessThresholdMs(stream) * 3;
        if (Date.now() - last > threshold) {
          log.warn(
            `[${this.options.name}] stream ${stream} silent for ${Math.round((Date.now() - last) / 1000)}s`,
          );
          this.lastDataByStream.set(stream, Date.now());
        }
      }
    }, ResilientStream.WATCHDOG_INTERVAL_MS);
  }

  /** Close the current socket and wait for it to actually terminate. */
  private async teardown(): Promise<void> {
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;

    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(() => {
        try {
          socket.terminate();
        } catch {
          /* already gone */
        }
        resolve();
      }, 3000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        socket.close(1000, 'reconnect');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Market data stream                                                         */
/* -------------------------------------------------------------------------- */

export interface MarketStreamHandlers {
  onKline?: (event: BinanceWsKlineEvent) => void;
  onMarkPrice?: (event: BinanceWsMarkPriceEvent) => void;
  /** Raw escape hatch for stream types without a typed handler. */
  onMessage?: (stream: string, payload: unknown) => void;
  onStateChange?: (route: WsRoute, state: StreamState, detail: string) => void;
}

/**
 * Market data over the routed `/public` and `/market` endpoints.
 *
 * One socket per traffic class, matching Binance's own recommendation: the
 * high-frequency order-book feed cannot be allowed to delay kline or mark-price
 * delivery, and neither may be allowed to delay user-data events.
 */
export class BinanceMarketStream {
  private readonly sockets = new Map<WsRoute, ResilientStream>();

  constructor(
    private readonly endpoints: BinanceEndpoints,
    private readonly handlers: MarketStreamHandlers = {},
  ) {}

  async start(streams: string[]): Promise<void> {
    const grouped = groupStreamsByRoute(streams);

    for (const route of ['public', 'market'] as const) {
      const list = grouped[route];
      if (list.length === 0) continue;

      const stream = new ResilientStream({
        name: `market:${route}`,
        url: () => buildMarketStreamUrl(this.endpoints, route, list),
        watchedStreams: () => list,
        onStateChange: (state, detail) => this.handlers.onStateChange?.(route, state, detail),
        onData: (_streamName, payload) => this.dispatch(payload),
      });

      this.sockets.set(route, stream);
      await stream.start();
    }
  }

  private dispatch(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return;
    const event = payload as { e?: string };

    switch (event.e) {
      case 'kline':
        this.handlers.onKline?.(payload as BinanceWsKlineEvent);
        return;
      case 'markPriceUpdate':
        this.handlers.onMarkPrice?.(payload as BinanceWsMarkPriceEvent);
        return;
      default:
        this.handlers.onMessage?.(event.e ?? 'unknown', payload);
    }
  }

  async stop(): Promise<void> {
    await Promise.all([...this.sockets.values()].map((s) => s.stop()));
    this.sockets.clear();
  }

  /** Liveness across every market socket, for the readiness banner. */
  get isLive(): boolean {
    const all = [...this.sockets.values()];
    return all.length > 0 && all.some((s) => s.isLive);
  }
}

/* -------------------------------------------------------------------------- */
/*  User data stream                                                           */
/* -------------------------------------------------------------------------- */

export interface UserStreamHandlers {
  onOrderUpdate?: (event: BinanceWsOrderTradeEvent) => void;
  onAccountUpdate?: (event: BinanceWsAccountUpdateEvent) => void;
  onMarginCall?: (event: BinanceWsMarginCallEvent) => void;
  onAccountConfigUpdate?: (event: BinanceWsAccountConfigUpdateEvent) => void;
  /**
   * The listenKey lapsed. The socket is still open but permanently silent, so
   * the caller MUST recreate the key, reconnect, and re-fetch authoritative
   * order/position/balance state — events were lost.
   */
  onListenKeyExpired?: () => void | Promise<void>;
  /**
   * Fired after every successful user-data socket open. Because a drop means we
   * may have missed `ORDER_TRADE_UPDATE` frames entirely, the caller must
   * re-fetch open orders, positions and balance here rather than assume its
   * local view is still accurate.
   */
  onReconnected?: (reason: string) => void | Promise<void>;
  onStateChange?: (state: StreamState, detail: string) => void;
}

/** Keepalive every 30 minutes, against a 60-minute expiry. */
const LISTEN_KEY_KEEPALIVE_MS = 30 * 60 * 1000;

/**
 * User data stream, wrapping the listenKey lifecycle.
 *
 * `POST /fapi/v1/listenKey` is idempotent in a subtle way: calling it while a
 * key is already active returns the *same* key and extends its life by 60
 * minutes. So it is safe both as "create" and as "refresh".
 */
export class BinanceUserDataStream {
  private socket: ResilientStream | null = null;
  private listenKey: string | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private readonly log = log;

  constructor(
    private readonly rest: BinanceRest,
    private readonly endpoints: BinanceEndpoints,
    private readonly handlers: UserStreamHandlers = {},
  ) {}

  async start(): Promise<void> {
    // Idempotent on purpose, and not merely as a courtesy.
    //
    // `start()` used to overwrite `this.socket` with a brand-new
    // `ResilientStream` unconditionally. Every caller that restarts the stream —
    // `keepalive()` on a lapsed key, the `listenKeyExpired` event path, and any
    // future one — therefore orphaned the previous object: its socket stayed
    // connected (so Binance kept delivering user-data frames), its 10-second
    // watchdog interval stayed scheduled, and both copies dispatched the same
    // `ORDER_TRADE_UPDATE` / `MARGIN_CALL` events. Bots that reconnect often
    // accumulate one live socket and one leaked timer per partition.
    //
    // Stopping first fixes both: exactly one socket and exactly one watchdog,
    // and the old key's frames stop arriving before the new key is dialled.
    await this.stopSocket();

    this.socket = this.createSocket();
    await this.socket.start();
    this.startKeepalive();
  }

  /** Build a fresh resilient stream over the current `listenKey`. */
  private createSocket(): ResilientStream {
    return new ResilientStream({
      name: 'user-data',
      /*
       * 用户数据流**不能**用市场数据流那套"多久没数据就算坏"的判据。
       *
       * Binance 只在这个账户真的发生变化时推送 `ACCOUNT_UPDATE` /
       * `ORDER_TRADE_UPDATE` —— **空仓、无委托时长时间没有消息是完全正常的**。
       * 用默认的 120 秒窗口会让看门狗每两分钟就判定"连接僵死"并强制重连，
       * 实测每 5 分钟一轮、10 分钟 76 次 `clean-close`。
       *
       * 55 分钟：低于 listenKey 的 60 分钟有效期，所以"密钥失效导致的开着但不发数据"
       * 仍然抓得到；而账户空闲时不会再把健康连接掐掉。
       * 真正断掉的 TCP 由 `ws` 库的 ping/pong 负责发现，不需要这个看门狗。
       */
      stalenessWindowMs: 55 * 60 * 1000,
      // Recreate or refresh the key before every dial. A dial can follow a lapse,
      // and a stale key yields an open-but-silent socket.
      beforeConnect: async () => {
        await this.ensureListenKey();
      },
      url: () => {
        if (!this.listenKey) throw new Error('listenKey not initialised');
        return buildUserStreamUrl(this.endpoints, this.listenKey);
      },
      onStateChange: (state, detail) => this.handlers.onStateChange?.(state, detail),
      onData: (_stream, payload) => void this.dispatch(payload),
      onOpen: async (reason) => {
        await this.handlers.onReconnected?.(reason);
      },
    });
  }

  /**
   * Tear down the current stream, if any.
   *
   * Single place that owns "there is no live socket", so the three restart
   * paths cannot each get the teardown order slightly different.
   */
  private async stopSocket(): Promise<void> {
    const previous = this.socket;
    this.socket = null;
    if (!previous) return;
    await previous.stop().catch((error) => {
      this.log.warn(`停止旧的用户数据流失败：${(error as Error).message}`);
    });
  }

  /** Recreate the key and dial a fresh socket, replacing any live one. */
  private async restart(reason: string): Promise<void> {
    this.log.warn(`用户数据流重连（${reason}）`);
    await this.ensureListenKey();
    await this.stopSocket();
    this.socket = this.createSocket();
    await this.socket.start();
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      void this.keepalive();
    }, LISTEN_KEY_KEEPALIVE_MS);
  }

  /** Create or refresh the listenKey. Safe to call repeatedly. */
  async ensureListenKey(): Promise<string> {
    const response = await this.rest.keyedRequest<{ listenKey: string }>('POST', '/fapi/v1/listenKey');
    if (!response?.listenKey) throw new Error('Binance did not return a listenKey');
    if (this.listenKey && this.listenKey !== response.listenKey) {
      this.log.info('listenKey rotated by the server');
    }
    this.listenKey = response.listenKey;
    return response.listenKey;
  }

  /** Extend the key's life by 60 minutes. `-1125` means it lapsed — recreate. */
  async keepalive(): Promise<void> {
    try {
      const response = await this.rest.keyedRequest<{ listenKey: string }>('PUT', '/fapi/v1/listenKey');
      if (response?.listenKey) this.listenKey = response.listenKey;
    } catch (error) {
      const expired =
        error instanceof BinanceApiError && (error.code === -1125 || error.code === -1102);
      this.log.warn(`listenKey keepalive failed (${(error as Error).message})`);
      if (expired) {
        this.log.warn('listenKey expired; recreating and reconnecting');
        await this.restart('keepalive-lapsed');
        await this.handlers.onListenKeyExpired?.();
      }
    }
  }

  private async dispatch(payload: unknown): Promise<void> {
    if (typeof payload !== 'object' || payload === null) return;
    const event = payload as { e?: string };

    switch (event.e) {
      case 'ORDER_TRADE_UPDATE':
        this.handlers.onOrderUpdate?.(payload as BinanceWsOrderTradeEvent);
        return;
      case 'ACCOUNT_UPDATE':
        this.handlers.onAccountUpdate?.(payload as BinanceWsAccountUpdateEvent);
        return;
      case 'MARGIN_CALL':
        this.log.error('MARGIN CALL received — the account is close to liquidation', payload);
        this.handlers.onMarginCall?.(payload as BinanceWsMarginCallEvent);
        return;
      case 'ACCOUNT_CONFIG_UPDATE':
        this.handlers.onAccountConfigUpdate?.(payload as BinanceWsAccountConfigUpdateEvent);
        return;
      case 'listenKeyExpired':
        this.log.warn('listenKeyExpired event received — recreating key and reconnecting');
        void (payload as BinanceWsListenKeyExpiredEvent);
        await this.restart('listenKeyExpired-event');
        await this.handlers.onListenKeyExpired?.();
        return;
      default:
        this.log.debug(`unhandled user-data event: ${event.e ?? 'unknown'}`);
    }
  }

  get isLive(): boolean {
    return this.socket?.isLive ?? false;
  }

  async stop(): Promise<void> {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    await this.stopSocket();
    // Release the server-side key so another process can take over cleanly.
    try {
      await this.rest.keyedRequest('DELETE', '/fapi/v1/listenKey');
    } catch {
      /* best effort */
    }
    this.listenKey = null;
  }
}

export { sleep as sleepMs };
