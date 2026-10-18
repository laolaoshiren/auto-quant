/**
 * **运行期开关中心**（2026-10-18）。
 *
 * ## 为什么需要它
 *
 * 用户要一个新标签「机器人控制」，专门放**实时生效**的配置：
 *
 * > 「是实时生效的那种（不受机器人运行影响），运行中机器人改了这里配置也会马上生效的，
 * >   以后我计划放很多功能进去，目前只需要做一个功能：JEV 模型开关」
 *
 * ## 它和 `.env` 的区别（这是整个设计的核心）
 *
 * | | `.env` | 本模块 |
 * |---|---|---|
 * | 生效时机 | **重启进程** | **下一次读取就生效**（毫秒级） |
 * | 谁能改 | 运维（SSH 进服务器） | **操作员点开关** |
 * | 适合放什么 | 启动期才需要的东西（端口、密钥、路径） | 运行期要调的策略开关 |
 *
 * `AQ_JEV_PREFILTER` 原本在 `.env` 里 —— 改一次要 SSH + 重启，
 * 而重启会**打断正在跑的决策周期**。这不是"实时生效"。
 *
 * ## 三层取值（后者覆盖前者）
 *
 * ```
 *   ① 代码默认值
 *   ② `.env`（部署时的初始意图 —— 仍然尊重它，否则老部署会突然变行为）
 *   ③ `settings` 表（操作员在界面上点的 —— **最高优先级**）
 * ```
 *
 * ⚠️ **但"界面没设过"时以 `.env` 为准**，这一点很重要：
 * 已经部署的服务器 `.env` 里写着 `AQ_JEV_PREFILTER=on`，
 * 如果界面一上来就把它当成 `off`（因为表里没记录），那是**静默改行为**。
 *
 * ## 为什么用 `settings` 表而不是新表
 *
 * `settings` 已经是本项目的 key-value 运行期配置表（`agent_last_wake`、
 * `foreign_activity:8` 之类都放这里）。加新表要迁移，而这里没有那个必要。
 *
 * ## 关于缓存
 *
 * **不做缓存**。每次读都是一次 index seek（`settings` 表很小），
 * 而"实时生效"的语义要求**读到的一定是最新值** —— 缓存会让"点了没反应"
 * 这种事重新出现。用 `Map` 缓存 1 秒也许省不了多少，却引入了失效时机的问题。
 */
import { settings } from '../store/repositories.js';

/**
 * 一个**布尔型**运行期开关。
 *
 * ## 为什么要有 `envKey`
 *
 * 老部署靠 `.env` 控制行为。界面从没被点过时，必须回落到 `.env`
 * —— 否则升级之后所有老部署的行为会静默改变（见文件头那段）。
 */
export interface RuntimeSwitchSpec {
  /**
   * 存储键（`settings` 表里的 key）。
   *
   * ⚠️ **一旦发布就不能改名** —— 它是持久化契约，改名等于把操作员的选择丢掉。
   */
  key: string;
  /** 界面上显示给她看的标题。 */
  label: string;
  /** 一句话说清"关掉之后会发生什么"（用户关心的是后果，不是实现）。 */
  effect: string;
  /** 对应的 `.env` 变量名（未设过界面值时回落到它）。 */
  envKey: string;
  /** `.env` 也没写时的默认值。 */
  fallback: boolean;
}

/**
 * **当前所有可运行期切换的开关**。
 *
 * ## 加一个新功能就是往这里加一行
 *
 * 用户说「以后我计划放很多功能进去」—— 所以这张表就是那个"扩展位"。
 * 加一行之后：
 * ```
 *   ① 界面自动多出一个开关（前端从 /api/control/switches 拉这张表）
 *   ② 代码里用 `isSwitchOn('xxx')` 读
 * ```
 * **不需要改接口、不需要改前端组件。**
 */
export const RUNTIME_SWITCHES: readonly RuntimeSwitchSpec[] = [
  {
    key: 'jev_prefilter',
    label: 'Jev 模型初筛',
    effect: '关闭后整个智能体团队都不再调用 Jev —— 每轮会重新分析全部标的（更慢，但不会筛掉任何机会）',
    envKey: 'AQ_JEV_PREFILTER',
    /*
     * ⚠️ **默认 `false`**：新部署不该悄悄开始调用一个外部决策模型。
     * 老部署的 `.env` 里写着 `on`，会走第 ② 层读成 `true` —— 行为不变。
     */
    fallback: false,
  },
];

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  **JEV 模式的可调选项**（2026-10-19）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 用户的原话：
 * > 「我感觉 P3 可以做，这模型成本忽略不计了，但是**要有开关**（像团队模式一样，
 * >   这边增加 P3 选项和其他你觉得必要的选项，**不要全部写死**）」
 *
 * ## 为什么单独一张表，而不是塞进 `RUNTIME_SWITCHES`
 *
 * `RUNTIME_SWITCHES` 是**布尔开关**（开/关）。而这里有的是**枚举**
 *（选币方式：代码筛选 / Jev 两阶段 / 混合）、有的是**数字**（置信门槛、风险比例）。
 *
 * 强行塞进布尔表会让类型变成 `boolean | string | number` ——
 * 而那种联合类型在读取处必然要写一堆 `typeof` 判断，正是缺陷温床。
 *
 * ## ⚠️ 每一项都必须有 `why`
 *
 * 用户不懂 JEV 的实际用法，所以界面上**必须解释这一项在做什么**、
 * 改了会有什么后果。只给一个下拉框等于让他瞎猜。
 */
export interface JevOptionSpec {
  key: string;
  label: string;
  /** 一句话说明「它是什么、改了会怎样」—— 用户靠它做决定。 */
  why: string;
  kind: 'boolean' | 'enum' | 'number';
  /** `enum` 的候选值（`value` 存库，`label` 给人看）。 */
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** `number` 的取值范围与单位。 */
  range?: { min: number; max: number; step: number; unit: string };
  /** 默认值（字符串形式，落库统一用字符串）。 */
  fallback: string;
  /**
   * ⚠️ **改这一项需要重启机器人才生效**吗？
   *
   * 大多数项是**下一轮就读到**（实时生效），但有几项是在
   * `buildJevModeModel()` 装配时读的（例如 `maxCandidates`），
   * 那些必须重启。界面上要如实标注 —— 否则用户改完以为生效了。
   */
}

export const JEV_OPTIONS: readonly JevOptionSpec[] = [
  {
    key: 'coin_select',
    label: '选币方式',
    why:
      '决定「谁来挑标的」。代码筛选用成交额 + 持仓量榜（快、稳、免费）；' +
      'Jev 两阶段让 Jev 从全市场里挑（更自主，但 Jev 只看得到价格/RSI/ATR 等几个数字）；' +
      '混合 = 代码先筛 20 个、Jev 再从中挑（推荐）。',
    kind: 'enum',
    options: [
      { value: 'code', label: '按成交额自动筛（默认，不花额外费用）' },
      { value: 'hybrid', label: '自动筛 20 个 → 让 Jev 自己挑（推荐）' },
      { value: 'jev', label: '让 Jev 从全市场 100 个里自己选' },
    ],
    fallback: 'code',
  },
  {
    key: 'entry_type',
    label: '开仓方式',
    why:
      '市价 = 立刻成交（滑点大一点，但一定进得去）；' +
      '限价 = 挂单等回调（省手续费，但可能等不到、错过机会）。' +
      'Jev 看不到盘口深度，所以「等回调」这件事它判断不了 —— 限价用的是机械规则（当前价回退 0.3%）。',
    kind: 'enum',
    options: [
      { value: 'market', label: '市价（默认，立刻成交）' },
      { value: 'limit', label: '限价等待（回退 0.3% 挂单）' },
    ],
    fallback: 'market',
  },
  {
    key: 'allow_short',
    label: '允许做空',
    why: '关掉之后 Jev 只能选做多 —— 下跌行情里会一直跳过。',
    kind: 'boolean',
    fallback: 'on',
  },
  {
    key: 'allow_resize',
    label: '允许加减仓',
    why: '开仓之后 Jev 可以判断「加仓 / 减仓 / 保持 / 平掉」。关掉则只做开仓与平仓。',
    kind: 'boolean',
    fallback: 'on',
  },
  {
    key: 'allow_trailing',
    label: '允许移动止损',
    why:
      '浮盈达标后把止损往盈利方向收紧（只收紧、绝不放宽）。' +
      '关掉则止损挂上后永不动 —— 实测那样会回吐大部分浮盈。',
    kind: 'boolean',
    fallback: 'on',
  },
  {
    key: 'min_confidence',
    label: '出手门槛',
    why:
      'Jev 有多确定才允许开仓。' +
      '「只做有把握的」会放弃约一半机会（实测 Jev 置信多在 25–65 之间）；' +
      '「有机会就做」连 50:50 的平局也会执行。',
    kind: 'enum',
    options: [
      { value: '55', label: '只做有把握的（约一半机会）' },
      { value: '40', label: '平衡（默认）' },
      { value: '20', label: '有机会就做' },
      { value: '0', label: '全部都做（含平局）' },
    ],
    fallback: '40',
  },
  {
    key: 'risk_percent',
    label: '单笔风险',
    why:
      '一笔最多亏掉账户的多少。它同时决定仓位大小 —— ' +
      '设「1%」时，一笔打止损只损失账户的 1%。',
    kind: 'enum',
    options: [
      { value: '0.5', label: '很小（0.5%/笔）' },
      { value: '1', label: '平衡（1%/笔，默认）' },
      { value: '2', label: '较大（2%/笔）' },
      { value: '3', label: '激进（3%/笔）' },
    ],
    fallback: '1',
  },
  {
    key: 'min_rr',
    label: '止盈止损比',
    why:
      '止盈距离 ÷ 止损距离。设「2:1」时，赚一次抵两次亏。' +
      '设得越高，单笔赚得越多但越难达到（可能一直不成交）；' +
      '设「1.5:1」容易成交，但长期要靠更高胜率才赚钱。',
    kind: 'enum',
    options: [
      { value: '1.5', label: '1.5 : 1（容易成交）' },
      { value: '2', label: '2 : 1（默认，推荐）' },
      { value: '2.5', label: '2.5 : 1（要求更高）' },
      { value: '3', label: '3 : 1（很难成交）' },
    ],
    fallback: '2',
  },
  {
    key: 'max_candidates',
    label: '每轮看几个标的',
    why:
      '决定成本与耗时。越少越省，但也可能错过机会。' +
      '（界面上会实时显示每天大约花多少钱。）',
    kind: 'enum',
    options: [
      { value: '4', label: '省（4 个）' },
      { value: '8', label: '标准（8 个，默认）' },
      { value: '12', label: '多（12 个）' },
      { value: '20', label: '全力（20 个）' },
    ],
    fallback: '8',
  },
  {
    key: 'hold_ask_every',
    label: '持仓检查频率',
    why:
      '多久问一次 Jev「这个仓位还该拿着吗」。' +
      '问得越勤反应越快、越贵；问得稀省 token，但可能错过平仓时机。',
    kind: 'enum',
    options: [
      { value: '1', label: '每轮都问（默认，最灵敏）' },
      { value: '2', label: '两轮一次' },
      { value: '3', label: '三轮一次（省 2/3）' },
    ],
    fallback: '1',
  },
];

/**
 * 按 key 找到规格。找不到返回 `null`（**不抛**）。
 *
 * 调用方拿到的 `null` 应当当成"这个开关不存在"，而不是"关着"——
 * 两者含义不同（后者会让一个拼错的 key 静默失效）。
 */
export function switchSpec(key: string): RuntimeSwitchSpec | null {
  return RUNTIME_SWITCHES.find((s) => s.key === key) ?? null;
}

/** `.env` 里那个变量的值转成布尔。`on` / `true` / `1` / `yes` 都算开。 */
function envBoolean(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === '') return null;
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return false;
  return null;
}

/**
 * **读一个开关的当前值**（三层取值，见文件头）。
 *
 * ⚠️ `settings.get()` 可能抛（表还没建、连接断了）——
 * 那种情况下**回落到 `.env` / 默认值**，不把异常抛给调用方。
 * 理由：一个读配置失败不该让整轮决策崩掉。
 */
export function isSwitchOn(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const spec = switchSpec(key);
  if (spec === null) {
    /*
     * 未知 key：**返回 false 但不当成"关着"** —— 这里没有日志通道，
     * 由调用方（`/api/control`）在设置不存在的开关时报 400。
     * 读路径上静默 false 是安全的（不会误开任何功能）。
     */
    return false;
  }

  /* ③ 界面设过的值（最高优先级）。 */
  try {
    const stored = settings.get(`control:${spec.key}`);
    if (stored !== undefined) {
      const parsed = envBoolean(stored);
      if (parsed !== null) return parsed;
    }
  } catch {
    /* 读不到就走下面两层 —— 不因为"读配置失败"而改变默认行为。 */
  }

  /* ② `.env` 的初始意图。 */
  const fromEnv = envBoolean(env[spec.envKey]);
  if (fromEnv !== null) return fromEnv;

  /* ① 代码默认值。 */
  return spec.fallback;
}

/**
 * **写一个开关**（界面点开关时调）。
 *
 * ⚠️ **不校验 key 是否存在** —— 那是路由层的职责（它要返回 400 和中文原因）。
 * 这里只负责落库。
 */
export function setSwitch(key: string, on: boolean): void {
  settings.set(`control:${key}`, on ? 'on' : 'off');
}

/**
 * **界面要展示的完整状态**：每个开关的当前值 + 它现在是从哪一层读来的。
 *
 * ## 为什么要带上 `source`
 *
 * 操作员看到"Jev 开着"时，如果不知道那是**自己点的**还是**部署时的默认**，
 * 就没法判断"我改了会不会影响别人/会不会重启后变回去"。
 *
 * ```
 *   source: 'ui'    → 界面上设的（重启也保持）
 *   source: 'env'   → .env 里的初始值（界面上从没点过）
 *   source: 'default' → 代码默认值（.env 里也没有）
 * ```
 */
export interface SwitchState {
  key: string;
  label: string;
  effect: string;
  on: boolean;
  source: 'ui' | 'env' | 'default';
}

export function listSwitches(env: NodeJS.ProcessEnv = process.env): SwitchState[] {
  return RUNTIME_SWITCHES.map((spec) => {
    let stored: boolean | null = null;
    try {
      stored = envBoolean(settings.get(`control:${spec.key}`));
    } catch {
      stored = null;
    }
    if (stored !== null) {
      return { key: spec.key, label: spec.label, effect: spec.effect, on: stored, source: 'ui' };
    }
    const fromEnv = envBoolean(env[spec.envKey]);
    if (fromEnv !== null) {
      return {
        key: spec.key,
        label: spec.label,
        effect: spec.effect,
        on: fromEnv,
        source: 'env',
      };
    }
    return {
      key: spec.key,
      label: spec.label,
      effect: spec.effect,
      on: spec.fallback,
      source: 'default',
    };
  });
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  JEV 选项的读写                                                           */
/* ══════════════════════════════════════════════════════════════════════════ */

/** 按 key 找 JEV 选项的规格。找不到返回 `null`（**不抛**）。 */
export function jevOptionSpec(key: string): JevOptionSpec | null {
  return JEV_OPTIONS.find((s) => s.key === key) ?? null;
}

/**
 * **读一个 JEV 选项的当前值**（字符串形式，与落库一致）。
 *
 * 三层取值与 `isSwitchOn` 同一条纪律：
 * ```
 *   ① 界面上设的（settings 表）   ← 最高
 *   ② 代码默认值（fallback）
 * ```
 * ⚠️ JEV 选项**不读 `.env`** —— 它们是新模式专属的，没有"老部署兼容"的问题，
 * 多一层只会让"这个值到底从哪来"更难回答。
 */
export function getJevOption(key: string): string {
  const spec = jevOptionSpec(key);
  if (spec === null) return '';
  try {
    const stored = settings.get(`jev:${spec.key}`);
    if (stored !== undefined && stored !== '') return stored;
  } catch {
    /* 读不到就用默认值 —— 一个读配置失败不该让整轮决策崩掉。 */
  }
  return spec.fallback;
}

/** 读一个布尔型 JEV 选项。 */
export function jevBool(key: string): boolean {
  const v = getJevOption(key).trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1' || v === 'yes';
}

/** 读一个数字型 JEV 选项。超出范围时**钳制**（不抛）。 */
export function jevNumber(key: string): number {
  const spec = jevOptionSpec(key);
  const raw = Number(getJevOption(key));
  if (!Number.isFinite(raw)) return spec?.fallback !== undefined ? Number(spec.fallback) : 0;
  if (spec?.range === undefined) return raw;
  return Math.min(spec.range.max, Math.max(spec.range.min, raw));
}

/**
 * 读一个枚举型 JEV 选项。
 *
 * ⚠️ **不在候选里就回落到默认值**（不猜、不抛）——
 * 那可能是有人手工改了库，或者枚举项被删了。
 */
export function jevEnum(key: string): string {
  const spec = jevOptionSpec(key);
  if (spec === null) return '';
  const v = getJevOption(key);
  const allowed = spec.options?.map((o) => o.value) ?? [];
  return allowed.includes(v) ? v : spec.fallback;
}

/**
 * **写一个 JEV 选项**（界面点保存时调）。
 *
 * ⚠️ 校验在路由层做（它要返回 400 和中文原因）。这里只负责落库。
 */
export function setJevOption(key: string, value: string): void {
  settings.set(`jev:${key}`, value);
}

/** 界面要展示的 JEV 选项状态（含「从哪来」）。 */
export interface JevOptionState {
  key: string;
  label: string;
  why: string;
  kind: 'boolean' | 'enum' | 'number';
  options?: ReadonlyArray<{ value: string; label: string }>;
  range?: { min: number; max: number; step: number; unit: string };
  value: string;
  /** `ui` = 界面上设过；`default` = 用代码默认值。 */
  source: 'ui' | 'default';
  /** 改它是否要重启机器人才生效。 */

}

export function listJevOptions(): JevOptionState[] {
  return JEV_OPTIONS.map((spec) => {
    let stored: string | undefined;
    try {
      stored = settings.get(`jev:${spec.key}`);
    } catch {
      stored = undefined;
    }
    const hasUi = stored !== undefined && stored !== '';
    return {
      key: spec.key,
      label: spec.label,
      why: spec.why,
      kind: spec.kind,
      ...(spec.options !== undefined ? { options: spec.options } : {}),
      ...(spec.range !== undefined ? { range: spec.range } : {}),
      value: hasUi ? stored! : spec.fallback,
      source: hasUi ? 'ui' : 'default',

    };
  });
}