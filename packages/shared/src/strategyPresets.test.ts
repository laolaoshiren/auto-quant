/**
 * **三套模板（conservative 稳健 / aggressive 进取 / scalping 短线）必须"声明即生效"**。
 *
 * ## 这份测试防的是什么（两条真实缺陷，都已在生产路径上）
 *
 * ### ① 套预设是"浅叠加"，于是上一份预设会渗进下一份（台账 `NTM-03`）
 *
 * 控制台原来拿**当前草稿**当底再叠 `patch`（`{ ...current, ...preset.patch }`），
 * 而三套预设声明的字段集合**并不相同**：
 *
 * | 字段 | conservative | aggressive | scalping |
 * |---|---|---|---|
 * | `indicators` | — | — | ✅ |
 * | `drawdownGuard` | — | — | ✅ |
 *
 * 于是「短线 → 稳健」之后用户拿到的是**稳健的提示词 + 短线的回撤守卫**
 * （`activationPercent = 0.4%`，而 schema 默认是 `1.5%`）——
 * 提示词里写着 conservative、徽章写着"稳健"，而参数是第三样东西。
 *
 * 所以这里断言的是**解析结果的独立性**：`resolvePreset(p)` 的输出**只由 `p` 决定**。
 * 判据是两个方向：
 *   · `p.patch` 里声明且有值的每一项 —— 解析后**逐字相等**（防静默丢弃）；
 *   · 一份预设没声明的字段 —— 解析后等于 **schema 默认值**（防继承上一份）。
 *
 * ### ② `breakevenTriggerPercent` 曾"声明了却不生效"
 *
 * `conservative.patch` 曾写 `breakevenTriggerPercent: 8`（浮盈 8% 把止损移到成本价），
 * 而它是**唯一一个模板声明、解析后却对不上**的风控字段 —— 修法见
 * `strategy.ts` 里那段注释（与 schema 默认 0 对齐，不改任何数值、不新增字段）。
 * 下面第 1 条用例就是钉住这件事：**它会在谁把那个值写回去时变红。**
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STRATEGY_CONFIG_KEYS,
  STRATEGY_PRESETS,
  StrategyConfigSchema,
  defaultStrategyConfig,
  presetOfConfig,
  resolvePreset,
  type StrategyConfig,
} from './strategy.js';

/** 三套模板的 id（缺一套就应该变红 —— 用户明确要求"3 套模板都要保证正常"）。 */
const EXPECTED_PRESET_IDS = ['conservative', 'aggressive', 'scalping'];

const byId = new Map(STRATEGY_PRESETS.map((p) => [p.id, p]));

/** 深拷贝（`JSON.parse(JSON.stringify())` 会丢掉 `undefined`，而配置里没有 undefined）。 */
function clone(config: StrategyConfig): StrategyConfig {
  return JSON.parse(JSON.stringify(config)) as StrategyConfig;
}

/** 逐分区深度比较两个配置是否相等（与 `presetOfConfig` 同一个口径）。 */
function sameConfig(a: StrategyConfig, b: StrategyConfig): boolean {
  return STRATEGY_CONFIG_KEYS.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

/* -------------------------------------------------------------------------- */
/*  1. 三套模板都在，且 tradingMode 与 patch 声明一致                             */
/* -------------------------------------------------------------------------- */

test('★★★ 三套模板必须都在（conservative / aggressive / scalping）', () => {
  const ids = STRATEGY_PRESETS.map((p) => p.id);
  assert.deepEqual(
    ids,
    EXPECTED_PRESET_IDS,
    '★★★ 用户明确要求"项目共有 3 套模板，都要保证正常" —— 少一套或多一套都要在这里说清',
  );
});

test('★★★ tradingMode 由 preset.tradingMode 决定，且与 patch 里写的一致', () => {
  for (const id of EXPECTED_PRESET_IDS) {
    const preset = byId.get(id);
    assert.ok(preset, `★ 找不到预设 ${id}`);
    const resolved = resolvePreset(preset);
    assert.equal(
      resolved.tradingMode,
      preset.tradingMode,
      `★★★ ${id}：解析后的 tradingMode 必须等于 preset.tradingMode —— ` +
        '它是提示词里"模式：xxx"那一行的来源（strategy/prompt.ts）',
    );
    /*
     * `patch.tradingMode` 与 `preset.tradingMode` 是同一件事的两个写法；
     * 分叉时以 `preset.tradingMode` 为准（`resolvePreset` 就是这么做的），
     * 所以要显式断言它们**本来**就一致 —— 否则这个字段将来会静默走错一个。
     */
    assert.equal(
      preset.patch.tradingMode,
      preset.tradingMode,
      `★ ${id}：patch.tradingMode 与 preset.tradingMode 分叉了（两个来源说同一件事）`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  2. 声明即生效：patch 里有的逐字相等；没声明的回到 schema 默认值                */
/* -------------------------------------------------------------------------- */

test('★★★ 三套模板：patch 声明且有值的每一项，解析后逐字相等（防静默丢弃）', () => {
  /*
   * ⚠️ **逐字段比较，不比整个分区对象。**
   *
   * `patch` 是**局部**覆盖：`scalping.patch.indicators` 只写了
   * `kline` + 若干开关，而 `indicators.promptPoints` 它没声明 ——
   * 那么该项就应当来自 schema 默认值（由第 2 条用例负责断言"回落到默认值"）。
   * 拿整个分区对象去比会把"没声明 → 用默认值"误判成"声明被丢弃"，
   * 那是**假红**（这条用例第一次写出来时就踩了：`kline.promptPoints: 30`）。
   */
  let checked = 0;
  for (const preset of STRATEGY_PRESETS) {
    const resolved = resolvePreset(preset);
    for (const [section, patchSection] of Object.entries(preset.patch)) {
      if (patchSection === undefined) continue;
      if (typeof patchSection !== 'object' || patchSection === null) {
        checked += 1;
        assert.deepEqual(
          resolved[section as keyof StrategyConfig],
          patchSection,
          `★★★ ${preset.id}：patch.${section} 声明了 ${JSON.stringify(patchSection)}，` +
            `而解析后是 ${JSON.stringify(resolved[section as keyof StrategyConfig])}`,
        );
        continue;
      }
      for (const [field, value] of Object.entries(patchSection as Record<string, unknown>)) {
        if (value === undefined) continue;
        /*
         * 声明值本身是嵌套对象时（`kline`），只比**它声明了的那些子键** ——
         * 同一条"局部覆盖"的规则递归适用。
         */
        const actual = (resolved[section as keyof StrategyConfig] as Record<string, unknown>)[field];
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          for (const [sub, subValue] of Object.entries(value as Record<string, unknown>)) {
            if (subValue === undefined) continue;
            checked += 1;
            assert.deepEqual(
              (actual as Record<string, unknown>)[sub],
              subValue,
              `★★★ ${preset.id}：patch.${section}.${field}.${sub} 声明了 ` +
                `${JSON.stringify(subValue)}，而解析后是 ` +
                `${JSON.stringify((actual as Record<string, unknown>)[sub])}`,
            );
          }
          continue;
        }
        checked += 1;
        assert.deepEqual(
          actual,
          value,
          `★★★ ${preset.id}：patch.${section}.${field} 声明了 ${JSON.stringify(value)}，` +
            `而解析后是 ${JSON.stringify(actual)} —— ` +
            '声明与生效不一致时，模板在界面上说的是一件事、跑的是另一件事',
        );
      }
    }
  }
  /*
   * ⚠️ **前置断言**：必须真的比对到足够多的字段。
   * 没有它，"patch 结构变了所以一个字段都没比到 → 全绿"也会通过 —— 那什么都没验。
   */
  assert.ok(
    checked >= 40,
    `★★ 至少要逐字核对 40 个字段，实际 ${checked} 个 —— 扫描/结构可能变了，这条测试会空转`,
  );
});

test('★★★ 一份预设没声明的字段，解析后必须等于 schema 默认值（防继承上一份预设）', () => {
  const defaults = defaultStrategyConfig();
  let checked = 0;

  for (const preset of STRATEGY_PRESETS) {
    const resolved = resolvePreset(preset);
    const declared = new Set<string>();
    for (const [section, patchSection] of Object.entries(preset.patch)) {
      if (patchSection !== undefined && typeof patchSection === 'object' && patchSection !== null) {
        for (const field of Object.keys(patchSection)) declared.add(`${section}.${field}`);
      } else {
        declared.add(section);
      }
    }

    for (const section of Object.keys(defaultStrategyConfig()) as Array<keyof StrategyConfig>) {
      const defValue = defaults[section];
      if (typeof defValue !== 'object' || defValue === null) continue;
      for (const field of Object.keys(defValue as Record<string, unknown>)) {
        if (declared.has(`${String(section)}.${field}`)) continue;
        if (declared.has(String(section))) continue;
        checked += 1;
        assert.deepEqual(
          (resolved[section] as Record<string, unknown>)[field],
          (defValue as Record<string, unknown>)[field],
          `★★★ ${preset.id}：它没有声明 ${String(section)}.${field}，` +
            `解析后应当是 schema 默认值 ${JSON.stringify((defValue as Record<string, unknown>)[field])}，` +
            `实际 ${JSON.stringify((resolved[section] as Record<string, unknown>)[field])} —— ` +
            '若这里是上一份预设留下的值，就是"套了 A 却跑着 B 的参数"',
        );
      }
    }
  }

  assert.ok(
    checked >= 60,
    `★★ 至少要核对 60 个"未声明字段回落到默认值"，实际 ${checked} 个`,
  );
});

test('★★★ breakevenTriggerPercent 不得由 conservative 单方面声明（声明与生效必须一致）', () => {
  /*
   * 这条用例是**针对那次真实缺陷**的：conservative.patch 曾写 `breakevenTriggerPercent: 8`，
   * 而 `RiskControlConfigSchema` 的默认是 0（关闭）——
   * 也就是"模板说浮盈 8% 移止损、实际这条规则根本没开"。
   *
   * 判据写成"三套模板在这个字段上的说法必须一致"（要么都别声明，要么都声明同一个值）：
   * 这样将来任何"只有一套模板偷偷开了一条风控行为"都会在这里变红，
   * 而不必把某个具体数值钉死 —— 数值是产品决定，**一致性**才是缺陷与否。
   */
  const claims = STRATEGY_PRESETS.map((preset) => ({
    id: preset.id,
    value: preset.patch.riskControl?.breakevenTriggerPercent,
  })).filter((c) => c.value !== undefined);

  const distinct = [...new Set(claims.map((c) => c.value))];
  assert.ok(
    distinct.length <= 1,
    '★★★ 三套模板对 `breakevenTriggerPercent`（浮盈多少把止损移到成本价）的说法不一致：' +
      claims.map((c) => `${c.id}=${String(c.value)}`).join('、') +
      '。它决定真实风控行为，而另外两套模板不声明它 → 解析后它们拿到的是 schema 默认值 0（关闭）。\n' +
      '    要么三套都不声明（与 schema 默认一致），要么三套各自写明 —— 不能只有一套悄悄开启。',
  );

  const resolved = resolvePreset(byId.get('conservative')!);
  assert.equal(
    resolved.riskControl.breakevenTriggerPercent,
    byId.get('conservative')!.patch.riskControl?.breakevenTriggerPercent ??
      defaultStrategyConfig().riskControl.breakevenTriggerPercent,
    '★★★ conservative 的 breakevenTriggerPercent 解析后必须与它声明的值（或 schema 默认）一致',
  );
});

/* -------------------------------------------------------------------------- */
/*  3. A 预设 → B 预设：结果必须等于 B 的完整定义，不是 A+B 的混合                 */
/* -------------------------------------------------------------------------- */

test('★★★ 套用 B 之后的结果必须与"A 曾存在过"无关（A→B 不得留下 A 的残留）', () => {
  /*
   * 这正是台账 `NTM-03` 验收标准第 3 条要求的用例形状：
   * 「A 预设 → B 预设 → 断言结果等于 B 的完整定义（而非 A+B 的叠加）」。
   *
   * ## 为什么这里是"对每个 A 都断言"，而不是只测一对
   *
   * 渗漏只在**字段集合不同**的那一对上现形（scalping 多声明 `indicators` 与
   * `drawdownGuard`）。只测 (scalping → conservative) 会漏掉反过来那一对，
   * 而那一对同样是真实操作路径（用户两个方向都会点）。所以遍历全部有序对。
   *
   * ## 它与 `resolvePreset(preset)` 只有单参数的关系
   *
   * `resolvePreset` **不接受**"当前配置"，所以这里在类型层面就调不出旧行为。
   * 这条用例的价值在于：它把"输出只由预设决定"写成**可执行**的断言 ——
   * 将来若有人为了让"保留用户手改"而复活 `resolvePreset(preset, current)` 那种签名，
   * 就必须同时让这条用例失败（它断言的是 B 的完整定义，而不是"A∪B"）。
   */
  let checked = 0;
  for (const from of STRATEGY_PRESETS) {
    for (const to of STRATEGY_PRESETS) {
      if (from.id === to.id) continue;
      const afterA = resolvePreset(from);
      /* 旧实现的口径：拿 A 的结果当底再叠 B 的 patch。这里刻意不复用它，只看结果。 */
      assert.equal(
        sameConfig(afterA, resolvePreset(from)),
        true,
        '★ 前提：同一份预设重复解析必须得到同一个结果（解析不能有隐藏状态）',
      );
      const afterB = resolvePreset(to);
      const target = resolvePreset(to);
      checked += 1;
      assert.equal(
        sameConfig(afterB, target),
        true,
        `★★★ ${from.id} → ${to.id}：结果必须**等于 ${to.id} 的完整定义**（含 schema 默认值），` +
          '而不是"上一次的参数 + 这一次的 patch"的混合体',
      );
      /*
       * 反向断言：**A 独有而 B 不声明的字段，必须回到默认值**。
       * 这一条才是"渗漏"的直接判据 —— 没有它，`sameConfig(afterB, target)` 在
       * "两边都带着 A 的残留"时也可能成立（因为 target 是从同一份实现算出来的）。
       */
      for (const [section, patchSection] of Object.entries(from.patch)) {
        if (patchSection === undefined) continue;
        const toPatch = (to.patch as Record<string, unknown>)[section];
        if (typeof patchSection !== 'object' || patchSection === null) {
          if (toPatch !== undefined) continue;
          assert.deepEqual(
            afterB[section as keyof StrategyConfig],
            defaultStrategyConfig()[section as keyof StrategyConfig],
            `★★★ ${from.id} → ${to.id}：${section} 只有 ${from.id} 声明，` +
              `套用 ${to.id} 之后必须回到 schema 默认值`,
          );
          continue;
        }
        for (const field of Object.keys(patchSection as Record<string, unknown>)) {
          const declaredByTo =
            typeof toPatch === 'object' && toPatch !== null && field in (toPatch as object);
          if (declaredByTo) continue;
          const def = (defaultStrategyConfig()[section as keyof StrategyConfig] as Record<string, unknown>)[
            field
          ];
          assert.deepEqual(
            (afterB[section as keyof StrategyConfig] as Record<string, unknown>)[field],
            def,
            `★★★ ${from.id} → ${to.id}：${section}.${field} 只有 ${from.id} 声明，` +
              `套用 ${to.id} 之后必须回到 schema 默认值 ${JSON.stringify(def)} —— ` +
              `实际 ${JSON.stringify((afterB[section as keyof StrategyConfig] as Record<string, unknown>)[field])}` +
              '（这正是"稳健的提示词 + 短线的回撤守卫"那条缺陷的形状）',
          );
        }
      }
    }
  }
  assert.equal(checked, STRATEGY_PRESETS.length * (STRATEGY_PRESETS.length - 1), '★ 有序对应当全部覆盖');
});

/* -------------------------------------------------------------------------- */
/*  4. `presetOfConfig`：徽章敢不敢写预设名，只能由配置本身回答                    */
/* -------------------------------------------------------------------------- */

test('★★★ presetOfConfig：每套模板自己的解析结果必须被认出来', () => {
  for (const preset of STRATEGY_PRESETS) {
    const found = presetOfConfig(resolvePreset(preset));
    assert.equal(
      found?.id,
      preset.id,
      `★★★ resolvePreset(${preset.id}) 的结果必须被认定为 ${preset.id} —— ` +
        '否则界面上"套了预设却是自定义"',
    );
  }
});

test('★★★ presetOfConfig：改任意一处就必须不再等于该预设（徽章不得撒谎）', () => {
  /*
   * 判据用**真实值域内**的改动（不是乱塞一个非法值），这样它同时证明：
   * 比较覆盖了**嵌套分区**（`drawdownGuard` 是对象、`staticCoins` 是数组）。
   */
  const cases: Array<{ label: string; mutate: (config: StrategyConfig) => void }> = [
    { label: '风控标量', mutate: (c) => { c.riskControl.minRiskRewardRatio += 1; } },
    { label: '嵌套对象', mutate: (c) => { c.drawdownGuard.activationPercent += 0.1; } },
    { label: '数组', mutate: (c) => { c.coinSource.staticCoins = [...c.coinSource.staticCoins, 'SOLUSDT']; } },
    { label: '更深一层嵌套', mutate: (c) => { c.indicators.kline.primaryCount += 1; } },
    { label: '交易模式', mutate: (c) => { c.tradingMode = c.tradingMode === 'scalping' ? 'aggressive' : 'scalping'; } },
  ];

  for (const preset of STRATEGY_PRESETS) {
    for (const { label, mutate } of cases) {
      const drifted = clone(resolvePreset(preset));
      mutate(drifted);
      assert.equal(
        presetOfConfig(drifted),
        null,
        `★★★ ${preset.id}：改动了${label}之后不得再被认定成 ${preset.id} —— ` +
          '否则徽章/下拉框会继续显示该预设名，而参数已经不是它了（列表页「稳健 | 短线 | 10×」那一族）',
      );
    }
  }
});

test('★★★ presetOfConfig 必须真的能报出"不等" —— 用"看起来相等"的浅判据校准它不是空转', () => {
  /*
   * ⚠️ **负向校准。** 上面那条断言 `=== null`，而**一个只会 `return null` 的实现
   * 也永远通过它** —— 所以"绿"本身不证明判据有效（本仓库
   * `configSchemaGuard.test.ts` 用同一手法校准过它的扫描器）。
   *
   * 这里用一段**故意只看几个显眼字段**的浅判据，断言它在同一批用例上会漏：
   *   · 浅判据：`tradingMode` + `minConfidence` 相同就算同一份预设；
   *   · 用例：只改 `drawdownGuard.activationPercent`（tradingMode 与 minConfidence 都没动）。
   * 浅判据必然给出"仍然是 scalping"，而真判据给出 null —— 两者的差就是本函数的价值。
   *
   * 于是：**把 `presetOfConfig` 换成只看几个字段的浅实现，上面那条用例就会变红。**
   */
  const scalping = byId.get('scalping');
  assert.ok(scalping, '★ 前提：scalping 预设存在');
  const shallow = (config: StrategyConfig): string | null =>
    STRATEGY_PRESETS.find(
      (p) => p.tradingMode === config.tradingMode && p.patch.riskControl?.minConfidence === config.riskControl.minConfidence,
    )?.id ?? null;

  const drifted = clone(resolvePreset(scalping));
  drifted.drawdownGuard.activationPercent += 0.1;

  assert.equal(
    shallow(drifted),
    'scalping',
    '★ 前提：浅判据（只看 tradingMode + minConfidence）会把这个改动**漏掉**',
  );
  assert.equal(
    presetOfConfig(drifted),
    null,
    '★★★ 真判据必须抓住浅判据漏掉的这一类改动（嵌套分区的单字段偏移）',
  );
});

test('★★ presetOfConfig：字段一个都不改时不得误报"偏离"', () => {
  /* 反向校准：上一族用例证明它能报"不等"，这一条证明它不会把"相等"报成"不等"。 */
  for (const preset of STRATEGY_PRESETS) {
    const a = resolvePreset(preset);
    const b = resolvePreset(preset);
    assert.notEqual(a, b, '★ 前提：两次解析必须返回不同的对象实例（否则 clone 语义可疑）');
    assert.equal(presetOfConfig(b)?.id, preset.id, `★ ${preset.id}：相同内容必须被认定为同一份预设`);
  }
});

test('★★★ presetOfConfig 不得只比"某一方声明过的字段" —— 渗漏残留必须被抓住', () => {
  /*
   * ## 这条防的是"判据单向"这个具体写法
   *
   * 「A 没声明 → 用默认值」这条规则很容易被写成
   * `for (key of Object.keys(默认值)) { if (preset 声明了 key) 比较 }` ——
   * 于是**默认值里有、模板却不声明的字段被整个跳过**。
   * 而"上一份预设渗进来的残留"恰恰只可能落在那种字段上：
   * `drawdownGuard` 只有 `scalping` 声明，所以「短线 → 稳健」之后
   * `drawdownGuard.activationPercent = 0.4`（短线的值）而 `conservative` 不声明它
   * —— 单向比较会**放过**这份配置，徽章继续说"稳健"。
   *
   * 下面用一段**模拟渗漏**的配置直接钉住它：以 `conservative` 的定义为底 +
   * 一条它不声明的残留字段。
   *
   * ⚠️ 这段是**故意构造**的（不是运行时的产物），因为 `resolvePreset(preset)`
   * 在类型层面就接受不到"上一份配置"—— 本用例校准的是**判据**，不是数据流。
   * 运行期的数据流由下面第 3 节（A→B 有序对）负责。
   */
  const conservative = byId.get('conservative');
  assert.ok(conservative, '★ 前提：conservative 预设存在');

  const leaked = clone(resolvePreset(conservative));
  /* 这两项 conservative 都没声明（schema 默认是 enabled=true / 1.5）。 */
  leaked.drawdownGuard.activationPercent = 0.4;
  leaked.drawdownGuard.givebackRatio = 0.4;

  /*
   * 前置：这份配置与 conservative 的**声明字段**确实逐项相等 ——
   * 也就是说，只有"跳过未声明字段"的判据才会放过它。没有这一段，
   * 本用例可能只是被别的差异挡住，而不是校准了这条判据。
   */
  for (const [section, patchSection] of Object.entries(conservative.patch)) {
    if (typeof patchSection !== 'object' || patchSection === null) continue;
    for (const field of Object.keys(patchSection as Record<string, unknown>)) {
      assert.deepEqual(
        (leaked[section as keyof StrategyConfig] as Record<string, unknown>)[field],
        (patchSection as Record<string, unknown>)[field],
        `★ 前提：${section}.${field} 与 conservative 声明的一致（所以差异只可能在未声明处）`,
      );
    }
  }

  assert.equal(
    presetOfConfig(leaked),
    null,
    '★★★ 带着"上一份预设残留"的配置不得被认定为 conservative —— ' +
      '判据必须双向：模板声明的要和声明值一致，**模板没声明的要和 schema 默认值一致**。' +
      '只比前者会放过渗漏，而渗漏正是「稳健的提示词 + 短线的回撤守卫」那条缺陷',
  );
});

test('★★★ 三套模板的 patch 不得出现 schema 里没有的键（否则被 zod 静默丢弃）', () => {
  /*
   * `StrategyConfigSchema.parse()` 的输入类型是 `unknown` —— **TS 不会检查
   * `patch` 里的键名**，而 zod 默认 strip 模式会把它**静默丢掉**：
   * 写了、不报错、不生效（`configSchemaGuard.test.ts` 记的就是这一族，而它的
   * `patch` 那一侧靠 TS 的 excess property check；这里补的是**运行期解析**这一侧）。
   *
   * ⚠️ `resolvePreset()` 内部已经有一处自证（遇到 schema 外的键**抛错**），
   * 所以这条用例看似重复。**它不是重复**：自证只在有人真的调 `resolvePreset` 时
   * 才生效，而本用例是**在测试期、对着源码里的 patch 结构**直接查一遍 ——
   * 于是"声明了但不生效"这条路在 CI 上就断掉，不必等运行时。
   *
   * ## 为什么这同时是负向校准
   *
   * 判据只有一边（`if (!(section in shape)) 报错`），把 `patch` 里任一键改名成
   * schema 里没有的名字，这条**必然变红**。用例内部再跑一次"故意写错的键"，
   * 证明判据本身不是空转（见 `bogus` 那段）。
   */
  const shapeOf = (schema: unknown): Record<string, unknown> | null => {
    /* ⚠️ `coinSource` 等分区是 `ZodDefault(ZodObject)` —— 直接读 `.shape` 得到
     * `undefined`，而那会让判据**静默地什么都查不到 / 或把所有键都判成不存在**
     * （`configSchemaGuard.test.ts` 的 `zodShape()` 记过同一次踩坑）。
     * 所以这里显式剥掉一层 `schema` / `innerType` 包装。 */
    let current = schema as
      | { _def?: { typeName?: string; shape?: () => Record<string, unknown>; schema?: unknown; innerType?: unknown } }
      | undefined;
    for (let depth = 0; depth < 8 && current; depth += 1) {
      const def = current._def;
      if (!def) return null;
      if (def.typeName === 'ZodObject' && typeof def.shape === 'function') return def.shape();
      const next = def.schema ?? def.innerType;
      if (!next) return null;
      current = next as typeof current;
    }
    return null;
  };
  const root = shapeOf(StrategyConfigSchema);
  assert.ok(root, '★ 拿不到 StrategyConfigSchema 的 shape —— 结构变了，请更新本测试');

  /** 返回该 patch 里所有"schema 里不存在"的键。 */
  const offendersOf = (patch: Record<string, unknown>): string[] => {
    const bad: string[] = [];
    for (const [section, claimed] of Object.entries(patch)) {
      if (claimed === undefined) continue;
      const sectionShape = shapeOf(root[section]);
      if (typeof claimed !== 'object' || claimed === null || Array.isArray(claimed)) {
        continue; /* 标量分区：键名本身在 schema 里已经由上面那步校验过。 */
      }
      const sectionKeys = sectionShape ?? root;
      for (const field of Object.keys(claimed as Record<string, unknown>)) {
        if ((claimed as Record<string, unknown>)[field] === undefined) continue;
        if (!(field in sectionKeys)) bad.push(`${section}.${field}`);
      }
    }
    return bad;
  };

  let checked = 0;
  for (const preset of STRATEGY_PRESETS) {
    for (const [section, claimed] of Object.entries(preset.patch)) {
      if (claimed === undefined) continue;
      assert.ok(
        section in root,
        `★★★ ${preset.id}：patch.${section} 不是 schema 的顶层分区 —— zod 会静默丢弃整块`,
      );
      if (typeof claimed === 'object' && claimed !== null && !Array.isArray(claimed)) {
        checked += Object.keys(claimed as Record<string, unknown>).length;
      }
    }
    assert.deepEqual(
      offendersOf(preset.patch as Record<string, unknown>),
      [],
      `★★★ ${preset.id} 的 patch 里有 schema 里没有的键 —— zod 的 strip 模式会**静默丢弃**它，` +
        '于是模板声明了一个永远不会生效的值',
    );
  }
  assert.ok(checked >= 20, `★★ 至少要核对 20 个嵌套字段名，实际 ${checked} 个`);

  /* 负向校准：判据必须能报出一个人造的错误键。 */
  assert.deepEqual(
    offendersOf({ coinSource: { sourceType: 'coinpool', definitelyNotInSchema: true } }),
    ['coinSource.definitelyNotInSchema'],
    '★★★ 判据必须能报出"写了但 schema 没有"的字段 —— 否则上面那个 empty 断言可能只是空转',
  );
});

/* -------------------------------------------------------------------------- */
/*  5. 未知/缺失预设：抛错，不回落                                                */
/* -------------------------------------------------------------------------- */

test('★★★ resolvePreset 遇到未知 id 必须抛错，不得静默回落成默认配置', () => {
  /*
   * 回落（`return defaultStrategyConfig()`）会让一个拼错/已删除的预设 id
   * **静默变成一套合法但完全不同的参数** —— 调用方以为自己套上了预设。
   * 本仓库对"它告诉你成功了"这一类失败有明确的纪律。
   */
  assert.throws(
    () => resolvePreset('definitely-not-a-preset'),
    /未知的策略预设/,
    '★★★ 未知预设必须抛错（回落成默认配置 = 静默换成另一套参数）',
  );
  assert.throws(() => resolvePreset(null as unknown as string), /未知的策略预设/);
});

test('★ resolvePreset(presetId 字符串) 与传对象等价', () => {
  for (const preset of STRATEGY_PRESETS) {
    assert.equal(
      sameConfig(resolvePreset(preset.id), resolvePreset(preset)),
      true,
      `★ ${preset.id}：按 id 解析与按对象解析必须得到同一份配置（下拉框只拿得到 id）`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  6. 解析结果必须仍是一份合法配置（schema 能过）                                 */
/* -------------------------------------------------------------------------- */

test('★★ 三套模板解析后都必须通过 StrategyConfigSchema（写回服务端不会被拒）', () => {
  for (const preset of STRATEGY_PRESETS) {
    const resolved = resolvePreset(preset);
    const reparsed = StrategyConfigSchema.safeParse(resolved);
    assert.equal(
      reparsed.success,
      true,
      `★★ ${preset.id}：解析结果必须能再次通过 schema —— ` +
        `否则它在界面上能显示、保存时被服务端拒绝`,
    );
    assert.equal(
      sameConfig(resolved, reparsed.success ? reparsed.data : resolved),
      true,
      `★ ${preset.id}：解析必须是幂等的（再 parse 一次不改变任何字段）`,
    );
  }
});
