/**
 * 角色定义与上下文隔离。
 *
 * ## 为什么这些用例存在
 *
 * 这一层的失效**不会有任何报错**：审查者照常返回一个结构正确的 JSON，
 * 只是它的结论永远是"通过"。所以"对抗审查还在不在"必须由测试来钉，
 * 而不是靠读一遍提示词觉得"写得挺严厉的"。
 *
 * 最要紧的一条在 `toRiskReviewInput`：**风控官拿不到提案人的论证与信心**。
 * 那是机械保证；提示词层面的"请保持独立判断"防不住谄媚。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentMemoryRow } from '../../store/agentStore.js';
import {
  contextFor,
  parseRoleOutput,
  ROLES,
  renderPriorFailures,
  toRiskReviewInput,
  type AgentRole,
} from './roles.js';

const ALL_ROLES: AgentRole[] = [
  'strategist',
  'performance_analyst',
  'attribution_analyst',
  'risk_officer',
  'market_analyst',
  'trader',
  'reviewer',
];

test('七个角色齐全，且每个都有中文名与非空提示词', () => {
  for (const role of ALL_ROLES) {
    const spec = ROLES[role];
    assert.equal(spec.role, role);
    assert.ok(spec.label.length > 0, `${role} 缺中文名 —— 界面与日志要显示它`);
    assert.ok(spec.system.length > 100, `${role} 的提示词太短`);
    assert.match(spec.system, /JSON/, `${role} 必须被要求输出 JSON —— 散文无法被校验`);
  }
});

test('风控官的上下文里**没有**提案人的论证与信心', () => {
  /*
   * 这是本文件最重要的一条。
   *
   * 把交易员的 `reasoning` 放进风控官的上下文，它就会去论证那个 reasoning 成立 ——
   * 这是所有"自我审查"退化的共同机制。提示词里写多少句"请保持独立判断"都挡不住，
   * 因为那是在要求一个角色**违背它拿到的信息**去下结论。
   *
   * 所以在数据层面切断：它只看得到仓位的结构（标的、方向、杠杆、名义、止损、止盈、现价）。
   * 判断"这个仓位结构会不会亏"只需要数字。
   */
  const fed = toRiskReviewInput({
    symbol: 'BTCUSDT',
    action: 'open_long',
    leverage: 5,
    positionSizeUsd: 50,
    stopLoss: 58000,
    takeProfit: 64000,
    markPrice: 60000,
    confidence: 95,
    reasoning: '1H 放量突破关键阻力，回踩确认，多头结构完好，这是本轮最好的机会。',
  });

  const text = JSON.stringify(fed);
  assert.ok(!text.includes('confidence'), '提案人的信心不得进入风控官的上下文');
  assert.ok(!text.includes('reasoning'), '提案人的论证不得进入风控官的上下文');
  assert.ok(!text.includes('放量突破'), '论证的正文更不得进入');
  assert.ok(!/95/.test(text), '信心的数值也不得进入');

  // 该给的必须给全 —— 少了这些它就没法判断止损距离
  for (const key of ['symbol', 'action', 'leverage', 'positionSizeUsd', 'stopLoss', 'takeProfit', 'markPrice']) {
    assert.ok(key in (fed as unknown as Record<string, unknown>), `风控官必须拿到 ${key}`);
  }
});

test('风控官被定义为"找亏损场景"，而不是"评估好坏"', () => {
  const sys = ROLES.risk_officer.system;
  assert.match(sys, /找出它会怎么亏/, '职责必须定义成找亏损场景');
  assert.match(sys, /不是评估这个提案好不好/, '必须明确排除"评估好坏"这个框');
  assert.match(sys, /只能否决|没有"放宽"/, '必须写明权限是单向的');
  assert.match(sys, /checked/, '找不到问题时要说明查了什么 —— "没找到"和"没找"必须能区分');
});

test('风控官的输出结构强制要求亏损场景：空数组也必须说明查了什么', () => {
  const sys = ROLES.risk_officer.system;
  assert.match(sys, /lossScenarios/, '输出结构里必须有亏损场景字段');
  assert.match(sys, /verdict/, '必须有裁决字段');
  assert.match(sys, /approve\|tighten\|reject/, '裁决的取值必须写死，不能自由发挥');
});

test('风控官拿不到交易员的角色上下文（隔离是声明式的）', () => {
  assert.equal(contextFor('risk_officer'), 'proposal_only');
  assert.equal(contextFor('trader'), 'decision_review');
  assert.notEqual(contextFor('risk_officer'), contextFor('trader'));
});

test('行情分析师拿不到账户绩效 —— 那会干扰对行情本身的判断', () => {
  assert.equal(contextFor('market_analyst'), 'market');
  assert.equal(contextFor('performance_analyst'), 'strategy_review');
  assert.notEqual(contextFor('market_analyst'), contextFor('performance_analyst'));
});

test('绩效分析师被要求主动指出样本量不足', () => {
  /*
   * 这一条是防"拿噪声当信号"的。少于 30 笔的成绩无法区分策略有效与运气好，
   * 而下游（策略师）会照着绩效结论调参 —— 不主动说，它就会照着一个噪声去改参数。
   */
  assert.match(ROLES.performance_analyst.system, /样本量/, '必须提到样本量');
  assert.match(ROLES.performance_analyst.system, /30/, '要给出具体门槛，不能只说"注意样本量"');
  assert.match(ROLES.performance_analyst.system, /sampleAdequate/, '要有机器可判的字段');
});

test('策略师被要求先读自己的实验记录，且一次只改少数几项', () => {
  const sys = ROLES.strategist.system;
  assert.match(sys, /get_experiments/, '必须要求先读实验记录 —— 否则它会重复试过的失败方向');
  assert.match(sys, /一次只改少数几项/, '一次改十项就学不到任何东西');
  assert.match(sys, /不改也是/, '"不改"必须被明确写成正当结论，否则它会为了交差而乱调');
  assert.match(sys, /wouldFalsify/, '要求它写下什么结果会说明自己错了');
});

test('交易员被告知"不交易"是正当结论', () => {
  const sys = ROLES.trader.system;
  assert.match(sys, /不交易/, '必须明说');
  assert.match(sys, /太频繁|手续费/, '要写出本系统的实测问题，否则它倾向于多做');
  assert.match(sys, /reasoning/, '提案必须带入场理由 —— 它会与真实结果对照');
});

test('复盘员被要求区分决策质量与结果', () => {
  /*
   * 一笔好决策可能亏钱、一笔坏决策可能赚钱。不区分的话，记忆里会积累错误的教训，
   * 而那些教训会在以后被检索出来误导决策。
   */
  const sys = ROLES.reviewer.system;
  assert.match(sys, /决策质量/, '必须区分');
  assert.match(sys, /结果与决策质量不符/, '不符时要明确指出来');
  assert.match(sys, /decisionQuality/, '要有机器可判的字段');
});

test('所有角色共用同一条铁律：不确定就说不确定', () => {
  for (const role of ALL_ROLES) {
    assert.match(
      ROLES[role].system,
      /不确定|数据不足/,
      `${role} 必须被允许说"不知道" —— 这个系统要为它的结论下真实资金`,
    );
  }
});

test('历史失败渲染成风控官能用的弹药', () => {
  const rows: AgentMemoryRow[] = [
    {
      id: 1,
      traderId: 1,
      tradeId: 1,
      createdAt: '2026-09-17T00:00:00.000Z',
      symbol: 'BTCUSDT',
      closeReason: 'stop_loss',
      netPnl: -0.31,
      lesson: '在 1H 下跌趋势里逆势做多，止损被打掉。',
      tagsJson: '["逆势"]',
    },
  ];
  const text = renderPriorFailures(rows);
  assert.match(text, /BTCUSDT/);
  assert.match(text, /逆势做多/, '教训正文必须进去 —— 那是它唯一的弹药');
  assert.match(text, /-0\.3100/, '带真实亏损数字');

  assert.match(renderPriorFailures([]), /没有记录/, '没有历史时要明说，不能让它是空白');
});

/* -------------------------------------------------------------------------- */
/*  结构化输出解析                                                             */
/* -------------------------------------------------------------------------- */

test('解析：纯 JSON、带围栏、带前后说明三种都认', () => {
  const cases = [
    '{"verdict":"reject"}',
    '```json\n{"verdict":"reject"}\n```',
    '我的判断如下：\n{"verdict":"reject"}\n以上。',
  ];
  for (const text of cases) {
    const r = parseRoleOutput<{ verdict: string }>(text);
    assert.equal(r.error, null, `应能解析：${text.slice(0, 30)}`);
    assert.equal(r.value?.verdict, 'reject');
  }
});

test('解析失败时返回 null 与原因，**不用默认值兜底**', () => {
  /*
   * 静默降级是危险的：把"解析不了"当成"结论是空的"，整个循环会在错误的输入上继续跑，
   * 而且没有任何迹象。宁可在这一层就明确失败，由调用方决定降级策略。
   */
  for (const text of ['', '我无法判断。', '[1,2,3]', '{"未闭合":']) {
    const r = parseRoleOutput(text);
    assert.equal(r.value, null, `不得为 ${JSON.stringify(text.slice(0, 20))} 编出一个值`);
    assert.ok(r.error, '必须给出原因');
  }
});

test('解析：单对象被包在数组里可以宽容，多个对象必须失败', () => {
  /*
   * 分层与 §2.4 一致：**对结构宽容、对语义严格**。
   *
   * 模型把单个对象包在数组里是无害的格式变化，抽出它是对的 ——
   * 下游只要一个结论，从一层数组里拿到它没有歧义。
   *
   * 但**多个对象必须失败**：那时"取哪一个"是有歧义的，而猜错的后果是
   * 把一个角色的结论当成另一个角色的。宁可在这一层明确失败。
   */
  const single = parseRoleOutput<{ verdict: string }>('[{"verdict":"approve"}]');
  assert.equal(single.error, null, '单对象数组应当被宽容');
  assert.equal(single.value?.verdict, 'approve');

  const many = parseRoleOutput('[{"verdict":"approve"},{"verdict":"reject"}]');
  assert.equal(many.value, null, '多对象时取哪一个是有歧义的，必须失败而不是猜');
  assert.ok(many.error);
});
