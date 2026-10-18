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
