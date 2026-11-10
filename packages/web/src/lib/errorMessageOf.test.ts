/**
 * 审计 #21（2026-11-10）：失败响应的原因只放在 `note` 里时（例如
 * `POST /api/traders/:id/agent-review` 的 409「机器人没有在运行」），
 * 前端原来只认 `error`，于是 toast 只显示「请求失败：HTTP 409」，原因丢了。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { errorMessageOf } from './api';

test('#21 只有 note 时用 note，而不是「请求失败：HTTP 409」', () => {
  assert.equal(
    errorMessageOf(409, { ok: false, accepted: false, note: '机器人没有在运行 —— 先启动它。' }),
    '机器人没有在运行 —— 先启动它。',
  );
});

test('有 error 时仍以 error 为准（既有行为不变）', () => {
  assert.equal(errorMessageOf(400, { error: '未知的策略', note: '别的' }), '未知的策略');
});

test('都没有 / 非对象 / 空 note → 回落到状态码', () => {
  assert.equal(errorMessageOf(500, null), '请求失败：HTTP 500');
  assert.equal(errorMessageOf(502, 'Bad Gateway'), '请求失败：HTTP 502');
  assert.equal(errorMessageOf(409, { ok: false, note: '  ' }), '请求失败：HTTP 409');
});
