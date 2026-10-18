/**
 * **错误文案的人话翻译**（2026-10-18）。
 *
 * ## 这个文件防的是什么
 *
 * 用户截图指出界面上红着一行：
 * ```
 *   ⚠ 持仓读不到，下面是 8 秒前的读数：Failed to fetch
 * ```
 * 原话：「别老整一些莫名其妙，对用户无意义的东西上 UI」。
 *
 * `Failed to fetch` 是浏览器 `fetch` 的原始异常文案 —— 对操作员**零信息量**：
 * 不是中文、没说清发生了什么、也没说该怎么办。
 *
 * ⇒ `hooks.ts` 的 `humanErrorText()` 把它翻译成
 * 「暂时连不上服务（网络或服务正在重启）—— 页面会自动重试」。
 *
 * ## 两条边界（都要钉住）
 *
 * | # | 输入 | 期望 |
 * |---|---|---|
 * | ① | 浏览器底层异常文案 | **翻译**（对用户无意义） |
 * | ② | 后端业务错误 / 401 | **保留原文**（那是有意义的信息） |
 *
 * ⚠️ 第 ② 条更重要：把"登录已过期"翻译成"网络问题"会让操作员
 * 去查网络，而真相是他该重新登录。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { humanErrorText } from './hooks.js';

const FRIENDLY = '暂时连不上服务（网络或服务正在重启）—— 页面会自动重试';

test('★★★ 浏览器底层异常文案被翻译成中文（用户截图里的那句）', () => {
  /*
   * 这五种是 Chrome / Safari / Firefox / Node 各自的原始写法，
   * 实测用户看到的是第一个。
   */
  for (const raw of [
    'Failed to fetch',
    'Load failed',
    'NetworkError when attempting to fetch resource.',
    'The operation was aborted.',
    'fetch failed',
  ]) {
    assert.equal(
      humanErrorText(new Error(raw)),
      FRIENDLY,
      `★ 「${raw}」对操作员毫无意义，必须翻译`,
    );
  }
});

test('★★★ 后端业务错误【保留原文】—— 翻译掉会丢信息', () => {
  /*
   * 这些是**有意义的**：操作员看了知道该做什么。
   * 尤其是"登录已过期" —— 翻译成"网络问题"会让他去查网络。
   */
  for (const raw of ['登录已过期，请重新登录', '机器人不存在', '该标的不在候选集内', 'HTTP 500']) {
    assert.equal(humanErrorText(new Error(raw)), raw, `★ 「${raw}」是有用信息，不能翻译`);
  }
});

test('★★ `ApiError(0, …)`（根本没拿到响应）也翻译成临时性提示', () => {
  /*
   * `api.ts` 在 `fetch` 本身抛错时构造 `ApiError(0, '无法连接后端')`。
   * status 0 的语义就是"请求没发出去/没回来"，属于临时性。
   */
  assert.equal(humanErrorText(new Error('无法连接后端')), FRIENDLY);
});

test('★★ 空错误信息也不能显示成空白', () => {
  assert.equal(humanErrorText(new Error('')), '读取失败（原因未返回）');
  assert.equal(humanErrorText(new Error('   ')), '读取失败（原因未返回）');
});

test('★★ 非 Error 对象也能处理（不抛）', () => {
  assert.equal(typeof humanErrorText('字符串错误'), 'string');
  assert.equal(typeof humanErrorText(null), 'string');
  assert.equal(typeof humanErrorText(undefined), 'string');
});
