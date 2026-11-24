/**
 * AI 团队模式初始配置的测试。
 *
 * ## 为什么这里要测得具体（实测踩到的坑）
 *
 * 上一轮我给 `ai_team` 只写了注释说"配置留给 S3"，**没有真的播种** ——
 * 于是实测：
 *
 *     机器人 #11 的配置里没有任何候选标的（静态列表为空、也没开动态候选池）
 *     —— 它不会交易任何东西。
 *
 * 也就是说：团队模式**跑得起来、界面显示"运行中"，但永远不会开任何仓**。
 * 而用户要的正是「然后做相应的动作（**开仓、平仓、调仓**等等）」。
 *
 * 所以这里钉住"配置一出生就是可用的"。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultAiTeamConfig, unboundedAiManagedConfig } from './strategy.js';

test('★★ 团队配置必须有【真实可用的标的来源】（否则跑起来也不交易）', () => {
  const cfg = defaultAiTeamConfig();
  assert.equal(cfg.coinSource.sourceType, 'coinpool', '要用动态池，而不是空的静态列表');
  assert.equal(cfg.coinSource.useCoinPool, true);
  assert.ok(cfg.coinSource.coinPoolLimit > 0, '★ 动态池数量必须大于 0');
  assert.equal(cfg.coinSource.staticCoins.length, 0, '静态列表为空是**预期**（靠动态池）');
});

test('★★ 团队配置与智能托管的配置【不是同一份】', () => {
  /*
   * 两份配置的语义不同：团队模式有**风控官**在裁决之后把关，
   * 而智能托管没有。共用一个函数会让"加模式"变成"改语义"。
   */
  const team = defaultAiTeamConfig();
  const managed = unboundedAiManagedConfig();
  assert.notDeepEqual(team.coinSource, managed.coinSource, '★ 标的来源必须不同（团队模式要有池）');
});

test('★ 团队模式门槛归零（暂缓重构期间保持既有口径，不随智能托管硬底线改动）', () => {
  const team = defaultAiTeamConfig();
  assert.equal(team.riskControl.maxPositions, 20);
  assert.equal(team.riskControl.maxMarginUsage, 100);
  assert.equal(team.riskControl.minConfidence, 0, '门槛归零 —— 该不该出手由 AI 判断');
  assert.equal(team.riskControl.minRiskRewardRatio, 0);
});

test('★★ 唯一的例外：`requireStopLoss` 必须保留', () => {
  /*
   * 它是**结构要求**，不是策略偏好 —— **没有止损的仓位等于没有下限**。
   * 用户说"不再设置内置风控"，但那指的是"策略风格"（仓位大小、该不该收手），
   * 而不是"允许开出没有止损的仓位"。
   *
   * 这一条与设计文档 §5.1 的两层结构一致：
   *   ① 智能体层管策略风格 ② 代码层管物理底线
   */
  const cfg = defaultAiTeamConfig();
  assert.equal(cfg.riskControl.requireStopLoss, true, '★ 止损是结构要求，不能交给模型自便');
});

test('★ 成交额下限被设置（避免滑点把利润吃光）', () => {
  /*
   * 动态池按成交额排序，但**排序不等于过滤** —— 一个成交额很小的币
   * 也可能排进前 20（如果当时整体成交量都低）。
   * 所以需要一个下限，而"滑点吃光利润"是这个项目真实踩过的教训。
   */
  const cfg = defaultAiTeamConfig();
  assert.ok(
    cfg.coinSource.minQuoteVolume24h > 0,
    '★ 必须有成交额下限（否则会去交易流动性极差的标的）',
  );
});

test('团队配置通过 schema 校验（不会在生产里抛错）', () => {
  assert.doesNotThrow(() => defaultAiTeamConfig());
});

test('★★ 成交额下限【真的生效】——防字段名写错被 schema 静默丢弃', () => {
  /*
   * 实测踩到：我先写成了 `minQuoteVolume`（真名是 `minQuoteVolume24h`），
   * 而 zod 的 `.parse()` 对**未知字段是静默丢弃的** —— 不报错、不警告。
   *
   * 后果：配置看起来"写了成交额下限"，实际**没有任何下限**，
   * 于是机器人会去交易流动性极差的标的（滑点吃掉利润）。
   * 而 `tsc` 只在**测试文件**引用该字段时才抓到这个错 ——
   * 生产代码里那份 `parse({...})` 的参数是对象字面量，多余字段不报错。
   *
   * 所以这条断言不是"再确认一遍数值"，而是**确认那个字段真的落进了配置**。
   */
  const cfg = defaultAiTeamConfig();
  assert.equal(
    cfg.coinSource.minQuoteVolume24h,
    50_000_000,
    '★ 成交额下限必须真的落到配置里（字段名写错会被静默丢弃）',
  );
});

test('★★ 动态池的参数都真的生效（同类陷阱的批量检查）', () => {
  /*
   * 与上一条同一个理由：`parse({...})` 会静默丢弃写错名字的字段。
   * 这里把**所有**关键参数逐一对一遍 —— 任何一个是默认值就说明名字写错了。
   */
  const cfg = defaultAiTeamConfig();
  assert.equal(cfg.coinSource.useOITop, true, 'useOITop 要真的生效（默认 false）');
  assert.equal(cfg.coinSource.oiTopLimit, 4, 'oiTopLimit 要真的生效（默认不是 4）');
  assert.equal(cfg.coinSource.coinPoolLimit, 8, 'coinPoolLimit 要真的生效（2026-10-12 从 20 降到 8：20 个候选=15万token提示词，整轮跑不完）');
  assert.equal(cfg.coinSource.coinPoolRank, 'quote_volume');
});