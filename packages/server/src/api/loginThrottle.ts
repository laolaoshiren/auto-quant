/**
 * 登录失败的节流器（in-memory）。
 *
 * 为什么需要它：`POST /api/auth/login` 在补上这个之前**没有任何节流**，
 * 而校验一次口令要跑一遍 scrypt（约几十毫秒）。于是任何人都可以对一个已知用户名
 * 持续在线爆破密码，唯一的成本是网络往返；对单人部署来说，这等于把「随机用户名」
 * 换来的那点余量在一次不间断的字典攻击里耗光。
 *
 * 为什么是内存实现而不是 Redis：这个系统是**单人自用部署**，进程只有一个，
 * 重启后计数清零是可接受的（重启本身通常意味着操作员在场）。
 * 引入 Redis 会给「npm install 无编译步骤」这个刻意的取舍开一个口子。
 *
 * 为什么必须**限制键的数量**：被节流的键包括「不存在的用户名」——
 * 攻击者用随机用户名刷接口时，每个用户名都会新建一条记录。
 * 一个没有上限的 Map 本身就是一条内存耗尽路径（DoS），
 * 也就是说：没有上限的节流器会变成它要防的那个洞。
 * 因此这里是 LRU + 过期清理的双重上限。
 */

/** 同一把键在窗口内允许的最大失败次数，超过后开始锁定。 */
export interface ThrottleOptions {
  /** 允许的失败次数上限；达到这个数才开始锁定，给手误留出余量。 */
  threshold: number;
  /** 第一次超限时的锁定时长，之后每多失败一次翻倍。 */
  baseLockoutMs: number;
  /** 锁定时长上限，避免一次攻击把账号锁到天荒地老。 */
  maxLockoutMs: number;
  /** 超过这个时间没有新的失败，历史失败就不再计入。 */
  windowMs: number;
  /** 同时跟踪的键数量上限（内存上界）。 */
  maxKeys: number;
}

const DEFAULTS: ThrottleOptions = {
  threshold: 5,
  baseLockoutMs: 1_000,
  maxLockoutMs: 15 * 60_000,
  windowMs: 30 * 60_000,
  maxKeys: 2_048,
};

export interface ThrottleVerdict {
  allowed: boolean;
  /** 建议的 `Retry-After`（秒）。`allowed` 为真时为 0。 */
  retryAfterSeconds: number;
}

interface Entry {
  failures: number;
  windowStartedAt: number;
  lockedUntil: number;
}

export class FailureThrottle {
  private readonly options: ThrottleOptions;
  /**
   * 插入顺序即 LRU 顺序：每次写入都先 delete 再 set，把该键移到队尾。
   * 淘汰时从队首（最久未使用）开始，这是 Map 自带的唯一"免费"排序。
   */
  private readonly entries = new Map<string, Entry>();

  constructor(options: Partial<ThrottleOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** 当前跟踪的键数量。测试用它断言内存上界。 */
  get trackedKeys(): number {
    return this.entries.size;
  }

  /**
   * 任一键处于锁定中就不放行。
   *
   * 传入多个键是为了同时按**用户名**与**来源 IP** 两个维度判定：
   * 只按 IP 限，攻击者换 IP 即可；只按用户名限，攻击者换用户名刷不存在的账号即可
   * （并且能顺带探测哪些用户名存在）。两个维度都记，见 `recordFailure`。
   */
  check(keys: readonly string[], now = Date.now()): ThrottleVerdict {
    let worst = 0;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      if (now - entry.windowStartedAt > this.options.windowMs && entry.lockedUntil <= now) {
        this.entries.delete(key);
        continue;
      }
      if (entry.lockedUntil > now) {
        worst = Math.max(worst, Math.ceil((entry.lockedUntil - now) / 1000));
      }
    }
    return worst > 0 ? { allowed: false, retryAfterSeconds: worst } : { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailure(keys: readonly string[], now = Date.now()): void {
    for (const key of keys) {
      const entry = this.entries.get(key) ?? { failures: 0, windowStartedAt: now, lockedUntil: 0 };
      if (now - entry.windowStartedAt > this.options.windowMs) {
        entry.failures = 0;
        entry.windowStartedAt = now;
        entry.lockedUntil = 0;
      }
      entry.failures += 1;
      if (entry.failures >= this.options.threshold) {
        const step = entry.failures - this.options.threshold;
        entry.lockedUntil = now + Math.min(this.options.maxLockoutMs, this.options.baseLockoutMs * 2 ** step);
      }
      this.touch(key, entry);
    }
    this.evict();
  }

  /** 一次成功的登录说明这就是所有者，立即解除自己的锁定。 */
  recordSuccess(keys: readonly string[]): void {
    for (const key of keys) this.entries.delete(key);
  }

  private touch(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evict(): void {
    if (this.entries.size <= this.options.maxKeys) return;

    // 先清掉已经过期（窗口结束且不在锁定中）的条目，它们本来就该被忘掉。
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.options.maxKeys) break;
      if (now - entry.windowStartedAt > this.options.windowMs && entry.lockedUntil <= now) {
        this.entries.delete(key);
      }
    }
    // 仍然超限说明是活跃攻击：按 LRU 淘汰最久未使用的键。
    // 被淘汰的键会重新获得尝试次数——这是刻意的取舍：宁可让攻击者承担"滚动淘汰"的
    // 不确定性，也不能让它用一个随机用户名表把进程的内存吃光。
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.options.maxKeys) break;
      this.entries.delete(key);
    }
  }
}

/**
 * 用户名维度的节流参数。
 *
 * threshold 取 5：比手误宽（输错四次不会锁），比爆破窄（第五次起锁定 1s、2s、4s…，
 * 封顶 15 分钟）。这条曲线让"猜一个 32 位随机口令"在数学上仍然不可行，
 * 同时不会让操作员因为自己记错密码而长时间进不去。
 */
export const USERNAME_THROTTLE_OPTIONS: Partial<ThrottleOptions> = {
  threshold: 5,
  baseLockoutMs: 1_000,
  maxLockoutMs: 15 * 60_000,
};

/**
 * 来源 IP 维度的节流参数。
 *
 * threshold 取 20，比用户名维度宽：同一个出口 IP 后面可能既有操作员也有攻击者，
 * 而 `trustProxy: true` 下 `request.ip` 取自 `X-Forwarded-For`——
 * 攻击者可以直接伪造这个头绕过 IP 维度。真正拦得住定向爆破的是**用户名**维度：
 * 攻击者无法在不被察觉的情况下换掉自己要爆破的那个用户名。
 * IP 维度挡的是"一个来源扫很多用户名"的枚举式攻击。
 */
export const IP_THROTTLE_OPTIONS: Partial<ThrottleOptions> = {
  threshold: 20,
  baseLockoutMs: 1_000,
  maxLockoutMs: 15 * 60_000,
};
