/**
 * 智能体参数补丁的守卫。
 *
 * ## 这个文件存在的理由
 *
 * AI 会输出一份"我想把参数改成这样"的补丁。它是**不可信输入** ——
 * 可能是坏 JSON、可能缺字段、可能写了 schema 不允许的值、也可能（最危险）
 * 试图关掉那条"没有止损不开仓"的结构性约束。
 *
 * 所以补丁**不直接生效**：先过这里，再过 zod，最后如实记录被改动了什么。
 *
 * ## 与"用户上限"的区别（这是设计上的一个明确决定）
 *
 * 最初的设想是"用户设上限、AI 只能在上限内调"。产品方最终选择了**完全交给 AI**，
 * 包括原来那些上限（杠杆、保证金占比、每小时开仓数、熔断阈值）。
 * 因此这里**不再有"保守上限"** —— 那些字段 AI 可以自由调高调低。
 *
 * 于是安全责任落到两处，各自分工明确：
 *
 *  1. **本文件的 `STRUCTURAL_INVARIANTS`** —— 只保留**不是偏好、而是结构**的东西。
 *     目前只有一条：`requireStopLoss` 必须为真。一个没有保护的杠杆仓位可以在
 *     几秒内亏掉全部保证金，那**不是一种策略选择**（§2.6）。
 *  2. **账户级紧急刹车**（`emergencyStop.ts`）—— **不在 `StrategyConfig` 里**，
 *     所以 AI 的补丁永远碰不到它。这是"机器该不该继续跑"的问题，
 *     不是策略问题。
 *
 * 熔断阈值因此**降级为一个策略工具**：AI 可以用它主动停手（比如当日亏损后
 * 避免情绪化加仓），但它不再是最后一道防线 —— 最后一道防线是紧急刹车。
 * 这个分工是有意的，不是遗漏。
 *
 * ## 为什么是纯函数
 *
 * 没有数据库、没有网络、没有时钟。这样它可以被穷举测试（§5.4）：
 * 每一类越界各一个用例，外加"被钳制时如实记录"。
 */

import { StrategyConfigSchema, type StrategyConfig } from '@aq/shared';

/* -------------------------------------------------------------------------- */
/*  结果类型                                                                   */
/* -------------------------------------------------------------------------- */

/** 守卫对补丁做的一处改动。空数组表示 AI 的补丁被原样接受。 */
export interface AgentClamp {
  /** 点号路径，例如 `riskControl.requireStopLoss`。 */
  field: string;
  /** AI 想设成什么。 */
  asked: unknown;
  /** 实际生效成什么。 */
  allowed: unknown;
  /** 为什么改 —— 这句话会进 `agent_experiments.clamps_json`，并被回喂给 AI。 */
  why: string;
}

export interface AgentPatchResult {
  /** 实际生效的配置（**已通过 zod**，可以直接落库）。 */
  config: StrategyConfig;
  /** 被守卫改动的项。 */
  clamps: AgentClamp[];
  /**
   * 补丁被整体拒绝时的原因。
   *
   * 非 null 时 `config` 等于传入的 `current`（**一个字段都没改**）——
   * 宁可整份不接受，也不要"部分生效"：那会让 AI 以为自己改成了 A，
   * 而实际上只有 B 生效，下一轮它基于一个错误前提继续推理。
   */
  rejected: string | null;
}

/* -------------------------------------------------------------------------- */
/*  结构性不变量                                                               */
/* -------------------------------------------------------------------------- */

/**
 * **不是偏好，是结构**的那些字段。AI 无论怎么调都改不掉。
 *
 * 判断标准很严格：一条约束只有满足下面两点才配放在这里 ——
 *   ① 违反了它，**亏损可以在一笔之内变成不可逆的**（而不是"收益率变差"）；
 *   ② 它**不是一种策略风格**（不是"激进/保守"的区别，而是"有没有护栏"的区别）。
 *
 * 按这个标准，目前只有一条。**不要因为"这样更安全"就往里加东西** ——
 * 往里加得越多，这个模式就越接近原来的固定参数策略，也就失去了它存在的意义。
 * 想加之前先问：这是护栏，还是我在替它做策略决定？
 */
const STRUCTURAL_INVARIANTS: ReadonlyArray<{
  path: string;
  /** 强制值。 */
  force: unknown;
  why: string;
}> = [
  {
    path: 'riskControl.requireStopLoss',
    force: true,
    why:
      '每个仓位都必须带交易所侧止损 —— 没有保护的杠杆仓位可以在几秒内亏掉全部保证金，' +
      '那不是一种策略风格。这条不受 AI 调整影响。',
  },
];

/* -------------------------------------------------------------------------- */
/*  工具                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * **把 `"a.b.c": v` 形式的键展开成嵌套对象**（2026-10-13）。
 *
 * 见 `applyAgentPatch` 里那段说明：`set_params` 的工具文档推荐点号写法
 *（`riskControl.*`），而按字面键名过滤会把整条静默丢弃。
 *
 * ## 语义
 *
 * ```
 *   {"riskControl.minPositionSize": 5}          → { riskControl: { minPositionSize: 5 } }
 *   {"a.b": 1, "a.c": 2}                        → { a: { b: 1, c: 2 } }   （合并，不互相覆盖）
 *   {"a": {"b": 1}, "a.c": 2}                   → { a: { b: 1, c: 2 } }   （两种写法混用也可以）
 * ```
 *
 * ⚠️ **只处理"含点"的键**，不含点的键原样保留（绝大多数补丁都是嵌套写法，
 * 这条路径对它们是零影响的 —— 那是"旧行为逐字节不变"的要求）。
 *
 * ⚠️ **不覆盖已有值**：若 `{"a": {...}}` 与 `{"a.b": v}` 同时出现，
 * 后者写进前者里面；若两者写同一个叶子，**嵌套写法优先**
 *（它是更明确的表达，而且先出现）。
 */
/**
 * 路径段里**永远不该被遍历或写入**的键。
 *
 * ⚠️ **原型污染（2026-10-14 外部审查发现，实测复现）。**
 * 展开逻辑用 `node[part]` 遍历，而 `node['__proto__']` 返回的是 `Object.prototype`
 * —— `typeof` 是 `'object'`、不是数组，**通过**原有的类型守卫，于是
 * `{"riskControl.__proto__.isAdmin": 1}` 把 `isAdmin` 写进了**全局原型**：
 *
 * ```
 *   before: ({}).isAdmin = undefined
 *   after : ({}).isAdmin = 1        ← 整个进程里每个普通对象都继承了它
 * ```
 *
 * 危害不止"改了一个怪键"：本文件的 `pickKnown` 用 `key in target` 做
 * "只留已知字段"过滤，而 `in` **会看见原型链** —— 一旦某个名字被放上
 * `Object.prototype`，`STRUCTURAL_INVARIANTS` 与未知字段过滤双双失效，
 * 全进程任何 `x in obj` 判断都被静默改变。
 *
 * 而这是从**不可信输入**可达的：`set_params` 的 `patch` 只校验"是个对象"
 * （`tools.ts` 的 `validateArgs`），键名不过滤；模型输出、乃至 webSearch
 * 检索内容注入提示词后操纵策略师，都能触发。展开又发生在 `pickKnown` 之前
 * （见下方注释），过滤救不了它。
 *
 * 修法从源头拒绝这三类段 —— 它们**不可能**是合法的配置字段名
 * （schema 里没有任何一个字段叫这些名字，就算有 `pickKnown` 也会丢），
 * 所以这不违反"多认格式、不放宽语义"：合法的点号写法行为逐字节不变。
 */
const UNSAFE_SEGMENT = /^(?:__proto__|constructor|prototype)$/;

function expandDottedKeys(patch: Record<string, unknown>): Record<string, unknown> {
  /*
   * `Object.create(null)`：连"顶层键就叫 `__proto__`"这种不含点的写法也一并废掉
   * —— 普通对象字面量上 `out['__proto__'] = v` 走的是 setter（原型改指向），
   * 无原型对象上它只是一个普通数据键。与上面的段拒绝互为双保险。
   */
  const out: Record<string, unknown> = Object.create(null);
  /* ① 先放不含点的键（原样）。⚠️ 危险名一律丢弃（见上方 UNSAFE_SEGMENT）。 */
  for (const [key, value] of Object.entries(patch)) {
    if (!key.includes('.') && !UNSAFE_SEGMENT.test(key)) out[key] = value;
  }
  /* ② 再把含点的键写进去。 */
  for (const [key, value] of Object.entries(patch)) {
    if (!key.includes('.')) continue;
    const parts = key.split('.');
    /*
     * ⚠️ 空段（`"a..b"` / `".a"` / `"a."`）是坏输入 → 跳过这一个键，
     * 而不是整条拒绝。理由与"多认格式"一致：一个坏键不该让整个补丁作废。
     * 危险段（`__proto__` 等）同样按"坏输入跳过这个键"处理 —— 一个坏键不作废整条补丁。
     */
    if (parts.some((p) => p.length === 0)) continue;
    if (parts.some((p) => UNSAFE_SEGMENT.test(p))) continue;
    let node = out;
    let ok = true;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      if (next === undefined) {
        node[part] = Object.create(null);
      } else if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        /* 与一个非对象值冲突（`{"a": 1, "a.b": 2}`）→ 跳过这个键。 */
        ok = false;
        break;
      }
      node = node[part] as Record<string, unknown>;
    }
    if (!ok) continue;
    const leaf = parts[parts.length - 1] as string;
    /* ⚠️ 嵌套写法优先 —— 不覆盖已经由 ① 放好的值。 */
    if (!(leaf in node)) node[leaf] = value;
  }
  return out;
}

/** 只取 `source` 里在 `target` 中也存在的键，并递归进去。 */
function pickKnown(target: unknown, source: unknown): unknown {
  if (
    typeof target !== 'object' ||
    target === null ||
    Array.isArray(target) ||
    typeof source !== 'object' ||
    source === null ||
    Array.isArray(source)
  ) {
    return source;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (!(key in (target as Record<string, unknown>))) continue;
    out[key] = pickKnown((target as Record<string, unknown>)[key], value);
  }
  return out;
}

/**
 * **深**合并补丁到基准上。
 *
 * ## 为什么不能用 `{ ...current, ...patch }`
 *
 * 那是浅展开：`patch.coinSource` 只要写了 `{ coinPoolLimit: 8 }`，
 * 就会**整个替换**掉 `current.coinSource` —— 同一层里 AI 没提到的字段
 * （`sourceType`、`staticCoins`、`useCoinPool`、`minQuoteVolume24h` …）
 * 全部丢失，随后被 zod 用 **schema 默认值**补齐。
 *
 * 实测量到的后果：一次只改 `coinPoolLimit` 的补丁，把 `coinSource` 下的
 * **另外 7 个字段全部重置成了默认值**（`mixed`→`static`、`[BTC,ETH]`→`[]`、
 * `true`→`false`、`100M`→`50M` …）。
 *
 * 这个 bug 的可怕之处在于**它看起来很成功**：AI 以为自己只调了一个参数，
 * 而实际上它把选币策略整个换掉了，然后基于一个错误的前提继续推理下一轮。
 *
 * 数组按值整体替换（不当成对象递归）—— 数组是"一份完整的清单"，
 * 合并两个数组没有正确的语义。
 */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (
    typeof base !== 'object' ||
    base === null ||
    Array.isArray(base) ||
    typeof patch !== 'object' ||
    patch === null ||
    Array.isArray(patch)
  ) {
    return patch;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

function readPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function writePath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node: Record<string, unknown> = root;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== 'object' || next === null) return;
    node = next as Record<string, unknown>;
  }
  node[parts[parts.length - 1] as string] = value;
}

/* -------------------------------------------------------------------------- */
/*  守卫                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 把 AI 的补丁应用到当前配置上，返回**可以落库的配置**与被改动的项。
 *
 * 顺序是刻意的：
 *   1. 只保留已知字段（未知字段直接丢弃，不让 AI 往配置里塞东西）
 *   2. 结构性不变量强制覆盖 —— **在任何校验之前**，因为它是不可谈判的
 *   3. 整份走 zod：失败就**整体拒绝**，不做部分应用
 *
 * @param current 当前生效的配置（已通过 schema 的）
 * @param patch   AI 输出的补丁。**不可信**，类型是 `unknown`。
 */
export function applyAgentPatch(current: StrategyConfig, patch: unknown): AgentPatchResult {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return {
      config: current,
      clamps: [],
      rejected: `补丁必须是一个对象，收到的是 ${Array.isArray(patch) ? 'array' : typeof patch}。`,
    };
  }

  // 1. 只留已知字段。未知字段静默丢弃是**故意的**：配置的形状由 schema 决定，
  //    不由模型决定；把未知字段带进去只会让 zod 报一个与真实错误无关的错。
  //
  //    ── ⚠️⚠️ **但"点号路径"必须先展开**（2026-10-13 修一个真 BUG）──────────
  //
  //    ## 事故：模型改了参数、以为成功了、实际被静默丢弃
  //
  //    `set_params` 的**工具说明里写的就是点号写法**（原文）：
  //    ```
  //      Adjustable: coin selection (coinSource.*), indicators (indicators.*),
  //                  how much you risk (riskControl.*, throttle.*, circuitBreaker.*)
  //    ```
  //    而 `pickKnown` 是按**字面键名**过滤的 —— `"riskControl.minPositionSize"`
  //    在配置对象里不是键（真正的键是嵌套的 `riskControl`）→ **整条丢弃**。
  //
  //    实测（`#11` 的策略师，实验记录 `#79`）：
  //    ```
  //      patch_json:   {"riskControl.minPositionSize": 5}
  //      applied_json: minPositionSize = **12**      ← 没改！
  //      clamps_json:  []                            ← 也没有"被钳制"的记录
  //      reason: "DEADLOCK CONFIRMED: minPositionSize(12) > max achievable
  //               notional(equity 20.75 × positionValueRatio 50% = 10.375)"
  //    ```
  //    **它正确地诊断出了死锁、给出了正确的修复、然后那个修复被静默丢掉。**
  //    这是最坏的一类失败：**它告诉模型成功了。**
  //
  //    ## 修法：把点号键展开成嵌套，两种写法都接受
  //
  //    ```
  //      {"riskControl.minPositionSize": 5}        → 展开为嵌套 ✅
  //      {"riskControl": {"minPositionSize": 5}}   → 原样 ✅
  //    ```
  //    ⚠️ **多认格式、不放宽语义** —— 这与本项目里 `set_params` 的
  //    "也接受平铺字段"、`screen_symbols` 的"多格式识别"是同一条原则：
  //    模型换一种等价写法不该让整条调用作废。
  //    ⚠️ 展开发生在 `pickKnown` **之前**，所以未知字段**仍然**会被丢弃
  //    （安全性不变）。
  const normalized = expandDottedKeys(patch as Record<string, unknown>);
  const known = pickKnown(current, normalized) as Record<string, unknown>;

  // 2. 结构性不变量。必须在 zod 之前 —— 即使 schema 允许它被改成 false，
  //    这里也要把它按住。
  const clamps: AgentClamp[] = [];
  for (const invariant of STRUCTURAL_INVARIANTS) {
    const asked = readPath(known, invariant.path);
    // 补丁里没提这一项时不用管：它继承 `current` 的值，本来就已经是强制的。
    if (asked === undefined) continue;
    if (asked === invariant.force) continue;
    writePath(known, invariant.path, invariant.force);
    clamps.push({
      field: invariant.path,
      asked,
      allowed: invariant.force,
      why: invariant.why,
    });
  }

  // 3. **深**合并到当前配置，整份校验。
  //    不能写 `{ ...current, ...known }` —— 那是浅展开，会把同一层里
  //    AI 没提到的字段全部丢掉再用 schema 默认值补齐（见 deepMerge 的注释）。
  const merged = deepMerge(current, known) as unknown;
  const parsed = StrategyConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join('.') || '(根)';
    return {
      config: current,
      clamps,
      rejected: `配置校验失败：${where} —— ${first?.message ?? '未知原因'}。本轮补丁整体不生效。`,
    };
  }

  return { config: parsed.data as StrategyConfig, clamps, rejected: null };
}
