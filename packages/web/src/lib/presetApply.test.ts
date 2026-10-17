/**
 * **UI 的"套预设"必须与共享包解析出的那一份配置完全一致**（台账 `NTM-03`）。
 *
 * ## 这份测试盯的是哪条路径
 *
 * 两个入口（策略编辑器的下拉框、策略列表的"从预设新建"）现在都调共享包的
 * `resolvePreset(preset)` —— **它不接受"当前配置"**，所以"上一份预设渗进下一份"
 * 在类型层面就发生不了。这里盯的是**结果**：解析结果与 schema 默认值、与 patch
 * 声明值之间的关系仍然正确，而且**与"当前是什么"无关**。
 *
 * ## 为什么不再有 `applyPreset` 的用例
 *
 * `applyPreset(current, preset)` 已被**删除**（它就是载体：签名逼调用方交出
 * "当前配置"，而那条路会继承未声明字段）。删掉之后"`applyPreset` 等于
 * `resolvePreset`"这类断言没有对象了 —— 它们是**随实现一起消失**，不是被删掉。
 * 剩下的守卫：
 *   · 本文件：解析出的配置满足全部模板要求；
 *   · `presetWiring.test.ts`：两个入口**没有再自己合并**（源码结构断言；
 *     已用"把浅合并写回去"变异实测变红）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { STRATEGY_PRESETS, defaultStrategyConfig, presetOfConfig, resolvePreset, type StrategyConfig } from '@aq/shared';

import { activePreset, cloneConfig, presetById } from './strategy';

/** 三套模板的 id —— 用户明确要求"3 套模板都要保证正常"。 */
const EXPECTED_PRESET_IDS = ['conservative', 'aggressive', 'scalping'];

/* -------------------------------------------------------------------------- */
/*  1. 三套模板在 UI 这一侧也能取到                                                */
/* -------------------------------------------------------------------------- */

test('★★★ 三套模板都能按 id 取到，且覆盖 tradingMode 全枚举', () => {
  for (const id of EXPECTED_PRESET_IDS) {
    const preset = presetById(id);
    assert.ok(preset, `★★★ presetById(${id}) 必须能取到 —— 下拉框靠它渲染`);
    assert.equal(preset.id, id, `★ ${id}：取回来的必须是同一份预设`);
  }
  assert.equal(presetById(null), undefined, '★ 没有预设时应返回 undefined（下拉框显示占位）');
  assert.equal(presetById('definitely-not-a-preset'), undefined, '★ 未知 id 必须返回 undefined');

  const modes = new Set(STRATEGY_PRESETS.map((p) => p.tradingMode));
  assert.deepEqual(
    [...modes].sort(),
    ['aggressive', 'conservative', 'scalping'],
    '★★★ 三套模板必须覆盖 tradingMode 的全部三个取值 —— ' +
      '缺一个就会有一套模板套完之后提示词里的"模式：xxx"与参数不一致',
  );
});

/* -------------------------------------------------------------------------- */
/*  2. 解析结果与"当前配置"无关（A→B 不得留下 A 的残留）                            */
/* -------------------------------------------------------------------------- */

test('★★★ 套用 B 之后的结果必须等于 B 的完整定义，且与"A 曾存在过"无关', () => {
  /*
   * 台账 `NTM-03` 验收标准第 3 条的形状。两个方向都测：
   *   · `scalping → conservative`（短线的 `drawdownGuard` / `indicators` 不得留下）；
   *   · `conservative → scalping`（稳健的盈亏比/置信度不得留下）。
   *
   * ⚠️ 这条是**行为不变量**，不是"因为实现恰好如此所以必然绿"：
   * 它锁的是"套模板 = 得到那份模板"，将来若有人给 `resolvePreset` 加上
   * "保留用户已改字段"的第二个参数（并在调用点传当前草稿），这里会变红。
   */
  const pairs: Array<[string, string]> = [
    ['scalping', 'conservative'],
    ['conservative', 'scalping'],
    ['aggressive', 'conservative'],
    ['scalping', 'aggressive'],
    ['conservative', 'aggressive'],
    ['aggressive', 'scalping'],
  ];

  const defaults = defaultStrategyConfig();

  for (const [fromId, toId] of pairs) {
    const from = presetById(fromId);
    const to = presetById(toId);
    assert.ok(from && to, `★ 前提：${fromId} 与 ${toId} 都存在`);

    /* 模拟用户：先套 A（得到一份"带着 A 的值"的配置），再套 B。 */
    const afterA = resolvePreset(from);
    const afterB = resolvePreset(to);
    const expectedB = resolvePreset(to);

    assert.deepEqual(
      afterB,
      expectedB,
      `★★★ ${fromId} → ${toId}：套用 ${toId} 的结果必须等于它的完整定义（含 schema 默认值）`,
    );

    /*
     * 反向判据：A 独有而 B 不声明的字段必须**回到默认值**。
     * `scalping` 是唯一声明 `drawdownGuard` 与 `indicators` 的模板，
     * 所以这两块是渗漏最直接的观测面。
     */
    for (const section of ['drawdownGuard', 'indicators', 'throttle'] as const) {
      const declaredByTo = to.patch[section] as Record<string, unknown> | undefined;
      for (const field of Object.keys(defaults[section] as Record<string, unknown>)) {
        if (declaredByTo && field in declaredByTo) continue;
        assert.deepEqual(
          (afterB[section] as Record<string, unknown>)[field],
          (defaults[section] as Record<string, unknown>)[field],
          `★★★ ${fromId} → ${toId}：${section}.${field} 未被 ${toId} 声明，` +
            `必须回到 schema 默认值（实际 ${JSON.stringify((afterB[section] as Record<string, unknown>)[field])}）` +
            ' —— 留着它就意味着"套了 B 却跑着 A 的那一项"',
        );
      }
    }

    /*
     * ⚠️ **前置断言**：`afterA` 必须真的与 B 不同，否则上面那些"不得残留"
     * 的断言在 A≈B 的退化情形下毫无意义（它们会自然成立）。
     */
    assert.notDeepEqual(
      afterA,
      expectedB,
      `★ 前提：${fromId} 与 ${toId} 的解析结果确实不同（否则这条用例什么都没验）`,
    );
  }
});

test('★★★ resolvePreset 的输入只有预设本身 —— 结果不得随"调用顺序"变化', () => {
  /*
   * 直白的形状：连续解析三套、再倒着解析一遍，同一份预设的结果必须逐字相同。
   * 这条挡的是"解析里留了跨调用的状态"（例如把上一次的结果当底）。
   */
  const forward = STRATEGY_PRESETS.map((p) => JSON.stringify(resolvePreset(p)));
  const backward = [...STRATEGY_PRESETS].reverse().map((p) => JSON.stringify(resolvePreset(p))).reverse();
  assert.deepEqual(backward, forward, '★★★ 解析结果不得依赖调用顺序（那是隐藏状态的信号）');
});

/* -------------------------------------------------------------------------- */
/*  3. activePreset：徽章/下拉框的判据来自配置本身                                  */
/* -------------------------------------------------------------------------- */

test('★★★ activePreset 与共享包的 presetOfConfig 必须是同一个答案（UI 不得自实现一套）', () => {
  const samples: StrategyConfig[] = [
    ...STRATEGY_PRESETS.map((p) => resolvePreset(p)),
    defaultStrategyConfig(),
    (() => {
      const c = cloneConfig(resolvePreset('scalping'));
      c.drawdownGuard.activationPercent += 0.1;
      return c;
    })(),
    (() => {
      const c = cloneConfig(resolvePreset('conservative'));
      c.coinSource.staticCoins = [...c.coinSource.staticCoins, 'SOLUSDT'];
      return c;
    })(),
  ];

  for (const config of samples) {
    assert.equal(
      activePreset(config)?.id ?? null,
      presetOfConfig(config)?.id ?? null,
      '★★★ UI 的 activePreset 必须与共享包的 presetOfConfig 给出同一个答案 —— ' +
        '两处各写一套比较就是"同一件事两份定义"，而它们会分叉',
    );
  }
});

test('★★★ 改一处字段之后 activePreset 必须返回 null（徽章不得继续写预设名）', () => {
  for (const preset of STRATEGY_PRESETS) {
    const drifted = cloneConfig(resolvePreset(preset));
    drifted.riskControl.minRiskRewardRatio += 1;
    assert.equal(
      activePreset(drifted),
      null,
      `★★★ ${preset.id}：改了最小盈亏比之后不得再被认定成该预设 —— ` +
        `否则界面会说"预设：${preset.label}"，而参数已经不是它`,
    );
  }
});

test('★★ activePreset：内容不变时不得误报"偏离"（反向校准）', () => {
  for (const preset of STRATEGY_PRESETS) {
    const a = resolvePreset(preset);
    const b = cloneConfig(a);
    assert.notEqual(a, b, '★ 前提：必须是两个不同的对象实例');
    assert.equal(activePreset(b)?.id, preset.id, `★ ${preset.id}：内容相同必须被认定为同一份预设`);
  }
});

test('★★ 用"看起来相等"的浅判据校准 activePreset 不是空转（负向校准）', () => {
  /*
   * ⚠️ **负向校准。** 上面的用例断言 `=== null`，而"永远返回 null 的实现"同样通过。
   * 这里用一段只看显眼字段的浅判据，证明它在同一批输入上会漏 ——
   * 于是"把 `activePreset` 换成浅实现，上面那条会变红"。
   */
  const base = resolvePreset('conservative');
  const drifted = cloneConfig(base);
  drifted.drawdownGuard.activationPercent += 1; // conservative 并不声明 drawdownGuard

  const shallow = (config: StrategyConfig): string | null =>
    STRATEGY_PRESETS.find(
      (p) =>
        p.tradingMode === config.tradingMode &&
        p.patch.riskControl?.minConfidence === config.riskControl.minConfidence,
    )?.id ?? null;

  assert.equal(shallow(drifted), 'conservative', '★ 前提：浅判据会把这个改动漏掉');
  assert.equal(activePreset(drifted), null, '★★★ 真判据必须抓住浅判据漏掉的嵌套分区改动');
});
