import WebSocket from 'ws';
import { createLogger } from '../logger.js';
import {
  buildUserStreamUrl,
  stalenessThresholdMs,
  type BinanceEndpoints,
} from './endpoints.js';
import type { BinanceRest } from './rest.js';
import { BinanceApiError } from './types.js';
import type {
  BinanceWsAccountConfigUpdateEvent,
  BinanceWsAccountUpdateEvent,
  BinanceWsListenKeyExpiredEvent,
  BinanceWsMarginCallEvent,
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
  stalenessWindowMs?: number;
  /**
   * 该流是否为“空闲静默属正常”的事件驱动流（例如 Binance User Data Stream）。
   *
   * - `false`（默认，行情流）：超过 `stalenessWindowMs` 无业务帧直接记 `ERROR` 并按故障退避重连；
   * - `true`（用户数据流）：空仓/无挂单时长时间无业务帧是正常的。只要近期仍持续收到服务端 WS `ping`
   *   心跳，说明传输层健康；超过 `stalenessWindowMs` 仍执行例行保活重连与状态对账（防止 listenKey
   *   静默失效），但记为 `INFO` 且不累加故障退避计数，避免空仓期间污染自检告警。
   */
  idleSilenceExpected?: boolean;
  /** 可选覆盖看门狗巡检周期（仅测试加速使用，默认 10,000ms）。 */
  watchdogIntervalMs?: number;
  /** Called once per successfully received data message. */
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
  private openedAt = 0;
  private lastMessageAt = 0;
  private lastPingAt = 0;
  private connectGen = 0;
  private lastDataByStream = new Map<string, number>();
  private watchdog: NodeJS.Timeout | null = null;
  private rotationTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(protected readonly options: ResilientStreamOptions) {}

  /** Proactive reconnect at 23h, safely inside Binance's 24-hour cap. */
  private static readonly ROTATE_AFTER_MS = 23 * 60 * 60 * 1000;
  private static readonly WATCHDOG_INTERVAL_MS = 10_000;
  /** Binance Futures 约每 3 分钟发送一次 WS ping；10 分钟内收到过即视为传输层存活。 */
  private static readonly IDLE_HEARTBEAT_MAX_AGE_MS = 10 * 60 * 1000;

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
    /* 代次号防止并发 connect() 跨 await 交错时泄漏孤儿 socket 与 rotationTimer。 */
    const gen = ++this.connectGen;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting', reason);

    let url: string;
    try {
      // Some streams (user data) need fresh credentials before their URL is valid.
      await this.options.beforeConnect?.();
      if (this.stopped || gen !== this.connectGen) return;
      url = await this.options.url();
      if (this.stopped || gen !== this.connectGen) return;
    } catch (error) {
      if (this.stopped || gen !== this.connectGen) return;
      log.error(`[${this.options.name}] 无法构造数据流地址`, error);
      this.scheduleReconnect('url-error');
      return;
    }

    await this.teardown();
    if (this.stopped || gen !== this.connectGen) return;

    const socket = new WebSocket(url, {
      handshakeTimeout: 15_000,
      // `ws` answers server pings automatically; this keeps our own keepalive
      // explicit and inside the "unsolicited pongs are allowed" allowance.
      followRedirects: true,
    });
    this.socket = socket;
    this.openedAt = 0;
    this.lastMessageAt = 0;
    this.lastPingAt = 0;

    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.openedAt = Date.now();
      log.info(`[${this.options.name}] 连接已建立（${reason}）`);
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
        log.info(`[${this.options.name}] 数据流已确认可用；重连退避已重置`);
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
      if (this.socket !== socket) return;
      this.lastPingAt = Date.now();
      // `ws` already replies with a pong; recording the timestamp proves transport liveness
      // for event-driven streams (like Binance user-data) when the account is flat/idle.
      log.debug(`[${this.options.name}] server ping`);
    });

    socket.on('pong', () => {
      if (this.socket !== socket) return;
      this.lastPingAt = Date.now();
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
      log.warn(`[${this.options.name}] 连接出错：${error.message}`);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      // 过期 socket 的关闭事件不代表当前连接断了，忽略。
      if (this.socket !== socket) return;
      const detail = `close ${code}${reason.length ? ` ${reason.toString()}` : ''}`;
      if (this.stopped) return;

      // A clean close or a planned rotation deserves an immediate retry;
      // anything else is a fault and backs off.
      const immediate = code === 1000;
      log.warn(`[${this.options.name}] 连接已断开：${detail}`);
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const delay = fullJitterBackoff(this.attempt);
    this.attempt += 1;
    log.warn(`[${this.options.name}] ${delay}ms 后重连（第 ${this.attempt} 次，原因：${reason}）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(reason);
    }, delay);
  }

  /**
   * Watchdog for silent failure. A socket can be `OPEN` and deliver nothing —
   * either because the URL is wrong or because a listenKey lapsed. Protocol
   * liveness cannot see this; only the absence of data can.
   */
  private startWatchdog(): void {
    const intervalMs = Math.max(20, this.options.watchdogIntervalMs ?? ResilientStream.WATCHDOG_INTERVAL_MS);
    this.watchdog = setInterval(() => {
      if (this.stopped) return;

      const hasRecentHeartbeat =
        this.options.idleSilenceExpected === true &&
        this.lastPingAt > 0 &&
        Date.now() - this.lastPingAt < ResilientStream.IDLE_HEARTBEAT_MAX_AGE_MS;

      /*
       * ⚠️ **也要盯住「握手成功但从未收到首帧」的静默僵尸连接（2026-11-23 P1 修复）**。
       *
       * `socket.on('open')` 刻意不把 `state` 翻成 `'live'`（要等首帧 `message`），
       * 原先 `if (this.state !== 'live') return;` 直接跳过了这类连接 —— 一旦 listenKey
       * 失效或路由错误导致握手成功但一直无消息，看门狗永远不重连。
       *
       * 但对事件驱动的 `user-data` 流（`idleSilenceExpected: true`），空仓且无挂单时
       * 几小时没有业务帧完全正常：若近期仍正常收到服务端 WS `ping` 心跳，则按 `INFO`
       * 执行例行保活刷新重连（兼做 `onOpen` 状态对账与 listenKey 续期），不记 `ERROR`、
       * 不污染健康自检；只有连心跳也丢失时才按真正僵尸连接记 `ERROR`。
       */
      if (this.state !== 'live') {
        if (this.socket?.readyState === WebSocket.OPEN && this.openedAt > 0) {
          const openSilence = Date.now() - this.openedAt;
          if (openSilence > this.stalenessWindowMs()) {
            if (hasRecentHeartbeat) {
              log.info(
                `[${this.options.name}] 账户空闲 ${Math.round(openSilence / 1000)}s 无首帧事件（WS 心跳正常）；执行例行保活重连与状态对账`,
              );
              void this.connect('idle-refresh');
            } else {
              log.error(
                `[${this.options.name}] 连接建立后 ${Math.round(openSilence / 1000)}s 未收到任何首帧数据；强制重连`,
              );
              this.attempt += 1;
              void this.connect('watchdog-open-silent');
            }
          }
        }
        return;
      }

      const silence = Date.now() - this.lastMessageAt;
      if (silence > this.stalenessWindowMs()) {
        if (hasRecentHeartbeat) {
          log.info(
            `[${this.options.name}] 账户空闲 ${Math.round(silence / 1000)}s 无新事件（WS 心跳正常）；执行例行保活重连与状态对账`,
          );
          void this.connect('idle-refresh');
        } else {
          log.error(
            `[${this.options.name}] no data for ${Math.round(silence / 1000)}s — socket is alive but silent; forcing reconnect`,
          );
          this.attempt += 1; // do not treat this as a healthy connection
          void this.connect('watchdog-stale');
        }
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
    }, intervalMs);
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
  private stopped = false;
  /** 生命周期代次号：串行化并作废并发的 start / restart / stop，防止孤儿 socket 泄漏。 */
  private lifecycleGen = 0;
  private readonly log = log;

  constructor(
    private readonly rest: BinanceRest,
    private readonly endpoints: BinanceEndpoints,
    private readonly handlers: UserStreamHandlers = {},
  ) {}

  async start(): Promise<void> {
    const gen = ++this.lifecycleGen;
    this.stopped = false;
    await this.stopSocket();
    if (this.stopped || gen !== this.lifecycleGen) return;

    const nextSocket = this.createSocket();
    this.socket = nextSocket;
    await nextSocket.start();
    if (this.stopped || gen !== this.lifecycleGen) {
      if (this.socket === nextSocket) this.socket = null;
      await nextSocket.stop().catch(() => undefined);
      return;
    }
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
      idleSilenceExpected: true,
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
    if (this.stopped) return;
    const gen = ++this.lifecycleGen;
    this.log.warn(`用户数据流重连（${reason}）`);
    await this.ensureListenKey();
    if (this.stopped || gen !== this.lifecycleGen) return;
    await this.stopSocket();
    if (this.stopped || gen !== this.lifecycleGen) return;
    const nextSocket = this.createSocket();
    this.socket = nextSocket;
    await nextSocket.start();
    if (this.stopped || gen !== this.lifecycleGen) {
      if (this.socket === nextSocket) this.socket = null;
      await nextSocket.stop().catch(() => undefined);
    }
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      void this.keepalive().catch((error) => {
        this.log.warn(`用户数据流保活异常：${(error as Error).message}`);
      });
    }, LISTEN_KEY_KEEPALIVE_MS);
  }

  /** Create or refresh the listenKey. Safe to call repeatedly. */
  async ensureListenKey(): Promise<string> {
    const response = await this.rest.keyedRequest<{ listenKey: string }>('POST', '/fapi/v1/listenKey');
    if (!response?.listenKey) throw new Error('Binance did not return a listenKey');
    if (this.listenKey && this.listenKey !== response.listenKey) {
      this.log.info('交易所已轮换用户数据流的密钥');
    }
    this.listenKey = response.listenKey;
    return response.listenKey;
  }

  /** Extend the key's life by 60 minutes. `-1125` means it lapsed — recreate. */
  async keepalive(): Promise<void> {
    if (this.stopped) return;
    try {
      const response = await this.rest.keyedRequest<{ listenKey: string }>('PUT', '/fapi/v1/listenKey');
      if (response?.listenKey) this.listenKey = response.listenKey;
    } catch (error) {
      if (this.stopped) return;
      const expired =
        error instanceof BinanceApiError && (error.code === -1125 || error.code === -1102);
      this.log.warn(`用户数据流密钥的保活失败（${(error as Error).message}）`);
      if (expired) {
        this.log.warn('用户数据流的密钥已过期；重新申请并重连');
        try {
          await this.restart('keepalive-lapsed');
          if (!this.stopped) await this.handlers.onListenKeyExpired?.();
        } catch (restartError) {
          this.log.warn(`用户数据流密钥过期后重连失败：${(restartError as Error).message}`);
        }
      }
    }
  }

  private async dispatch(payload: unknown): Promise<void> {
    if (this.stopped || typeof payload !== 'object' || payload === null) return;
    const event = payload as { e?: string };

    switch (event.e) {
      case 'ORDER_TRADE_UPDATE':
        this.handlers.onOrderUpdate?.(payload as BinanceWsOrderTradeEvent);
        return;
      case 'ACCOUNT_UPDATE':
        this.handlers.onAccountUpdate?.(payload as BinanceWsAccountUpdateEvent);
        return;
      case 'MARGIN_CALL':
        this.log.error('收到保证金追缴通知 —— 账户已接近强平，请立即处理', payload);
        this.handlers.onMarginCall?.(payload as BinanceWsMarginCallEvent);
        return;
      case 'ACCOUNT_CONFIG_UPDATE':
        this.handlers.onAccountConfigUpdate?.(payload as BinanceWsAccountConfigUpdateEvent);
        return;
      case 'listenKeyExpired':
        this.log.warn('收到密钥过期事件；重新申请并重连');
        void (payload as BinanceWsListenKeyExpiredEvent);
        try {
          await this.restart('listenKeyExpired-event');
          if (!this.stopped) await this.handlers.onListenKeyExpired?.();
        } catch (restartError) {
          this.log.warn(`listenKeyExpired 重连失败：${(restartError as Error).message}`);
        }
        return;
      default:
        this.log.debug(`unhandled user-data event: ${event.e ?? 'unknown'}`);
    }
  }

  get isLive(): boolean {
    return this.socket?.isLive ?? false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.lifecycleGen += 1;
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
