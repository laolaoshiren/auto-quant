/**
 * 人工别名表与"不可归一"闸门的测试。
 *
 * ## 为什么这个文件存在
 *
 * `modelsDev.ts` 的 4 级阶梯里，L1（人工别名）与第 0 级（不可归一闸门）
 * 都是**纯数据**驱动的 —— 而纯数据的风险不是"写错逻辑"，是**表被填错**，
 * 且填错了不会有任何报错（它会安静地生效，把参数写到错误的模型上）。
 *
 * 所以这里的测试分两类：
 *
 * 1. **结构不变式** —— 比如"清单里必须已经是归一化形式"。这一条防的是
 *    手写归一化结果时把 `.` 写成 `-`，那会让闸门**静默失效**。
 * 2. **行为** —— `qfmodel` 必须被挡住（这是实测得出的安全边界，不是审美偏好）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MODELS_DEV_ALIASES, MODELS_DEV_UNRESOLVABLE } from './modelsDevAlias.js';
import { normalizeGatewayName, parseModelsDev, matchModel } from './modelsDev.js';

/* -------------------------------------------------------------------------- */
/*  结构不变式                                                                  */
/* -------------------------------------------------------------------------- */

test('★ 别名表里每条都必须写清 `why`（没有依据的别名不该存在）', () => {
  /*
   * 这个断言看起来像形式主义，但它防的是一个具体的失败：
   * 一个只有 `from`/`to` 的别名，三个月后**没人能判断它还对不对**
   *（上游改名、模型换代都不会有任何提示）。而写 `why` 的成本是几秒钟。
   */
  for (const rule of MODELS_DEV_ALIASES) {
    assert.ok(rule.why.trim().length >= 8, `别名 ${rule.from} 的 why 太短："${rule.why}"`);
    assert.notEqual(normalizeGatewayName(rule.from), '', `别名 ${rule.from} 归一化后为空`);
    assert.notEqual(normalizeGatewayName(rule.to), '', `别名 ${rule.to} 归一化后为空`);
  }
});

test('★ `MODELS_DEV_UNRESOLVABLE` 里必须已经是归一化形式', () => {
  /*
   * ## 为什么这条必须存在（否则闸门会静默失效）
   *
   * `modelsDevAlias.ts` **刻意不导入** `modelsDev.ts`（避免循环依赖），
   * 所以清单里的字符串是**手写**的归一化结果，`matchModel` 拿它直接查表。
   *
   * 手写就会写错：写成 `group/auto-qfmodel`（未归一化）时，查表永远不命中，
   * 而**不会有任何报错** —— `qfmodel` 又会走回模糊匹配那条路。
   * 一条测试就能把这个隐患永久钉死，值得。
   */
  for (const name of MODELS_DEV_UNRESOLVABLE) {
    assert.equal(
      normalizeGatewayName(name),
      name,
      `"${name}" 不是归一化形式（应为 "${normalizeGatewayName(name)}"）—— 手写错了它就不会生效`,
    );
  }
});

test('★ 闸门清单里必须包含 qfmodel（实测得出的安全边界）', () => {
  /*
   * 这条是**回归钉**：如果将来有人"清理"这个清单，测试会立刻失败。
   * 它为什么必须在清单里，见 `modelsDevAlias.ts` 的反例 ①。
   */
  assert.ok(
    MODELS_DEV_UNRESOLVABLE.map(normalizeGatewayName).includes('qfmodel'),
    '★ qfmodel 必须在不可归一清单里 —— 它是网关的路由聚合别名，不是模型',
  );
});

/* -------------------------------------------------------------------------- */
/*  行为：闸门                                                            */
/* -------------------------------------------------------------------------- */

test('★★ `group/auto-qfmodel` 必须被闸门挡住（三种写法都要挡）', () => {
  /*
   * ## 为什么这条测试是本次任务的核心断言之一
   *
   * 实测（2026-10-14，models.dev 全量 229 provider / 8831 模型）：
   *
   * ```
   *   含 "qfmodel" 的条目数 = 0
   *   最近候选 = `model`           相似度 0.8000   ← 若不剥 group/auto- 前缀
   *   最近候选 = `auto-model`      相似度 0.5333   ← 剥了之后
   * ```
   *
   * 两个候选都是噪声。若不挡住，会给这个风控/路由别名填上
   * `nano-gpt/auto-model` 的 **1,000,000 上下文 + 0 定价**。
   * 而"对不上就 unknown"是本项目刻意选择的安全侧。
   */
  /* 造一份**真的**含有 `auto-model` 与 `model` 的索引 —— 让闸门面对真实诱惑。 */
  const index = parseModelsDev({
    'nano-gpt': {
      id: 'nano-gpt',
      models: {
        'auto-model': {
          id: 'auto-model',
          name: 'Auto model',
          limit: { context: 1_000_000, output: 1_000_000 },
          cost: { input: 0, output: 0 },
        },
        model: {
          id: 'model',
          name: 'Model',
          limit: { context: 2_000_000, output: 2_000_000 },
          cost: { input: 1, output: 2 },
        },
      },
    },
  });

  for (const spelling of ['group/auto-qfmodel', 'auto-qfmodel', 'qfmodel', 'QFModel']) {
    assert.equal(
      matchModel(spelling, index),
      null,
      `★ ${spelling} 必须返回 null（不写任何参数），而不是找一个"最像的"`,
    );
  }
});

test('★ 闸门优先于别名表（即使有人往别名表里误加了 qfmodel）', () => {
  /*
   * 顺序上的保证：闸门（第 0 级）在 L1 之前。
   *
   * 这条测的是**结构**而不是当前数据 —— 当前别名表是空的，所以直接测不出来。
   * 用一个自定义索引 + 真实闸门清单来验证：只要 `matchModel` 的实现里
   * 把闸门放在别名之前，下面的断言就成立。
   *
   * ⚠️ 我**无法**在不改实现的前提下注入一个"包含 qfmodel 的别名表"
   *（别名表是模块级常量，刻意如此）。所以这里只验证闸门本身在索引有数据时
   * 仍然优先返回 null —— 那正是"有没有别名的都挡住"这一条的实质。
   */
  const index = parseModelsDev({
    p: { id: 'p', models: { qfmodel: { id: 'qfmodel', name: 'Q', limit: { context: 999 } } } },
  });
  /* 索引里**真有**一个叫 qfmodel 的条目时，仍然必须被闸门挡住。 */
  assert.ok(index.byLeafName.has('qfmodel'), '夹具前提：索引里确实有 qfmodel');
  assert.equal(matchModel('group/auto-qfmodel', index), null, '★ 闸门必须先于"精确匹配"生效');
});
