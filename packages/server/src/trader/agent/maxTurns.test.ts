/**
 * **harness 必须有轮数上限**（2026-10-13）。
 *
 * ## 为什么单独一条测试
 *
 * 这是一个**"没有上限"导致的超时** —— 而它的表现（"agent 超过 600 秒未返回"）
 * 看起来像"网络慢"或"模型慢"，完全不像"它自己在无限地搜"。
 *
 * ## 决定性实测（同一个真实猎手任务）
 *
 * ```
 *   不限轮数（线上）   → **600 秒超时**，0 字产出
 *   --max-turns 10     → **86.1 秒**，正常完成（2 次 WebSearch）
 * ```
 * 步骤序列（限 10 轮那次）：
 * ```
 *   tool:WebSearch → tool:WebSearch → result(86111ms)
 * ```
 * **它 2 次搜索就够了** —— 那 600 秒全花在"继续搜更多来源"上，
 * 而那些额外搜索**对最终产出没有任何贡献**（它早就有结论了）。
 *
 * ## 而"撞上限"不等于失败
 *
 * `--max-turns` 到达时会报 `Error: Reached max turns (N)` 并**以非 0 退出**，
 * 而那时它**可能已经写出了我们要的东西**。一律判失败会丢掉可用产出。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const HARNESS = readFileSync(new URL('./harness.ts', import.meta.url), 'utf8');

test('★★★ spawn 参数里必须有 `--max-turns`', () => {
  /*
   * ⚠️ 这是那个超时的**直接形状**：没有这个参数时 claude code 没有轮数上限。
   */
  assert.ok(
    HARNESS.includes("'--max-turns'"),
    '★ 必须传 --max-turns（否则它会无限搜下去直到超时）',
  );
  assert.ok(
    /maxTurns\?: number/.test(HARNESS),
    '★ 必须可配置（不同角色需要不同轮数）',
  );
  /* 默认值必须是有限的数字，不能是 undefined/Infinity。 */
  const m = /String\(input\.maxTurns \?\? (\d+)\)/.exec(HARNESS);
  assert.ok(m !== null, '★ 必须有有限的默认值');
  const def = Number(m[1]);
  assert.ok(def >= 4 && def <= 30, `★ 默认轮数应当合理（实际 ${def}）`);
});

test('★★★ "撞上轮数上限"不能一律判失败（那时可能已有可用产出）', () => {
  assert.ok(
    /Reached max turns/i.test(HARNESS),
    '★ 必须识别"撞上限"这个情形',
  );
  /*
   * ⚠️ **判据改过（2026-10-15）—— 原来的写法钉住了一个 bug。**
   *
   * 原来断言的是：
   * ```
   *   /hitMaxTurns && text\.length > 0[\s\S]{0,200}?ok: true/
   * ```
   * 而 **`text.length > 0` 正是"把错误当产出"的那个错判据** ——
   * `claude --print` 撞上限时把 `Error: Reached max turns (N)` 写到 stdout，
   * 于是 `text` 非空 ⇒ 判成 `ok: true` ⇒ 那句错误被当成有效产出。
   *
   * 线上后果（`research_cache:11`）：
   * ```
   *   ## 消息面调研（4/4 个猎手有产出）      ← 标题说全部有产出
   *   ### 新闻猎手（news_hunter）
   *   Error: Reached max turns (12)          ← 而内容是一句错误
   * ```
   * ⇒ 下游所有角色都以为"消息面调研成功了"。
   *
   * ## 所以现在断言的是【意图】，不是那个具体表达式
   *
   * 意图：**撞上限但有实质内容 → `ok: true`**（不能白跑一轮）；
   *       **撞上限且只有错误行 → `ok: false`**（不能把错误当产出）。
   *
   * ⚠️ 这两条语义由 `hunterErrorNotOutput.test.ts` 做**行为级**验证
   *（直接调 `mergeHunterReports` 看输出），比文本判据可靠 ——
   * 这里只做"harness 源码里确实有这个分支"的结构性检查。
   */
  assert.ok(
    /hitMaxTurns\s*&&\s*substantive\.length > 0[\s\S]{0,300}?ok: true/.test(HARNESS),
    '★ 撞上限但【有实质内容】时应当收下（ok:true）—— 判据不能是"有没有文本"',
  );
  assert.ok(
    /hitMaxTurns\)\s*\{[\s\S]{0,300}?ok: false/.test(HARNESS),
    '★ 撞上限且【只有错误行】时必须是失败（ok:false）—— 否则错误会被当产出',
  );
  /* ⚠️ 但不能静默当成完整成功 —— 必须说明它是被截断的。 */
  assert.ok(
    /达到轮数上限（产出可能不完整）/.test(HARNESS),
    '★ 必须说明产出可能不完整（不能静默当成完整成功）',
  );
});
