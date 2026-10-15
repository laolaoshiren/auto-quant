/**
 * **模型档案的编排层必须守住三条**（2026-10-15）
 *
 * ## 为什么单独一条（这是我写文档时发现的真实缺口）
 *
 * `modelsDev.test.ts` 有 43 条，覆盖了 `ModelsDevStore` 内部（解析、cost 键名、
 * `limit` 嵌套、重启后装载）。但**"谁在什么时候调它"**那一层没有测试 ——
 * 也就是 `manager.ts` 的 `modelsDevLookup()`：
 * ```
 *   · 首次调用时同步装载本地快照
 *   · 快照不存在时【不同步拉网络】（那是启动路径，会拖慢机器人启动）
 *   · 挂上后台刷新循环（它会在后台拉第一次）
 * ```
 * 而这三条**每一条都有明确的理由**（见那个函数的注释），且每一条坏掉都会
 * 表现为"看起来正常、实际参数没补上"——正是本仓库最怕的那种失败。
 *
 * ⚠️ 我写 `docs/MODEL-CATALOG-UPDATE.md` 时第一版说"inferTier 没有守卫测试"，
 * 实测它**有 26 条**。**没查就下结论** —— 所以这一条是查过之后补的**真缺口**。
 *
 * ## 判据（三条，都从源码反查，不靠"看起来对"）
 * ```
 *   ① 首次调用时必须有 store.load()（否则永远不装载）
 *   ② 装载失败/不存在时【不能】同步拉网络 —— 判据：那一段里不出现 await fetch
 *      且必须有 startRefreshLoop()（否则永远不会拉）
 *   ③ 单例（不能每次调用都 new —— 那会每次挂一个新刷新循环）
 * ```
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../testUtils/sourceText.js';

const MANAGER = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');

/** 取 `modelsDevLookup()` 的函数体。 */
function lookupBody(): string {
  const code = codeOnly(MANAGER);
  const at = code.indexOf('function modelsDevLookup');
  assert.ok(at > 0, '★ 找不到 modelsDevLookup');
  /* 到下一个顶格 `}` 为止（不数字符窗口 —— 那个写法我踩过坑）。 */
  const rest = code.slice(at);
  const end = rest.indexOf('\n}');
  assert.ok(end > 0, '★ 找不到函数结尾');
  return rest.slice(0, end);
}

test('★★★ 模型档案：首次调用必须装载本地快照', () => {
  const body = lookupBody();
  assert.ok(
    /\.load\(\)/.test(body),
    '★ 必须调 store.load() —— 否则快照永远不会被装载（参数永远补不上）',
  );
});

test('★★★ 模型档案：装载那一步【不能】同步拉网络（那是启动路径）', () => {
  const body = lookupBody();
  /*
   * 判据：函数体里不出现 `await` —— 它是同步函数。
   * ⚠️ 这是**有意为之**：启动路径上同步拉网络会拖慢机器人启动
   *（注释原话：「不在这里同步拉网络 —— 那是启动路径」）。
   */
  assert.ok(
    !/\bawait\b/.test(body),
    '★ `modelsDevLookup` 必须是同步的 —— 它跑在启动路径上，同步拉网络会拖慢启动',
  );
  assert.ok(
    !/fetch\(/.test(body),
    '★ 函数体里不该出现 fetch —— 拉网络交给后台刷新循环',
  );
});

test('★★★ 模型档案：必须挂上后台刷新循环（否则永远不拉第一次）', () => {
  const body = lookupBody();
  assert.ok(
    /startRefreshLoop\(\)/.test(body),
    '★ 必须调 startRefreshLoop() —— 它是"后台首次拉取"的唯一入口。\n' +
      '   漏了它：快照不存在时既不装载也不拉，参数【永远】补不上，而日志只有一句"将在后台首次拉取"。',
  );
});

test('★★★ 模型档案：store 必须是进程级单例（不能每次 new）', () => {
  const body = lookupBody();
  /*
   * 判据：`new ModelsDevStore` 必须被 `if (… === null)` 包住。
   * 若每次都 new，每装配一次就多一个刷新循环 —— 而症状是"网络请求越来越多"。
   */
  assert.ok(
    /if\s*\(\s*modelsDevStoreSingleton\s*===\s*null\s*\)/.test(body),
    '★ `new ModelsDevStore` 必须在单例判据里 —— 否则每次调用都挂一个新刷新循环',
  );
  assert.ok(
    /modelsDevStoreSingleton\s*=/.test(body),
    '★ 必须把新建的 store 存回单例变量',
  );
});

test('★★★ 装载失败必须留日志（不能静默）', () => {
  const body = lookupBody();
  /*
   * 快照不存在是**正常情况**（首次部署），但必须留痕 ——
   * 否则"参数一直没补上"这件事在日志里完全不可见。
   */
  assert.ok(
    /log\.info\(/.test(body),
    '★ 装载成功与失败都要有日志 —— 否则"参数没补上"在日志里看不见',
  );
});
