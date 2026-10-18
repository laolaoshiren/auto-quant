import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 把底层异常翻译成**用户看得懂的一句话**。
 *
 * ## 为什么必须有这一层（2026-10-18 · 用户截图指出）
 *
 * 用户看到界面上红着一行：
 * ```
 *   ⚠ 持仓读不到，下面是 8 秒前的读数：Failed to fetch
 * ```
 * 原话是「别老整一些莫名其妙，对用户无意义的东西上 UI」。
 *
 * **`Failed to fetch` 是浏览器 `fetch` 的原始错误文案** —— 它对操作员毫无意义：
 * 既不是中文、也没说清"发生了什么"、更没说"该怎么办"。
 *
 * ## 它实际意味着什么
 *
 * `fetch` 抛 `TypeError: Failed to fetch` 只有几种原因，而且**都不是业务错误**：
 * ```
 *   ① 网络断了 / Wi-Fi 切换 / 手机信号弱
 *   ② 服务正在重启（部署的那十几秒）
 *   ③ CORS 或证书问题（首次访问域名时）
 *   ④ 浏览器插件拦截
 * ```
 * **共同点：这是一次临时性的连接失败，下一次轮询很可能就好了。**
 *
 * ⇒ 所以文案要说的不是"失败"，而是「**暂时连不上，正在重试**」。
 *
 * ⚠️ **本来就有意义的文案保留原文**（例如 401 的"登录已过期"、
 *   后端返回的业务错误）—— 翻译掉反而丢失信息。
 *   只有"看起来像底层异常"的才翻译。
 */
export function humanErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const trimmed = raw.trim();

  /*
   * 浏览器 fetch 的原始文案（Chrome / Safari / Firefox 各有一种写法）。
   * 它们共同的特征是：**原文是英文且对操作员零信息量**。
   */
  if (
    trimmed === 'Failed to fetch' ||
    trimmed === 'Load failed' ||
    trimmed === 'NetworkError when attempting to fetch resource.' ||
    trimmed === 'The operation was aborted.' ||
    trimmed === 'fetch failed'
  ) {
    return '暂时连不上服务（网络或服务正在重启）—— 页面会自动重试';
  }

  /*
   * `ApiError(0, …)` 是"根本没拿到响应"那条路（见 `api.ts`），同样属于临时性。
   * 后端绝不会返回 status 0，所以这个判定是准的。
   */
  if (/无法连接后端/.test(trimmed)) {
    return '暂时连不上服务（网络或服务正在重启）—— 页面会自动重试';
  }

  /* 其余（后端业务错误、401 等）**保留原文** —— 那些是有意义的信息。 */
  return trimmed === '' ? '读取失败（原因未返回）' : trimmed;
}

/**
 * **连续失败多少次才打扰用户**（2026-10-18）。
 *
 * ## 为什么是 2
 *
 * 轮询每 N 秒一次。**连着两次都失败**才说明真的读不到了 ——
 * 单次失败在这个系统里绝大多数是：
 * ```
 *   ① 部署时服务重启的那十几秒
 *   ② Wi-Fi 切换 / 手机信号抖动
 *   ③ 一次请求超时
 * ```
 * 这三种都会在下一次轮询自愈，而**用户手里的旧读数仍然有效**。
 *
 * ⇒ 单次失败**静默**（界面照常显示 N 秒前的真实读数），
 *   连着两次才出红条。用户原话：
 *   「是不是的闪这么一下在页面上完全不合理」「这些不应该是系统内部\后台处理的吗」。
 */
const TOLERATE_FAILURES = 2;

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Milliseconds epoch of the last successful load. */
  updatedAt: number | null;
  /**
   * **手里这份 `data` 是"上一次成功的、可能已经过期"的读数**（`data !== null && error !== null`）。
   *
   * 界面据此把话说清楚：「最新一次读取失败，下面是 N 秒前的数据」——
   * 而不是把上一次的成功读数当成当前状态（那正是本仓库反复禁止的
   * 「查不到 ≠ 没有」的展示面）。
   */
  stale: boolean;
  reload: () => void;
}

/**
 * Run an async loader on mount and then on an interval.
 *
 * Every fetch is abortable, so switching symbols or unmounting a trader page
 * cannot land a stale response in the UI. In-flight requests are skipped rather
 * than queued when a poll fires while the previous one is still running.
 *
 * ## 谁来"清旧数据"（2026-10-17 · 台账 FRD-05）
 *
 * 这里**必须**由协议层清，而不是让每个调用点自己 `filter` 一遍：
 * ```
 *   · deps 变（换机器人 / 换筛选）→ 旧 data 不属于新主体 → 清掉
 *   · enabled 由 true 变 false     → 这个查询现在不成立 → 清掉
 * ```
 * 原来两条都不做，于是调用点各自打了补丁（`DecisionFeed.tsx` 的
 * `filter(record => record.traderId === traderId)`、`TraderTables.tsx` 的同款）——
 * **补丁的存在本身就是协议层该清而未清的证据**，而且只要有一个调用点忘了打，
 * 屏幕上就会出现上一个机器人的持仓/决策。现在这两处补丁已删。
 *
 * ⚠️ **不因 `intervalMs`/`nonce` 变化清 data**：手动 `reload()` 与轮询节奏变化
 * 都不改变"这是谁的数"，清掉只会让表格闪一下白。
 */
export function usePolled<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  options: { intervalMs?: number; enabled?: boolean; deps?: unknown[] } = {},
): QueryState<T> {
  const { intervalMs = 0, enabled = true } = options;
  const deps = options.deps ?? [];
  /*
   * 依赖用**序列化后的字符串**参与 effect 依赖数组。
   *
   * 直接把 `deps` 展开进依赖数组（`[...deps]`）要求调用方保证长度恒定 ——
   * 那是一条没人检查的纪律（见 `usePolledDeps.test.ts`）。而这里既要用它做
   * "换主体了"的判据，又不能让长度变化把 React 的依赖位置挪位，
   * 所以收敛成一个**恒为一元**的字符串依赖。
   */
  const depsKey = JSON.stringify(deps);
  const depsKeyRef = useRef(depsKey);

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  /**
   * `data` 的镜像 —— **给 catch 里判断"有没有旧读数"用**。
   *
   * 不能直接读 `data`：那个值被闭包捕获在 effect 创建时，轮询跑起来之后
   * 它永远是旧的那份（`null`），于是"有旧数据就容忍一次失败"的判断会永远走不通。
   */
  const dataRef = useRef<T | null>(null);
  dataRef.current = data;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const clear = useCallback(() => {
    setData(null);
    setError(null);
    setUpdatedAt(null);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      /* 这个查询现在不成立：留着旧 data 只会让下一个使用它的人读到别人的数。 */
      clear();
      return;
    }

    /* 换主体（deps 变）→ 旧读数与错误都不属于新主体。 */
    if (depsKeyRef.current !== depsKey) {
      depsKeyRef.current = depsKey;
      clear();
    }

    const controller = new AbortController();
    let disposed = false;
    // Scoped to this effect instance on purpose. A shared instance counter would
    // deadlock the restarted effect: the previous run is still unwinding from
    // its abort while the new run checks the flag and bails out.
    let busy = false;
    /**
     * ⚠️ **连续失败次数** —— 单次失败不打扰用户（2026-10-18 用户报）。
     *
     * ## 症状
     *
     * 用户截图：页面底部闪出一条红色提示
     * ```
     *   ⚠ 持仓暂时读不到（不代表没有持仓）：暂时连不上服务… 页面会自动重试
     * ```
     * 原话是「是不是的闪这么一下在页面上完全不合理」「这些不应该是系统内部\
     * 后台处理的吗」。
     *
     * ## 为什么它会闪
     *
     * 轮询每 N 秒发一次。**只要有一次失败**（部署重启、网络抖动、一次超时），
     * 原来的实现就立刻 `setError(...)` ⇒ 红条出现；下一次成功又消失。
     * 于是用户看到一个反复闪的红条 —— 而**数据其实一直是好的**
     *（`data !== null`，界面显示的是 N 秒前的真实读数）。
     *
     * ## 正确的形态
     *
     * ```
     *   第 1 次失败  → 静默（大概率是抖动，下一次就好了）
     *   第 2 次连续  → 才提示（连着两次说明真的有问题）
     *   任何一次成功 → 计数归零、错误清空
     * ```
     *
     * ⇒ 用户只在**真的持续读不到**时才看到红条，而不是被抖动静音骚扰。
     *
     * ⚠️ **首次加载（还没有任何 data）例外**：那时没有旧读数可以显示，
     * 必须立刻说"读不到"，否则用户面对一片空白而不知道发生了什么
     *（见下面 `TOLERATE_FAILURES` 的用法）。
     */
    let consecutiveFailures = 0;

    const run = async () => {
      if (busy || disposed) return;
      busy = true;
      try {
        const result = await loaderRef.current(controller.signal);
        if (disposed) return;
        consecutiveFailures = 0;
        setData(result);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (disposed || (err as Error).name === 'AbortError') return;
        consecutiveFailures += 1;
        /*
         * 已经有旧数据时，**容忍 1 次失败** —— 那大概率是抖动，
         * 而界面上的旧读数仍然有效（会标"N 秒前"）。
         * 没有旧数据时（首次加载）立刻报错，否则用户看到的是空白。
         */
        const hasStaleData = dataRef.current !== null;
        if (hasStaleData && consecutiveFailures < TOLERATE_FAILURES) return;
        setError(humanErrorText(err));
      } finally {
        busy = false;
        if (!disposed) setLoading(false);
      }
    };

    void run();
    let timer: number | null = null;
    if (intervalMs > 0) {
      timer = window.setInterval(() => void run(), intervalMs);
    }

    return () => {
      disposed = true;
      controller.abort();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [enabled, intervalMs, nonce, depsKey, clear]);

  return { data, error, loading, updatedAt, stale: data !== null && error !== null, reload };
}

/** Poll interval that lengthens while the socket is delivering live data. */
export function fallbackInterval(socketOpen: boolean, liveMs = 5000, idleMs = 3000): number {
  return socketOpen ? liveMs : idleMs;
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · AutoQuant`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** Copy-to-clipboard with a transient "copied" flag for the audit views. */
export function useCopy(timeoutMs = 1400): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  const copy = useCallback(
    (text: string) => {
      const done = () => {
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), timeoutMs);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(done);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        try {
          document.execCommand('copy');
        } catch {
          /* nothing else we can do */
        }
        document.body.removeChild(area);
        done();
      }
    },
    [timeoutMs],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return { copied, copy };
}

/** A ticking clock for relative timestamps ("last cycle 34s ago"). */
export function useTicker(intervalMs = 1000): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return tick;
}
