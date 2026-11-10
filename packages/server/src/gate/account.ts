/**
 * Gate.io USDT 永续 → 本项目领域对象（`AccountState` / `ExchangePosition`）的读取与映射。
 *
 * ## 两个必须记住的 Gate 差异
 *
 * 1. **数量是"张数"不是"币数"**：`size` 张 × `quanto_multiplier`（一张面值多少个币）
 *    = 币数。任何"数量"进出 Gate 都要过一次这个换算，否则数量会差几十倍
 *    （BTC_USDT 的 quanto_multiplier 是 0.0001，即 1 张 = 0.0001 BTC）。
 * 2. **符号在符号位**：`size` 有符号（正=多/买，负=空/卖），本项目用 `side` 字段
 *    + 正的 `quantity` 表达方向，所以映射时取绝对值。
 *
 * ## 为什么映射写成纯函数
 *
 * 映射是最容易出错、也最适合被单测钉住的部分（Gate 加字段/改字符串格式时，
 * 这里会先坏）。把 HTTP 与映射分开：`GateAccountReader` 只负责取数，
 * `mapBalance` / `mapPosition` 是纯函数，测试不需要 mock 网络。
 */
import type { AccountState } from '../binance/account.js';
import type { ExchangePosition } from '../binance/broker.js';
import type { GateFuturesAccount, GateFuturesContract, GateFuturesPosition } from './types.js';
import type { GateRest } from './rest.js';

/** `BTC_USDT` → `BTCUSDT`（本项目的 symbol 一律无下划线）。 */
export function gateContractToSymbol(contract: string): string {
  return contract.replace(/_/g, '').toUpperCase();
}

/** `BTCUSDT` → `BTC_USDT`。 */
export function symbolToGateContract(symbol: string): string {
  const upper = symbol.toUpperCase();
  if (upper.endsWith('USDT')) return `${upper.slice(0, -4)}_USDT`;
  return upper;
}

/**
 * Gate 的数值是十进制字符串（还可能给空串/`null`）。
 * 转不出来就返回 0 —— 映射层不该抛，坏数据要能被上层看到"是 0"而不是崩。
 */
export function num(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string' || value.trim() === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 合约账户 → `AccountState`。
 *
 * Gate 的 `total` = 钱包余额 + 未实现盈亏（保证金余额语义，与本项目 `equity` 一致），
 * 所以钱包余额要反算：`wallet = total - unrealised_pnl`。
 */
export function mapBalance(account: GateFuturesAccount): AccountState {
  const total = num(account.total);
  const unrealizedPnl = num(account.unrealised_pnl);
  const available = num(account.available);
  const marginUsedRaw = account.margin === undefined ? NaN : num(account.margin);
  const marginUsed = Number.isFinite(marginUsedRaw) && marginUsedRaw > 0 ? marginUsedRaw : Math.max(0, total - available);
  return {
    equity: total,
    walletBalance: total - unrealizedPnl,
    availableBalance: available,
    unrealizedPnl,
    marginUsed,
    /* Gate 不单独给"挂单占用"，且它已经包含在 marginUsed 里 —— 不再重复计。 */
    openOrderMargin: 0,
  };
}

/**
 * 一张持仓 → `ExchangePosition`；**平掉的仓位（size=0 / contract 为空）返回 null**。
 *
 * Gate 的 `GET /futures/usdt/positions` 会把历史仓位也列出来（size 为 0、
 * contract 为空串），直接映射会让界面出现一堆"0 数量持仓"。
 */
export function mapPosition(position: GateFuturesPosition, contract: GateFuturesContract): ExchangePosition | null {
  const size = num(position.size);
  if (position.contract === '' || size === 0) return null;
  const multiplier = num(contract.quanto_multiplier);
  const quantity = Math.abs(size) * (multiplier > 0 ? multiplier : 1);
  const entryPrice = num(position.entry_price);
  const markPrice = num(position.mark_price);
  const leverage = num(position.leverage) > 0 ? num(position.leverage) : 1;
  const notional = quantity * markPrice;
  const marginUsedRaw = position.margin === undefined ? NaN : num(position.margin);
  const unrealizedPnl = num(position.unrealised_pnl);
  /*
   * 收益率：Gate 的 `unrealised_pnl_rate` 是**百分比字符串**（"2.5" = 2.5%）。
   * 缺失时按"未实现盈亏 ÷ 保证金"算 —— 与本项目其它地方的口径一致（保证金口径）。
   */
  const rateRaw = position.unrealised_pnl_rate;
  const unrealizedPnlPercent =
    rateRaw === undefined || rateRaw === '' ? (marginUsedRaw > 0 ? (unrealizedPnl / marginUsedRaw) * 100 : 0) : num(rateRaw);
  const liq = position.liq_price === undefined || position.liq_price === '' ? 0 : num(position.liq_price);
  return {
    symbol: gateContractToSymbol(position.contract),
    side: size > 0 ? 'long' : 'short',
    quantity,
    entryPrice,
    markPrice,
    leverage,
    liquidationPrice: liq > 0 ? liq : null,
    unrealizedPnl,
    unrealizedPnlPercent,
    marginUsed: Number.isFinite(marginUsedRaw) && marginUsedRaw > 0 ? marginUsedRaw : notional / leverage,
    notional,
    /*
     * Gate 的合约仓位默认全仓（cross）；逐仓要显式设置且响应里未必回传。
     * 这里如实给 `cross` —— 不要假装知道它不是。
     */
    marginType: 'cross',
  };
}

/**
 * 合约信息缓存（`quanto_multiplier` / 最小张数 / 价格步长）。
 *
 * 数量换算离不开它，而它变化很慢 —— 缓存 5 分钟足够，且能被显式失效。
 */
export class GateContractRegistry {
  private cache: { at: number; byName: Map<string, GateFuturesContract> } | null = null;
  private readonly ttlMs = 5 * 60_000;

  constructor(private readonly rest: GateRest) {}

  async all(force = false): Promise<Map<string, GateFuturesContract>> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.byName;
    const contracts = await this.rest.publicGet<GateFuturesContract[]>('/futures/usdt/contracts');
    const byName = new Map<string, GateFuturesContract>();
    for (const contract of contracts) byName.set(contract.name, contract);
    this.cache = { at: Date.now(), byName };
    return byName;
  }

  async get(contract: string): Promise<GateFuturesContract> {
    const byName = await this.all();
    const found = byName.get(contract);
    if (!found) throw new Error(`Gate 合约不存在：${contract}`);
    return found;
  }

  /** 币数 → 张数（**向下取整到 step**，且不小于最小张数；转换不出可交易数量时返回 0）。 */
  async quantityToSize(contract: string, quantity: number): Promise<number> {
    const info = await this.get(contract);
    const multiplier = num(info.quanto_multiplier);
    if (!(multiplier > 0) || !(quantity > 0)) return 0;
    const stepRaw = num(info.order_size_step ?? '1');
    const step = stepRaw > 0 ? stepRaw : 1;
    const raw = quantity / multiplier;
    const stepped = Math.floor(raw / step) * step;
    const minSize = num(info.order_size_min ?? '1') > 0 ? num(info.order_size_min ?? '1') : 1;
    return stepped >= minSize ? stepped : 0;
  }
}

/** 账户/持仓读取器（HTTP 取数 → 纯映射）。 */
export class GateAccountReader {
  constructor(
    private readonly rest: GateRest,
    private readonly contracts: GateContractRegistry,
  ) {}

  async balance(): Promise<AccountState> {
    const account = await this.rest.signed<GateFuturesAccount>('GET', '/futures/usdt/accounts');
    return mapBalance(account);
  }

  async positions(): Promise<ExchangePosition[]> {
    const [raw, registry] = await Promise.all([
      this.rest.signed<GateFuturesPosition[]>('GET', '/futures/usdt/positions'),
      this.contracts.all(),
    ]);
    const out: ExchangePosition[] = [];
    for (const position of raw) {
      const contract = registry.get(position.contract);
      if (!contract) continue;
      const mapped = mapPosition(position, contract);
      if (mapped) out.push(mapped);
    }
    return out;
  }
}
