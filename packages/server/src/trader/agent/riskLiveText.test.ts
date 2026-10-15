/**
 * **用线上真实文本验证 `tighten` 的修复**（2026-10-15）
 *
 * 这两段是 `#11` 的 `raw_response` 里的**原文**（我只截了长度）。
 * 判据：同一段文本，修复前会判成"未能识别表态 → 保守拦下"，
 *       修复后必须判成"放行 + 削减"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRiskOfficerVerdict } from './riskOfficer.js';
import type { Decision } from '@aq/shared';

/** 第 282 轮的 `<risk>` 块原文（风控官的表态部分）。 */
const CYCLE_282 = `{"verdict":"tighten","lossScenarios":[{"scenario":"ZECUSDT长仓在EMA50(1120)压制位被拒后回落，止损1084.17距入场仅约1.9倍ATR(1.00%)，一根正常15m影线即可击穿","likelihood":"high","severity":"minor"},{"scenario":"XRP与ZEC同为15m动量追多，若市场在信号触发后出现均值回归（常见于<2%的弱动量），两笔同时止损，形成伪分散下的真实相关性亏损","likelihood":"medium","severity":"minor"}],"checked":"止损距离与ATR倍数、两笔的相关性、EMA50 压制位"}`;

/** 第 283 轮的 `<risk>` 块原文（这个是【真否决】）。 */
const CYCLE_283 = `{"verdict":"reject","lossScenarios":[{"scenario":"ZEREBROUSDT open_long的1.5%止损(0.045885→0.045197)在ATR=4.33%环境下必然被正常噪声打掉——止损距离仅为单根15m蜡烛波幅的0.35倍,这不是止损而是随机退出机制","likelihood":"high","severity":"severe"}],"checked":"止损距离与ATR倍数"}`;

const mk = (symbol: string, usd: number): Decision =>
  ({ symbol, action: 'open_long', leverage: 5, positionSizeUsd: usd, confidence: 60 }) as Decision;

test('★★★ 线上第 282 轮：tighten 必须变成「放行+削减」，而不是拦下两条 open_long', () => {
  /*
   * ⚠️ 这是**真实事故现场**：
   * ```
   *   第 282 轮 judge 提议: open_long, open_long, hold, skip, skip
   *   而 <risk> 写成: 否决（…）：（未能识别风控官的表态，按保守策略只放行降低风险的动作）
   *   ⇒ <decision> = []   ← 两条开仓被清空
   * ```
   * 修复后：`tighten` → 放行 + 削减，那两条开仓应当**以削减后的仓位保留**。
   */
  const decisions = [mk('ZECUSDT', 11), mk('XRPUSDT', 11)];
  const v = parseRiskOfficerVerdict(CYCLE_282, decisions);
  assert.equal(v.approved, true, '★ tighten 不是否决 —— 必须放行');
  assert.equal(v.reduced, true, '★ tighten 必须削减');
  assert.ok(v.adjusted !== null, '★ 必须有削减后的决策');
  assert.equal(v.adjusted!.length, 2, '★ 两条开仓都应当保留（削减而不是删除）');
  assert.ok(
    v.adjusted!.every((d) => (d.positionSizeUsd ?? 0) < 11),
    '★ 削减后的仓位必须小于原值',
  );
  assert.ok(!/未能识别/.test(v.reason), '★ 不该再说"未能识别表态"');
});

test('★★★ 线上第 283 轮：reject 必须仍然是否决（修复不能把它放松）', () => {
  /*
   * ⚠️ 反向守卫，而且这一条**特别重要**：
   * 第 283 轮的风控官是**有理有据地否决**（止损仅为单根蜡烛波幅的 0.35 倍）。
   * 若我的修复让它变成"放行"，那就是**为了多交易而放松风控** ——
   * 那是本仓库绝对禁止的。
   */
  const decisions = [mk('ZEREBROUSDT', 11)];
  const v = parseRiskOfficerVerdict(CYCLE_283, decisions);
  assert.equal(v.approved, false, '★ reject 必须仍然拦下（不能为了动作率放松风控）');
  assert.equal(v.adjusted, null, '★ 否决时不该有削减后的决策');
});

test('★★★ 理由必须来自 lossScenarios/checked（不能是"未给出理由"）', () => {
  const v = parseRiskOfficerVerdict(CYCLE_282, [mk('ZECUSDT', 11)]);
  assert.ok(!/未给出理由/.test(v.reason), `★ 实际：${v.reason}`);
  assert.ok(v.reason.length > 10, '★ 理由必须有内容（它明明写了 lossScenarios）');
});
