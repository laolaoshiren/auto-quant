/**
 * `plainText()` 的测试（2026-10-15）。
 *
 * ## 为什么需要它
 *
 * 界面是**给人读的纯文本**，不是 markdown 渲染器。而模型输出与服务端文案里
 * 大量使用 `**` 做强调 —— 那些符号会**原样显示**给用户：
 * ```
 *   汇总多空论证，给出**唯一**结论（有权决定"不行动"）     ← 用户看到的界面
 *   它**没有被执行**，但也不是"模型没给"
 * ```
 * 用户看到只会当成界面坏了。所以这条测试钉住**两侧**：
 * `**` 必须剥掉，而**看起来像 markdown、其实是技术文本**的东西必须原样保留。
 *
 * 只测"剥掉"那一侧是不够的 —— 一个 `replace(/[_*`#]/g,'')` 也能让它通过，
 * 但那会静默改掉模块名、字段名、路径（本仓库对这类"静默改掉事实"的处理一贯更严）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { plainText } from './plainText.js';

test('★★★ 强调符号必须剥掉（案例取自真实页面文案）', () => {
  /* `firm.ts` 的 duty 字段（团队看板每个岗位那一行的悬浮说明）。 */
  assert.equal(
    plainText('汇总多空论证，给出**唯一**结论（有权决定"不行动"）'),
    '汇总多空论证，给出唯一结论（有权决定"不行动"）',
  );
  /* `parser.ts` 的拒单理由 —— 它在决策审计里直接显示给操作员。 */
  assert.equal(
    plainText('它**没有被执行**，但也不是"模型没给" —— 原始内容见本轮 rawResponse。'),
    '它没有被执行，但也不是"模型没给" —— 原始内容见本轮 rawResponse。',
  );
  /* `roster.ts` 的 STATE_HINT（悬浮说明）。 */
  assert.equal(plainText('**这个岗位还没有实现** —— 不要以为有人在干这件事。'), '这个岗位还没有实现 —— 不要以为有人在干这件事。');
});

test('★★★ 不该剥的必须原样保留：`__` / 反引号 / `#` 可能是技术文本的一部分', () => {
  /*
   * ⚠️ `__` 在标识符里很常见（模块名、字段名、双下划线路径）。
   * 误剥它会**静默改掉一个可核对的事实** —— 而 `carriedBy` 写的正是
   * "这个职能由哪段代码承担"，操作员要靠它去核对。那比漏剥更难发现。
   *
   * 反引号与 `#` 同理：它们常用来标出代码 / 编号，剥掉会丢掉"这是代码"的暗示。
   * 所以本函数**只剥 `**`**，其余一律不动。
   */
  assert.equal(
    plainText('selfcheck.ts 的 findDeterministicProblems()'),
    'selfcheck.ts 的 findDeterministicProblems()',
  );
  assert.equal(plainText('/api/health 的 staleTraders'), '/api/health 的 staleTraders');
  assert.equal(plainText('字段 a__b 与 my_module'), '字段 a__b 与 my_module');
  assert.equal(plainText('`code` 与 # 标题都保留'), '`code` 与 # 标题都保留');
});

test('★ 不配对的 `**` 也要剥（模型输出常常只写一半）', () => {
  /*
   * 模型经常写出 `**开头强调` 而没有收尾 —— 那种残留同样会让用户觉得界面坏了。
   * 这条不要求"成对才算 markdown"，因为**显示层的目标是去掉符号**，
   * 不是解析一个合法的 markdown 文档。
   */
  assert.equal(plainText('**开头强调'), '开头强调');
  assert.equal(plainText('结尾强调**'), '结尾强调');
  assert.equal(plainText('无符号文本'), '无符号文本');
  assert.equal(plainText(''), '');
});
