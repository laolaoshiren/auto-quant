import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeOpenAiStreamChunks } from './stream.js';

/* -------------------------------------------------------------------------- */
/*  流式分片 → 非流式形状                                                       */
/* -------------------------------------------------------------------------- */

test('★ 把 SSE 分片拼成与非流式完全相同的形状 —— 这样 parse() 一行都不用改', () => {
  /*
   * ## 为什么需要流式（2026-10-01，`HTTP 524`）
   *
   * 线上连续出现 `AI 服务不可用：服务商 5xx（HTTP 524）`，一轮 8 轮里 4 次失败。
   *
   * **`524` 是 Cloudflare 的"源站超时"**：网关等 **100 秒**还没拿到**响应头**就放弃。
   * 而非流式的请求要**把整个响应生成完**才返回第一字节 —— 我们的请求实测
   * **60–205 秒**（一次 100K tokens 的请求实测 220 秒），所以撞上它几乎必然。
   *
   * 流式改变的是**响应头什么时候回来**：源站一连上就返回 200 + `text/event-stream`，
   * 之后才慢慢吐 token。于是网关的 100 秒计时**不再是问题**，
   * 而客户端仍然会一直读到流结束才返回 —— 对上层完全透明。
   *
   * ## 为什么做成"重组"而不是"改 parse"
   *
   * `client.ts` 的 `parse()` 已经在处理非流式形状，而且被大量测试覆盖。
   * 让流式分片**在进入 parse 之前**就被拼成同样的对象，
   * 意味着这次改动**不会碰到解析逻辑** —— 风险小得多。
   */
  const body = mergeOpenAiStreamChunks([
    'data: {"id":"x","model":"deepseek/deepseek-v4-flash-fast","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"先看"},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"结构。"},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"{"},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"}"},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":7}}}',
    'data: [DONE]',
  ]) as Record<string, any>;

  assert.equal(body['model'], 'deepseek/deepseek-v4-flash-fast', 'model 要保留');
  assert.equal(body['choices'][0]['message']['content'], '{}', 'content 分片要按序拼接');
  assert.equal(
    body['choices'][0]['message']['reasoning_content'],
    '先看结构。',
    'reasoning_content 也要拼 —— 丢掉它会让「思考过程」在页面上变空',
  );
  assert.equal(body['choices'][0]['finish_reason'], 'stop', 'finish_reason 取最后一个非 null');
  assert.equal(body['usage']['prompt_tokens'], 100, 'usage 要保留（计费与展示都靠它）');
});

test('忽略注释行、空行与 `[DONE]`，不因它们而崩', () => {
  /*
   * SSE 的注释行（`: ping`）用来保活，`[DONE]` 是结束标记 ——
   * 它们都不是 JSON。一个健壮的拼接器必须跳过它们，而不是抛错。
   */
  const body = mergeOpenAiStreamChunks([
    ': keep-alive',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
  ]) as Record<string, any>;
  assert.equal(body['choices'][0]['message']['content'], 'ok');
});

test('坏分片被跳过，而不是让整次调用失败', () => {
  /*
   * 上游偶尔会在流里插入一行不完整/非法 JSON（连接抖动）。
   * 已经拿到的内容**必须保住** —— 那可能已经是一份完整的决策。
   */
  const body = mergeOpenAiStreamChunks([
    'data: {"choices":[{"index":0,"delta":{"content":"A"},"finish_reason":null}]}',
    'data: {broken',
    'data: {"choices":[{"index":0,"delta":{"content":"B"},"finish_reason":"stop"}]}',
  ]) as Record<string, any>;
  assert.equal(body['choices'][0]['message']['content'], 'AB');
});

test('工具调用分片要按 index 归并 —— 否则调用会被拆成多个残片', () => {
  /*
   * OpenAI 兼容的流式 `tool_calls` 是**增量**的：先给 id 与 name，
   * 再按 index 一点点给 arguments 的字符串片段。
   * 不归并会让一个工具调用变成三个半截的调用，而下游根本没法执行。
   */
  const body = mergeOpenAiStreamChunks([
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_klines","arguments":""}}]},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"sym"}}]},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"bol\\":\\"BTCUSDT\\"}"}}]},"finish_reason":"tool_calls"}]}',
  ]) as Record<string, any>;

  const calls = body['choices'][0]['message']['tool_calls'];
  assert.equal(calls.length, 1, '同一个 index 要归并成一个调用');
  assert.equal(calls[0]['id'], 'call_1');
  assert.equal(calls[0]['function']['name'], 'get_klines');
  assert.equal(calls[0]['function']['arguments'], '{"symbol":"BTCUSDT"}');
});

test('空流返回一个"没有内容"的形状，而不是 null', () => {
  /*
   * 上游可能返回一个立刻结束的空流。返回 `null` 会让调用方在
   * "读一个属性"时崩在离现场很远的地方；返回空形状则会被既有的
   * `isEmpty` 判定捕获，走它本来就走的那条"空补全"路径。
   */
  const body = mergeOpenAiStreamChunks(['data: [DONE]']) as Record<string, any>;
  assert.equal(body['choices'][0]['message']['content'], '');
  assert.equal(body['choices'][0]['finish_reason'], null);
});
