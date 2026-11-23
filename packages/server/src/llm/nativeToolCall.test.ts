/**
 * **原生 function calling 的三家协议测试**（2026-10-23）
 *
 * ## 为什么有这份测试
 *
 * 实测 `#10`（智能托管）：`agent_runs` 里 **ok 85 / failed 74（成功率 53%）**，
 * 失败原因几乎全是同一句：
 * ```
 *   "JSON 解析成功，但里面没有 tool 字段 —— 你只写了 thought"
 * ```
 * 而提示词里已经用 5 处整段警告反复强调那个格式，**模型仍然不听** ——
 * 「在自由文本里遵守一个格式约定」本来就是模型的弱项，不是它不配合。
 *
 * 修法是把这件事从「模型自觉」换成「协议保证」：工具清单由 API 参数传下去，
 * 模型返回结构化 `tool_calls`。**"忘了写 tool 字段"这种失败形态在协议上就不存在了。**
 *
 * ## 这份测试钉的是什么
 *
 * 三家 provider 的 wire 格式**互不相同**，而错一处就会静默退化：
 * ```
 *   · OpenAI 工具结果用 role:'tool' + tool_call_id
 *   · Anthropic **没有 tool 角色**，用 role:'user' + {type:'tool_result'}
 *   · Gemini  **没有 tool 角色**，用 role:'user' + {functionResponse}
 *           而且它靠**工具名**关联结果，不是 id
 * ```
 * 照抄一家的形状到另一家，表现是"请求发出去了、模型回了个不相干的东西"——
 * 那是最难查的一类故障（没有报错）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as anthropic from '../llm/anthropic.js';
import * as gemini from '../llm/gemini.js';
import * as openai from '../llm/openaiCompatible.js';
import type { ChatMessage, ToolSpec } from '../llm/types.js';
import { AGENT_TOOL_SPECS } from '../trader/agent/tools.js';

const TOOLS: ToolSpec[] = [
  {
    name: 'get_performance',
    description: '读已实现绩效',
    parameters: {
      type: 'object',
      properties: { window: { type: 'string' } },
      required: ['window'],
    },
  },
  {
    name: 'set_params',
    description: '改一个参数',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' }, value: { type: 'number' } },
      required: ['key', 'value'],
    },
  },
];

/** 一轮典型的工具对话：用户问 → 助手调工具 → 工具回结果。 */
const CONVERSATION: ChatMessage[] = [
  { role: 'system', content: 'you are a strategist' },
  { role: 'user', content: '看绩效' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call_abc', name: 'get_performance', arguments: '{"window":"7d"}' }],
  },
  { role: 'tool', content: '{"netPnl":1.5}', toolCallId: 'call_abc', toolName: 'get_performance' },
];

/* -------------------------------------------------------------------------- */
/*  OpenAI 兼容                                                                */
/* -------------------------------------------------------------------------- */

test('★★★ OpenAI：tools 必须翻译成 {type:function,function:{…}}', () => {
  const body = openai.buildBody('deepseek', 'm', CONVERSATION, { tools: TOOLS });
  const tools = body['tools'] as unknown[];
  assert.ok(Array.isArray(tools), '★ 必须带 tools 数组');
  assert.equal(tools.length, 2);
  const first = tools[0] as { type: string; function: { name: string; parameters: unknown } };
  assert.equal(first.type, 'function', '★ OpenAI 要求外层 type:function');
  assert.equal(first.function.name, 'get_performance');
  assert.ok(first.function.parameters !== undefined, '★ schema 放在 function.parameters');
  assert.equal(body['tool_choice'], 'auto', '★ 不指定时要显式写 auto');
});

test('★★★ OpenAI：工具结果必须带 tool_call_id（否则模型认为没人问过）', () => {
  const body = openai.buildBody('deepseek', 'm', CONVERSATION, { tools: TOOLS });
  const messages = body['messages'] as Array<Record<string, unknown>>;
  const toolMsg = messages.find((m) => m['role'] === 'tool');
  assert.ok(toolMsg !== undefined, '★ tool 角色要原样保留');
  assert.equal(toolMsg['tool_call_id'], 'call_abc', '★ 丢了它模型就对不上');
});

test('★★★ OpenAI：带工具调用的 assistant 消息 content 必须是 null 而非空串', () => {
  /*
   * OpenAI 要求带 `tool_calls` 的 assistant 消息 `content` 为 null 或省略；
   * 传空字符串在某些兼容网关上会被判 invalid_request。
   */
  const body = openai.buildBody('deepseek', 'm', CONVERSATION, { tools: TOOLS });
  const messages = body['messages'] as Array<Record<string, unknown>>;
  const asst = messages.find((m) => m['role'] === 'assistant');
  assert.ok(asst !== undefined);
  assert.equal(asst['content'], null, '★ 空内容必须发 null');
  assert.ok(Array.isArray(asst['tool_calls']), '★ 要带 tool_calls 数组');
});

test('★★★ OpenAI：tools 与 response_format 互斥（同时发会让模型永远不调工具）', () => {
  const body = openai.buildBody('deepseek', 'm', CONVERSATION, {
    tools: TOOLS,
    jsonMode: true,
    jsonSchema: { type: 'object', properties: {} },
  });
  assert.ok(body['tools'] !== undefined, '★ tools 要保留');
  assert.equal(
    body['response_format'],
    undefined,
    '★ response_format 必须被撤掉 —— 否则模型被约束成只能吐那个 schema',
  );
});

test('★★★ OpenAI：解析 response 里的 tool_calls（arguments 是字符串）', () => {
  const parsed = openai.parseResponse(
    'deepseek',
    {
      model: 'm',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'set_params', arguments: '{"key":"a","value":1}' },
              },
            ],
          },
        },
      ],
    },
    'fallback',
  );
  assert.equal(parsed.toolCalls?.length, 1);
  assert.equal(parsed.toolCalls?.[0]?.name, 'set_params');
  assert.equal(parsed.toolCalls?.[0]?.id, 'call_1');
  assert.equal(parsed.finishReason, 'tool_calls');
  assert.equal(parsed.isEmpty, false, '★ 只调工具不说话不是"空回复"');
});

test('★★ 网关把 finish_reason 错报成 stop 时，有 tool_calls 仍要判成 tool_calls', () => {
  /*
   * 上层用 `finishReason` 判断"这一轮是不是结束了"。若它看到 `stop` 就当成
   * 最终回答，那**工具调用永远不会被执行**，模型会一直等一个它以为已经
   * 发生的工具结果 —— 那正是"表面成功、实际空转"的形态。
   */
  const parsed = openai.parseResponse(
    'deepseek',
    {
      model: 'm',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{}' } }],
          },
        },
      ],
    },
    'fallback',
  );
  assert.equal(parsed.finishReason, 'tool_calls', '★ 以 tool_calls 的实际存在为准');
});

test('★★ 网关把 arguments 发成对象时也要接住（不能静默丢掉那次调用）', () => {
  /*
   * 规范上 `arguments` 是字符串，但实测有网关直接发对象。拒掉的话那一次
   * 工具调用会**静默消失**，而模型会以为它调过了，于是不再重试。
   */
  const parsed = openai.parseResponse(
    'deepseek',
    {
      model: 'm',
      choices: [
        {
          message: {
            tool_calls: [{ id: 'c', function: { name: 'x', arguments: { a: 1 } } }],
          },
        },
      ],
    },
    'fallback',
  );
  assert.equal(parsed.toolCalls?.length, 1, '★ 对象形状也要接住');
  assert.equal(parsed.toolCalls?.[0]?.arguments, '{"a":1}');
});

/* -------------------------------------------------------------------------- */
/*  Anthropic                                                                  */
/* -------------------------------------------------------------------------- */

test('★★★ Anthropic：工具声明是 {name,description,input_schema}（没有 type:function 包装）', () => {
  const body = anthropic.buildBody('claude-sonnet-5-5', CONVERSATION, { tools: TOOLS });
  const tools = body['tools'] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(tools), '★ 必须带 tools');
  assert.equal(tools[0]?.['name'], 'get_performance');
  assert.ok(tools[0]?.['input_schema'] !== undefined, '★ 字段名是 input_schema 不是 parameters');
  assert.equal(tools[0]?.['type'], undefined, '★ Anthropic 没有 type:function 这层包装');
});

test('★★★ Anthropic：没有 tool 角色 —— 工具结果必须是 user + tool_result 块', () => {
  /*
   * 直接照抄 OpenAI 的 `role:'tool'` 会被拒（`role: tool is not supported`）。
   */
  const body = anthropic.buildBody('claude-sonnet-5-5', CONVERSATION, { tools: TOOLS });
  const messages = body['messages'] as Array<Record<string, unknown>>;
  assert.ok(
    messages.every((m) => m['role'] !== 'tool'),
    '★ Anthropic 里不能出现 tool 角色',
  );
  const withResult = messages.find(
    (m) => Array.isArray(m['content']) && (m['content'] as Array<Record<string, unknown>>).some((b) => b['type'] === 'tool_result'),
  );
  assert.ok(withResult !== undefined, '★ 工具结果要以 tool_result 块回传');
  assert.equal(withResult['role'], 'user', '★ 用 user 身份');
  const block = (withResult['content'] as Array<Record<string, unknown>>)[0];
  assert.equal(block?.['tool_use_id'], 'call_abc', '★ 靠 tool_use_id 关联');
});

test('★★★ Anthropic：tool_choice 用 {type:any} 表示"必须调工具"（不是 required）', () => {
  const body = anthropic.buildBody('claude-sonnet-5-5', CONVERSATION, {
    tools: TOOLS,
    toolChoice: 'required',
  });
  const choice = body['tool_choice'] as { type: string };
  assert.equal(choice.type, 'any', '★ Anthropic 把 required 叫 any');
});

test('★★★ Anthropic：解析 content[] 里的 tool_use 块（input 是对象）', () => {
  const parsed = anthropic.parseResponse(
    {
      model: 'claude-sonnet-5-5',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '我先看一下' },
        { type: 'tool_use', id: 'toolu_01', name: 'set_params', input: { key: 'a', value: 1 } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    'fallback',
  );
  assert.equal(parsed.toolCalls?.length, 1);
  assert.equal(parsed.toolCalls?.[0]?.name, 'set_params');
  assert.equal(parsed.toolCalls?.[0]?.arguments, '{"key":"a","value":1}', '★ input 对象要归一化回字符串');
  assert.equal(parsed.finishReason, 'tool_calls');
  assert.equal(parsed.text, '我先看一下', '★ 文字部分照常保留');
});

/* -------------------------------------------------------------------------- */
/*  Gemini                                                                     */
/* -------------------------------------------------------------------------- */

test('★★★ Gemini：工具声明包在 functionDeclarations，且 schema 要过 toGeminiSchema', () => {
  const body = gemini.buildBody(CONVERSATION, { tools: TOOLS });
  const tools = body['tools'] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(tools), '★ 必须带 tools');
  const decls = tools[0]?.['functionDeclarations'] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(decls), '★ 要包在 functionDeclarations 里');
  assert.equal(decls[0]?.['name'], 'get_performance');
  /*
   * Gemini 只认大写的 type（STRING/OBJECT…），小写会被 400 拒。
   * `toGeminiSchema` 负责这件事 —— 这里钉住它确实被调用了。
   */
  const params = decls[0]?.['parameters'] as Record<string, unknown>;
  assert.equal(params['type'], 'OBJECT', '★ type 必须被翻成大写');
});

test('★★★ Gemini：没有 tool 角色 —— 工具结果用 user + functionResponse（靠 name 关联）', () => {
  const body = gemini.buildBody(CONVERSATION, { tools: TOOLS });
  const contents = body['contents'] as Array<Record<string, unknown>>;
  assert.ok(
    contents.every((c) => c['role'] !== 'tool'),
    '★ Gemini 只有 user / model 两种 role',
  );
  const withResponse = contents.find(
    (c) =>
      Array.isArray(c['parts']) &&
      (c['parts'] as Array<Record<string, unknown>>).some((p) => p['functionResponse'] !== undefined),
  );
  assert.ok(withResponse !== undefined, '★ 工具结果要以 functionResponse 回传');
  assert.equal(withResponse['role'], 'user', '★ 用 user 身份');
  const part = (withResponse['parts'] as Array<Record<string, unknown>>)[0];
  const fr = part?.['functionResponse'] as Record<string, unknown>;
  assert.equal(fr['name'], 'get_performance', '★ Gemini 靠工具名关联，不是 id');
});

test('★★★ Gemini：解析 parts 里的 functionCall（args 是对象）', () => {
  const parsed = gemini.parseResponse(
    {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { text: '看一下' },
              { functionCall: { name: 'set_params', args: { key: 'a', value: 1 } } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    },
    'fallback',
  );
  assert.equal(parsed.toolCalls?.length, 1);
  assert.equal(parsed.toolCalls?.[0]?.name, 'set_params');
  assert.equal(parsed.toolCalls?.[0]?.arguments, '{"key":"a","value":1}');
  assert.equal(parsed.finishReason, 'tool_calls');
});

/* -------------------------------------------------------------------------- */
/*  向后兼容                                                                   */
/* -------------------------------------------------------------------------- */

test('★★★ 不传 tools 时三家都不该产生任何 tools 字段（老路径逐字节不变）', () => {
  /*
   * 这条很重要：改造**不能改变任何现有调用的行为**。
   * 老的 JSON 协议路径（模型自己写 `{"tool":"…"}`）还要继续工作。
   */
  const msgs: ChatMessage[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
  ];
  assert.equal(openai.buildBody('deepseek', 'm', msgs)['tools'], undefined);
  assert.equal(anthropic.buildBody('claude-sonnet-5-5', msgs)['tools'], undefined);
  assert.equal(gemini.buildBody(msgs)['tools'], undefined);
});

test('★★★ 不传 tools 时解析结果没有 toolCalls（undefined 不是空数组）', () => {
  /*
   * `undefined` = 这次请求根本没带 tools；
   * `[]`       = 带了 tools 但模型选择不调。
   * 混成一个会让上层无法区分"该等工具结果"和"这是最终回答"。
   */
  const parsed = openai.parseResponse(
    'deepseek',
    { model: 'm', choices: [{ finish_reason: 'stop', message: { content: '你好' } }] },
    'fallback',
  );
  assert.equal(parsed.toolCalls, undefined, '★ 没有工具调用时是 undefined');
});

test('★★★ 改造后三种 adapter 的响应形状一致（上游只需一套解析）', () => {
  /*
   * 这是整个改造的价值所在：`loop.ts` 只认 `result.toolCalls`，
   * 不需要知道背后是哪家 provider。
   */
  const o = openai.parseResponse(
    'deepseek',
    { model: 'm', choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'n', arguments: '{}' } }] } }] },
    'f',
  );
  const a = anthropic.parseResponse(
    { model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'n', input: {} }] },
    'f',
  );
  const g = gemini.parseResponse(
    { candidates: [{ content: { parts: [{ functionCall: { name: 'n', args: {} } }] } }] },
    'f',
  );
  for (const [label, parsed] of [
    ['openai', o],
    ['anthropic', a],
    ['gemini', g],
  ] as const) {
    assert.equal(parsed.toolCalls?.length, 1, `★ ${label} 必须都归一化成 ToolCall[]`);
    assert.equal(parsed.toolCalls?.[0]?.name, 'n', `★ ${label} 的名称字段一致`);
    assert.equal(typeof parsed.toolCalls?.[0]?.id, 'string', `★ ${label} 都必须有 id`);
    assert.equal(typeof parsed.toolCalls?.[0]?.arguments, 'string', `★ ${label} 的参数都是字符串`);
    assert.equal(parsed.finishReason, 'tool_calls', `★ ${label} 的 finishReason 一致`);
  }
});

test('★★★ Anthropic & Gemini：连续多条 tool 消息必须合并为单条 user turn', () => {
  /*
   * 防 bug：并行工具调用回传 2 条 `{ role: 'tool' }` 消息时，若逐条映射为独立
   * `user` turn，Anthropic 和 Gemini 都会因连续同 role 或缺少完整配对而拒绝请求。
   */
  const parallelMsgs: ChatMessage[] = [
    { role: 'user', content: '查绩效和教训' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'c1', name: 'get_performance', arguments: '{"window":"7d"}' },
        { id: 'c2', name: 'get_lessons', arguments: '{"limit":5}' },
      ],
    },
    { role: 'tool', content: '{"net":1}', toolCallId: 'c1', toolName: 'get_performance' },
    { role: 'tool', content: '{"rows":[]}', toolCallId: 'c2', toolName: 'get_lessons' },
  ];

  const aBody = anthropic.buildBody('claude-sonnet-5-5', parallelMsgs, { tools: TOOLS });
  const aMessages = aBody['messages'] as Array<{ role: string; content: unknown }>;
  assert.equal(aMessages.length, 3, '★ Anthropic 只能有 user → assistant → 1 条合并的 user');
  assert.equal(aMessages[2]?.role, 'user');
  const aBlocks = aMessages[2]?.content as Array<Record<string, unknown>>;
  assert.equal(aBlocks.length, 2, '★ 两条 tool_result 必须合并在同一个 content[] 中');
  assert.equal(aBlocks[0]?.['tool_use_id'], 'c1');
  assert.equal(aBlocks[1]?.['tool_use_id'], 'c2');

  const gBody = gemini.buildBody(parallelMsgs, { tools: TOOLS });
  const gContents = gBody['contents'] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  assert.equal(gContents.length, 3, '★ Gemini 只能有 user → model → 1 条合并的 user');
  assert.equal(gContents[2]?.role, 'user');
  assert.equal(gContents[2]?.parts.length, 2, '★ 两条 functionResponse 必须合并在同一个 parts[] 中');
  assert.equal((gContents[2]?.parts[0]?.['functionResponse'] as Record<string, unknown>)?.['name'], 'get_performance');
  assert.equal((gContents[2]?.parts[1]?.['functionResponse'] as Record<string, unknown>)?.['name'], 'get_lessons');
});

test('★★★ Anthropic：tool_use.input 解析出非纯对象（数组/原始值/null）时回退为 {}', () => {
  /*
   * 防 bug：历史消息中若模型曾吐出 `[1,2]` / `"str"` / `null` 作为 arguments，
   * `JSON.parse` 不会抛错，但 Anthropic 要求 `tool_use.input` 必须是 JSON 对象。
   */
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'run' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'c1', name: 't1', arguments: '[1,2]' },
        { id: 'c2', name: 't2', arguments: 'null' },
        { id: 'c3', name: 't3', arguments: '"raw"' },
        { id: 'c4', name: 't4', arguments: '{"ok":true}' },
      ],
    },
  ];
  const body = anthropic.buildBody('claude-sonnet-5-5', msgs, { tools: TOOLS });
  const messages = body['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  const blocks = messages[1]!.content;
  assert.deepEqual(blocks[0]?.['input'], {});
  assert.deepEqual(blocks[1]?.['input'], {});
  assert.deepEqual(blocks[2]?.['input'], {});
  assert.deepEqual(blocks[3]?.['input'], { ok: true });
});

test('★★★ Gemini：AGENT_TOOL_SPECS 转换后不含非法空 OBJECT（get_current_params / set_params.patch）', () => {
  /*
   * 防 bug：Gemini 拒绝所有 `type: 'OBJECT'` 但缺 `properties` 或 `properties: {}` 的 schema
   * (`properties: should be non-empty for OBJECT type`)。
   * 覆盖全部真实智能体工具声明，确保无参工具省略 `parameters`，自由对象 `set_params.patch` 不产生空 OBJECT。
   */
  const body = gemini.buildBody([{ role: 'user', content: 'hi' }], { tools: AGENT_TOOL_SPECS });
  const decls = (body['tools'] as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0]!
    .functionDeclarations;

  const getCurrentParams = decls.find((d) => d['name'] === 'get_current_params');
  assert.ok(getCurrentParams, '★ get_current_params 必须存在');
  assert.equal(getCurrentParams['parameters'], undefined, '★ 无参工具按 Gemini 规范省略 parameters');

  const setParams = decls.find((d) => d['name'] === 'set_params');
  assert.ok(setParams, '★ set_params 必须存在');
  const patchSchema = ((setParams['parameters'] as Record<string, unknown>)['properties'] as Record<string, unknown>)[
    'patch'
  ] as Record<string, unknown>;
  assert.notEqual(patchSchema['type'], 'OBJECT', '★ 无固定 properties 的 patch 不得生成非法空 OBJECT');
  assert.equal(patchSchema['type'], 'STRING');

  /* 递归校验所有 declaration 的任意层级 schema 都不得出现空 OBJECT */
  const assertNoEmptyObject = (node: unknown, path: string): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => assertNoEmptyObject(item, `${path}[${i}]`));
      return;
    }
    const rec = node as Record<string, unknown>;
    if (rec['type'] === 'OBJECT') {
      const props = rec['properties'];
      assert.ok(
        props && typeof props === 'object' && !Array.isArray(props) && Object.keys(props).length > 0,
        `★ ${path} 不得是空 OBJECT`,
      );
    }
    for (const [k, v] of Object.entries(rec)) assertNoEmptyObject(v, `${path}.${k}`);
  };
  for (const d of decls) assertNoEmptyObject(d['parameters'], String(d['name']));
});
