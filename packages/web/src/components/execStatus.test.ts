import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXEC_ROW_CLASS, EXEC_TEXT_CLASS, STATUS_LABELS, statusLabel } from './DecisionAudit.js';

/* -------------------------------------------------------------------------- */
/*  审计日志的状态渲染                                                          */
/* -------------------------------------------------------------------------- */

test('★ `data` 状态必须能被界面渲染出来 —— 那是"看到模型在做什么"的入口', () => {
  /*
   * ## 用户 2026-10-02 的两条要求是连在一起的
   *
   *   「会像真人一样，**决定何时做什么事情**」（能力）
   *   「我打开网页，就能方便快捷**看到模型在做什么**」（可见性）
   *
   * 而"它主动去要了数据"是**最直接的"它在主动工作"的证据** ——
   * 在此之前这条信息只走实时事件流，页面刷新之后就没了，历史里一条都查不到。
   * 于是操作员无法分辨这两种轮次：
   *
   *   · 「它只是把系统喂的 20 个候选看了一遍」（被动）；
   *   · 「它自己决定去拉 XRP 的 15m 与 1h」（主动）。
   *
   * 实测（线上 `#1836` / `#1839`）这两个例子确实产生了 `data` 状态的审计条目。
   *
   * ⚠️ 这条用例真正钉住的是**渲染链条的完整性**：状态码有中文名、有行样式、
   * 有文字样式。少任何一环，那个条目在页面上就是空白或者原始机器码 ——
   * 而"看不到"就等于"没发生过"。
   */
  assert.equal(statusLabel('data'), '已取数', '要有中文名 —— 绝不显示原始机器码');
  assert.ok(STATUS_LABELS.data.length > 0, 'STATUS_LABELS 必须有 data 这一项');

  /* 行样式与文字样式都不能缺 —— 缺了在界面上就是不可见的空白行。 */
  assert.ok(
    typeof EXEC_ROW_CLASS.data === 'string' && EXEC_ROW_CLASS.data.length > 0,
    'data 状态必须有行样式',
  );
  assert.ok(
    typeof EXEC_TEXT_CLASS.data === 'string' && EXEC_TEXT_CLASS.data.length > 0,
    'data 状态必须有文字样式',
  );
});

test('既有的五种状态仍各有中文名 —— 这条改动不该顺手改坏它们', () => {
  for (const [status, label] of [
    ['ok', '已执行'],
    ['submitted', '已挂单'],
    ['rejected', '已拒绝'],
    ['failed', '失败'],
    ['skipped', '已跳过'],
  ] as const) {
    assert.equal(statusLabel(status), label, `${status} 的中文名被改动了`);
  }
  /* 认不出的状态如实回显，而不是渲染成空 —— 那也是"看不到就等于没发生"。 */
  assert.equal(statusLabel('something-new'), 'something-new');
});
