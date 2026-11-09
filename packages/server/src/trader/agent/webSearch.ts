/**
 * **联网搜索客户端** —— 给新闻/情绪智能体真正的数据源。
 *
 * ## 用户的要求（这是本文件存在的理由）
 *
 * > 「总管**委派子代理去做市场调研**（查新闻、各大交易所社区、社交媒体、新闻源等等。。）
 * >  根据资料反馈给相应的智能体做处理，资料整理、判断、决策等等」
 *
 * > 「以后系统自身、调用的 harness 需要用到网络搜索，**可以直接用 magpie 内置的搜索 MCP**
 * >  `http://127.0.0.1:3425/mcp/magpie/web-search`（我已经配置好了密钥）」
 *
 * ## 为什么用 MCP 而不是自己接搜索 API
 *
 * **不重复造轮子**（用户需求 #4）—— magpie 已经内置了搜索能力：
 * 它会把搜索 API（tavily / brave / exa / firecrawl / searxng）或"会搜索的模型"
 * 统一成一个 `web_search` 工具。用户已经配好了密钥，我们直接调即可。
 *
 * ## 实测确认的协议细节（2026-10-12）
 *
 * ```
 *   POST http://127.0.0.1:3425/mcp/magpie/web-search
 *   headers: authorization: Bearer <网关 key>
 *            content-type: application/json
 *            accept: application/json, text/event-stream    ← 少这个会 406
 *   body:    {"jsonrpc":"2.0","id":1,"method":"tools/call",
 *             "params":{"name":"web_search","arguments":{"query":"..."}}}
 * ```
 *
 * - **必须带网关 key**（不带 → 401 `no API key was sent`）
 * - **仅 Streamable HTTP**（没有 stdio/SSE；GET/DELETE → 405）
 * - 返回是 JSON-RPC，结果在 `result.content[0].text`
 */

/** 一次搜索的结果。 */
export interface SearchResult {
  /** 是否成功。**失败也要如实返回，让上层决定要不要继续。** */
  ok: boolean;
  /** 查询词（审计用）。 */
  query: string;
  /** 模型能读的搜索结果文本（原始返回，含 URL）。 */
  text: string;
  /** 失败原因（`ok=false` 时有值）。 */
  error?: string;
  /** 耗时（毫秒）。 */
  latencyMs: number;
}

/** 搜索客户端配置。 */
export interface WebSearchConfig {
  /** MCP 端点，默认 `http://127.0.0.1:3425/mcp/magpie/web-search`。 */
  endpoint: string;
  /** magpie 网关 key。 */
  apiKey: string;
  /** 单次搜索超时（毫秒）。默认 45 秒 —— 实测真实搜索要几秒到十几秒。 */
  timeoutMs?: number;
}

/**
 * 调一次 `web_search`。
 *
 * ## 为什么失败不抛错
 *
 * 搜索是**外部依赖**（网络、magpie、上游搜索 API 任何一环都可能挂）。
 * 抛错会让"新闻拿不到"升级成"整轮决策失败" —— 而行情数据是好的，
 * 团队完全可以基于行情做决策。**所以返回 `ok: false` 让上层降级。**
 *
 * 这与 `buildModel` 探测失败不阻断启动是同一个原则：
 * 一个**可选**能力失败，不该让核心流程停摆。
 */
export async function webSearch(
  config: WebSearchConfig,
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<SearchResult> {
  const started = Date.now();
  const timeoutMs = config.timeoutMs ?? 45_000;

  try {
    const res = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        /* ⚠️ 必须带 `accept` —— MCP Streamable HTTP 要求，少它会 406。 */
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'web_search', arguments: { query } },
      }),
      signal: options.signal ?? AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return {
        ok: false,
        query,
        text: '',
        error: `搜索端点返回 HTTP ${res.status}${res.status === 401 ? '（网关 key 不对或没带）' : ''}`,
        latencyMs: Date.now() - started,
      };
    }

    const payload: unknown = await res.json();
    const text = extractToolText(payload);
    if (text === null) {
      return {
        ok: false,
        query,
        text: '',
        error: '搜索返回的结构不认识（没有 result.content[0].text）',
        latencyMs: Date.now() - started,
      };
    }
    if (text.trim().length === 0) {
      return { ok: false, query, text: '', error: '搜索返回了空内容', latencyMs: Date.now() - started };
    }
    return { ok: true, query, text, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      query,
      text: '',
      error: (error as Error).message.slice(0, 200),
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * 从 JSON-RPC 响应里取出工具返回的文本。
 *
 * 兼容三种形态（MCP 规范允许的）：
 *   · `result.content[{type:'text',text}]` —— 标准
 *   · `result.content` 是字符串 —— 有些实现会简化
 *   · `error.message` —— JSON-RPC 层错误
 *
 * 认不出来就返回 `null`（**不猜**）。
 */
export function extractToolText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;

  /* JSON-RPC 层错误要**说出来**，否则会被当成"搜到 0 条"。 */
  const err = p.error as { message?: unknown } | undefined;
  if (err !== undefined && typeof err.message === 'string') {
    return `搜索出错：${err.message}`;
  }

  const result = p.result as Record<string, unknown> | undefined;
  if (result === undefined) return null;

  const content = result.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'object' && item !== null) {
        const t = (item as { text?: unknown }).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
  }
  return null;
}

/**
 * 给团队模式收集**市场调研材料**。
 *
 * ## 查什么（这是"分工"的机器表达）
 *
 * 用户要的是「查新闻、各大交易所社区、社交媒体、新闻源」。
 * 但**不能一次问一堆** —— 每次搜索都是一次真实的外部调用（几秒），
 * 而团队一轮的预算有限（`tradingDesk` 的 `maxCalls`）。
 *
 * 所以查**两条**：整体市场情绪、以及针对当前标的的消息面。
 * 两条并行（互不依赖），总耗时等于较慢的那一条。
 *
 * ## 拿不到就明说
 *
 * 返回的材料里**必须写明"搜索不可用"** —— 否则新闻分析师会对着一句
 * "暂无数据"编出分析（模型的常见失败模式）。说清了它才会如实说"样本不足"。
 */
export async function collectMarketResearch(
  config: WebSearchConfig,
  symbols: readonly string[],
): Promise<{ text: string; ok: boolean; errors: string[] }> {
  const top = symbols.slice(0, 3);
  const queries = [
    'crypto market sentiment news today bitcoin ethereum',
    ...(top.length > 0 ? [`${top.join(' ')} crypto news today`] : []),
  ];

  const results = await Promise.all(queries.map((q) => webSearch(config, q)));

  const errors = results.filter((r) => !r.ok).map((r) => `${r.query} → ${r.error ?? '未知'}`);
  const okOnes = results.filter((r) => r.ok);

  if (okOnes.length === 0) {
    /*
     * ⚠️ **全部失败时明确说"搜索不可用"**，而不是给一段空材料。
     *
     * 空材料会让新闻分析师自由发挥（模型面对空白很爱编）；
     * 明说"不可用"它才会回答"样本不足，无法给出新闻面判断"。
     */
    return {
      text:
        '## 联网搜索不可用\n\n' +
        `本轮未能获取新闻/社区数据（原因：${errors.join('；')}）。\n` +
        '**请如实说明"没有新闻数据"，不要凭印象编造消息面。**',
      ok: false,
      errors,
    };
  }

  const text = [
    '## 联网搜索结果（自动抓取，未经核实）',
    '',
    ...okOnes.map((r) => `### ${r.query}\n${r.text}`),
    ...(errors.length > 0 ? ['', `（部分查询失败：${errors.join('；')}）`] : []),
  ].join('\n');

  return { text, ok: true, errors };
}
