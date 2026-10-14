/**
 * **models.dev 必须真的接线生效**（2026-10-14）
 *
 * ## 为什么要单独钉这一条
 *
 * 子代理把 `modelsDev.ts`（1160 行）+ 测试（1450 行）写完了，
 * **但接线点不在它的改动范围里** —— 它明确报告：
 * > 「`ModelsDevStore` 尚未接进 `magpieGateway.ts`……接一行即可，但这一步我没做」
 *
 * 那正是本项目反复强调的那类缺口：
 * ```
 *   typecheck 过 · 测试全绿 · 界面上不报错 —— 只是【永远不会被调用】
 * ```
 * `roles.ts:405` 记录过一模一样的 `engineer` 角色（prompt 写好了、档位有了、
 * 生产零调用），结局是被删除。**所以接线必须有测试钉住。**
 *
 * ## 接线链（三处，缺一不可）
 *
 * ```
 *   ① magpieGateway.discoverFromGateway 收 modelsDev 参数并转给 buildCatalog
 *   ② manager 装配时传 modelsDevLookup()
 *   ③ manager 有那个进程级单例（load 同步 + startRefreshLoop 后台刷新）
 * ```
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../testUtils/sourceText.js';

const GATEWAY = readFileSync(new URL('./magpieGateway.ts', import.meta.url), 'utf8');
const MANAGER = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');
const GATEWAY_CODE = codeOnly(GATEWAY);
const MANAGER_CODE = codeOnly(MANAGER);

test('★★★ ① 网关必须把 models.dev 转给 buildCatalog（第 4 个参数）', () => {
  assert.ok(
    /modelsDev\?: ModelsDevLookup \| null/.test(GATEWAY_CODE),
    '★ discoverFromGateway 必须收这个参数',
  );
  assert.ok(
    /buildCatalog\(payload, gateway\.pluginProvidersPath \?\? null, null, options\.modelsDev \?\? null\)/.test(
      GATEWAY_CODE,
    ),
    '★ 必须真的把它传给 buildCatalog —— 收到但不用等于没接',
  );
});

test('★★★ ② 装配时必须传 modelsDevLookup()', () => {
  assert.ok(
    /modelsDev: modelsDevLookup\(\)/.test(MANAGER_CODE),
    '★ manager 装配时必须以 modelsDev 传进去',
  );
});

test('★★★ ③ 必须存在进程级单例（含同步 load 与后台刷新）', () => {
  assert.ok(
    /let modelsDevStoreSingleton: ModelsDevStore \| null = null;/.test(MANAGER_CODE),
    '★ 必须是模块级单例 —— 每个机器人存一份 5.6MB 快照纯属浪费',
  );
  assert.ok(
    /function modelsDevLookup\(\): ModelsDevLookup \| null/.test(MANAGER_CODE),
    '★ 必须有那个懒加载入口',
  );
  assert.ok(
    /const index = store\.load\(\);/.test(MANAGER_CODE),
    '★ 启动时【同步】读本地快照（不联网）—— 启动路径不能等网络',
  );
  assert.ok(
    /store\.startRefreshLoop\(\);/.test(MANAGER_CODE),
    '★ 必须挂上后台刷新循环（否则快照永远不会更新）',
  );
});

test('★★★ 快照不存在时不能抛错（读不到事实不该让功能停下来）', () => {
  /*
   * ⚠️ 与 `pluginProvidersPath` 读不到时退化为 `free: 'unknown'` 同源。
   * 装配路径上抛错 = 机器人起不来，那比"这次不补参数"糟得多。
   */
  assert.ok(
    /if \(index === null\) \{[\s\S]{0,400}?将在后台首次拉取/.test(MANAGER_CODE),
    '★ 快照不存在时只记日志、继续走',
  );
  assert.ok(
    /return modelsDevStoreSingleton\.lookup\(\);/.test(MANAGER_CODE),
    '★ 无论有没有快照都要返回 lookup（它内部对 null 索引返回 null）',
  );
});

test('★★ 数据目录必须来自 env（不能硬编码路径）', () => {
  assert.ok(
    /new ModelsDevStore\(\{ dataDir: env\.dataDir \}\)/.test(MANAGER_CODE),
    '★ 用 env.dataDir —— 硬编码路径会在部署环境里写错地方',
  );
});
