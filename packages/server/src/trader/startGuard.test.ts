import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGuard } from './manager.js';

/**
 * 启动守卫。
 *
 * ## 这个文件为什么存在
 *
 * `manager.ts` 有一千六百多行、管着启动 / 停止 / 开机恢复，却**一行行为测试都没有**
 * （测试里只有 `import type`）—— 因为启动路径会真读库、真连交易所，夹具成本很高。
 * 于是**最该被覆盖的那几条守卫一条都没被覆盖**，而它们各自都对应一次真实事故：
 *
 *   · **全局熔断**：原来只装在 `/start` 与 `/run-once` 两个路由上，**开机恢复没有看它** ——
 *     操作员设了 `GLOBAL_TRADING_DISABLED=true` 并重启（env 只能靠重启改），
 *     原本 running 的机器人**照样用 `dryRun=false` 恢复实盘交易**，
 *     而启动日志还写着「任何机器人都无法启动」—— 一句**事实错误**的话。
 *   · **重复启动**：同一台机器人被启动两次会走两条完整流程（重复对账、重复下单）。
 *
 * 把判定抠成纯函数（项目 §5.4：导出的纯函数优先于需要打桩的对象）之后，三条分支都能钉住。
 * 这里断言的是**行为契约**，所以文案改动会让它红 —— 那是有意的。
 */
const base = {
  traderId: 9,
  globalTradingDisabled: false,
  traderExists: true,
  running: false,
  starting: false,
};

test('★ 全局熔断优先于一切 —— 别的条件再怎么变都不能改变这个结论', () => {
  /*
   * 顺序本身就是要守的东西：熔断是"这台机器不该有任何动作"。
   * 如果它被排在"机器人不存在"之后，那么一个 id 写错的情况下
   * 操作员看到的会是"找不到机器人"，而不是"全局熔断已生效"——
   * 后者才是他真正需要知道的事。
   */
  for (const extra of [
    { traderExists: false },
    { running: true },
    { starting: true },
    { traderExists: false, running: true },
  ]) {
    const verdict = startGuard({ ...base, globalTradingDisabled: true, ...extra });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.match(
        verdict.error,
        /GLOBAL_TRADING_DISABLED/,
        `熔断必须排在最前（extra=${JSON.stringify(extra)}）`,
      );
    }
  }
});

test('★ 机器人不存在 / 正在启动 / 已在运行 —— 三种拒绝各自说清是哪一种', () => {
  const missing = startGuard({ ...base, traderExists: false });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /找不到机器人 9/);

  const starting = startGuard({ ...base, starting: true });
  assert.equal(starting.ok, false);
  if (!starting.ok) assert.equal(starting.error, '该机器人正在启动中');

  const running = startGuard({ ...base, running: true });
  assert.equal(running.ok, false);
  if (!running.ok) assert.equal(running.error, '该机器人已经在运行中');

  /*
   * `running` 与 `starting` 同时为真时，"正在启动中"优先 ——
   * 那正是并发 start 的窗口，说"正在启动"比说"已经在运行"准确。
   */
  const both = startGuard({ ...base, running: true, starting: true });
  assert.equal(both.ok, false);
  if (!both.ok) assert.equal(both.error, '该机器人正在启动中');
});

test('★ 三道守卫都通过才允许启动', () => {
  assert.deepEqual(startGuard(base), { ok: true });
});
