/**
 * `publicAccount()` 的回归测试。
 *
 * 这个测试的存在理由是一次真实事故：`GET /api/exchange-accounts` 原本写的是
 * `{ ...account, apiKeyMasked: maskSecret(account.apiKey) }`，展开运算符把
 * **明文 API Key** 一起带进了响应体。界面只画掩码，所以肉眼看不出任何异常 ——
 * 但开发者工具、任何 XSS、任何错误上报或会话回放插件都能直接读到它。
 *
 * 之所以值得单独测：这类泄露不是"写错一次"，而是**每次给账户对象加字段时
 * 都有机会重犯**。只要有人再写一遍展开，测试就会红。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { publicAccount } from './server.js';

/** 一个形状与 `ExchangeAccount` 一致的凭据对象（含明文密钥）。 */
function account() {
  return {
    id: 7,
    exchange: 'binance' as const,
    label: '主账户',
    apiKey: 'Kx9mQ2vT7pL4wR8nB3cD6fG1hJ5kM0sZ2aX4yU6iO8eQ1rT3vW5n',
    hasSecret: true,
    testnet: false,
    canTrade: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('publicAccount', () => {
  it('不回传原始 apiKey', () => {
    const result = publicAccount(account());

    assert.ok(!('apiKey' in result), '响应里出现了 apiKey 字段');
    // 逐个序列化检查，确保密钥没有藏在任何嵌套结构里
    const json = JSON.stringify(result);
    assert.ok(!json.includes('Kx9mQ2vT7pL4wR8nB3cD6fG1hJ5kM'), '序列化结果里出现了明文密钥');
  });

  it('返回掩码，且掩码保留了可辨识的头尾', () => {
    const result = publicAccount(account());

    assert.equal(typeof result.apiKeyMasked, 'string');
    assert.notEqual(result.apiKeyMasked, '', '掩码为空会让界面显示不出任何信息');
    assert.ok(result.apiKeyMasked.includes('…'), '掩码应当是省略形式');
    // 掩码必须比原文短，否则等于没掩
    assert.ok(result.apiKeyMasked.length < account().apiKey.length);
  });

  it('其余字段原样保留', () => {
    const source = account();
    const result = publicAccount(source);

    // 用 any 取值是刻意的：这里要断言的正是"除了 apiKey 之外都在"，
    // 而类型上已经不含 apiKey，直接索引会编译不过。
    const rest = result as Record<string, unknown>;
    for (const key of ['id', 'exchange', 'label', 'hasSecret', 'testnet', 'canTrade', 'createdAt', 'updatedAt']) {
      assert.deepEqual(rest[key], (source as Record<string, unknown>)[key], `字段 ${key} 丢失或被改写`);
    }
  });

  it('新增字段默认外发 —— 只有密钥被摘掉', () => {
    // 这条断言锁住的是**方向**：将来给凭据加字段时，它应当自动出现在响应里，
    // 不需要改 publicAccount。真正需要显式处理的只有密钥。
    const withExtra = { ...account(), lastVerifiedAt: '2026-02-02T00:00:00.000Z' };
    const result = publicAccount(withExtra) as Record<string, unknown>;

    assert.equal(result.lastVerifiedAt, '2026-02-02T00:00:00.000Z');
    assert.ok(!('apiKey' in result));
  });

  it('密钥为空时不抛错（新建但未填完的凭据）', () => {
    const result = publicAccount({ ...account(), apiKey: '' });
    assert.equal(result.apiKeyMasked, '');
    assert.ok(!('apiKey' in result));
  });
});
