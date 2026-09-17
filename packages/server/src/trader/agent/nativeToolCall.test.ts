/**
 * 原生工具调用方言的解析。
 *
 * ## 为什么这些用例存在
 *
 * 这个解析器是**为了接住模型真实会说的话**。它漏掉的情形，后果是
 * 一整轮审视作废 + 2.5 万 tokens 白烧 —— 而日志里只会显示"模型没输出可解析的
 * 工具调用"，看起来像模型不听话，实际是解析器不够宽。
 *
 * 所以夹具用的是**实测那次失败的真实形态**（含它缺少闭合标签这一点），
 * 而不是我设想的"标准写法"。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseNativeToolCalls } from './nativeToolCall.js';

/** 构造那种格式的行。用码点拼，避免源码里出现难以辨认的全角竖线。 */
const M = '\uFF5C\uFF5CDSML\uFF5C\uFF5C';
const open = (): string => '<' + M + ' calls>';
const invoke = (name: string): string => '<' + M + ' invoke name="' + name + '">';
const param = (name: string, value: string, isString = false): string =>
  '<' + M + ' parameter name="' + name + '"' + (isString ? ' string="true"' : '') + '>' + value;

test('抽出一次调用（parameter 没有闭合标签 —— 这是实测的真实形态）', () => {
  /*
   * 实测那次回复就是**没有闭合标签**的：模型在生成中被截断，或在格式上偷懒。
   * 靠闭合标签切块会一个都抽不出来，而这个用例把它钉住。
   */
  const text = [open(), invoke('finish'), param('summary', '本轮不改参数')].join('\n');

  const calls = parseNativeToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.tool, 'finish');
  assert.equal(calls[0]!.args.summary, '本轮不改参数');
});

test('抽出 parameter（带闭合标签时不留残渣）', () => {
  const text = [open(), invoke('finish'), param('summary', '看完了'), '</' + M + ' invoke>'].join('\n');
  const calls = parseNativeToolCalls(text);
  assert.equal(calls[0]!.args.summary, '看完了', '闭合标签必须被去掉，不能留在值里');
});

test('多个 parameter：值不会被下一个 parameter 的标签污染', () => {
  const text = [
    open(),
    invoke('set_params'),
    param('reason', '候选太多'),
    param('patch', '{"coinSource":{"coinPoolLimit":6}}'),
  ].join('\n');

  const calls = parseNativeToolCalls(text);
  assert.equal(calls[0]!.args.reason, '候选太多');
  assert.equal(calls[0]!.args.patch, '{"coinSource":{"coinPoolLimit":6}}');
});

test('多个 invoke 各自成一条调用', () => {
  const text = [
    open(),
    invoke('get_performance'),
    param('window', '24h'),
    invoke('finish'),
    param('summary', '看完了'),
  ].join('\n');

  const calls = parseNativeToolCalls(text);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.tool, 'get_performance');
  assert.equal(calls[0]!.args.window, '24h');
  assert.equal(calls[1]!.tool, 'finish');
  assert.equal(calls[1]!.args.summary, '看完了');
});

test('数字被转成数字，但声明成字符串的永不转', () => {
  /*
   * 后半条很要紧：一次自以为是的转换会把 summary 里的 "007" 变成 7。
   */
  const text = [
    open(),
    invoke('get_experiments'),
    param('limit', '10'),
    param('reason', '007', true),
  ].join('\n');

  const calls = parseNativeToolCalls(text);
  assert.equal(calls[0]!.args.limit, 10, '无类型声明的纯数字应当转');
  assert.equal(calls[0]!.args.reason, '007', '声明为字符串的必须保持字符串');
});

test('true / false / null 被转成字面量', () => {
  const text = [open(), invoke('set_params'), param('a', 'true'), param('b', 'false'), param('c', 'null')].join('\n');
  const args = parseNativeToolCalls(text)[0]!.args;
  assert.equal(args.a, true);
  assert.equal(args.b, false);
  assert.equal(args.c, null);
});

test('不含这种格式时返回空数组 —— 不是抛异常', () => {
  /*
   * 这条让调用方可以"先试 JSON、再试这种"，两条路都不认时才判失败。
   */
  for (const text of ['', '我无法判断。', '{"tool":"finish","args":{}}', '普通的一句话']) {
    assert.deepEqual(parseNativeToolCalls(text), [], JSON.stringify(text.slice(0, 20)));
  }
});

test('前后有解释文字：调用抽得出来，但**值只到本行末尾**', () => {
  /*
   * ⚠️ 这条断言的是**格式本身的限制**，不是理想的宽容度。
   *
   * 没有闭合标签时，"值到哪结束"在格式上就是有歧义的 —— 尾随的"以上。"
   * 与值本身长得一模一样，解析器无法区分。
   *
   * 取舍方向是刻意的：**按行切**。多截一点会失败得响亮（JSON.parse 抛错），
   * 多留一点会静默把尾随文字混进值里。前者比后者安全。
   *
   * 真正会被截断影响的只有 reason/summary 这类给人看的散文 —— 代价可接受。
   */
  const text = [
    '我的判断如下：',
    open(),
    invoke('finish'),
    param('summary', '不改'),
    '以上。',
  ].join('\n');

  const calls = parseNativeToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.args.summary, '不改', '值到本行末尾为止');
  assert.ok(!calls[0]!.args.summary!.toString().includes('以上'), '尾随解释文字不得混进值里');
});

test('工具名为空或畸形时，那一条被跳过而不是产生一个空名字的调用', () => {
  /*
   * 一个空工具名传下去只会得到"没有名为 的工具"这种没用的错误。
   * 正则要求 name="..." 里至少一个字符，所以畸形行整体不匹配。
   */
  const text = ['<' + M + ' calls>', '<' + M + ' invoke name="">', param('x', '1')].join('\n');
  assert.deepEqual(parseNativeToolCalls(text), []);
});