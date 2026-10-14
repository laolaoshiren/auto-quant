/**
 * **coerce 白名单必须覆盖 `RawDecisionSchema` 的每一个键**（2026-10-15）
 *
 * ## 事故：`intel_keys` 被静默丢掉 —— 这是**第四次**踩同一个坑
 *
 * `parser.ts` 的 `coerceRawDecision()` 里有一段注释，**它自己记过三次**同一件事：
 * ```
 *   entry_type    —— 「第一版我把它加在了调用点，于是 zod 认、
 *                     而 coerced 里根本没有这两个键，限价入场永远是市价」
 *   wait_minutes  —— 「zod 认、而这个白名单里没有的键会被静默丢掉」
 *   setup_score   —— 「这是第二次踩」
 * ```
 * 而 `intel_keys` 是**第四次**：
 * ```
 *   上游全都写好了：
 *     decision.ts:233   RawDecisionSchema 收了 intel_keys
 *     parser.ts:874     用它构造 intelKeys（有去重与过滤）
 *     repositories.ts   positions.intel_keys / trades.intel_keys 两列都在
 *     tradingDesk.ts    提示词要求裁决官标注
 *     signalHealth.ts   按 signalKey 分组算胜率崩塌 / 反应衰减
 *   但 coerce 白名单里没有它 ⇒ coerced.intel_keys 永远 undefined
 *   ⇒ parser.ts:874 那个分支永远不成立
 *   ⇒ 实测线上：trades / positions 的 intel_keys 三个机器人 500+ 行【全部为 []】
 *   ⇒ signalHealth 永远 insufficient_data（用户点名要的功能从未生效）
 * ```
 *
 * ## 所以这条测试的判据必须**自动**发现漏项
 *
 * 前三段注释的教训都是"下一个人要记得" —— 而**人一定会忘**（已经忘了三次）。
 * 正确判据是：**从 `RawDecisionSchema` 的键反查白名单**，
 * 漏一个就红，不需要任何人记得。
 *
 * ⚠️ 允许的例外：schema 里有、而白名单**故意**不搬的键（见下面 `EXEMPT`）。
 * 每加一个例外都必须写清为什么 —— 否则它就成了"悄悄放宽"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { RawDecisionSchema } from '@aq/shared';

const PARSER = readFileSync(new URL('./parser.ts', import.meta.url), 'utf8');

/**
 * schema 里有、但**故意**不搬进 `coerced` 的键。
 *
 * ⚠️ 加进来必须给理由 —— 这个列表本身是"白名单的例外清单"，
 * 它越长，说明"zod 认而解析层丢"的风险面越大。
 */
const EXEMPT: Readonly<Record<string, string>> = {
  /*
   * `action` 在 `LenientDecisionSchema` 里被放宽成 `z.string()`（见 parser.ts:30），
   * 而 `coerced` 里确实搬了它（`action`）—— 所以这里不需要例外。
   * 保留这个空对象是为了让"加例外"这件事**需要显式编辑**（有摩擦才有思考）。
   */
};

test('★★★ coerce 白名单必须覆盖 RawDecisionSchema 的每个键（防第四次踩坑）', () => {
  /* 从 schema 取全集（唯一事实来源）—— 不手写列表。 */
  const schemaKeys = Object.keys(RawDecisionSchema.shape);
  assert.ok(schemaKeys.length >= 10, `★ 从 schema 只解析出 ${schemaKeys.length} 个键，太少了`);

  /*
   * 从 `coerceRawDecision` 里取白名单。
   * 判据：`candidate` 对象字面量里出现的键名（`key:` 形式）。
   */
  const fnAt = PARSER.indexOf('function coerceRawDecision');
  assert.ok(fnAt > 0, '★ 找不到 coerceRawDecision');
  const body = PARSER.slice(fnAt, fnAt + 7000);
  const candidateAt = body.indexOf('const candidate');
  assert.ok(candidateAt > 0, '★ 找不到 candidate 对象字面量');
  const candidateBlock = body.slice(candidateAt, body.indexOf('const parsed', candidateAt));
  const coercedKeys = new Set<string>();
  for (const line of candidateBlock.split('\n')) {
    /*
     * 两种形状都要认（第一版只认 `key:`，于是把 `action,` 这种
     * **简写属性**误判成"不在白名单里" —— 假警报）：
     * ```
     *   action,                     ← 简写（变量名即键名）
     *   leverage: toFiniteNumber(…)  ← 显式
     *   intel_keys: Array.isArray(…) ← 显式
     * ```
     */
    const explicit = /^\s{4}([a-z_][a-z0-9_]*):/.exec(line);
    if (explicit) coercedKeys.add(explicit[1] as string);
    const shorthand = /^\s{4}([a-z_][a-z0-9_]*),\s*$/.exec(line);
    if (shorthand) coercedKeys.add(shorthand[1] as string);
  }
  assert.ok(coercedKeys.size >= 10, `★ 从 candidate 只解析出 ${coercedKeys.size} 个键，太少了`);

  const missing = schemaKeys.filter(
    (k) => !coercedKeys.has(k) && !(k in EXEMPT),
  );
  assert.deepEqual(
    missing,
    [],
    `★ 这些键在 RawDecisionSchema 里、却不在 coerce 白名单里 —— ` +
      `它们会被【静默丢掉】（zod 认、而 coerced 里没有）：${missing.join('、')}\n` +
      `   加进白名单，或加进 EXEMPT 并写清理由。`,
  );
});

test('★★★ `intel_keys` 必须在白名单里（它是被漏掉的那一个）', () => {
  /*
   * 单独钉一条：因为它是**用户点名要的功能**（消息面策略失效检测）
   * 的数据来源，而它已经静默失效过一次。
   */
  const fnAt = PARSER.indexOf('function coerceRawDecision');
  const body = PARSER.slice(fnAt, fnAt + 7000);
  assert.ok(
    /intel_keys:/.test(body),
    '★ `intel_keys` 必须在 coerce 白名单里 —— 否则 signalHealth 永远拿不到数据',
  );
  /* 两种写法都要收（模型输出 camelCase 还是下划线看它当天习惯）。 */
  assert.ok(
    /intelKeys/.test(body),
    '★ 也必须收 camelCase 写法（否则一半模型输出会被丢）',
  );
});
