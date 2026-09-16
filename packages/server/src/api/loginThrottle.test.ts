/**
 * 登录节流器的回归测试。
 *
 * 为什么存在：登录端点原先**没有任何节流**，而一次口令校验要跑一遍 scrypt。
 * 于是"随机用户名"换来的那点余量，在一次不间断的在线字典攻击里会被耗光。
 *
 * 这里只测纯逻辑（不打网络、不碰数据库），因为节流是**计数与时间**的行为，
 * 用注入的 `now` 就能精确断言锁定曲线，不需要真的等 15 分钟。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FailureThrottle } from './loginThrottle.js';

test('未达阈值不锁定，达到阈值开始锁定', () => {
  const throttle = new FailureThrottle({ threshold: 3, baseLockoutMs: 1_000, maxLockoutMs: 60_000 });

  const t0 = 1_000_000;
  for (let i = 0; i < 2; i += 1) {
    throttle.recordFailure(['user:admin'], t0);
    assert.equal(throttle.check(['user:admin'], t0).allowed, true, `第 ${i + 1} 次失败不该锁定`);
  }

  throttle.recordFailure(['user:admin'], t0);
  const locked = throttle.check(['user:admin'], t0);
  assert.equal(locked.allowed, false, '第 3 次失败后应当锁定');
  assert.equal(locked.retryAfterSeconds, 1);
});

test('锁定时长按失败次数指数增长，并且有上限', () => {
  const lockFor = (failures: number): number => {
    const fresh = new FailureThrottle({ threshold: 1, baseLockoutMs: 1_000, maxLockoutMs: 8_000 });
    for (let i = 0; i < failures; i += 1) fresh.recordFailure(['k'], 1_000_000);
    return fresh.check(['k'], 1_000_000).retryAfterSeconds;
  };

  assert.equal(lockFor(1), 1);
  assert.equal(lockFor(2), 2);
  assert.equal(lockFor(3), 4);
  // 上限：继续翻倍会被封顶，否则攻击者只要多打几次就能把账号锁到天荒地老
  assert.equal(lockFor(10), 8);
  assert.equal(lockFor(50), 8);
});

test('锁定到期后自动放行', () => {
  const throttle = new FailureThrottle({ threshold: 1, baseLockoutMs: 5_000, maxLockoutMs: 5_000 });
  const t0 = 1_000_000;
  throttle.recordFailure(['k'], t0);

  assert.equal(throttle.check(['k'], t0 + 4_999).allowed, false);
  assert.equal(throttle.check(['k'], t0 + 5_000).allowed, true, '锁定到期应当放行');
});

test('一次成功登录立即清除自己那条键', () => {
  const throttle = new FailureThrottle({ threshold: 2, baseLockoutMs: 60_000, maxLockoutMs: 60_000 });
  const t0 = 1_000_000;
  throttle.recordFailure(['user:admin']);
  throttle.recordSuccess(['user:admin']);
  throttle.recordFailure(['user:admin'], t0);

  // 成功之后计数归零：这一次失败只是"第 1 次"，不该触发锁定
  assert.equal(throttle.check(['user:admin'], t0).allowed, true);
  assert.equal(throttle.trackedKeys, 1);
});

test('两个维度各自独立：用户名被锁不影响其他用户名', () => {
  const throttle = new FailureThrottle({ threshold: 1, baseLockoutMs: 60_000, maxLockoutMs: 60_000 });
  throttle.recordFailure(['user:victim']);

  assert.equal(throttle.check(['user:victim']).allowed, false);
  assert.equal(throttle.check(['user:other']).allowed, true);
});

test('一次请求的多个键中任意一个被锁就整体拒绝', () => {
  const throttle = new FailureThrottle({ threshold: 1, baseLockoutMs: 60_000, maxLockoutMs: 60_000 });
  throttle.recordFailure(['sock:203.0.113.9']);

  // 攻击者伪造 X-Forwarded-For 换掉 `ip:` 键，但 TCP 对端地址换不掉
  const verdict = throttle.check(['ip:198.51.100.7', 'sock:203.0.113.9']);
  assert.equal(verdict.allowed, false);
});

test('跟踪的键数量有上限 —— 节流器自己不能变成内存耗尽路径', () => {
  // 攻击者用随机用户名刷登录：每个不存在的用户名都会新建一条记录。
  // 没有上限的 Map 就是一条 DoS 路径，比它要防的爆破更廉价。
  const throttle = new FailureThrottle({ threshold: 100, maxKeys: 16, windowMs: 60_000 });

  for (let i = 0; i < 500; i += 1) {
    throttle.recordFailure([`user:spray-${i}`], 1_000_000);
  }

  assert.ok(
    throttle.trackedKeys <= 16,
    `跟踪键数应当被限制在 16 以内，实际 ${throttle.trackedKeys}`,
  );
});

test('过期的失败记录会被清掉，不占内存也不误伤', () => {
  const throttle = new FailureThrottle({
    threshold: 2,
    baseLockoutMs: 1_000,
    maxLockoutMs: 1_000,
    windowMs: 10_000,
  });
  const t0 = 1_000_000;
  throttle.recordFailure(['user:admin'], t0);

  // 窗口之外的失败不再计入：这一次是新窗口的"第 1 次"
  throttle.recordFailure(['user:admin'], t0 + 20_000);
  assert.equal(throttle.check(['user:admin'], t0 + 20_000).allowed, true);
});
