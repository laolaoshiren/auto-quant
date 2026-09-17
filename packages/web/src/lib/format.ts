/**
 * Presentation helpers. Money and PnL always carry an explicit sign.
 *
 * 命名规则（见 `DESIGN.md` §5.3）：**输出里带单位的格式化器，名字里必须带单位。**
 *
 * 反例就是这一版之前的 `fmtCompact`：同一个函数在行情表里既画「24h 成交额（USDT）」
 * 又画「成交量（币）」，两处都是 `12.35M`，而单位只写在调用处的标签里。一旦标签被
 * 省略（行情表格子的表头就是「24h 成交额」，没有 USDT），数值就再也说不清是什么。
 *
 * 所以计数值一律叫 `…Amount`（名里带单位），只做数字美化的才叫 `fmtNum`。
 * `fmtAmount` 是 `fmtNum` 的别名，只为让调用处一眼看出"这里是一个数量、单位在别处"。
 *
 * 增量与格式器（`Δ` 前缀）只用于**两个同类读数相减**的结果 —— 它是差值，不是账户
 * 里的余额，混用会让操作员把它当成"我的钱"。
 */

export function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/* -------------------------------------------------------------------------- */
/*  数字                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 通用数字美化：加千分位，大数转 `K` / `M` / `B`。
 *
 * ⚠️ **名字里没有单位，所以它不知道自己在画什么。** 用于"单位由调用处明确给出"
 * 的场景；写新界面时优先用下面的 `fmtCompactAmount` / `fmtAmountUsd` 这类带单位的
 * 名字，读代码的人不必回头去找标签。
 */
export function fmtNum(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 100_000) return `${(value / 1000).toFixed(1)}K`;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** `fmtNum` 的语义别名：调用处用来表明"这是一个数量，单位在别处"。 */
export const fmtAmount = fmtNum;

/* -------------------------------------------------------------------------- */
/*  余额词汇表                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The single place the balance vocabulary lives.
 *
 * The credentials table and the trader dashboard both label the same exchange
 * figures, so a divergence here (“钱包余额” on one screen, “余额” on the other)
 * would make an operator doubt both.
 *
 * `equity` 从“权益”改成“账户权益”是刻意的：这些读数是**交易所账户**的（共享钱包），
 * 而机器人页面上的“权益”是**该机器人归属**的那一份。同一个词指两个数，操作员就
 * 没法判断哪个是账户里的钱、哪个是这个机器人挣的 —— 这正是本次修的那个 bug。
 *
 * `marginUsed` / `openOrderMargin` 与 `equity` 同为**结算币种计价**（USDT）；
 * 这也是 `settleAsset` 存在的理由：一屏里出现的金额必须能说清自己是什么币。
 */
export const BALANCE_LABEL = {
  equity: '账户权益',
  wallet: '钱包余额',
  available: '可用',
  unrealized: '未实现',
  marginUsed: '保证金占用',
  openOrderMargin: '挂单占用',
  /** 上面每个金额的计价币种 —— 标签里写出来，不靠读者猜。 */
  settleAsset: '结算币种',
  short: {
    equity: '账户权益',
    wallet: '钱包',
    available: '可用',
  },
} as const;

/** Asset shown when a payload predates the `asset` field. */
export const DEFAULT_SETTLE_ASSET = 'USDT';

/* -------------------------------------------------------------------------- */
/*  金额                                                                       */
/* -------------------------------------------------------------------------- */

/** `$1,015.50` — 美元计价金额。 */
export function fmtUsd(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) return '—';
  return `$${fmtNum(value, digits)}`;
}

/** `1,015.50 USDT` — money with its settlement unit spelled out. */
export function fmtAsset(
  value: number | null | undefined,
  asset: string | null | undefined,
  digits = 2,
): string {
  const amount = fmtNum(value, digits);
  if (amount === '—') return '—';
  return `${amount} ${asset?.trim() || DEFAULT_SETTLE_ASSET}`;
}

/** `1,015.50 USDT` — 名字带单位；与 `fmtAsset` 同一套逻辑，供"币种写死在名下"的调用处用。 */
export function fmtAmountUsd(value: number | null | undefined, digits = 2): string {
  const amount = fmtNum(value, digits);
  if (amount === '—') return '—';
  return `${amount} ${DEFAULT_SETTLE_ASSET}`;
}

/** 数量 + 后缀单位：`12.35M USDT`。后缀即单位，所以不会出现"12.35M 是什么"的歧义。 */
export function fmtCompactAmount(
  value: number | null | undefined,
  unit: string,
  digits = 2,
): string {
  if (!isNum(value)) return '—';
  return `${fmtCompact(value, digits)} ${unit}`;
}

/** 简洁金额，默认按结算币种（USDT）：`12.35M USDT`。 */
export function fmtCompactUsd(value: number | null | undefined, digits = 2): string {
  return fmtCompactAmount(value, DEFAULT_SETTLE_ASSET, digits);
}

/**
 * 差值（Δ）金额：权益 / 余额 / 已实现盈亏的**变动量**。
 *
 * 与 `fmtUsdSigned` 的区别只在名称：一屏里同时出现"当前权益"与"权益变化"时，
 * 这个名字让读代码的人（和下一个改这行的人）知道它是差值，不该被当成账户余额。
 */
export function fmtDeltaUsd(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${fmtNum(Math.abs(value), digits)}`;
}

/** Unsigned magnitude, for labels that already say `未实现`. */
export function fmtSigned(
  value: number | null | undefined,
  digits = 2,
): string {
  if (!isNum(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${fmtNum(Math.abs(value), digits)}`;
}

/** Signed money — used for every PnL figure, so the sign is never implied. */
export function fmtUsdSigned(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${fmtNum(Math.abs(value), digits)}`;
}

/* -------------------------------------------------------------------------- */
/*  比率与价格                                                                 */
/* -------------------------------------------------------------------------- */

/** 百分比。**永远带正负号** —— 颜色不是所有人都能分辨。 */
export function fmtPercent(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

/**
 * 回撤百分比，**永远带负号，除非真的是零**。
 *
 * 回撤在语义上必然是负数或零，所以这个格式与 `fmtPercent` 不同：它固定加负号，
 * 而不是按值的正负号决定。
 *
 * 但不能对零也加负号 —— 会渲染成 `-0.00%`。那不是"很小的回撤"，
 * 而是一个不存在的负数，看起来像格式化 bug，也很廉价。
 * 判定用 `toFixed` 之后的字符串，而不是原始值：0.0001 显示出来就是 0.00，
 * 那么它也该显示为 `0.00%` 而不是 `-0.00%`。
 */
export function fmtDrawdownPercent(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) return '—';
  const magnitude = Math.abs(value).toFixed(digits);
  const isZero = Number(magnitude) === 0;
  return `${isZero ? '' : '-'}${magnitude}%`;
}

/**
 * 价格。
 *
 * 结算币种（USDT）是**协议约定**而不是这个函数能推出来的：合约价格一律以
 * 结算币种报价，所以单位写进名字，避免出现「`fmtPrice` 到底是不是美元」这种疑问。
 */
export function fmtPriceUsd(value: number | null | undefined): string {
  if (!isNum(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 100 ? 3 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 8;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 旧的、名字里没有单位的价格格式化器 —— 保留给尚未迁移的调用处。 */
export const fmtPrice = fmtPriceUsd;

/** 仓位数量（币本位），不带单位后缀：单位是具体交易对的基础币。 */
export function fmtQty(value: number | null | undefined): string {
  if (!isNum(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

/** 整数计数。 */
export function fmtInt(value: number | null | undefined): string {
  if (!isNum(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

/**
 * 紧凑数量：`1.23M`。
 *
 * ⚠️ 名字里没有单位 —— 必须在调用处把单位写出来（`fmtCompactAmount` 会替你加后缀）。
 */
export function fmtCompact(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(digits)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(digits)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(digits);
}

/** Tailwind text colour for a signed number. Zero is neutral. */
export function pnlColor(value: number | null | undefined): string {
  if (!isNum(value) || value === 0) return 'text-ink-mid';
  return value > 0 ? 'text-up' : 'text-down';
}

/* -------------------------------------------------------------------------- */
/*  时间                                                                       */
/* -------------------------------------------------------------------------- */

/** 分钟数 → 中文时长。入参单位是分钟，写在名字里。 */
export function fmtDuration(minutes: number | null | undefined): string {
  if (!isNum(minutes)) return '—';
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total}分`;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours < 24) return `${hours}时${mins}分`;
  const days = Math.floor(hours / 24);
  return `${days}天${hours % 24}时`;
}

/** 一天内的时刻（24 小时制）。 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

/** 带日期的时刻（2024-05-01 13:20:45）。 */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toLocaleDateString('en-CA')} ${date.toLocaleTimeString('en-GB', { hour12: false })}`;
}

/**
 * 时钟偏移。入参单位是**毫秒**，名字里写出来，输出里也带 `ms`。
 *
 * 见 `LAYOUT.md` §3：它是诊断值，只在越界时展示，并且要带后果而不是原始数值。
 */
export function fmtClockOffsetMs(ms: number | null | undefined): string {
  if (!isNum(ms)) return '—';
  const sign = ms >= 0 ? '+' : '-';
  return `${sign}${Math.abs(Math.round(ms))} ms`;
}

/** 旧名 —— 保留给尚未迁移的调用处。 */
export const fmtClockOffset = fmtClockOffsetMs;

/** 模型延迟。入参单位是**毫秒**；`12.3s` / `840ms` 比原始毫秒数好读。 */
export function fmtLatencyMs(ms: number | null | undefined): string {
  if (!isNum(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** 旧名 —— 保留给尚未迁移的调用处。 */
export const fmtLatency = fmtLatencyMs;

/* -------------------------------------------------------------------------- */
/*  运行环境                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 测试网 / 主网的唯一文案来源。
 *
 * 这三（四）句原本散落在 `ExchangeAccountsSection` 的横幅、行内徽章、编辑对话框里
 * 各写一份。同一件事有多个措辞时，改一处就会让另外两处说法不一致 —— 而这一屏分辨
 * 错的代价是真金白银（`LAYOUT.md` §1 要求它"不可能看错"）。
 *
 * 短标签给徽章用，长标签给横幅和警告用；**两处都带文字**，不靠颜色。
 */
export const TRADING_ENV_LABEL = {
  /** 徽章 / 列表里的短标签。 */
  short: {
    testnet: '测试网 · 模拟',
    live: '主网 · 真实资金',
  },
  /** 横幅 / 对话框里的完整说法。 */
  long: {
    testnet: '测试网 / 模拟盘',
    live: '主网 / 真实资金',
  },
  /** 悬停说明：写清后果。 */
  title: {
    testnet: '测试网 / 模拟盘：订单不会进入真实市场。',
    live: '主网 / 实盘：这里的订单是真钱，会在真实市场成交。',
  },
} as const;

export function tradingEnvLabel(testnet: boolean, variant: 'short' | 'long' = 'short'): string {
  return testnet ? TRADING_ENV_LABEL[variant].testnet : TRADING_ENV_LABEL[variant].live;
}

export function tradingEnvTitle(testnet: boolean): string {
  return testnet ? TRADING_ENV_LABEL.title.testnet : TRADING_ENV_LABEL.title.live;
}

/* -------------------------------------------------------------------------- */
/*  其它                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Profit factor. The API serialises `Infinity` to `null` — that means "no losing
 * trades closed yet", which must read as ∞ and not as zero.
 */
export function fmtProfitFactor(value: number | null | undefined): string {
  if (value === null || value === undefined) return '∞';
  if (!Number.isFinite(value)) return '∞';
  return value.toFixed(2);
}

/** Coarse relative time, good enough for a status line. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '从未';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '从未';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

export function sideLabel(side: string): string {
  return side === 'long' || side === 'BUY' ? '多' : '空';
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function safeJson(value: unknown, indent = 2): string {
  try {
    return JSON.stringify(value, null, indent);
  } catch {
    return String(value);
  }
}

/**
 * 交易对名称的**区分色**。
 *
 * ## 为什么按名称哈希取色，而不是按出现顺序
 *
 * 按顺序分配会让同一个币种在不同表格、翻页之后变色 —— 而颜色的唯一用途
 * 就是**让人一眼认出"这是同一个东西"**。哈希保证：**同一个币种永远是同一个颜色**，
 * 无论出现在哪张表、翻到哪一页。
 *
 * ## 为什么不用主题里的语义色
 *
 * `up`（绿）/ `down`（红）/ `warn`（琥珀）在这个界面里含义是固定的（涨跌与风险）。
 * **拿它们去"区分币种"会制造假信号**：一个红色的 BTCUSDT 看起来像"BTC 在跌"，
 * 而它只是恰好排到了红色那一档。所以用一组避开红/绿/琥珀语义区间的中性色。
 *
 * 碰撞是允许的（只有 8 档）：**颜色是辅助，名称本身才是身份。**
 */
const SYMBOL_TONES = [
  '#6ea8fe', // 蓝
  '#a78bfa', // 紫
  '#22d3ee', // 青
  '#f472b6', // 粉
  '#facc15', // 黄
  '#34d399', // 翠
  '#fb923c', // 橙
  '#818cf8', // 靛
] as const;

export function symbolTone(symbol: string): string {
  // FNV-1a 的简化版：够均匀，且不依赖任何库。
  let h = 2166136261;
  for (let i = 0; i < symbol.length; i += 1) {
    h ^= symbol.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return SYMBOL_TONES[Math.abs(h) % SYMBOL_TONES.length] as string;
}
