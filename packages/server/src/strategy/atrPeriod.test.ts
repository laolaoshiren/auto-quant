/**
 * **ATR 的周期号不能写死 `'14'`**（外部 issue #179）。
 *
 * ## 缺陷形状
 *
 * `atr` 的键来自 `config.atrPeriods`（`market/indicators.ts` 用
 * `atrSeries[String(period)]` 构造），而该字段：
 *
 * - 默认 `[14]`（`shared/strategy.ts:140`）
 * - **界面上可改**（`StrategyFields.tsx`）
 * - **AI 可调**
 *
 * 但三处取值写死了 `'14'`：
 *
 * ```
 * prompt.ts:2816       c.primary?.atr?.['14']       ← 连续观望提醒的 ATR 统计
 * prompt.ts:4324       snap?.primary?.atr?.['14']   ← 挂单时限估算
 * autoTrader.ts:4754   snap?.primary?.atr?.['14']   ← 真实撤单时限
 * ```
 *
 * 一旦配置里不含 14（例如用户/AI 把它改成 `[7]`）：
 *
 * 1. **提示词里那整块统计/估算无声消失** —— 没有 else、没有 fallback、没有告警；
 * 2. `autoTrader.ts` 那处同样落空 → 时限退回固定值 →
 *    **"自适应时限"静默退化成固定值**（那是能力降级，不只是少显示一行字）。
 *
 * ## 修法（两个方向组合，与 issue 里的建议一致）
 *
 * - **A**：优先取 `atrPeriods` 里**实际存在的**第一个周期；
 * - **B**：一个都取不到时**显式说明**，而不是让整块消失。
 *
 * ## 为什么抽成纯函数
 *
 * 三处取值 + 三处不同的消费逻辑，如果各写一遍"怎么挑周期"，
 * 将来必然出现"改了两处、漏了一处"（本仓库反复吃过这个亏）。
 * 所以挑周期这件事**只有一份实现**，三处共用。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { pickAtrSeries } from './atrPeriod.js';

/** 造一个 `atr: Record<string, number[]>` 形状。 */
function series(keys: string[], value = 1): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const k of keys) out[k] = [value];
  return out;
}

test('★★★ 配置里第一个周期存在时就用它 —— 不能写死 14', () => {
  const atr = series(['7', '14']);

  /* 配置是 `[7]`：必须用 7，而不是去要那个不存在的 14。 */
  const picked = pickAtrSeries(atr, [7]);
  assert.deepEqual(picked.values, [1], '★ 必须取到 7 的序列');
  assert.equal(picked.period, 7, '★ 报出实际用的周期号（调用方要能说清口径）');
});

test('★★★ 配置里第一个不存在、第二个存在时用第二个', () => {
  /* 配置 `[3, 14]` 而只算了 14 —— 不该整块消失，应当用 14。 */
  const atr = series(['14']);
  const picked = pickAtrSeries(atr, [3, 14]);
  assert.deepEqual(picked.values, [1]);
  assert.equal(picked.period, 14);
});

test('★★★ 一个都取不到时返回 null，并报出"配置要了哪些"', () => {
  /*
   * 这是 issue 里的方向 B：**显式说明**而不是静默跳过。
   * 返回 `null` 让调用方自己决定怎么说明（提示词里加一行、或日志里留一条），
   * 而 `requested` 让那句话能说清"配置要的是哪些周期"。
   */
  const atr = series(['14']);
  const picked = pickAtrSeries(atr, [7, 21]);
  assert.equal(picked.values, null, '★ 取不到就是 null，不能返回空数组（那会被当成"ATR 是空的"）');
  assert.deepEqual(picked.requested, [7, 21], '★ 要能说出配置里要的是哪些周期');
});

test('★★ 配置为空数组时同样返回 null —— 不猜一个默认值', () => {
  /*
   * ⚠️ **不 fallback 到 14**：配置是空的说明"没有要求任何 ATR"，
   * 猜一个 14 会让调用方以为有数据、而那个数据不是配置要的。
   * 这与 `atrPeriods: []` 的语义一致（schema 允许空数组）。
   */
  const atr = series(['14']);
  const picked = pickAtrSeries(atr, []);
  assert.equal(picked.values, null, '★ 配置为空 → null，不猜默认值');
  assert.deepEqual(picked.requested, []);
});

test('★★ 14 在配置里时行为与修复前一致 —— 反向守卫', () => {
  /*
   * 默认配置是 `[14]`，所以**绝大多数部署的行为必须一字不变**。
   */
  const atr = series(['14'], 42);
  const picked = pickAtrSeries(atr, [14]);
  assert.deepEqual(picked.values, [42], '★ 默认配置下取到的就是 14 的序列');
  assert.equal(picked.period, 14);
});

test('★ atr 记录为空对象时返回 null —— 不能抛', () => {
  assert.equal(pickAtrSeries({}, [14]).values, null);
  assert.equal(pickAtrSeries(undefined, [14]).values, null, 'undefined 也要安全');
});

test('★ 非整数 / 重复的配置项不会导致取错 —— 按 String(period) 精确匹配', () => {
  const atr = series(['14']);
  /* 配置里混入一个不存在的 7.5，不能因此取到别的东西。 */
  const picked = pickAtrSeries(atr, [7.5, 14]);
  assert.equal(picked.period, 14, '★ 7.5 不存在 → 继续找，取到 14');
  /* 重复项不影响结果。 */
  assert.equal(pickAtrSeries(atr, [14, 14]).period, 14);
});

/* -------------------------------------------------------------------------- */
/*  ★★★ 接线：三处调用点必须真的调用它（变异测试发现的盲区）                      */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ **这个文件上面所有用例都只测 `pickAtrSeries` 这个纯函数本身。**
 *
 * 我是用变异测试发现的：把 `autoTrader.ts` 里那处**回退成原来的写死写法**
 *
 * ```ts
 * const atrSeries = snap?.primary?.atr?.['14'];   // ← issue #179 的原始形状
 * ```
 *
 * —— 也就是**把修复完全回退**（真实撤单时限又只认周期 14）——
 * `autoTrader.test.ts` + `atrPeriod.test.ts` **119 条全部通过**。
 *
 * ⚠️ 这与 #182 是**完全同型**的盲区：**纯函数测了，接线没测**。
 * 而 #179 的缺陷形状恰恰就是"可配置的东西被代码当成常量" ——
 * 所以"接线"正是它唯一会失效的地方。
 *
 * ## 三处调用点（issue #179 修复时改的）
 *
 * | 位置 | 用途 |
 * | --- | --- |
 * | `trader/autoTrader.ts` | **真实撤单时限**（自适应时限的 ATR）|
 * | `strategy/prompt.ts`（连续观望提醒）| 提示词里的 ATR 统计 |
 * | `strategy/prompt.ts`（挂单时限估算）| 提示词里的时限估算 |
 *
 * ## 为什么用结构断言
 *
 * 三处都要真实模型客户端 / 交易所 / 完整提示词上下文才能驱动，
 * 而这里要验的只是"**调用点在不在、传的是不是配置**"。读源码足够 ——
 * 与 `fetchGuardedWiring.test.ts`、`openInterestGate.test.ts` 是同一手法：
 * **接线用结构断言、逻辑用功能测试。**
 *
 * ⚠️ 断言前**剥掉注释**（本仓库注释会逐字引用被讨论的代码，包括那个写死的 `['14']`）。
 */
test('★★★ 三处调用点都必须用 pickAtrSeries，且传入配置的 atrPeriods —— 不能写死 14', () => {
  const files: Array<[string, string]> = [
    ['trader/autoTrader.ts', readFileSync(new URL('../trader/autoTrader.ts', import.meta.url), 'utf8')],
    ['strategy/prompt.ts', readFileSync(new URL('./prompt.ts', import.meta.url), 'utf8')],
  ];

  for (const [label, source] of files) {
    const code = source
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      })
      .join('\n');

    /* ① 必须有调用（不只是 import）。 */
    const calls = [...code.matchAll(/pickAtrSeries\(/g)];
    assert.ok(
      calls.length >= 1,
      `★★★ \`${label}\` 里没有任何 \`pickAtrSeries(...)\` 的**调用** ——\n` +
        '    那是 issue #179 修复的核心：ATR 周期必须从配置挑，不能写死 14。\n' +
        '    ⚠️ 这个回退**不会**让 `atrPeriod.test.ts` 变红（它只测纯函数），必须由这条守着。',
    );

    /* ② 调用时必须把配置里的周期列表传进去 —— 传 `[14]` 等于又写死了。 */
    for (const call of calls) {
      const open = code.indexOf('(', call.index);
      let depth = 0;
      let end = open;
      for (let i = open; i < code.length; i += 1) {
        const ch = code[i]!;
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const args = code.slice(open, end + 1);
      assert.match(
        args,
        /atrPeriods/,
        `★★ ${label}：调用 \`pickAtrSeries\` 时没有传 \`atrPeriods\` ——\n` +
          '    传一个写死的数组等于把"可配置"又变成常量（#179 的原始形状）。\n' +
          `    实际实参：${args.replace(/\s+/g, ' ').slice(0, 100)}`,
      );
    }

    /* ③ 反向：不得残留写死的 `atr?.['14']` 取法。 */
    assert.doesNotMatch(
      code,
      /\.atr\?\.\['14'\]/,
      `★★★ ${label} 里还残留写死的 \`atr?.['14']\` —— 那正是 #179 的原始形状`,
    );
  }

  /* 前置断言：确认两个文件都真的读到了（否则"零个问题"是因为没扫到东西）。 */
  assert.ok(files[0]![1].length > 1000 && files[1]![1].length > 1000, '★ 源码语料没读到');
});
