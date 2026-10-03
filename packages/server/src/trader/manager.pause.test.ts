import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../db/index.js';
import { settings } from '../store/repositories.js';
import { TraderManager } from './manager.js';
import { Vault } from '../crypto/vault.js';

/**
 * **AI 主动停手（`pause_trading`）必须能被操作员撤掉。**
 *
 * ## 用户 2026-10-04 的原话
 *
 * > 「**再也不会开新仓？你确定？那这个机器人存在意义是什么？**」
 *
 * 他的质疑是对的，而这条链当时只写了一半：
 *
 *   · 模型能调 `pause_trading` **设上**开关（`ports.requestPause`）；
 *   · 交易循环也**读**它并拦下全部开仓（`autoTrader` 的 `agentPaused` 闸门）；
 *   · 而**清除它的 `clearPause()` 在生产代码里零引用** —— 只有 `ports.test.ts` 调过。
 *
 * 于是开关一旦落下就撤不掉：机器人**永久**停在新仓之外，而操作员在界面上
 * 只看到决策卡不断出现的「开多 / 未执行（已跳过）」，既查不到原因也没有出口。
 *
 * ## ⚠️ 为什么原来的测试**没能**发现它
 *
 * `ports.test.ts` 里那条「暂停是落库的，重启之后仍然生效」**已经断言了
 * "操作员可以恢复"**（它直接调 `clearPause`）—— **而它是绿的**。
 *
 * 因为它测的是**函数**，而缺陷在**从界面到那个函数的整条路**：
 * 函数写对了、没人调用它。**绿测试在这里给出的是一份假的安心。**
 *
 * 所以本文件测的是 `TraderManager` 这一层（API 路由直接转发到它），
 * 而不是再测一遍 `clearPause` 本身。
 *
 * `pausedInfo` / `resumeAgent` 都只访问 `settings`，不需要真的存在一个机器人 ——
 * 停手是**持久状态**，机器人没在跑的时候它同样有意义。
 */

let workDir: string;
const traderId = 4242;
const pausedKey = (id: number): string => `agent_paused:${id}`;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-pause-'));
  initDb(path.join(workDir, 'pause.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

test('★ 停手状态发得出来，而操作员恢复之后它真的消失', () => {
  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));

  /* 模型调 `pause_trading` 之后库里长什么样（`ports.ts` 写的那个 JSON）。 */
  settings.set(pausedKey(traderId), JSON.stringify({ at: new Date().toISOString(), reason: '连续三笔亏损，暂停开新仓' }));

  const before = manager.pausedInfo(traderId);
  assert.ok(before, '★ 停手之后必须能读出状态 —— 否则界面无从显示它，人也不知道为什么不开仓');
  assert.match(before!.reason, /连续三笔亏损/);

  /* 操作员点「恢复开仓」。 */
  manager.resumeAgent(traderId);

  assert.equal(
    manager.pausedInfo(traderId),
    null,
    '★ 恢复之后必须真的清掉 —— 这台机器人要能重新开新仓（否则那个按钮是假的）',
  );
});

test('没停手时恢复是幂等的（不抛错、不产生副作用）', () => {
  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  assert.equal(manager.pausedInfo(traderId), null, '前提：现在没停手');
  manager.resumeAgent(traderId); // 不该抛
  assert.equal(manager.pausedInfo(traderId), null);
});

test('停手状态落在 settings 里，所以"进程重启"不该悄悄把它撤掉', () => {
  /*
   * 反面守卫：恢复只能由**显式调用**发生。
   * 一个"因为亏太多而停手"的决定被一次重启抹掉，是另一种坏法 ——
   * `ports.test.ts` 那条用例守的就是这个方向。
   */
  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  settings.set(pausedKey(traderId), JSON.stringify({ at: new Date().toISOString(), reason: 'x' }));

  /* 换一个 manager 实例（模拟进程重启）。 */
  const afterRestart = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  assert.ok(afterRestart.pausedInfo(traderId), '★ 重启不该撤销停手 —— 它落的是库');

  afterRestart.resumeAgent(traderId);
  assert.equal(manager.pausedInfo(traderId), null, '显式恢复之后才该消失');
});
