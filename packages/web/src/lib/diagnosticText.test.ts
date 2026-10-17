/**
 * **英文诊断信息中文化** —— 负向校准（2026-10-18 · 用户截图）。
 *
 * ## 用户的原话
 *
 * > 「这 UI 设计我都不说符不符合审美了，这东倒西歪，到处错位，大片空白的，
 * >  是给人看的吗？我都不要求他好看，你这起码的能看都达不到吧？」
 *
 * 截图里最刺眼的一条，**每隔几分钟出现一次**：
 * ```
 *   (The model called a tool this agent doesn't have: "bash". The call was left out.)
 * ```
 *
 * ## 这个文件钉住两件事
 *
 * | # | 输入 | 期望 |
 * |---|---|---|
 * | ① | 上游 SDK 的固定英文句式 | **译成中文**，且保留工具名（那是有诊断价值的部分） |
 * | ② | 模型自己写的英文推理 | **不译**（会失真），但 `looksForeign` 认得出 → 界面标注来源 |
 *
 * 第 ② 条的边界最容易做错：把模型正文也"翻译"掉，等于替它改口供。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { formatForeignText, looksForeign, translateDiagnostic } from './diagnosticText';

test('★★★ 上游 SDK 的工具缺失诊断 → 中文，且保留工具名', () => {
  const raw = `(The model called a tool this agent doesn't have: "bash". The call was left out.)`;
  const out = translateDiagnostic(raw);
  assert.notEqual(out, null, '★ 这是用户截图里反复出现的那一条，必须译');
  assert.ok(out!.includes('bash'), '★ 工具名必须保留 —— 那是唯一有诊断价值的部分');
  assert.ok(out!.includes('跳过'), '要说明"那次调用已跳过"，否则看不出后果');
  /* 不许留英文正文。 */
  assert.ok(!/The model called a tool/.test(out!), '中文结果里不该再有英文原句');
});

test('★★ 同一句式的紧凑版也要认', () => {
  const out = translateDiagnostic(`(The model called a tool this agent doesn't have: "web_search")`);
  assert.notEqual(out, null);
  assert.ok(out!.includes('web_search'));
});

test('★★★ 模型自己写的英文推理【不译】（那是它的推理，不是我们的文案）', () => {
  const reasoning =
    'Let me analyze each candidate systematically using the entry standards. ' +
    'Entry standards recap: Act on altcoins only. BTC/ETH/SOL not executable.';
  assert.equal(
    translateDiagnostic(reasoning),
    null,
    '★ 不许翻译模型正文 —— 会失真，且等于替它改口供',
  );
  /*
   * 但必须**认得出**它是整段外文，好让界面标注"这是模型的原始输出"。
   * 否则操作员的第一反应是"系统出 bug 了"。
   */
  assert.equal(looksForeign(reasoning), true);
  assert.equal(formatForeignText(reasoning).label, '模型输出（英文原文）');
});

test('★★ 中文内容不算外文（哪怕里面有英文术语）', () => {
  const cases = [
    '机械扫描：对每个候选算 D=|close[-1]-close[-6]|/close[-6]，可见 6 个',
    'ATR14 0.0032693/0.081205≈4.03%>3.5% 属成熟段，本轮不开仓',
    '已平仓 WLDUSDT 多头 @ 0.5115 → 净 +0.1234 USDT',
  ];
  for (const c of cases) {
    assert.equal(looksForeign(c), false, `★ 含中文就不算外文：${c.slice(0, 30)}`);
  }
});

test('★★ 短英文串不算"整段外文"（不要给每个标的都加标注）', () => {
  const shorts = ['BTCUSDT', 'RSI14 58.2', 'open_short', 'PF 1.31 · 89 笔', 'MACD 0.001206'];
  for (const s of shorts) {
    assert.equal(looksForeign(s), false, `★ 短串不该被标注成外文：${s}`);
  }
});

test('★★ 普通中文文本不受影响（回归：这三个函数不能误伤日常内容）', () => {
  const normal = [
    '汇总辩论并裁决',
    '这一轮对 19 个标的给了决策',
    '原文本已截断（完整 4750 字）',
  ];
  for (const n of normal) {
    assert.equal(translateDiagnostic(n), null, `★ 不该被当成诊断句：${n}`);
    assert.equal(looksForeign(n), false, `★ 不该被当成外文：${n}`);
  }
});
