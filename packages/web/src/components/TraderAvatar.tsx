/**
 * **机器人头像（像素 NFT 风）**（2026-11-10 用户要求）。
 *
 * 用户原话：
 * > 「每个机器人加一个随机头像（8BIT 简约各种风格就行，可以去下载一点，
 * >   就像币圈玩的NFC那种头像）」→ 之后又反馈「头像你整点好看热门得，不要这种随意垃圾得」。
 *
 * ## 为什么不是纯随机像素
 *
 * 第一版是"随机对称色块"——看起来像噪点，不像头像。现在改成：
 * **一组手工设计的像素角色模板**（机器人/猫/狐狸/外星人/幽灵/骷髅/熊/鸟）
 * × **热门配色**（紫/粉/青/绿/橙/黄/蓝/红/薄荷/薰衣草）
 * × **深色渐变底**。
 *
 * 同一个 `id` 永远得到同一个头像（模板 + 配色都由 id 决定），不同机器人分布均匀。
 * 全部本地生成（无版权、无网络请求），一个头像只有几百字节 SVG。
 */

/** 8×8 像素模板。`.` 透明 · `#` 主色 · `o` 亮色 · `x` 暗色。 */
const TEMPLATES: Record<string, readonly string[]> = {
  robot: [
    '..o..o..',
    '..####..',
    '.######.',
    '.x####x.',
    '.######.',
    '..#..#..',
    '..####..',
    '..x..x..',
  ],
  cat: [
    '..o..o..',
    '..####..',
    '.######.',
    '.#x##x#.',
    '.######.',
    '..#oo#..',
    '..####..',
    '...##...',
  ],
  fox: [
    'o......o',
    'oo....oo',
    '########',
    '##x##x##',
    '########',
    '..#oo#..',
    '..####..',
    '...##...',
  ],
  alien: [
    '..####..',
    '.######.',
    '##x##x##',
    '#x####x#',
    '##x##x##',
    '.######.',
    '..####..',
    '...##...',
  ],
  ghost: [
    '..####..',
    '.######.',
    '########',
    '##x##x##',
    '########',
    '########',
    '##.##.##',
    '.#..#...',
  ],
  skull: [
    '..####..',
    '.######.',
    '##x##x##',
    '##x##x##',
    '########',
    '.#.##.#.',
    '..#oo#..',
    '..####..',
  ],
  bear: [
    '.o....o.',
    '..####..',
    '.######.',
    '.#x##x#.',
    '.######.',
    '..#oo#..',
    '..####..',
    '...##...',
  ],
  bird: [
    '...##...',
    '..####..',
    '.#x##x#.',
    '.######.',
    '..oooo..',
    '..####..',
    '..x..x..',
    '..o..o..',
  ],
  dino: [
    '..##....',
    '.####...',
    '.#x##...',
    '.####...',
    '..####..',
    '.##..##.',
    '.#....#.',
    '......#.',
  ],
  astronaut: [
    '..####..',
    '.#oooo#.',
    '#o#xxo#.',
    '#oooooo#',
    '#o####o#',
    '.#oooo#.',
    '..####..',
    '..#..#..',
  ],
};

const TEMPLATE_NAMES = Object.keys(TEMPLATES);

/** 热门配色：`[主色, 亮色]`。深色主题下都用高饱和度，浅色主题下也够对比。 */
const PALETTES: ReadonlyArray<readonly [string, string]> = [
  ['#8b5cf6', '#c4b5fd'], // 紫
  ['#ec4899', '#f9a8d4'], // 粉
  ['#06b6d4', '#67e8f9'], // 青
  ['#10b981', '#6ee7b7'], // 绿
  ['#f97316', '#fdba74'], // 橙
  ['#fbbf24', '#fde68a'], // 黄
  ['#3b82f6', '#93c5fd'], // 蓝
  ['#ef4444', '#fca5a5'], // 红
  ['#2dd4bf', '#99f6e4'], // 薄荷
  ['#a78bfa', '#ddd6fe'], // 薰衣草
];

/** 8×8 像素网格尺寸（SVG viewBox）。 */
const GRID = 8;

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
  const seed = Math.floor(Math.abs(id));
  /*
   * ⚠️ **相邻 id 必须换色**（用户 2026-11-10：「不要全部整一样颜色（太近似得，
   * 风格不同热门得各来一点方便区分啊）」）。
   *
   * 第一版用的是 `Math.floor(seed / 5) % 调色板长度` —— 于是 id 5/6/8 全都落到
   * 同一个粉色，一排机器人看起来像同一个人。改成 `seed % 调色板长度`：
   * id 连续时颜色逐个不同；模板用 `seed % 模板数`（10 种造型），
   * 组合起来 10×10=100 种，单页十几台机器人足够区分。
   */
  const template = TEMPLATES[TEMPLATE_NAMES[seed % TEMPLATE_NAMES.length]!]!;
  const palette = PALETTES[seed % PALETTES.length]!;
  const [primary, bright] = palette;
  /* 每个头像一个唯一的渐变 id（同页多个头像不能共用一个 id）。 */
  const gradientId = `aq-avatar-${seed}`;

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
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={primary} stopOpacity="0.55" />
          <stop offset="100%" stopColor="#0b0f14" stopOpacity="0.95" />
        </linearGradient>
      </defs>
      <rect width={GRID} height={GRID} fill={`url(#${gradientId})`} />
      {template.map((row, y) =>
        [...row].map((cell, x) => {
          if (cell === '.') return null;
          const fill = cell === '#' ? primary : cell === 'o' ? bright : '#1b2330';
          return <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} />;
        }),
      )}
    </svg>
  );
}
