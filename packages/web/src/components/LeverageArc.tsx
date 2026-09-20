/**
 * 有效杠杆的半圆表。
 *
 * ## 为什么是"嵌进卡片"而不是"第五张卡"
 *
 * 参考产品把杠杆做成了一张独立卡片（半圆仪表 + 大数字）。我们没有照做，因为
 * `LAYOUT.md` §0 规则 3 定的是**一行最多 4 个指标卡**，而指标行已经满了
 * （归属权益 / 今日盈亏 / 胜率 / 持仓）。再加一张会把它们压窄，四个数字的可读性
 * 一起下降 —— 换来的是一条本来可以用一个图形表达的读数。
 *
 * 所以它走**和胜率进度条同一条路**：作为卡片内的 `sub` 可视化。
 * 一屏里两张卡各带一个图形、另两张是纯数字，视觉上也有节奏。
 *
 * ## 口径
 *
 * `leverage` = 本机器人总名义价值 ÷ 归属权益，`max` 取策略里允许的上限
 * （`maxLeverage`）。**满仓时指针到最右** —— 那个位置本身就是"风险敞口拉满"，
 * 所以它在接近右端时换色。
 *
 * ## 为什么刻度上还要写数字
 *
 * `DESIGN.md` §2：状态不能只靠颜色表达。弧长、颜色、以及旁边的 `0.00x / 10x`
 * 三个通道各自都能独立说明"现在用了多少"，红绿色盲用户与看不清细弧的人都不吃亏。
 */
import { CHART_INK } from './equityCurve';

/** 弧的粗细（px）。细一档：它是卡片内的小图形，不该和主数字抢注意力。 */
const STROKE = 4;

export function LeverageArc({
  leverage,
  max,
  size = 52,
}: {
  leverage: number;
  /** 策略允许的杠杆上限。`0` 或负数表示不可用，此时只画空槽。 */
  max: number;
  size?: number;
}) {
  const usable = Number.isFinite(leverage) && Number.isFinite(max) && max > 0;
  const ratio = usable ? Math.max(0, Math.min(1, leverage / max)) : 0;

  const r = (size - STROKE) / 2;
  const cx = size / 2;
  const cy = size / 2;
  /*
   * 半圆：从左侧 (180°) 顺时针到右侧 (0°)。半径 `r`，圆心在底部中点 ——
   * 用 `A r r 0 0 1` 画圆弧，`sweep=1` 即顺时针。
   */
  const d = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const half = Math.PI * r;

  /* 接近上限时换色：`DESIGN.md` 里 `warn` 是"正在变热"，不是错误。 */
  const stroke = ratio >= 0.85 ? CHART_INK.warn : ratio >= 0.6 ? CHART_INK.accent : CHART_INK.up;

  return (
    <span className="inline-flex items-center gap-1.5">
      <svg
        width={size}
        height={size / 2 + STROKE}
        viewBox={`0 0 ${size} ${size / 2 + STROKE}`}
        role="img"
        aria-label={usable ? `有效杠杆 ${leverage.toFixed(2)} 倍，上限 ${max} 倍` : '有效杠杆不可用'}
        className="shrink-0 overflow-visible"
      >
        {/* 空槽 */}
        <path d={d} fill="none" stroke={CHART_INK.track} strokeWidth={STROKE} strokeLinecap="round" />
        {/* 填充：用 dasharray 取半圆弧长的一段 */}
        {ratio > 0 && (
          <path
            d={d}
            fill="none"
            stroke={stroke}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${half * ratio} ${half}`}
          />
        )}
      </svg>
      <span className="num text-xs text-ink-mid">
        {usable ? `${leverage.toFixed(2)}x` : '—'}
        <span className="text-ink-faint"> / {usable ? `${max}x` : '?'}</span>
      </span>
    </span>
  );
}
