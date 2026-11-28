import { ExchangeIdSchema, TIMEFRAMES, TimeframeSchema, type ServerEvent } from '@aq/shared';
import { eventBus } from '../../events.js';
import { createLogger } from '../../logger.js';
import { extractToken, verifyToken } from '../auth.js';
import type { RouteContext } from './context.js';

const log = createLogger('api');

export function registerMarketEventsRoutes(ctx: RouteContext): void {
  const { app, deps, authed, tokenRevoked, activeWsClients, getPublicGateMarket } = ctx;

  /* --- Public market data ------------------------------------------------ */

  app.get('/api/market/symbols', authed, async (request, reply) => {
    const rawExchange = (request.query as { exchange?: string }).exchange;
    const exchangeParsed = rawExchange ? ExchangeIdSchema.safeParse(rawExchange) : { success: true as const, data: 'binance' as const };
    if (!exchangeParsed.success) {
      return reply.code(400).send({ error: `不支持的交易所：${rawExchange}` });
    }
    if (exchangeParsed.data === 'gate') {
      try {
        const { market } = await getPublicGateMarket();
        const [infos, tickers] = await Promise.all([
          market.contractInfos(),
          market.ticker24h().catch(() => []),
        ]);
        const bySymbol = new Map(tickers.map((t) => [t.symbol, t]));
        return infos
          .map((info) => {
            const ticker = bySymbol.get(info.symbol);
            const baseAsset = info.contract.split('_')[0] ?? info.symbol;
            return {
              symbol: info.symbol,
              baseAsset,
              price: Number(ticker?.lastPrice ?? 0),
              changePercent24h: Number(ticker?.priceChangePercent ?? 0),
              quoteVolume24h: Number(ticker?.quoteVolume ?? 0),
              minNotional: 0,
            };
          })
          .filter((s) => s.quoteVolume24h > 0)
          .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
      } catch (error) {
        return reply.code(502).send({ error: `读取 Gate 行情失败：${(error as Error).message}` });
      }
    }
    const registry = deps.publicConnection.registry;
    const tickers = await deps.publicConnection.market.ticker24h().catch(() => []);
    const bySymbol = new Map(tickers.map((t) => [t.symbol, t]));
    return registry
      .all()
      .map((info) => {
        const ticker = bySymbol.get(info.symbol);
        return {
          symbol: info.symbol,
          baseAsset: info.baseAsset,
          price: Number(ticker?.lastPrice ?? 0),
          changePercent24h: Number(ticker?.priceChangePercent ?? 0),
          quoteVolume24h: Number(ticker?.quoteVolume ?? 0),
          minNotional: info.minNotional,
        };
      })
      .filter((s) => s.quoteVolume24h > 0)
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
  });

  app.get('/api/market/klines', authed, async (request, reply) => {
    const query = request.query as { symbol?: string; interval?: string; limit?: string; exchange?: string };
    if (!query.symbol || typeof query.symbol !== 'string') {
      return reply.code(400).send({ error: '缺少 symbol 参数' });
    }
    const symbol = query.symbol.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,30}$/.test(symbol)) {
      return reply.code(400).send({ error: `无效的合约符号：${query.symbol}` });
    }
    const exchangeParsed = query.exchange
      ? ExchangeIdSchema.safeParse(query.exchange)
      : { success: true as const, data: 'binance' as const };
    if (!exchangeParsed.success) {
      return reply.code(400).send({ error: `不支持的交易所：${query.exchange}` });
    }
    const interval = TimeframeSchema.safeParse(query.interval ?? '15m');
    if (!interval.success) {
      return reply
        .code(400)
        .send({ error: `interval 必须是：${TIMEFRAMES.join(' / ')}` });
    }
    const rawLimit = Number(query.limit ?? 200);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), 1000)
      : 200;
    try {
      if (exchangeParsed.data === 'gate') {
        const { market } = await getPublicGateMarket();
        return await market.klines(symbol, interval.data, limit);
      }
      return await deps.publicConnection.market.klines(symbol, interval.data, limit);
    } catch (error) {
      const msg = (error as Error).message;
      const isBadRequest = /invalid symbol|unknown|不支持|not found|-1121|INVALID_PARAM/i.test(msg);
      return reply.code(isBadRequest ? 400 : 502).send({ error: msg });
    }
  });

  /* --- Live event stream ------------------------------------------------- */

  app.get('/api/events', { websocket: true }, (socket, request) => {
    try {
      // 这是**唯一**允许从查询参数取令牌的地方（浏览器的 WebSocket 构造函数
      // 无法设置请求头）。HTTP 路由一律只认 Authorization 头，见 auth.ts。
      const token = extractToken(request, { allowQueryToken: true });
      if (!token) {
        socket.close(1008, '需要登录');
        return;
      }
      const payload = verifyToken(token, deps.jwtSecret);
      if (!payload || tokenRevoked(payload)) {
        socket.close(1008, 'Invalid session');
        return;
      }

      const WS_MAX_BUFFERED_BYTES = 1024 * 1024;
      const safeSend = (data: string): void => {
        if (socket.readyState !== socket.OPEN) return;
        if (socket.bufferedAmount > WS_MAX_BUFFERED_BYTES) return;
        socket.send(data);
      };

      for (const event of eventBus.history(30)) {
        safeSend(JSON.stringify({ ...event, replay: true }));
      }

      const unsubscribe = eventBus.subscribe((event: ServerEvent) => {
        safeSend(JSON.stringify(event));
      });

      /*
       * ⚠️ **心跳同时负责三件事（2026-11-23 P0 安全/泄漏修复）**：
       *   1. 防止 nginx 60s 空闲断连；
       *   2. 校验 `pong` 响应：半开网络断开时立刻 `terminate()` 释放定时器与 `eventBus` 订阅；
       *   3. 周期性复检会话有效性（到期或管理员修改密码吊销令牌）→ 立刻以 1008 关闭旧 WS，
       *      防止改密码后泄漏会话继续实时收取持仓/成交/日志推送。
       */
      let isAlive = true;
      socket.on('pong', () => {
        isAlive = true;
      });

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        unsubscribe();
        const set = activeWsClients.get(payload.sub);
        if (set) {
          set.delete(revokeClose);
          if (set.size === 0) activeWsClients.delete(payload.sub);
        }
      };

      const revokeClose = () => {
        cleanup();
        try {
          socket.close(1008, 'Invalid session');
        } catch {
          /* socket already closed */
        }
      };

      let userSockets = activeWsClients.get(payload.sub);
      if (!userSockets) {
        userSockets = new Set();
        activeWsClients.set(payload.sub, userSockets);
      }
      userSockets.add(revokeClose);

      const heartbeat = setInterval(() => {
        if (socket.readyState !== socket.OPEN) {
          cleanup();
          return;
        }
        if (payload.exp * 1000 < Date.now() || tokenRevoked(payload)) {
          revokeClose();
          return;
        }
        if (!isAlive) {
          cleanup();
          socket.terminate();
          return;
        }
        isAlive = false;
        socket.ping();
      }, 30_000);

      socket.on('close', cleanup);
      socket.on('error', cleanup);
    } catch (error) {
      log.warn(`/api/events WebSocket 初始化失败：${(error as Error).message}`);
      try {
        socket.close(1008, 'Invalid session');
      } catch {
        /* socket already closed */
      }
    }
  });

}
