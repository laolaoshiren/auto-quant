/**
 * Gate.io API v4 的端点与环境。
 *
 * 合约（USDT 本位永续）与现货是**两套 base path**：
 *   · 现货 / 统一账户：`/api/v4/...`（本期不用）
 *   · USDT 永续：`/api/v4/futures/usdt/...`（本项目的交易对象）
 *
 * 测试网是**独立域名**，且只覆盖合约（`fx-api-testnet.gateio.ws`）——
 * 这一点与币安不同（币安测试网用 query 参数切）。所以环境是 base URL 级别的。
 */

export type GateEnvironment = 'live' | 'testnet';

export interface GateEndpoints {
  /** REST base（不带尾斜杠），例如 `https://api.gateio.ws/api/v4`。 */
  rest: string;
  /** WebSocket base（本期未接，保留给后续）。 */
  ws: string;
}

const LIVE: GateEndpoints = {
  rest: 'https://api.gateio.ws/api/v4',
  ws: 'wss://fx-ws.gateio.ws/v4/ws/usdt',
};

const TESTNET: GateEndpoints = {
  rest: 'https://api-testnet.gateapi.io/api/v4',
  ws: 'wss://ws-testnet.gateapi.io/v4/ws/usdt',
};

/** 把环境名解析成端点。未知值按 live 处理（宁可连错也别静默连测试网）。 */
export function resolveGateEndpoints(environment: GateEnvironment | string | null | undefined): GateEndpoints {
  return String(environment ?? 'live').toLowerCase() === 'testnet' ? TESTNET : LIVE;
}
