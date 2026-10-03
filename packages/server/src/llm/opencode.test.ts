import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getProvider, LLM_PROVIDERS } from '@aq/shared';
import { buildRequest, OPENCODE_SESSION } from './openaiCompatible.js';

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
