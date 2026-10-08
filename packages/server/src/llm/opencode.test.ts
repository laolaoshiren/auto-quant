import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getProvider, LLM_PROVIDERS } from '@aq/shared';
import { buildRequest, OPENCODE_SESSION } from './openaiCompatible.js';
import { usesAnthropicProtocol } from './client.js';

/**
 * OpenCode GO 内置配置（2026-10-04）—— 用户的原话：
 *
 * > 「**AI 提供商内置一个 opencode go** …… 我使用自定义添加的无法使用，
 * >  你根据文档内置一个，**以后我只用填 KEY 就能正常使用**」
 *
 * "只填 KEY"意味着**基址与必要的请求头都必须内置**，用户不该看到它们。
 */

test('★ OpenCode GO 已内置，且基址是【不含 /chat/completions】的基址', async () => {
  const p = getProvider('opencode');
  assert.equal(p.baseUrl, 'https://opencode.ai/zen/go/v1');

  /*
   * ⚠️ **这条是本用例的核心。**
   *
   * 用户上次失败时填的是 `https://opencode.ai/zen/go/v1/chat/completions` ——
   * 而客户端会在这个基址后面**再拼一次** `/chat/completions`，于是路径被拼了两遍。
   * 服务端回的是 `Request is missing x-opencode-session…`，
   * **把人引向了完全错误的方向**（他一直以为是缺请求头，其实基址写错了）。
   *
   * 所以：基址**必须以 `/v1` 结尾、且不含任何端点路径**。
   */
  assert.ok(
    !p.baseUrl.endsWith('/chat/completions'),
    '★ 基址里不能带 `/chat/completions` —— 客户端会再拼一次，路径就重复了',
  );
  void LLM_PROVIDERS;
});

test('★ 聊天请求必须带上 x-opencode-session（会话粘性路由）', () => {
  const req = buildRequest('opencode', 'sk-test', getProvider('opencode').baseUrl, 'deepseek-flash', [
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(
    req.headers['x-opencode-session'],
    OPENCODE_SESSION,
    '★ OpenCode GO 要求这个头；自定义端点填不了它，所以必须内置',
  );
  /* 拼出来的 URL 只能有一段 `/chat/completions`。 */
  assert.equal(req.url, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(
    (req.url.match(/chat\/completions/g) ?? []).length,
    1,
    '★ URL 里只允许出现一次 `/chat/completions`',
  );
});

test('"只填 KEY"：基址与头都内置，用户不需要填任何额外字段', () => {
  const p = getProvider('opencode');
  assert.equal(p.authStyle, 'bearer', '认证方式内置（Bearer），用户只给 Key');
  assert.ok(p.baseUrl.length > 0, '基址内置');
  assert.ok(p.modelsPath.length > 0, '模型列表路径内置');
  assert.equal(p.openAiCompatible, true);
});

test('别的供应商不该拿到 OpenCode 的私有头 —— 那些头只对它自己有意义', () => {
  const req = buildRequest('deepseek', 'sk-test', 'https://api.deepseek.com', 'deepseek-flash', [
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(req.headers['x-opencode-session'], undefined);
});

test('供应商目录里 opencode 只出现一次（免得下拉里出现两行同名）', () => {
  const ids = LLM_PROVIDERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
  assert.equal(ids.filter((id) => id === 'opencode').length, 1);
});

/*
 * ⚠️ **同一网关下按模型选协议 —— 这一条为用户的一个真实报错而写。**
 *
 * 用户 2026-10-08：「OpenCode GO 选 claude 用不了」。他的后台日志显示
 * Claude Haiku 5.5 在他账号下**大量 200 成功**，所以问题不在订阅、不在密钥，
 * 而在**我们把请求发错了端点**：文档的端点表写明 claude 走 `/v1/messages`，
 * 而我们因为"供应商是 OpenAI 兼容"就一律发 `/chat/completions`。
 *
 * 这条用例直接钉住"模型 → 协议"的映射。实测三种请求的差异：
 *
 *   `/v1/messages` + `x-api-key`          → 200（claude / minimax-m3 / qwen3.8-max）
 *   `/v1/messages` + `Authorization: Bearer` → 401 ModelError（认证方式不对）
 *   `/v1/chat/completions` + claude        → 400 ModelProtocolUnsupported
 */
test('★ opencode 的 claude 系模型必须走 Anthropic Messages 协议', () => {
  assert.equal(
    usesAnthropicProtocol('opencode', 'claude-haiku-5-5'),
    true,
    '★ claude 发到 /chat/completions 会被网关拒收（Model does not support this protocol）',
  );
  assert.equal(
    usesAnthropicProtocol('opencode', 'deepseek-v4.1-flash'),
    false,
    'deepseek 是 OpenAI 兼容那组，不能被改道',
  );
});

test('★ 文档端点表里同属 /messages 的另外几族也要走 Anthropic', () => {
  /* 这几条一起被这个 bug 影响（发错端点就报 ModelProtocolUnsupported），实测 /messages 均 200。 */
  for (const model of ['minimax-m3', 'minimax-m2.7', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus']) {
    assert.equal(usesAnthropicProtocol('opencode', model), true, `${model} 在文档里属于 /v1/messages`);
  }
  /* /responses 那族（grok / gpt-luna / muse-spark）尚未实现适配器，这里不断言 —— 见函数的注释。 */
  assert.equal(usesAnthropicProtocol('opencode', 'glm-5.3'), false);
});

test('provider 本身就是 anthropic 时，与模型 id 无关', () => {
  assert.equal(usesAnthropicProtocol('anthropic', '任何模型'), true);
});