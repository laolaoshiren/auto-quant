/**
 * 可交易标的体检：**照现在的配置与账户规模，到底能交易哪些标的？**
 *
 * ## 为什么需要它（这一类失效最难发现）
 *
 * 实测撞到过：机器人连续 60 多个周期一笔单没开，而
 * **每轮周期都"成功"、日志干净、状态显示 `running`** —— 唯一的现象是"什么都不发生"。
 *
 * 根因是**账户规模与交易所最小名义价值的矛盾**，而且在数字上完全不显眼：
 *
 *     9.11 USDT × maxMarginUsage(50%) ÷ 3x 杠杆 → 名义上限 13.68 USDT
 *     币安 BTCUSDT 的 MIN_NOTIONAL            → 50 USDT
 *     → BTC 在这个账户上**永远开不出来**
 *
 * 而每一轮对 BTC 的提议都会被风控正确地拒绝，日志里写着
 * `仓位名义价值 $6.00 低于最低要求 $50.00` —— **看起来像"策略太保守"，
 * 实际是"这一类标的根本不可能"。**
 *
 * ## 我在这上面错过两次，两次都值得记下来
 *
 * **第一次**：写了一个硬编码的 `EXCHANGE_MIN_NOTIONAL_USD = 5`。**那个 5 是我编的。**
 * 币安的真实值是**按标的不同的**（BTC 50、ETH 20、山寨 5），而且它一直就在
 * `registry.minNotional` 里。于是体检报出 `✅ BTC/ETH：名义区间 5.00 ~ 27.33` ——
 * **两处都错**，恰好漏掉了唯一真正不可达的那一类。
 *
 * **第二次**：算上限时用了 `btcEthMaxPositionValueRatio × equity = 27.33`，
 * **漏了 `maxMarginUsage` 那一层**。真上限是 `4.56 × 3 = 13.68`（保证金绑定）。
 *
 * 两次的教训是同一条：**不要用编出来的数字做校验。** 所以这个函数的签名里
 * 不再有任何常量 —— **每一标的最小名义都由调用方从交易所元数据传入。**
 *
 * ## 为什么报告形式是"哪些标的能交易"而不是"某一类可行吗"
 *
 * 因为那才是操作员需要的答案。`BTC/ETH 可行吗` 这个问题的答案
 * （"BTC 不行、ETH 不行、SOL 行"）没法直接用于决策；而
 * **"你能交易 17 个标的，其中 SOL/ZEC/HYPE…"** 可以直接用于决策。
 */

/** 一个标的的交易所约束。**全部来自交易所元数据，不接受调用方推测。** */
export interface SymbolConstraint {
  symbol: string;
  /** 交易所的 `MIN_NOTIONAL`（USDT）。 */
  minNotional: number;
  /** 交易所的 `LOT_SIZE.stepSize`。用于验证取整之后是否仍然达标。 */
  stepSize: number;
  /** 当前标记价。用于把名义价值换算成数量再算回来。 */
  price: number;
  /** 是否属于 BTC/ETH 这类主流币（决定用哪一档名义比例）。 */
  isMajor: boolean;
}

export interface ReachabilityInput {
  /** 账户权益（USDT）。**必须是真实值** —— 手填的数字会让这个检查给出错误结论。 */
  equity: number;
  /** 可用保证金比例（%，0–100）。 */
  maxMarginUsagePercent: number;
  /** 各资产类别的名义价值上限倍数（相对权益）。 */
  ratios: { major: number; altcoin: number };
  /** 我们自己设的最小名义价值下限。 */
  minPositionSize: number;
  /** 各资产类别的杠杆上限。 */
  maxLeverage: { major: number; altcoin: number };
  /** 候选标的的交易所约束。 */
  symbols: readonly SymbolConstraint[];
}

export interface SymbolVerdict {
  symbol: string;
  /** 这个标的现在能不能开出一个合法仓位。 */
  tradable: boolean;
  /** 能开的话，合法的名义价值区间。 */
  range: { min: number; max: number } | null;
  /** 为什么不行（`tradable` 为真时是"能"，但同样给出数字）。 */
  reason: string;
}

export interface ReachabilityReport {
  /** 至少有一个标的可交易。 */
  ok: boolean;
  tradable: SymbolVerdict[];
  blocked: SymbolVerdict[];
  /** 给操作员的一句话。**含具体标的数与名字** —— 那才是能用于决策的信息。 */
  summary: string;
}

/**
 * 算一个标的的可用名义区间。
 *
 * 上限取三者最小：比例上限、保证金上限。
 * 下限取两者最大：我们自己的下限、交易所的最小名义。
 *
 * **保证金那一层最容易漏**（我自己漏过一次）：3x 杠杆下 27.33 USDT 的名义
 * 只要 9.11 USDT 保证金，而 `maxMarginUsage 50%` 只给 4.56 —— 真上限是 13.68。
 */
function limitsFor(input: ReachabilityInput, c: SymbolConstraint): { floor: number; ceiling: number; leverage: number } {
  const ratio = c.isMajor ? input.ratios.major : input.ratios.altcoin;
  const leverage = c.isMajor ? input.maxLeverage.major : input.maxLeverage.altcoin;

  const byRatio = input.equity * ratio;
  const marginAvailable = input.equity * (input.maxMarginUsagePercent / 100);
  const byMargin = marginAvailable * leverage;

  return {
    floor: Math.max(input.minPositionSize, c.minNotional),
    ceiling: Math.min(byRatio, byMargin),
    leverage,
  };
}

/**
 * 按交易所步长向下取整数量。
 *
 * **必须在体检里也算一遍**：取整会把名义价值压低，而那正是实测里
 * `−4164 Order's notional must be no smaller than 5` 的成因 ——
 * 风控校验的是取整**之前**的值。
 */
function floorToStep(quantity: number, stepSize: number): number {
  if (!(stepSize > 0)) return quantity;
  // 用整数刻度避免浮点误差累积（0.1 的整数倍算出来会是 0.30000000000000004）。
  const decimals = Math.max(0, Math.ceil(-Math.log10(stepSize)));
  const factor = 10 ** decimals;
  return Math.floor(quantity * factor) / factor;
}

function judge(input: ReachabilityInput, c: SymbolConstraint): SymbolVerdict {
  const { floor, ceiling, leverage } = limitsFor(input, c);

  if (!(ceiling > 0)) {
    return {
      symbol: c.symbol,
      tradable: false,
      range: null,
      reason: `${c.symbol}：账户权益为 ${input.equity.toFixed(2)} USDT，名义上限算出来是 ${ceiling.toFixed(2)} —— 无法开仓。`,
    };
  }

  if (ceiling < floor) {
    const binding =
      c.minNotional > input.minPositionSize
        ? `交易所最小名义 ${c.minNotional} USDT`
        : `minPositionSize=${input.minPositionSize}`;
    return {
      symbol: c.symbol,
      tradable: false,
      range: null,
      reason:
        `${c.symbol}：名义上限 ${ceiling.toFixed(2)} USDT 低于 ${binding}。` +
        `**这个标的在当前账户规模下开不出来** —— 无论信号多好。`,
    };
  }

  /*
   * 把下限**抬到步长的整数倍**，而不是"取整后不足就判死"。
   *
   * ⚠️ 这里我写错过一次：最初的做法是把下限对应的数量向下取整，发现结果低于
   * 交易所下限就判不可交易。**那会误报。** 实测例子：
   *
   *     HYPE：下限 5 USDT ÷ 价格 80 = 0.0625 → 向下取整 0.06 → 名义 4.80 < 5  ✗
   *     正确做法：向上取到 0.07 → 名义 5.60 ≥ 5  ✅ **完全可以交易**
   *
   * 所以有效下限是"**能达到交易所下限的最小合法数量**"对应的名义价值。
   * 只有它超出了上限，才真的开不出来。
   */
  const stepsAtFloor = Math.ceil(floor / c.price / c.stepSize);
  const qtyAtFloor = floorToStep(stepsAtFloor * c.stepSize, c.stepSize);
  const effectiveFloor = qtyAtFloor * c.price;

  if (qtyAtFloor <= 0 || effectiveFloor < c.minNotional) {
    return {
      symbol: c.symbol,
      tradable: false,
      range: null,
      reason:
        `${c.symbol}：无法凑出达到交易所下限 ${c.minNotional} USDT 的合法数量` +
        `（步长 ${c.stepSize}，价格 ${c.price}）—— 这个标的在当前价位开不出来。`,
    };
  }

  if (effectiveFloor > ceiling) {
    return {
      symbol: c.symbol,
      tradable: false,
      range: null,
      reason:
        `${c.symbol}：按步长 ${c.stepSize} 取整后的最小合法名义是 ${effectiveFloor.toFixed(2)} USDT，` +
        `超过名义上限 ${ceiling.toFixed(2)} USDT。**这个标的在当前账户规模下开不出来。**`,
    };
  }

  const marginNeeded = effectiveFloor / leverage;
  return {
    symbol: c.symbol,
    tradable: true,
    range: { min: effectiveFloor, max: ceiling },
    reason:
      `${c.symbol}：名义区间 ${effectiveFloor.toFixed(2)} ~ ${ceiling.toFixed(2)} USDT，` +
      `${leverage}x 下最小单需保证金 ${marginNeeded.toFixed(2)} USDT。`,
  };
}

/**
 * 体检：照现在的配置与账户规模，能交易哪些标的。
 *
 * @param input 权益要传**真实值**；`symbols` 要传**交易所元数据里的原值**。
 *              这个函数里没有任何默认常量 —— 那是我上一版犯的错。
 */
export function checkConfigReachability(input: ReachabilityInput): ReachabilityReport {
  const verdicts = input.symbols.map((c) => judge(input, c));
  const tradable = verdicts.filter((v) => v.tradable);
  const blocked = verdicts.filter((v) => !v.tradable);

  const ok = tradable.length > 0;
  const names = tradable.map((v) => v.symbol);

  return {
    ok,
    tradable,
    blocked,
    summary: ok
      ? `${input.symbols.length} 个候选里有 ${tradable.length} 个可交易` +
        (input.symbols.length <= 12 ? `：${names.join('、')}。` : `（${names.slice(0, 8).join('、')} 等）。`) +
        (blocked.length > 0 ? `另有 ${blocked.length} 个因账户规模不足被挡下。` : '')
      : `**${input.symbols.length} 个候选里一个都开不出来** —— 这是配置/账户规模问题，不是策略判断。` +
        '机器人会永远空转，而每轮周期都会"成功"、日志干净、状态显示 running。',
  };
}
