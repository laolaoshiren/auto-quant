/**
 * **策略师必须有"校准入场门槛"的指令**（2026-10-15 实测抓到）
 *
 * ## 事故：工具在、描述写得极好，而任务描述里没让它去读
 *
 * 线上实测（`#11`）：
 * ```
 *   get_skipped_outcomes 历史上用过 44/68 次（64.7%）
 *   而【最近 8 轮】一次都没用 —— 每轮只读 2-3 个工具就 finish 了
 *   而它的 decisionProcess（1299 字）里【一个字都没提】这个工具
 * ```
 *
 * 而那个工具自己的描述（`tools.ts`）写得非常明确：
 * > 「**This is the only feedback that can calibrate your entry standards.**
 * >  If symbols you kept rejecting went up a lot, your filter is too strict —
 * >  that is evidence, not opinion.」
 *
 * 也就是说：**能力在、证据链在、而没人告诉它要用** —— 与 `orchestrator.ts:214`
 * 记录过的形态**一模一样**（原文：「这正是本项目反复出现的形态」）。
 *
 * ## 后果是具体的：它 3 天改了 10 次参数，却无法判断哪次是对的
 *
 * 它自己的原话（`agent_experiments #102`）：
 * ```
 *   「skipped_outcomes 样本太小(10个)……不足以支撑门槛调整」
 *   「现在再动任何参数会让 14:20 的修改无法被归因」
 * ```
 * 推理每一步都对，但结果是**永远不校准** —— 它在用"没有数据"论证"不该动"，
 * 而数据就在它手上没读。
 *
 * ## ⚠️ 样本量的指引也必须给
 *
 * 它上次用"只有 10 个样本"否决了校准。若不给指引，它会永远等一个"足够大"的
 * 样本 —— 而那等于永不校准。样本量的正确用法是**决定"结论能下多强"**，
 * 而不是"要不要看"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../../testUtils/sourceText.js';
import { strategistTask } from './orchestrator.js';

const SRC = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8');
const CODE = codeOnly(SRC);
const TASK = strategistTask(13);

test('★★★ 任务描述必须提到 get_skipped_outcomes（否则它不知道要读）', () => {
  assert.match(
    TASK,
    /get_skipped_outcomes/,
    '★ 必须点名这个工具 —— 实测它在提示词没提时【8 轮零调用】',
  );
});

test('★★★ 必须说清"为什么"：只凭盈亏调门槛是在凭结果猜原因', () => {
  /*
   * ⚠️ 光说"要读"不够。要给它**判据**：亏了可能是门槛太严、也可能是门槛太松，
   * 而两者的修法正好相反 —— 只有这个工具能区分。项目里的教训是
   * 「列工具清单不如给判据」。
   */
  assert.match(TASK, /凭结果猜原因/, '★ 要说清"为什么必须看这个数据"');
  assert.match(TASK, /门槛太严/, '★ 要给出两种相反的失败模式');
  assert.match(TASK, /门槛太松/, '★ 两者都要写 —— 只写一个会让它往一边调');
});

test('★★★ 必须给样本量指引（否则它会用"样本太小"否决一切校准）', () => {
  assert.match(
    TASK,
    /样本小不是不读的理由/,
    '★ 实测它用"只有 10 个样本"否决了校准 —— 必须纠正这个用法',
  );
  assert.match(
    TASK,
    /方向性/,
    '★ 要告诉它样本小时该怎么用（下方向性结论，而不是不下结论）',
  );
});

test('★★★ 必须保留原有的"核对规则有没有被遵守"（那条在起作用）', () => {
  /*
   * ⚠️ 实测它每轮都读 `recent_decisions`（41/40 次）—— 那条指令是有效的。
   * 不能因为加新指令而挤掉它。
   */
  assert.match(TASK, /也要核对你写的入场标准有没有被遵守/, '★ 这条不能丢');
  assert.match(TASK, /recent_decisions/, '★ 它靠这个工具核对');
});

test('★★★ 必须保留步数预算提示（否则它不知道怎么规划）', () => {
  assert.match(TASK, /13 次工具调用的预算/, '★ 预算要如实告知');
  assert.match(TASK, /没有结论的这一轮等于白花/, '★ 要说明不产出的代价');
});

test('★★ 注释里要记清事故（供下一个人/AI 理解为什么有这条）', () => {
  assert.match(SRC, /44\/68 次（64\.7%）/, '★ 要记实测数字');
  assert.match(SRC, /最近 8 轮/, '★ 要记"最近失效"这件事');
  assert.match(SRC, /同一个坑，换了个地方又踩一次/, '★ 要点明它与 :214 那个形态同源');
});
