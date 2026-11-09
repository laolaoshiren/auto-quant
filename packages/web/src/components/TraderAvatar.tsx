/**
 * **机器人头像（8-bit 像素风）**（2026-11-10 用户要求）。
 *
 * 用户原话：
 * > 「每个机器人加一个随机头像（8BIT 简约各种风格就行，可以去下载一点，
 * >   就像币圈玩的NFC那种头像）」。
 *
 * ## 为什么是本地生成而不是下载图片
 *
 * 1. **版权**：从网上抓的像素头像绝大多数有版权，仓库是公开的，不能塞进去；
 * 2. **确定性**：下载一批再随机分配，重装数据库后同一台机器人会换脸 —— 人对头像的
 *    识别是记忆性的，"名字 + 头像"应该稳定对应；
 * 3. **体积**：一张 8×8 的 SVG 只有几百字节，也不用额外请求。
 *
 * 这里用 `id` 作种子做确定性的伪随机：同一台机器人永远同一个头像，不同机器人
 * 大概率不同（8×8 左右对称 + 10 色调色板）。风格就是"币圈像素 NFT"那种：
 * 深底、亮色方块、左右对称。
 */

/** 调色板：保持低饱和到高饱和各几档，深浅色主题下都能看清。 */
const PALETTE = [
  '#a5b4fc',
  '#2fd08d',
  '#fbbf24',
  '#f472b6',
  '#60a5fa',
  '#fb923c',
  '#c084fc',
  '#34d399',
  '#f87171',
  '#38bdf8',
];

/** 深色底：与 quill 的 base-900 接近，浅色主题下也不会糊成白块。 */
const BG = '#151a21';

/** 32 位确定性伪随机（mulberry32）—— 不需要依赖。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function TraderAvatar({
  id,
  size = 28,
  className,
}: {
  id: number;
  /** 显示边长（px）。像素格数固定 8×8，靠 viewBox 缩放。 */
  size?: number;
  className?: string;
}) {
  const GRID = 8;
  const rnd = mulberry32(Math.floor(Math.abs(id)) * 2654435761 + 7);
  const primary = PALETTE[Math.floor(rnd() * PALETTE.length)]!;
  const accent = PALETTE[Math.floor(rnd() * PALETTE.length)]!;

  /*
   * 左右对称：只生成左半边（0..3 列），再镜像到右半边 ——
   * 这是"像素头像"最容易被认出来的形状特征。
   */
  const cells: Array<{ x: number; y: number; fill: string }> = [];
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < Math.ceil(GRID / 2); x += 1) {
      const v = rnd();
      /* 概率分布：约 35% 留空、约 55% 主色、约 10% 点缀色 —— 太密会糊成一块。 */
      if (v < 0.35) continue;
      const fill = v > 0.9 ? accent : primary;
      cells.push({ x, y, fill });
      if (x !== GRID - 1 - x) cells.push({ x: GRID - 1 - x, y, fill });
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${GRID} ${GRID}`}
      shapeRendering="crispEdges"
      className={className}
      aria-hidden
      focusable="false"
    >
      <rect width={GRID} height={GRID} fill={BG} />
      {cells.map((cell, index) => (
        <rect key={index} x={cell.x} y={cell.y} width={1} height={1} fill={cell.fill} />
      ))}
    </svg>
  );
}
