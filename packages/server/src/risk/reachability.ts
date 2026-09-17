/**
 * 配置可达性体检：**这个配置在这个账户规模下，究竟能不能开出仓来？**
 *
 * ## 为什么需要它（这一类失效最难发现）
 *
 * 实测撞到过一次：机器人连续 60 多个周期一笔单都没开，而
 * **每轮周期都"成功"、日志干净、状态显示 `running`** —— 唯一的现象是"什么都不发生"。
 *
 * 根因是两条**互相矛盾**的配置，而且在数字上完全不显眼：
 *
 *     9.11 USDT × altcoinMaxPositionValueRatio(0.5) = 4.55 USDT   名义**上限**
 *     币安合约最小名义价值 ≈ 5 USDT                                 名义**下限**
 *     → 4.55 < 5，**任何山寨币仓位都不成立**
 *
 * 第二层：`minPositionSize`（我们自己设的下限）也不该高于账户能承受的名义价值。
 * 实测里它是 12，而默认杠杆下最大名义只有 9.1 —— 又一次算术上不可能。
 *
 * **两条都是纯算术，本该在启动时就报出来。** 一个"参数不可达"的机器人与一个
 * "参数可达但市场不好"的机器人，在控制台上长得一模一样 —— 而前者是配置错误，
 * 后者才是策略判断。**把它们混为一谈的代价是几十轮空转和大量 token。**
 *
 * ## 为什么做成纯函数
 *
 * 这样它能被穷举测试（每个边界的两侧），而且能被预检、健康检查、AI 的工具层
 * 三个地方共用 —— 那三处都需要同一个判断，各写一遍必然会不一致（§5.4）。
 */

/** 币安 USDⓈ-M 合约的最小名义价值（USDT）。低于它的订单会被交易所拒绝。 */
export const EXCHANGE_MIN_NOTIONAL_USD = 5;

export interface ReachabilityInput {
  /** 账户权益（USDT）。 */
  equity: number;
  /** 可用保证金比例（%，0–100）。 */
  maxMarginUsagePercent: number;
  /** 各资产类别的名义价值上限倍数（相对权益）。 */
  ratios: {
    /** BTC/ETH 这类主流币。 */
    major: number;
    /** 山寨币。 */
    altcoin: number;
  };
  /** 我们自己设的最小名义价值下限。 */
  minPositionSize: number;
  /** 默认杠杆。 */
  defaultLeverage: number;
  /** 各资产类别的杠杆上限。 */
  maxLeverage: { major: number; altcoin: number };
}

export interface ReachabilityFinding {
  /** 哪个资产类别。 */
  scope: 'major' | 'altcoin';
  /** 这一类**能不能**开出一个合法仓位。 */
  reachable: boolean;
  /** 合法的名义价值区间。`null` 表示这一类完全开不出来。 */
  range: { min: number; max: number } | null;
  /** 一句话说明，带具体数字。 */
  detail: string;
}

export interface ReachabilityReport {
  ok: boolean;
  findings: ReachabilityFinding[];
  /** 全都不行时的一句话总结。 */
  summary: string;
}

/**
 * 检查一个资产类别能否开出仓位。
 *
 * 三个条件都要成立：
 *
 * 1. **名义价值区间非空**：`minPositionSize ≤ equity × ratio`
 * 2. **区间与交易所下限有交集**：`equity × ratio ≥ EXCHANGE_MIN_NOTIONAL_USD`
 *    （否则即使我们的下限再低，交易所也会拒单）
 * 3. **保证金够**：`max(minPositionSize, 交易所下限) / 杠杆 ≤ equity × 保证金比例`
 *
 * 第 2 条是最容易漏的：它是**我们与交易所之间的**矛盾，
 * 而不是我们自己参数之间的矛盾 —— 只看自己的配置永远看不出来。
 */
function checkScope(
  scope: 'major' | 'altcoin',
  input: ReachabilityInput,
  ratio: number,
  maxLeverage: number,
): ReachabilityFinding {
  const label = scope === 'major' ? 'BTC/ETH' : '山寨币';
  const notionalMax = input.equity * ratio;
  const exchangeFloor = EXCHANGE_MIN_NOTIONAL_USD;
  const ourFloor = input.minPositionSize;
  /** 实际生效的名义下限是"我们的下限"与"交易所下限"里更高的那个。 */
  const effectiveFloor = Math.max(ourFloor, exchangeFloor);

  if (notionalMax < effectiveFloor) {
    const binding = notionalMax < ourFloor ? `minPositionSize=${ourFloor}` : `交易所最小名义 ${exchangeFloor} USDT`;
    return {
      scope,
      reachable: false,
      range: null,
      detail:
        `${label}开不出仓位：名义上限 ${input.equity.toFixed(2)} × ${ratio} = ${notionalMax.toFixed(2)} USDT，` +
        `低于 ${binding}。**这一类标的在算术上完全不可交易** —— 无论信号多好。`,
    };
  }

  const marginNeeded = effectiveFloor / maxLeverage;
  const marginAvailable = input.equity * (input.maxMarginUsagePercent / 100);
  if (marginNeeded > marginAvailable) {
    return {
      scope,
      reachable: false,
      range: null,
      detail:
        `${label}开不出仓位：最小名义 ${effectiveFloor} USDT 在 ${maxLeverage}x 下需保证金 ` +
        `${marginNeeded.toFixed(2)} USDT，超过可用保证金 ${marginAvailable.toFixed(2)} USDT。`,
    };
  }

  return {
    scope,
    reachable: true,
    range: { min: effectiveFloor, max: notionalMax },
    detail:
      `${label}：名义区间 ${effectiveFloor.toFixed(2)} ~ ${notionalMax.toFixed(2)} USDT` +
      `（余量 ${(notionalMax - effectiveFloor).toFixed(2)}），${maxLeverage}x 下最小单需保证金 ` +
      `${marginNeeded.toFixed(2)} / 可用 ${marginAvailable.toFixed(2)} USDT。`,
  };
}

/**
 * 检查整个配置在给定账户规模下是否可达。
 *
 * @param input 当前生效的配置与本账户事实。**权益要传真实值** ——
 *              用启动时手填的数字会让这个检查给出错误结论。
 */
export function checkConfigReachability(input: ReachabilityInput): ReachabilityReport {
  const findings = [
    checkScope('major', input, input.ratios.major, input.maxLeverage.major),
    checkScope('altcoin', input, input.ratios.altcoin, input.maxLeverage.altcoin),
  ];
  const ok = findings.some((f) => f.reachable);

  return {
    ok,
    findings,
    summary: ok
      ? `至少一类标的可交易：${findings.filter((f) => f.reachable).map((f) => f.scope).join('、')}。`
      : '**没有任何标的类别能开出仓位** —— 这是配置错误，不是策略判断。机器人会永远空转，' +
        '而每轮周期都会"成功"、日志干净、状态显示 running。',
  };
}
