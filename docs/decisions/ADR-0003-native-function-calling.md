# ADR-0003：AI 工具调用改用标准 function calling

- **状态**：已采纳
- **日期**：2026-11-10
- **决策者**：用户（点名"AI 调用工具没用标准函数调用"）与 AI 共同确定

## 背景

用户 2026-11-10 指出：「AI 调用工具好像不对，没有用标准的函数调用」。

核实结论（**不是猜测**）：

- `llm/client.ts` 与三家适配器（OpenAI 兼容 / Anthropic / Gemini）**早已支持**
  `tools` / `toolChoice` / `tool_calls`（2026-10-23 加入）。
- 但 `tools` 参数**零生产调用方**：`trader/agent/loop.ts` 一直用**提示词文本协议**
  （要求模型在正文里手写 `{"thought":…,"tool":…,"args":{…}}`），
  `parseNativeToolCalls()` 只是"多认一种格式"的兜底。
- 代价（历史数据）：`agent_runs` 里 **31% 的 failed** 是"解析不出工具调用"，
  每次烧 2–6 万 tokens；`nativeToolCall.ts` 的注释也记录了"整个循环判失败"的事故。
- 链路缺口：`LoopModel.complete` / `ModelRouter.CallModel` / `routedModel` /
  `client.complete` 都没有传 `tools` 的入口。

## 决定

1. **原生优先、文本兜底**：agent 循环把 `AGENT_TOOL_SPECS`（标准 JSON Schema，
   与提示词用的 `AGENT_TOOLS` 同一份定义生成）传给模型；模型返回的 `tool_calls`
   **优先**于正文解析。文本协议保留，供不支持 `tools` 的网关/模型兜底。
2. **全链路透传**：`client.complete` → `ModelRouter.callByTier` →
   `magpieGateway` → `routedModel`（单模型与团队两条路径）→ `loop.parseTurn`。
   `DecisionModel` 的 options 增加 `tools`，返回值增加 `toolCalls`。
3. **语义不放宽**：原生调用的工具名与参数照样过 `dispatchTool` 那套校验；
   参数不是合法 JSON 时**报错不猜**（与文本协议同一条规则）。
4. **多调用只取第一个**：与文本协议一致（循环是"一步一动作"）。

## 验证

- 对**本机 magpie**（`workbuddy/deepseek-v4.1-flash`）真实调用：
  `finishReason: "tool_calls"`，返回 `[{ name: "get_performance", arguments: "{\"window\": \"7d\"}" }]`，
  **正文为空** —— 旧实现在这个形状下必判 failed。
- 单元测试：`loop.test.ts` 新增"原生优先"与"参数坏掉不猜"两条；全量 44/44。
- `typecheck` 0；`sim` 在整合时统一跑。

## 影响

- 团队/智能托管的 agent 工具循环从"猜文本"变成"标准协议"，失败率与 token 浪费应显著下降。
- 提示词里的 `PROTOCOL` 文本仍保留（兜底 + 视觉引导），但不再是唯一契约。
- 若某模型返回不合规的 `tool_calls`，上层仍会清楚地报"参数不是合法 JSON"，
  不会静默丢失动作。
