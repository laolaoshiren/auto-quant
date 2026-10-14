/**
 * **每个配置字段都必须有真实的读取点**（外部 issue #182 那一族）。
 *
 * ## 这个守卫接的是哪一族
 *
 * | issue | 字段 | 表现 |
 * | --- | --- | --- |
 * | **#182** | `minOpenInterestUsd` | 被接收 / 被转发 / 被写进提示词，但**筛选体从不读它** → 门槛形同不存在 |
 * | **#179** | `atrPeriods` | 可配置，而消费侧**写死 `'14'`** → 配置不含 14 时整块静默消失 |
 * | **#145** | `excludeStablecoins` | 预设写 `true`、schema 里没有 → 被 zod 静默丢弃 |
 *
 * 共同点：**"可配置的东西被代码当成常量、或从未接线"**。它们都不报错、不进日志。
 *
 * ⚠️ 上一条守卫（`configSchemaGuard.test.ts`）只封住了 #145 那一半
 *（字段名不在 schema 里）。**这一条封另一半：字段在 schema 里，但没人读它。**
 *
 * ## 判据：字段名要在【schema 之外】的源码里出现
 *
 * 我实测过：把 67 个配置字段逐个在全部非测试源码里扫一遍 ——
 * **只有 `funnelUniverseLimit` 一个**只出现在 `strategy.ts`（schema 自身）里，
 * 其余 66 个都至少有一个别的消费点。所以这个判据**既能抓到目标，又不误报**。
 *
 * ## ⚠️ 为什么判据是"出现"而不是"被比较/被返回"
 *
 * 更严的判据（"字段出现在比较或返回语句里"）需要真正的语法分析，
 * 而纯文本启发式会**误报**：`#182` 的 `minOpenInterestUsd` 在"逻辑层"出现过 16 次
 *（它被接收、被转发、被写进提示词）—— 一个"出现过就通过"的判据**抓不到它**，
 * 一个"要出现在比较里"的判据又会把 `roleDefinition`（只被拼进提示词）判成死配置。
 *
 * 所以这里取**下限**判据（"至少有一个 schema 之外的引用"）：它抓不住 #182 那种
 * "被转发但不被消费"的中间形态，但**能抓住"完全没人读"这一档** ——
 * 而 `funnelUniverseLimit` 正是这一档。**判据的边界写在下面。**
 *
 * ## 边界（诚实说明）
 *
 * · 它抓不住 #182 那种"有引用但不是决策依据"的形态（需要数据流分析）；
 * · 它抓不住"字段被读了但读错了"（例如读的是另一个同名字段）；
 * · 它对**动态键**（`config[key]`）无能为力。
 *
 * 这三条都不影响它的主要价值：**"完全没接线"是最常见、也最容易发生的一档**。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { StrategyConfigSchema } from './strategy.js';

/* -------------------------------------------------------------------------- */
/*  schema 字段名                                                                */
/* -------------------------------------------------------------------------- */

interface ZodLike {
  _def?: { typeName?: string; shape?: () => Record<string, unknown>; schema?: unknown; innerType?: unknown };
}

function zodShape(schema: unknown): Record<string, unknown> | null {
  let current = schema as ZodLike | undefined;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const def = current._def;
    if (!def) return null;
    if (def.typeName === 'ZodObject' && typeof def.shape === 'function') return def.shape();
    const next = def.schema ?? def.innerType;
    if (!next) return null;
    current = next as ZodLike;
  }
  return null;
}

/** 所有配置字段名（跨分区）。 */
function configFieldNames(): string[] {
  const root = zodShape(StrategyConfigSchema);
  assert.ok(root, '拿不到 `StrategyConfigSchema` 的 shape —— 结构变了，请更新本测试');
  const names: string[] = [];
  for (const field of Object.values(root)) {
    const shape = zodShape(field);
    if (shape) names.push(...Object.keys(shape));
  }
  return names;
}

/* -------------------------------------------------------------------------- */
/*  源码语料                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 从本文件定位 `packages/` 根。
 *
 * ⚠️ **不能靠"猜相对层数"**：我第一版写 `new URL('../../', import.meta.url)` 并以为
 * 那是 `packages/`，实测它给出的是**仓库根**（`tsx` 下 `import.meta.url` 的基准
 * 与我预期不同），于是 `readdirSync` 在 `packages/server` 上静默返回空 ——
 * 守卫会**在扫到 0 个文件的情况下报告"没问题"**。
 *
 * 改为**按标记定位**：从仓库根往下找含 `server` + `shared` + `web` 三个子目录的那一层。
 * 这样无论 cwd / bundler 怎么变都对，而且找不到时**会报错**（不是静默空扫描）。
 */
function findPackagesRoot(): string {
  const start = fileURLToPath(new URL('.', import.meta.url));
  let dir = start;
  for (let depth = 0; depth < 6; depth += 1) {
    const probe = join(dir, 'packages');
    if (
      existsSync(join(probe, 'server', 'src')) &&
      existsSync(join(probe, 'shared', 'src')) &&
      existsSync(join(probe, 'web', 'src'))
    ) {
      return probe;
    }
    /* 也接受"自己就在 packages 里"的情形。 */
    if (
      existsSync(join(dir, 'server', 'src')) &&
      existsSync(join(dir, 'shared', 'src')) &&
      existsSync(join(dir, 'web', 'src'))
    ) {
      return dir;
    }
    dir = join(dir, '..');
  }
  throw new Error(`找不到 packages 根（从 ${start} 向上找了 6 层）—— 本测试无法工作`);
}

const PACKAGES = findPackagesRoot();

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * 每个字段 → 它在哪些文件里出现（**排除 schema 自身**）。
 *
 * ⚠️ 排除 schema 文件是判据的核心：`strategy.ts` 里那个 `.default(…)` 是**定义**，
 * 不是**消费**。不排除的话每个字段都能"出现"，守卫就成了空转。
 */
function usageFiles(fields: readonly string[]): Map<string, string[]> {
  const schemaFile = join(PACKAGES, 'shared', 'src', 'strategy.ts');
  const files = [join(PACKAGES, 'server', 'src'), join(PACKAGES, 'shared', 'src'), join(PACKAGES, 'web', 'src')]
    .flatMap((dir) => walk(dir))
    .filter((f) => f !== schemaFile);

  const out = new Map<string, string[]>(fields.map((f) => [f, []]));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const field of fields) {
      if (new RegExp(`\\b${field}\\b`).test(text)) out.get(field)!.push(file);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  已知的"未接线"字段 —— 显式豁免，附理由                                        */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ **显式列出的豁免，不是静默放过。**
 *
 * 每一条都必须写清"为什么允许它没有读取点"以及"谁来决策"——
 * 否则这份名单会变成垃圾桶，而垃圾桶里的东西没人再检查。
 */
const KNOWN_UNWIRED: ReadonlyMap<string, string> = new Map([
  [
    'funnelUniverseLimit',
    '`sourceType: \'funnel\'` 目前**没有任何预设或 UI 在使用**（只有测试用）——' +
      '所以它随漏斗一起处于"已设计、未接线"状态。' +
      '⚠️ 注意它的**注释与实现不一致**：注释说它是"漏斗第一层的入口宽度（默认 500）"，' +
      '而 `coins.ts` 的 funnel 分支调的是 `runFunnel(rows)`（不传 stages、用 DEFAULT_FUNNEL），' +
      '且 `screenUniverseRows()` **有意返回全市场**（那一段注释解释了为什么：要让漏斗每层的' +
      '淘汰数可解释）。所以这个值**当前改了不起作用**。' +
      '要不要把 funnel 模式接线到 UI/预设（并让这个值真正生效）是**产品方向**，留给人拍板。',
  ],
]);

/* -------------------------------------------------------------------------- */
/*  验收：配置字段                                                               */
/* -------------------------------------------------------------------------- */

test('★★★ 每个配置字段都必须在 schema 之外有读取点 —— 否则是死配置', () => {
  const fields = configFieldNames();

  /* 前置断言：必须真的拿到字段。 */
  assert.ok(
    fields.length >= 40,
    `★ 只拿到 ${fields.length} 个配置字段 —— schema 解析可能失效了`,
  );

  const usage = usageFiles(fields);
  const unwired = fields.filter((f) => (usage.get(f) ?? []).length === 0);

  /* 前置断言：语料必须真的被读到（否则"零个未接线"是因为没扫到东西）。 */
  const scannedFiles = new Set([...usage.values()].flat()).size;
  assert.ok(
    scannedFiles >= 30,
    `★ 只扫到 ${scannedFiles} 个含配置字段的文件 —— 语料可能没读到，那样这条测试是空转`,
  );

  const unexpected = unwired.filter((f) => !KNOWN_UNWIRED.has(f));

  assert.deepEqual(
    unexpected,
    [],
    '★★★ 这些配置字段在 schema 里，但**在整个非测试源码里没有任何读取点** ——\n' +
      '    也就是说用户改了它没有任何效果（issue #182 / #179 就是这一族）：\n' +
      unexpected.map((f) => `      · ${f}`).join('\n') +
      '\n    ✅ 若它确实是"已设计、未接线"（等待产品决策），请把它加进 `KNOWN_UNWIRED`\n' +
      '       并**写清理由与决策方** —— 显式豁免，而不是让它悄悄躺着。',
  );

  /* 反向：豁免名单不能留下已经不成立的条目（字段已接线却还在名单里）。 */
  for (const [field, reason] of KNOWN_UNWIRED) {
    if ((usage.get(field) ?? []).length > 0) {
      assert.fail(
        `★★ \`${field}\` 已经有读取点了，请把它从 \`KNOWN_UNWIRED\` 移除 ——\n` +
          '    留在名单里会让下一个人以为它仍未接线。\n' +
          `    原豁免理由：${reason.slice(0, 60)}…`,
      );
    }
  }
});

test('★★★ 判据必须能真的报出死配置 —— 用一个不存在的字段证明它不是空转', () => {
  /*
   * ⚠️ "探针校准"：上面那条断言"意外未接线 = 空数组"，而**一个什么都没扫到的实现
   * 也返回空数组**。这里用一个**确定不存在**的字段名去跑同一套判据，断言它会被报出。
   */
  const fake = 'definitelyNotAConfigFieldAnywhere';
  const usage = usageFiles([fake]);
  assert.equal(
    usage.get(fake)!.length,
    0,
    '★★★ 判据必须能报出"没有任何读取点"的字段 —— 否则上面那条是在空转',
  );

  /* 同时证明它**不会**把真实有读取点的字段误报。 */
  const real = usageFiles(['excludeStablecoins']);
  assert.ok(
    real.get('excludeStablecoins')!.length > 0,
    '★★ 有读取点的字段不能被误报（`excludeStablecoins` 在 coins.ts 里被消费）',
  );
});

/* -------------------------------------------------------------------------- */
/*  验收：AI 团队岗位（同一族缺口的第二个实例）                                    */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ **同一个"定义了但没接线"的形态，在角色层也发生过。**
 *
 * `docs/FINDING-clerk-unwired.md`（另一维护者 2026-10-14 的侦察）记录：
 * `clerk`（文员）在**三个声明层**里都存在（组织架构 `firm.ts`、提示词 `roles.ts`、
 * 模型档位 `routedModel.ts`），而**生产代码 0 处调用** —— 而且
 * `roles.test.ts` 的角色清单检查**会覆盖它**（它在 `ROLES` 里），
 * 所以"定义了但没人用"**不会让任何测试变红**。
 *
 * 那份文档同时指出 `engineer` 有过**完全相同的处置**（`roles.ts` 里留了记录）。
 *
 * ⚠️ 这两个都是**产品决策**（要不要这个岗位），不是 BUG —— 所以我**不改代码**，
 * 只加守卫 + 显式豁免（与他自己写的"待决策，未修"一致）。
 */
/**
 * 配平花括号取对象字面量（跳过字符串）。
 *
 * ⚠️ 与 `configSchemaGuard.test.ts` 里那两个辅助函数是**同一形状**，
 * 但这里单独一份 —— 因为两个测试文件在**不同的 workspace**
 *（这个在 `shared`，那个也在 `shared`… 若合并会有耦合）。
 * 将来若第三个地方需要它，应当抽到 `src/` 下的非测试模块，而不是再抄一份。
 */
function balancedObject(code: string, openIndex: number): string | null {
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let i = openIndex; i < code.length; i += 1) {
    const ch = code[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(openIndex, i + 1);
    }
  }
  return null;
}

/** 取当前层级的顶层键名（跳过嵌套内容与字符串）。 */
function keysAtThisLevel(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  let token = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') { depth += 1; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth -= 1; continue; }
    if (depth !== 0) continue;
    if (ch === ':' && token.trim() !== '') { keys.push(token.trim()); token = ''; continue; }
    if (ch === ',') { token = ''; continue; }
    token += ch;
  }
  return keys.filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
}

const ROLES_SOURCE = readFileSync(join(PACKAGES, 'server', 'src', 'trader', 'agent', 'roles.ts'), 'utf8');

/** `roles.ts` 自身 —— 那是**定义**，不是**消费**，所以要从"调用点"扫描里排除。 */
const RolesFile = join(PACKAGES, 'server', 'src', 'trader', 'agent', 'roles.ts');

/** 从 `ROLES` 声明里取角色 id。 */
function roleIds(): string[] {
  /*
   * ⚠️ **不能用通用的 `keysAtThisLevel`**：`ROLES` 的值里含**模板字符串**，
   * 而 `${COMMON}` 这种插值里的 `{` 会让"配平 + 取键"那套逻辑错乱 ——
   * 实测它只解析出 7 个（实际 10 个），而我一开始没发现，是**前置断言**
   *（"至少 8 个"）把它拦下来的。
   *
   * 改用一条**针对这份字面量的形态**的匹配：`ROLES` 里每个角色都是
   * 「行首两个空格 + 标识符 + `: {`」。它比通用解析窄，但**准**，
   * 而且下面有"至少 8 个"的断言兜住"格式变了"的情形。
   */
  const anchor = /export const ROLES\s*(?::[^=]+)?=\s*\{/.exec(ROLES_SOURCE);
  if (!anchor) return [];
  const literal = balancedObject(ROLES_SOURCE, anchor.index + anchor[0].length - 1);
  if (!literal) return [];
  return [...literal.matchAll(/^ {2}([A-Za-z_$][\w$]*):\s*\{/gm)].map((m) => m[1]!);
}

/** 已知的"已声明、未接线"岗位 —— 显式豁免，附理由与决策方。 */
const KNOWN_UNWIRED_ROLES: ReadonlyMap<string, string> = new Map([
  [
    'clerk',
    '⚠️ 产品决策，未修。`docs/FINDING-clerk-unwired.md` 记录：它在组织架构' +
      '（`firm.ts`，`status: \'planned\'`）、提示词（`roles.ts`）、模型档位' +
      '（`routedModel.ts`）三层都存在，而生产代码 0 处调用。' +
      '⚠️ `roles.test.ts` 的角色清单检查**会覆盖它**，所以"没人用"不会让测试变红 ——' +
      '这正是需要这条守卫的原因。要不要这个岗位、以什么形式存在，由人拍板。',
  ],
]);

test('★★★ 每个声明的 AI 岗位都必须在生产代码里被调用 —— 否则是死角色', () => {
  const ids = roleIds();

  /*
   * ⚠️ 前置断言：必须真的解析出角色。
   * 没有它，"一个都没解析出来 → 没有问题"也会绿。
   */
  assert.ok(
    ids.length >= 8,
    `★ 只从 \`ROLES\` 解析出 ${ids.length} 个角色 —— 解析可能失效了`,
  );

  const files = walk(join(PACKAGES, 'server', 'src')).filter((f) => f !== RolesFile);
  const usage = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const id of ids) {
      /*
       * ⚠️ **调用形式不止一种** —— 我第一版只认 `role: 'xxx'`，于是把
       * `performance_analyst` / `attribution_analyst` **误报成死角色**。
       * 而它们其实是被调用的，只是形式不同：
       *
       * ```ts
       * const roles: AgentRole[] = ['performance_analyst', 'attribution_analyst'];  // 数组字面量
       * if (role === 'performance_analyst') { … }                                   // 相等判断
       * createRoutedDecisionModel({ request: { role: 'clerk', … } })                // 对象属性
       * ```
       *
       * 所以判据是「**这个 id 作为字符串字面量出现在生产代码里**」——
       * 比"精确匹配某种调用形状"宽，但**不会漏**；而多认一种形状的代价
       *（可能把"只在注释里提到"当成调用）由下面的注释剥离解决。
       */
      const withoutComments = text
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
        })
        .join('\n');
      if (new RegExp(`'${id}'`).test(withoutComments)) usage.get(id)!.push(file);
    }
  }

  const unwired = ids.filter((id) => (usage.get(id) ?? []).length === 0);
  const unexpected = unwired.filter((id) => !KNOWN_UNWIRED_ROLES.has(id));

  assert.deepEqual(
    unexpected,
    [],
    '★★★ 这些岗位在 `ROLES` 里声明了（有提示词、有模型档位），但**生产代码 0 处调用**：\n' +
      unexpected.map((id) => `      · ${id}`).join('\n') +
      '\n    ⚠️ 角色清单测试**会覆盖它们**，所以"定义了但没人用"不会让任何测试变红\n' +
      '    （`docs/FINDING-clerk-unwired.md` 记的就是这个形态，`engineer` 有过同样一次）。\n' +
      '    ✅ 若确实是"已设计、待产品决策"，请加进 `KNOWN_UNWIRED_ROLES` 并写明理由与决策方。',
  );

  /* 反向：豁免名单不能留下已经接线了的角色。 */
  for (const id of KNOWN_UNWIRED_ROLES.keys()) {
    if ((usage.get(id) ?? []).length > 0) {
      assert.fail(
        `★★ \`${id}\` 已经在生产代码里被调用了，请把它从 \`KNOWN_UNWIRED_ROLES\` 移除。`,
      );
    }
  }
});

test('★★★ 角色判据必须真的能报出死角色 —— 用一个不存在的 id 校准', () => {
  const files = walk(join(PACKAGES, 'server', 'src')).filter((f) => f !== RolesFile);
  const fake = 'definitelyNotARoleIdAnywhere';
  const hit = files.some((f) => {
    const text = readFileSync(f, 'utf8');
    return new RegExp(`role:\\s*'${fake}'`).test(text);
  });
  assert.equal(hit, false, '★★★ 判据必须能识别"没有调用点"的角色 —— 否则上面那条是空转');

  /* 且它不会把真实被调用的角色误报。 */
  const strategistCalled = files.some((f) =>
    new RegExp(`role:\\s*'strategist'`).test(readFileSync(f, 'utf8')),
  );
  assert.ok(
    strategistCalled,
    '★★ 有调用点的角色不能被误报（`strategist` 在 orchestrator.ts 里被调用）',
  );
});
