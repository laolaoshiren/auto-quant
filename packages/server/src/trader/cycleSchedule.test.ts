import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampNextCheckMinutes,
  FAILED_CYCLE_RETRY_MS,
  MAX_NEXT_CHECK_MINUTES,
  MIN_NEXT_CHECK_MINUTES,
  nextCycleDelayMs,
} from './cycleSchedule.js';

/* -------------------------------------------------------------------------- */
/*  它自己决定什么时候再看盘 —— "智能"与"定时机器人"的分界线                     */
/* -------------------------------------------------------------------------- */

test('★ 模型说了多久之后再看，就听它的 —— 而不是死等配置的 30 分钟', () => {
  /*
   * ## 用户的原话（2026-10-02）
   *
   *   「不是系统喂给 AI 什么，AI 就只能**定时定点**的去做，这不是智能，
   *     也不是 AI，这是传统机器人了。」
   *   「会像真人一样，**决定何时做什么事情**。」
   *
   * 在此之前机器人只有一个节拍：`cycleIntervalMinutes`（30 分钟）。
   * 它没法说"这个突破正在形成，5 分钟后再叫我"，也没法说
   * "这行情没意思，一小时后再看" —— 而**这两件事都是交易判断本身**。
   *
   * 真人交易员就是这么工作的：盯着一个刚放量的标的时几分钟看一眼，
   * 周末横盘时去干别的。
   */
  assert.equal(
    nextCycleDelayMs({ failed: false, cycleIntervalMinutes: 30, requestedMinutes: 5 }),
    5 * 60_000,
    '它说 5 分钟就 5 分钟',
  );
  assert.equal(
    nextCycleDelayMs({ failed: false, cycleIntervalMinutes: 30, requestedMinutes: 90 }),
    90 * 60_000,
    '它说 90 分钟就 90 分钟 —— 也包括"想慢下来"',
  );
});

test('它没提的时候退回配置周期 —— `undefined` 与"它说了 30 分钟"是两件事', () => {
  assert.equal(nextCycleDelayMs({ failed: false, cycleIntervalMinutes: 30 }), 30 * 60_000);
  assert.equal(
    nextCycleDelayMs({ failed: false, cycleIntervalMinutes: 30, requestedMinutes: undefined }),
    30 * 60_000,
  );
  /* 而它真的说了 30 时，走的是"它说的"那条路，结果相同但语义不同。 */
  assert.equal(
    nextCycleDelayMs({ failed: false, cycleIntervalMinutes: 30, requestedMinutes: 30 }),
    30 * 60_000,
  );
});

test('★ 它要求的间隔被钳在 1–120 分钟 —— 不许空转，也不许睡过去', () => {
  /*
   * 两侧都是真实的失败模式：
   *
   *  · **低于 1 分钟** = 空转。它会烧掉 token 与上游配额，而这套系统刚刚
   *    才因为"请求太大撞上网关 100 秒超时"吃过亏（`HTTP 524`）。
   *  · **高于 120 分钟** = 睡过去。一个能把自己设成"明天再看"的机器人，
   *    会在真正的机会出现时缺席 —— **"错过机会"和"乱开仓"是同一量级的失败。**
   */
  assert.equal(clampNextCheckMinutes(0), MIN_NEXT_CHECK_MINUTES);
  assert.equal(clampNextCheckMinutes(-10), MIN_NEXT_CHECK_MINUTES);
  assert.equal(clampNextCheckMinutes(0.1), MIN_NEXT_CHECK_MINUTES);
  assert.equal(clampNextCheckMinutes(99999), MAX_NEXT_CHECK_MINUTES);
  assert.equal(clampNextCheckMinutes(1337), MAX_NEXT_CHECK_MINUTES, '1440 太长了，钳到 120');
  assert.equal(clampNextCheckMinutes(60), 60, '范围内的值原样保留');

  /* 非数字一律视为"它没提"，而不是当成 0（那会变成疯狂空转）。 */
  assert.equal(clampNextCheckMinutes('30'), undefined);
  assert.equal(clampNextCheckMinutes(Number.NaN), undefined);
  assert.equal(clampNextCheckMinutes(Number.POSITIVE_INFINITY), undefined);
  assert.equal(clampNextCheckMinutes(null), undefined);
  assert.equal(clampNextCheckMinutes(undefined), undefined);

  /* 经过钳制之后，延迟永远落在合法区间里。 */
  for (const raw of [0, -5, 0.4, 1, 120, 121, 100000]) {
    const ms = nextCycleDelayMs({ failed: false, cycleIntervalMinutes: 30, requestedMinutes: raw });
    assert.ok(
      ms >= MIN_NEXT_CHECK_MINUTES * 60_000 && ms <= MAX_NEXT_CHECK_MINUTES * 60_000,
      `提出的 ${raw} 分钟被钳成了 ${ms / 60_000} 分钟，越界了`,
    );
  }
});

test('失败轮次仍优先于它要求的长时间 —— 抖动时不该被它拖慢', () => {
  /*
   * 它说"120 分钟后再看"，而上游这几分钟刚抖过 —— 那种情况下
   * **不能**因为它的要求就把重试拖到两小时后。
   * "提前永远不变成推后"这条既有不变量在这里同样成立。
   */
  assert.equal(
    nextCycleDelayMs({ failed: true, cycleIntervalMinutes: 30, requestedMinutes: 120 }),
    FAILED_CYCLE_RETRY_MS,
    '失败时取 5 分钟与它要求的较小者',
  );
  assert.equal(
    nextCycleDelayMs({ failed: true, cycleIntervalMinutes: 30, requestedMinutes: 2 }),
    2 * 60_000,
    '它要求比 5 分钟更短时以它为准',
  );
});

/* -------------------------------------------------------------------------- */
/*  下一轮什么时候跑 —— 失败时不该等一整个周期                                  */
/* -------------------------------------------------------------------------- */

test('★ 模型调用失败后要【短间隔重试】，而不是等一整个周期', () => {
  /*
   * ## 这条用例是为用户 2026-10-01 的截图写的
   *
   * 控制台上连着两条：
   *
   *     33 分钟前 | 周期 #543 | 失败 · AI 服务不可用
   *      1 小时前 | 周期 #542 | 失败 · AI 服务不可用
   *
   * 上游是**偶发**故障（同轮内已重试 2 次、共 3 次尝试都撞上同一段窗口），
   * 而系统的行为是"失败 → 等一整个周期（默认 30 分钟）→ 下一轮"。
   * 于是**服务商抖动几分钟，代价是一小时**：用户连丢两轮，什么也没发生。
   *
   * 实测同一份日志：#1777 在 05:15 就成功了 —— 上游恢复得很快，
   * 只是没人早一点再问它一次。
   *
   * ⚠️ **这不是"退避"**（退避是"失败了就慢下来"），而是"把一次抖动的影响
   * 限制在几分钟内"。它是**只提前、不推后**：正常轮次仍按周期走。
   */
  const retry = nextCycleDelayMs({ failed: true, cycleIntervalMinutes: 30 });
  assert.equal(retry, FAILED_CYCLE_RETRY_MS);
  assert.ok(retry < 30 * 60_000, '必须比正常周期短，否则这一条就没意义');
  assert.ok(retry >= 60_000, '也不能短到疯狂空转 —— 上游不会在几秒内恢复');
});

test('正常轮次仍按配置的周期走 —— 这条改动不碰成功路径', () => {
  /*
   * 用户在周期长度上有一条明确的原则（"让模型决定用什么时间，不要系统写死"），
   * 所以这里只是**失败时的例外**，成功轮次必须原样使用 `cycleIntervalMinutes`。
   */
  assert.equal(nextCycleDelayMs({ failed: false, cycleIntervalMinutes: 30 }), 30 * 60_000);
  assert.equal(nextCycleDelayMs({ failed: false, cycleIntervalMinutes: 5 }), 5 * 60_000);
  assert.equal(nextCycleDelayMs({ failed: false, cycleIntervalMinutes: 1440 }), 1440 * 60_000);
});

test('周期配置非法时退回 1 分钟下限，而不是算出 NaN/负数', () => {
  /*
   * 下游是 `setTimeout`：`NaN` 会被当成 0（**立刻重跑**，疯狂空转），
   * 负数同理。原来那行 `Math.max(1, minutes) * 60_000` 就是为这个存在的，
   * 抽出来之后这条保护不能丢。
   */
  assert.equal(nextCycleDelayMs({ failed: false, cycleIntervalMinutes: 0 }), 60_000);
  assert.equal(nextCycleDelayMs({ failed: false, cycleIntervalMinutes: -5 }), 60_000);
  assert.equal(nextCycleDelayMs({ failed: false, cycleIntervalMinutes: Number.NaN }), 60_000);
});

test('失败重试也不比正常周期更晚 —— 短周期机器人不该被拖慢', () => {
  /*
   * 一个周期设成 2 分钟的机器人，失败后不该等 5 分钟。
   * 取两者较小的那个：**"提前"永远不该变成"推后"**。
   */
  assert.equal(nextCycleDelayMs({ failed: true, cycleIntervalMinutes: 2 }), 2 * 60_000);
  assert.equal(nextCycleDelayMs({ failed: true, cycleIntervalMinutes: 30 }), FAILED_CYCLE_RETRY_MS);
});
