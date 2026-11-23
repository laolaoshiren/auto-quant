/**
 * 交易所凭证表单载荷：编辑 Gate 测试网凭证绝不能被 `envTestnet` 静默覆写。
 *
 * 背景：币安有进程级 `BINANCE_ENV`（生产服务器上 `envTestnet = false`），
 * 而 Gate 没有进程级开关，每个账户自己携带 `testnet`。
 * 此前编辑提交时把 `testnet` 写成 `envTestnet`，会导致生产服务器上编辑一把
 * Gate 测试网凭证（哪怕只改备注名）就把它悄悄切成 Gate 正式网（真实资金）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildExchangeAccountCreatePayload,
  buildExchangeAccountUpdatePayload,
  resolveDraftTestnet,
  type AccountDraft,
} from './exchangeAccountDraft';

test('★★★ 编辑 Gate 测试网凭证在生产环境（envTestnet=false）下绝不被覆写为正式网', () => {
  const draft: AccountDraft = {
    exchange: 'gate',
    label: 'Gate 测试网-改名',
    apiKey: '',
    apiSecret: '',
    testnet: true,
    canTrade: true,
  };

  assert.equal(resolveDraftTestnet('gate', true, false), true, 'Gate 测试网必须保持 testnet=true');
  const patch = buildExchangeAccountUpdatePayload(draft, false);
  assert.equal(patch.testnet, true, '★ PATCH 载荷必须保留 Gate 测试网标记，绝不被 envTestnet=false 覆写');
  assert.equal(patch.apiKey, undefined, '留空 apiKey 不得覆写已存 Key');
  assert.equal('apiSecret' in patch, false, '留空 apiSecret 不得覆写已存 Secret');
});

test('★★★ 编辑 Gate 正式网凭证在本地模拟环境（envTestnet=true）下也不被覆写为测试网', () => {
  const draft: AccountDraft = {
    exchange: 'gate',
    label: 'Gate 主网子账号',
    apiKey: '  new-key  ',
    apiSecret: 'new-secret',
    testnet: false,
    canTrade: true,
  };

  assert.equal(resolveDraftTestnet('gate', false, true), false);
  const patch = buildExchangeAccountUpdatePayload(draft, true);
  assert.equal(patch.testnet, false, '★ Gate 正式网必须保持 testnet=false');
  assert.equal(patch.apiKey, 'new-key', '填写新 Key 时做 trim');
  assert.equal(patch.apiSecret, 'new-secret');
});

test('★★ 币安凭证跟随进程级 envTestnet（创建/测试/更新一致）', () => {
  const draft: AccountDraft = {
    exchange: 'binance',
    label: '币安子账号',
    apiKey: 'k1',
    apiSecret: 's1',
    testnet: true,
    canTrade: true,
  };

  assert.equal(resolveDraftTestnet('binance', true, false), false, '生产环境币安为正式网');
  assert.equal(resolveDraftTestnet('binance', false, true), true, '本地 Demo 环境币安为测试网');
  assert.equal(buildExchangeAccountCreatePayload(draft, false).testnet, false);
  assert.equal(buildExchangeAccountUpdatePayload(draft, false).testnet, false);
});

test('★★ ExchangeAccountsSection 必须统一通过共享草稿构建函数生成载荷', () => {
  const src = readFileSync(new URL('./ExchangeAccountsSection.tsx', import.meta.url), 'utf8');
  assert.ok(/resolveDraftTestnet\(/.test(src), '必须使用 resolveDraftTestnet 计算 draftTestnet');
  assert.ok(/buildExchangeAccountCreatePayload\(/.test(src), '创建/测试必须走 buildExchangeAccountCreatePayload');
  assert.ok(/buildExchangeAccountUpdatePayload\(/.test(src), '编辑提交必须走 buildExchangeAccountUpdatePayload');
});
