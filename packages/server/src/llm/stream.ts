/**
 * 把 OpenAI 兼容的 **SSE 分片**重组成**与非流式响应完全相同的对象**。
 *
 * ## 为什么需要流式（2026-10-01，`HTTP 524`）
 *
 * 线上连续出现 `AI 服务不可用：服务商 5xx（HTTP 524）` —— 一轮 8 轮里 **4 次**失败。
 *
 * **`524` 是 Cloudflare 的"源站超时"**：网关等 **100 秒**还没拿到**响应头**就放弃。
 * 而非流式请求要等**整个响应生成完**才返回第一字节 —— 实测我们的请求要
 * **60–205 秒**（一次 100K tokens 的请求 220 秒），所以撞上它几乎必然，
 * 而代价是**整轮作废**。
 *
 * 流式改的是**响应头什么时候回来**：源站一连上就返回 `200 text/event-stream`，
 * 之后才慢慢吐 token。网关的 100 秒计时于是不再是问题，
 * 而客户端仍然读到流结束才返回 —— 对上层完全透明。
 *
 * （把客户端 `timeout_seconds` 提到 600 秒**解决不了**这个问题：
 * 那个计时器在我们这边，限制在中间的网关那里。）
 *
 * ## 为什么是"重组"而不是"改解析"
 *
 * `client.ts` 的 `parse()` 已经在处理非流式形状，被大量测试覆盖。
 * 让流式分片**在进入 parse 之前**拼成同样的对象，意味着这次改动
 * **不会碰到解析逻辑** —— 风险小得多。
 */

/** 流里累计出来的一个工具调用（OpenAI 的 `tool_calls` 是增量给的）。 */
interface PartialToolCall {
  index: number;
  id?: string;
  type?: string;
  name?: string;
  arguments: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 合并 SSE 的 `data:` 行。
 *
 * 输入是**已经按行切好的字符串**（含或不含 `data: ` 前缀都行），
 * 返回一个非流式形状的对象：`{ model, choices: [{ message, finish_reason }], usage }`。
 *
 * 容错取向（与 `parser.ts` 对模型输出"结构宽容、语义严格"一致）：
 *   · 注释行（`: ping`）、空行、`[DONE]` → **跳过**；
 *   · 坏 JSON 分片 → **跳过但它之前拿到的内容全部保留** ——
 *     那些内容可能已经是一份完整的决策；
 *   · `reasoning_content` 也拼（丢掉它会让"思考过程"在页面上变空）。
 */
export function mergeOpenAiStreamChunks(lines: readonly string[]): unknown {
  let model: string | null = null;
  let finishReason: string | null = null;
  let content = '';
  let reasoning = '';
  let usage: unknown = undefined;
  const tools = new Map<number, PartialToolCall>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(':')) continue;

    /* 允许调用方传"整行"或"已去掉 data: 前缀"的内容。 */
    const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (payload === '' || payload === '[DONE]') continue;

    let chunk: Record<string, unknown> | null;
    try {
      chunk = asRecord(JSON.parse(payload));
    } catch {
      /* 坏分片：跳过，但已经拼好的内容不动。 */
      continue;
    }
    if (chunk === null) continue;

    if (typeof chunk['model'] === 'string' && chunk['model'] !== '') {
      model = chunk['model'];
    }
    if (chunk['usage'] !== undefined && chunk['usage'] !== null) {
      /* 多数网关只在最后一个 chunk 带 usage（OpenAI 需要 stream_options）。 */
      usage = chunk['usage'];
    }

    const choices = chunk['choices'];
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const choice = asRecord(choices[0]);
    if (choice === null) continue;

    if (typeof choice['finish_reason'] === 'string') {
      finishReason = choice['finish_reason'];
    }

    const delta = asRecord(choice['delta']) ?? asRecord(choice['message']);
    if (delta === null) continue;

    if (typeof delta['content'] === 'string') content += delta['content'];
    if (typeof delta['reasoning_content'] === 'string') reasoning += delta['reasoning_content'];

    const toolCalls = delta['tool_calls'];
    if (Array.isArray(toolCalls)) {
      for (const item of toolCalls) {
        const call = asRecord(item);
        if (call === null) continue;
        const index = typeof call['index'] === 'number' ? call['index'] : 0;
        const existing = tools.get(index) ?? { index, arguments: '' };
        if (typeof call['id'] === 'string') existing.id = call['id'];
        if (typeof call['type'] === 'string') existing.type = call['type'];
        const fn = asRecord(call['function']);
        if (fn !== null) {
          if (typeof fn['name'] === 'string') existing.name = fn['name'];
          if (typeof fn['arguments'] === 'string') existing.arguments += fn['arguments'];
        }
        tools.set(index, existing);
      }
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content };
  /*
   * `reasoning_content` 只在**真的有内容**时挂上：很多解析器把"存在但为空"
   * 当成"有推理"，那会让页面显示一个空的思考段。
   */
  if (reasoning !== '') message['reasoning_content'] = reasoning;
  if (tools.size > 0) {
    message['tool_calls'] = [...tools.values()]
      .sort((a, b) => a.index - b.index)
      .map((t) => ({
        id: t.id,
        type: t.type ?? 'function',
        function: { name: t.name, arguments: t.arguments },
      }));
  }

  const out: Record<string, unknown> = {
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (model !== null) out['model'] = model;
  if (usage !== undefined) out['usage'] = usage;
  return out;
}

/**
 * 从一个 SSE `Response` 读出全部 `data:` 行。
 *
 * ⚠️ **这里才是流式的价值所在**：`fetch` 一拿到响应头就返回，
 * 所以网关的 100 秒超时不再作用于"生成耗时"。而本函数会一直读到流结束 ——
 * 对上层来说，返回时机与非流式一样，只是**期间连接是活的**。
 */
export async function readOpenAiStreamLines(response: Response): Promise<string[]> {
  const body = response.body;
  if (body === null) return [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    /*
     * 按行切：SSE 用 `\n`，但网关偶尔发 `\r\n`。留最后一段（可能是半行）
     * 在缓冲里等下一次读取 —— 直接切会把一个 JSON 分片劈成两半。
     */
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      lines.push(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  if (buffer.trim() !== '') lines.push(buffer);
  return lines;
}
