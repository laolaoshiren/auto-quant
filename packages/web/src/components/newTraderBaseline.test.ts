/**
 * 审计 #2（2026-11-10）：新建机器人返回 `equitySource: 'unavailable'` 时
 *
 *  · 纯模拟盘（不绑账户）不能说「未能从交易所读取钱包余额」—— 它根本没有交易所；
 *  · 「厂商建议」模型在同一个弹窗里只能建一次记录，重试必须复用。
 *
 * （「机器人已建好后按钮变成『完成』、不能再提交」是组件状态，本仓 web 侧没有
 *  组件挂载能力；`submit()` 开头的 `if (createdPending) return finishPending()` 钉住它。）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { baselineWarningFor, reusableModelId } from './TraderModals.js';

test('#2 纯模拟盘的基准警告不提交易所', () => {
  const paper = baselineWarningFor(true);
  assert.doesNotMatch(paper, /交易所/);
  assert.match(paper, /模拟盘起始余额/);
  assert.match(paper, /已创建/);
});

test('#2 绑了账户时仍说明是读交易所余额失败', () => {
  const live = baselineWarningFor(false);
  assert.match(live, /交易所/);
  assert.match(live, /已创建/);
});

test('#2 同一个「厂商建议」模型在本次弹窗里只建一次记录', () => {
  const created = { 'new:deepseek-chat': 42 };
  assert.equal(reusableModelId(created, 'new:deepseek-chat'), 42, '重试必须复用已建的记录');
  assert.equal(reusableModelId(created, 'new:other'), undefined, '别的模型照常新建');
  assert.equal(reusableModelId(created, '7'), undefined, '已有记录（纯数字）不走这条路');
  assert.equal(reusableModelId({}, 'new:deepseek-chat'), undefined);
});
