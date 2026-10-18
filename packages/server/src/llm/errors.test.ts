/**
 * **未归类网关错误文案**的被动观测（2026-10-18 · magpie 依赖治理）。
 *
 * ## 这个文件防的是什么
 *
 * magpie 自动更新、一天多版。它一旦改了某句错误文案的措辞，`errors.ts` 里
 * 那个 `TRANSIENT_BAD_REQUEST_MARKERS` 就匹配不上 —— 于是一个**本可重试**的
 * HTTP 400 被判成 `bad_request`（不可重试），那次请求被放弃。
 *
 * **这个仓库为此付过两次代价**（见 `errors.ts` 里 `模型不可用：deepseek-flash` 那段注释）。
 *
 * ⇒ 加了一个被动接收器：真实流量里出现"4xx 但文案一个都不认识"时记一笔。
 *
 * ## 三条边界（都要钉住）
 *
 * | # | 场景 | 期望 |
 * |---|---|---|
 * | ① | 没注册 sink | **零副作用**（默认行为逐字不变） |
 * | ② | 注册了 sink + 未归类文案 | 触发一次，带上原文 |
 * | ③ | 注册了 sink + **已登记**的可用性短语 | **不触发**（那是正常路径） |
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { kindForStatus, setUnrecognizedErrorSink } from './errors.js';

test('★★★ 没注册 sink 时零副作用（默认行为逐字不变）', () => {
  /*
   * 这是它能默认关闭的前提：不注册就完全不做任何事。
   * 用一个"如果被调用就抛"的探针 —— 但既然没注册，这里其实是断言语义：
   * 分类结果必须与不装钩子时一致。
   */
  setUnrecognizedErrorSink(null);
  assert.equal(kindForStatus(400, 'a completely unknown message'), 'bad_request');
  assert.equal(kindForStatus(400, '模型不可用：deepseek-flash'), 'overloaded', '已登记的短语仍走 overloaded');
});

test('★★★ 注册后：未归类的 4xx 文案触发一次，带原文', () => {
  const seen: Array<{ status: number; body: string }> = [];
  setUnrecognizedErrorSink((d) => seen.push(d));

  const kind = kindForStatus(400, 'a completely unknown message from upstream');
  assert.equal(kind, 'bad_request', '判定本身不变（这个钩子只观测，不改判据）');
  assert.equal(seen.length, 1, '★ 触发一次');
  assert.equal(seen[0]!.status, 400);
  assert.ok(seen[0]!.body.includes('a completely unknown message'), '要带上原文，否则没法判断该不该登记');

  setUnrecognizedErrorSink(null);
});

test('★★★ 已登记的可用性短语【不触发】（那是正常路径，不是漂移信号）', () => {
  const seen: Array<{ status: number; body: string }> = [];
  setUnrecognizedErrorSink((d) => seen.push(d));

  /*
   * 这些是 `TRANSIENT_BAD_REQUEST_MARKERS` 里已登记的。
   * 它们本来就该走 `overloaded`（可重试）—— 触发"未归类"告警是假警报。
   */
  for (const phrase of ['模型不可用', 'model unavailable', 'temporarily unavailable', 'try again']) {
    const kind = kindForStatus(400, `upstream said: ${phrase}`);
    assert.equal(kind, 'overloaded', `★ 已登记短语应判为 overloaded：${phrase}`);
  }
  assert.equal(seen.length, 0, '★ 一个都不该触发 —— 假警报会让这条信号失去价值');

  setUnrecognizedErrorSink(null);
});

test('★★ 非 4xx 不触发（5xx / 429 / 401 各有明确归类）', () => {
  const seen: Array<{ status: number; body: string }> = [];
  setUnrecognizedErrorSink((d) => seen.push(d));

  kindForStatus(500, 'boom');
  kindForStatus(502, 'bad gateway');
  kindForStatus(401, 'unauthorized');
  kindForStatus(404, 'not found');
  assert.equal(seen.length, 0, '★ 只有 4xx（除已归类的那几个）才需要"文案不认识"这条信号');

  setUnrecognizedErrorSink(null);
});
