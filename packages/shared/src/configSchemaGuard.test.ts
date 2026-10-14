/**
 * **`StrategyConfigSchema.parse({…})` 里的字段名必须存在于 schema** —— 堵住 TS 的盲区。
 *
 * （外部 issue #145 的待办，由 #182 / #179 与 #180 反复印证。）
 *
 * ## ⚠️ 为什么必须有这条守卫：`parse()` 的输入是 `unknown`
 *
 * 本仓库有两处写配置字面量的地方，而**类型检查只覆盖了其中一处**：
 *
 * | 位置 | TS 会不会检查字段名 | 为什么 |
 * | --- | --- | --- |
 * | `STRATEGY_PRESETS[].patch` | ✅ **会** | 类型是 `Partial<StrategyConfigInput>`，对象字面量触发 excess property check |
 * | `StrategyConfigSchema.parse({…})` | ❌ **不会** | zod 的签名是 `parse(data: unknown, …)` —— 输入类型是 `unknown`，TS 无从检查 |
 *
 * 我两条都实测过：
 * - 往 `STRATEGY_PRESETS[0].patch.coinSource` 塞 `definitelyNotARealField: true`
 *   → `npm run typecheck` 报 `TS2353: Object literal may only specify known properties`；
 * - 同样的字段塞进 `defaultAiTeamConfig()` 的 `parse({…})` → **typecheck 通过**。
 *
 * ⚠️ 而 `defaultAiTeamConfig()` **正是 issue #145 的现场**
 *（`excludeStablecoins: true` 写在 `parse({…})` 里，当时 schema 没有这个字段）。
 *
 * ## 为什么后果是"静默"的
 *
 * `z.object()` 默认 **strip 模式**：schema 里没有的键在 `parse()` 时被**丢掉**。
 * 实测：喂 `{ coinSource: { totallyFakeField: 123 } }` 进去，
 * `'totallyFakeField' in parsed.coinSource === false`。
 * 没有异常、没有日志 —— 只是那个值**不存在**，而写它的人以为它生效了。
 *
 * ## 所以审计必须在【源码文本层】做
 *
 * 运行时拿不到证据（未知字段已经消失）。一个审 `defaultAiTeamConfig()` 返回值的
 * 守卫会**永远绿** —— 我第一版就写成了那样，用人造字面量验证时才发现它抓不到真东西。
 *
 * ## 这个守卫的边界（诚实说明）
 *
 * · 它只查 `parse({…})` 里的**字面量**。若某份预设由变量拼出（`parse(build())`），
 *   它看不到 —— 由"必须真的查到 N 个字段"的前置断言兜住一部分。
 * · 它只保证**字段名存在**，不保证字段被消费。`#182` 那种"字段在 schema 里、
 *   但没有任何读取点"的缺口它抓不到（那需要"每个配置字段至少有一个读取点"的守卫）。
 * · 它**不重复** TS 已经覆盖的那一侧（`STRATEGY_PRESETS[].patch`）——
 *   在子集里再做一遍就是"同一件事两套实现"，而这个仓库为此付出过多次代价。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { StrategyConfigSchema } from './strategy.js';

const SOURCE = readFileSync(new URL('./strategy.ts', import.meta.url), 'utf8');

/* -------------------------------------------------------------------------- */
/*  schema 的合法字段名                                                          */
/* -------------------------------------------------------------------------- */

interface ZodLike {
  _def?: { typeName?: string; shape?: () => Record<string, unknown>; schema?: unknown; innerType?: unknown };
}

/**
 * 剥掉 zod 的包装拿到内层对象。
 *
 * ⚠️ 必须做：`coinSource` 是 `ZodDefault(ZodObject)` —— 直接读 `.shape` 得到
 * `undefined`，于是审计**静默地什么都查不到**（我第一版踩过：所有分区都"不是
 * zod 对象"，看起来像没问题，实际一个字段都没验）。
 */
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

/** `{ 分区名 → 合法字段名集合 }`（只含对象型分区）。 */
function schemaSections(): Map<string, Set<string>> {
  const root = zodShape(StrategyConfigSchema);
  assert.ok(root, '拿不到 `StrategyConfigSchema` 的 shape —— 结构变了，请更新本测试');
  const out = new Map<string, Set<string>>();
  for (const [name, field] of Object.entries(root)) {
    const shape = zodShape(field);
    if (shape) out.set(name, new Set(Object.keys(shape)));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  源码扫描：拿 `parse({…})` 的字面量                                            */
/* -------------------------------------------------------------------------- */

/** 配平花括号取对象字面量（跳过字符串）。 */
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

/**
 * 取该字面量里**每个嵌套对象**的顶层键名（一层）。
 *
 * ⚠️ 只做一层是**刻意的**：`parse({…})` 的顶层键就是 schema 的分区名
 *（`coinSource`、`riskControl`…），它们的直接子键才是要审的字段。
 */
function sectionFields(literal: string): Map<string, string[]> {
  const inner = literal.trim().replace(/^\{/, '').replace(/\}$/, '');
  const out = new Map<string, string[]>();

  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  let token = '';
  let pendingKey: string | null = null;

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
    if (depth === 0 && ch === ':') { pendingKey = token.trim(); token = ''; continue; }
    if (ch === '{') {
      if (depth === 0 && pendingKey !== null && /^[A-Za-z_$][\w$]*$/.test(pendingKey)) {
        const body = balancedObject(inner, i);
        if (body) out.set(pendingKey, keysAtThisLevel(body.slice(1, -1)));
      }
      depth += 1;
      continue;
    }
    if (ch === '}') { depth -= 1; if (depth === 0) pendingKey = null; continue; }
    if (depth === 0 && ch === ',') { token = ''; pendingKey = null; continue; }
    if (depth === 0) token += ch;
  }
  return out;
}

/** 找出源码里所有 `StrategyConfigSchema.parse({` 后的对象字面量。 */
function parseLiterals(code: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const anchor = /StrategyConfigSchema\.parse\(\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(code)) !== null) {
    const open = match.index + match[0].length - 1;
    const text = balancedObject(code, open);
    if (text) out.push({ line: code.slice(0, match.index).split('\n').length, text });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  验收                                                                        */
/* -------------------------------------------------------------------------- */

test('★★★ `parse({…})` 里的字段名必须都在 schema 里 —— 这一侧 TS 检查不到', () => {
  const sections = schemaSections();
  const literals = parseLiterals(SOURCE);

  /*
   * ⚠️ 前置断言：**必须真的找到若干处**。
   * 没有它，"一处都没找到 → 没有问题"也会绿 —— 而它什么都没验。
   */
  assert.ok(
    literals.length >= 3,
    `★★ 至少要找到 3 处 \`StrategyConfigSchema.parse({…})\`，实际 ${literals.length} 处 —— ` +
      '扫描可能失效了，那样这条测试什么都没验',
  );

  const problems: string[] = [];
  let checked = 0;

  for (const { line, text } of literals) {
    for (const [section, fields] of sectionFields(text)) {
      const allowed = sections.get(section);
      if (!allowed) {
        problems.push(`第 ${line} 行：${section}（整个分区都不在 schema 里）`);
        continue;
      }
      for (const field of fields) {
        checked += 1;
        if (!allowed.has(field)) problems.push(`第 ${line} 行：${section}.${field}`);
      }
    }
  }

  /*
   * ⚠️ 第二个前置断言：**必须真的查到有内容的字段**。
   * 只找到锚点但一个字段都没解析出来，同样是空转。
   */
  assert.ok(
    checked >= 10,
    `★★ 至少要检查到 10 个字段，实际 ${checked} 个 —— 字面量解析可能不完整`,
  );

  assert.deepEqual(
    problems,
    [],
    '★★★ 这些字段写在 `StrategyConfigSchema.parse({…})` 里，但 schema 里没有：\n' +
      problems.map((p) => `      · ${p}`).join('\n') +
      '\n    ⚠️ `parse()` 的输入类型是 `unknown`，**TS 不会检查它们**；\n' +
      '    而 zod 的 strip 模式会把它们**静默丢弃**（实测：parse 后该键 `in` 返回 false）——\n' +
      '    于是写它的人以为它生效了，而运行时根本没有这个值。\n' +
      '    issue #145（`excludeStablecoins` 写在 `defaultAiTeamConfig()` 的 `parse({…})` 里、\n' +
      '    schema 当时没有这个字段、功能静默不生效）就是这一族。',
  );
});

test('★★★ 审计判据必须能真的报出缺失字段 —— 用人造字面量证明它不是空转', () => {
  /*
   * ⚠️ "探针校准"。上面那条断言 `problems` 为空，而**一个什么都没查的实现
   * 也返回空数组** —— 所以绿本身不证明守卫有效。
   *
   * 用同一套解析函数审一段**故意写错**的字面量，断言它必须报出那个错字段。
   */
  const sections = schemaSections();
  const bogus = `StrategyConfigSchema.parse({ coinSource: { sourceType: 'coinpool', definitelyNotInSchema: true } })`;
  const literals = parseLiterals(bogus);
  assert.equal(literals.length, 1, '★ 前提：扫描要能找到这段人造字面量');

  const offenders = [...sectionFields(literals[0]!.text).entries()].flatMap(([section, fields]) =>
    fields.filter((f) => !(sections.get(section)?.has(f) ?? false)).map((f) => `${section}.${f}`),
  );
  assert.deepEqual(
    offenders,
    ['coinSource.definitelyNotInSchema'],
    '★★★ 判据必须能报出"写了但 schema 没有"的字段 —— 否则上面那条是在空转',
  );
});

test('★★ 扫描真的读到了内容（防止"解析失败所以没问题"）', () => {
  const sections = schemaSections();
  assert.ok(sections.has('coinSource'), '★ schema 里应当有 coinSource 分区');
  assert.ok(sections.get('coinSource')!.has('excludeStablecoins'), '★ #145 的字段现在应当在 schema 里');
  assert.ok(sections.get('coinSource')!.has('minOpenInterestUsd'), '★ #182 的字段也应当在');

  const found = parseLiterals(SOURCE).flatMap((l) => [...sectionFields(l.text).keys()]);
  assert.ok(found.includes('coinSource'), '★★ 扫描必须真的从源码里读出 coinSource 分区');
  assert.ok(found.includes('riskControl'), '★★ 也应读出 riskControl');
});
