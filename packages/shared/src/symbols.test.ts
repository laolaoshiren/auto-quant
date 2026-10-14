import test from 'node:test';
import assert from 'node:assert/strict';

import { isStableBaseAsset, isMajorSymbol, normalizeSymbol, baseAssetOf } from './symbols.js';

/**
 * `isStableBaseAsset` 的判据与边界。
 *
 * ## 为什么要有这个谓词
 *
 * `USDCUSDT` 这类**标的本身是稳定币**的 USDⓈ-M 永续能通过交易所适配层的过滤 ——
 * `SymbolRegistry` 只看 `quoteAsset === 'USDT'`，而它的计价**恰好**就是 USDT。
 * 于是"候选池里混进一个锚定永续"这件事没有任何一层拦着：名义波动接近 0、
 * 手续费与资金费占绝对主导，放进 8–20 个位置的池子就是挤掉真实机会。
 *
 * `CoinSourceConfigSchema.excludeStablecoins` 因此存在（且默认开）。
 * 它曾经是死配置 —— 默认配置写了这个键，而 schema 里没有它，被 zod 静默丢弃。
 */
test('锚定永续被认出，主流币与活跃山寨不被误杀', () => {
  for (const s of ['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'USDEUSDT', 'PYUSDUSDT', 'BUSDUSDT']) {
    assert.equal(isStableBaseAsset(s), true, `${s} 应判为稳定币`);
  }
  for (const s of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', '1000PEPEUSDT']) {
    assert.equal(isStableBaseAsset(s), false, `${s} 不应判为稳定币`);
  }
});

test('大小写与各种写法都被归一化后再判 —— 与 normalizeSymbol 同一套规则', () => {
  assert.equal(isStableBaseAsset('usdcusdt'), true, '小写');
  assert.equal(isStableBaseAsset('USDC_USDT'), true, '下划线');
  assert.equal(isStableBaseAsset('usdc-usdt'), true, '连字符');
  assert.equal(isStableBaseAsset('USDCUSDTPERP'), true, 'PERP 后缀');
  assert.equal(isStableBaseAsset('USDCUSDT.P'), true, '.P 后缀');
});

test('计价资产不是判据 —— USDC 当计价时不得因此剔掉别的标的', () => {
  /*
   * `baseAssetOf()` 剥的是**尾部** USDT，所以 `USDCUSDT` 的 base 是 USDC（标的），
   * 而一个假想的 `BTCUSDC` 的 base 是 BTCUSDC（尾部不是 USDT）。
   * 这条钉住的是：谓词只看**标的**，绝不因为计价侧像稳定币就误判。
   */
  assert.equal(baseAssetOf('USDCUSDT'), 'USDC');
  assert.equal(isStableBaseAsset('BTCUSDT'), false);
  assert.equal(isStableBaseAsset('BTCUSDC'), false, '计价是 USDC 的 BTC 合约不是稳定币');
});

test('与 isMajorSymbol 互不重叠 —— BTC/ETH 永远不是稳定币', () => {
  for (const s of ['BTCUSDT', 'ETHUSDT']) {
    assert.equal(isMajorSymbol(s), true);
    assert.equal(isStableBaseAsset(s), false, '同一符号不会被两个谓词同时命中');
  }
});

test('normalizeSymbol 的既有行为未被本次改动影响', () => {
  assert.equal(normalizeSymbol('btc/usdt'), 'BTCUSDT');
  assert.equal(normalizeSymbol('BTC_USDT'), 'BTCUSDT');
  assert.equal(normalizeSymbol('BTCUSDT.P'), 'BTCUSDT');
});
