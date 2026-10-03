import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strategyIdFor } from './TraderModals.js';

/* -------------------------------------------------------------------------- */
/*  创建机器人：strategyId 该传什么                                              */
/* -------------------------------------------------------------------------- */

test('★ AI 托管必须传 null —— 服务端会拒绝带策略的请求', () => {
  /*
   * ## 用户 2026-10-03 报的「创建不了机器人」
   *
   * 截图里红框写着：
   *
   *   ⚠️ 智能托管模式不引用任何策略 —— 请不要为它选择策略。
   *
   * **那不是界面提示，那就是服务端抛出来的错误文字**（前端 `setError(err.message)`
   * 把它显示在了表单上）。根因是前端无条件传 `Number(strategyId)`：
   *
   *   前端：strategyId: Number(strategyId)          // 永远是 #9
   *   服务端：if (ai_managed && strategyId !== null) throw …
   *
   * 而 `d338b35`「智能托管与策略彻底解耦」之后服务端已经要求可空
   * （迁移把 `traders.strategy_id` 改成 `ON DELETE SET NULL`），
   * **是前端的类型与注释停留在了解耦之前**。
   *
   * 这条用例钉住"提交时必须传 null"。策略模式仍然要传真实 id。
   */
  assert.equal(
    strategyIdFor('ai_managed', 9),
    null,
    '★ AI 托管不能把下拉框里那个 id 带上去 —— 服务端会因为它直接拒绝创建',
  );
  assert.equal(strategyIdFor('strategy', 9), 9, '策略模式必须带上真实策略 id');
});

test('★ 下拉框 disabled 不等于请求里没有 —— 这正是当初踩的坑', () => {
  /*
   * 界面上那个 `Select` 在 AI 托管时是 `disabled` 的，看起来"选不了策略"。
   * 但 `disabled` 只阻止**用户交互**，`strategyId` 这个 state 仍然是一个真实
   * 策略 id（默认就是列表第一个，`#9`）—— 提交时照样被带上。
   *
   * **"界面上选不了"与"请求里没有"是两件事。** 这条用例用"一个仍然有值的
   * selected"来模拟那个状态：无论传进来什么数字，AI 托管都必须归零。
   */
  for (const selected of [1, 9, 42, 999]) {
    assert.equal(
      strategyIdFor('ai_managed', selected),
      null,
      `AI 托管下不论 state 里残留哪个 id（${selected}），都不能发给服务端`,
    );
  }
});
