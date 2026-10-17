/**
 * **"这份系统状态有多旧"的判据**（台账 FRD-01）。
 *
 * ## 它回答的问题
 *
 * 后端不可达之后，界面**继续显示**上一份成功读数（顶栏「实盘」「推送在线」、
 * 状态栏「运行 1」）—— 那是刻意的（比清空更接近事实），但**必须让人知道它是旧的**。
 * 这个模块把那件事算成一句能直接渲染的话。
 *
 * ## 为什么是纯函数
 *
 * 它要能被单独测：三条边界（从没成功过 / 刚好在阈值上 / 早就过期）都值得钉住，
 * 而它们与 React 无关。
 *
 * ## 阈值为什么是 3 × 轮询间隔
 *
 * 兜底轮询是 10 秒（推送在线）或 4 秒（推送断开）—— 见 `ShellRuntime`。
 * 一次网络抖动不该让状态栏变红（那会让颜色失去意义），而**连续三次都没成功**
 * 说明这不是抖动。所以阈值取 3 倍，`pollMs` 由调用方按当前节奏传进来。
 *
 * ⚠️ **没成功过一次（`loadedAt === null`）不算"停更"**：那时界面本来就是空的
 * （首屏正在加载），说"停更 0 秒"是编的。这一条与 `TeamBoard` 里
 * 「`startedAt` 为 `null` 时不挂计时器」是同一条纪律。
 */

/** 三倍轮询间隔。 */
export const STALE_POLL_MULTIPLIER = 3;

export interface Staleness {
  /** 从上次成功到现在的秒数；`null` = 从没成功过（不判"停更"）。 */
  seconds: number | null;
  /** 是否已经超过 3 × 轮询间隔。 */
  stale: boolean;
  /** 出错但手里还有旧读数（"停更"之外的另一半事实）。 */
  failed: boolean;
  /** 直接可渲染的一句话；不需要提示时为 `null`。 */
  label: string | null;
}

/** `HH:MM:SS`（本地时区，24 小时制）。 */
function clockOf(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * @param loadedAt 上一次成功读到的时刻（epoch ms）；`null` = 从没成功过。
 * @param error    最近一次失败的原因；`null` = 最近一次是成功的。
 * @param pollMs   当前的轮询间隔（推送在线 10 秒 / 断开 4 秒）。
 * @param now      现在（epoch ms）—— 传进来而不是内部取，测试才能确定性地跑。
 */
export function staleness(
  loadedAt: number | null,
  error: string | null,
  pollMs: number,
  now: number,
): Staleness {
  const seconds = loadedAt === null ? null : Math.max(0, Math.round((now - loadedAt) / 1000));
  /*
   * ⚠️ **阈值比较用毫秒，不用取整后的秒**（2026-10-17 自测抓到）。
   *
   * 第一版写的是"秒 > 3 × 轮询秒数"，于是 `12001ms` 先被 `Math.round` 成 12 秒、
   * 再与 12 比较 → 判成"没超"。边界上差 1ms 就翻面，而边界正是这种判据唯一
   * 会出错的地方。**显示用秒、判据用毫秒**，两者各司其职。
   */
  const elapsedMs = loadedAt === null ? 0 : Math.max(0, now - loadedAt);
  const stale = loadedAt !== null && elapsedMs > pollMs * STALE_POLL_MULTIPLIER;
  const failed = error !== null;

  /*
   * ⚠️ 判据写 `loadedAt === null` 而**不是** `seconds === null`：两者等价，
   * 但后者不让 TS 收窄 `loadedAt`（`seconds` 是派生值），下面 `clockOf(loadedAt)`
   * 就通不过类型检查 —— 而"用派生值做判据"正是这类窄化问题的来源。
   */
  if (loadedAt === null) {
    /* 从没成功过：不判"停更"，但读取失败本身要说出来（载荷里带 error 时）。 */
    return { seconds: null, stale: false, failed, label: failed ? `状态读取失败：${error}` : null };
  }
  if (!stale) {
    /* 阈值内：成功就不说话；刚失败一次也先不说（下一轮很可能就好了）。 */
    return { seconds, stale: false, failed, label: null };
  }
  return {
    seconds,
    stale: true,
    failed,
    label: `状态停更 ${seconds} 秒 · 最后成功 ${clockOf(loadedAt)}`,
  };
}
