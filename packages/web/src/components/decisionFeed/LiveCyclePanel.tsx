import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { LiveCycle } from '../../lib/store';
import { humanizeToolNames } from '../../lib/toolLabels';
import { cn } from '../ui';

const SLOW_CYCLE_SECONDS = 20;

/**
 * 已等待时长。`8 秒` / `1 分 12 秒`。
 *
 * 不用 `fmtDuration`（那个入参是**分钟**）：这里最短只等几秒，用分钟为单位会把 8 秒
 * 显示成 `0.1 分钟`，正好丢掉这个读数唯一的价值 —— 秒级的变化。
 */
function elapsedLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/**
 * 一轮"正在请求模型"的占位条。
 *
 * ## 它解决的问题
 *
 * 服务器在真正调用模型**之前**就推了 `cycle_start`，而一轮要跑 6.8–18.3 秒。
 * 这段时间里决策流原来什么都不显示，看起来就像界面卡住了 ——
 * 操作者的原话是："如果系统开始向 AI 模型请求了，应该直接体现到页面上
 * （而不是等结果完全出来了才显示）"。
 *
 * ## 形态上守的两条契约
 *
 * - **元数据行照 `DECISION-FEED.md` §2**：一行纯文字、`│` 分隔、无边框、无底色、
 *   无徽章。第三格换成 `正在请求模型…`（成品那一格是 `in N · out N`），
 *   相对时间那一格换成一个呼吸的圆点 —— "刚刚"在这个条目上永远成立，
 *   不如用圆点表达"进行中"。
 * - **盒子明确不是成品**：虚线边框 + 更弱的底色（**不是**成品的 `bg-base-850`）+
 *   整体降透明度 + 一个转圈。不能让它看起来像一轮已经出结果的决策。
 *
 * ## 为什么秒数在这里、而不在别处
 *
 * 它回答的是"卡住了还是只是慢"这个问题，只有在这个条目内部才读得通
 * （`LAYOUT.md` §5 禁止把诊断值放进状态区）。
 */
/**
 * 这一轮的**步骤流水** —— 默认折叠，点开看每一步。
 *
 * ## 用户的原话（2026-10-10）
 *
 * > 「智能模式下，每一期最近决策里面能展开（就像你 DSH 一样），能折叠实时显示当前步骤
 * >  （默认是缩起来的，用户可以手动展开），这样用户可以手动展开看系统到底在做什么，
 * >  也可以判断系统到底是否正常工作」
 * > 「如果不展开，就默认显示一条:关键的摘要，能大概看到在做什么，是否在做事，
 * >  如果想看详情，再手动展开查看，里面就完全展示这一轮具体再做什么」
 *
 * ## 两条形态约束
 *
 * · **折叠态只有一行**：`步数 │ 最新那一步 │ 已用时`。它要回答的就是
 *   "在做事吗、卡在哪一步"，所以取的必须是**最新一条**，不是第一条。
 * · **展开态是完整流水**（带每步的时刻），后端只给最近 60 条。
 *
 * 用 `<button>` + 条件渲染而不是 `<details>`：`<details>` 的展开态不进 React 状态，
 * 而这里要跟着 `steps` 增长自动滚到最新（列表本身在增长，不能用一次性快照）。
 */
function CycleSteps({ steps, elapsedSec }: { steps: LiveCycle['steps']; elapsedSec: number }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const last = steps[steps.length - 1]!;
  /*
   * ⚠️ **两个数必须是同一口径，否则屏幕上会出现两个对不上的时间（用户 2026-10-10 实测）。**
   *
   * 上一版这里算的是"首步→末步的跨度"，而下面那个盒子写的是"从开始等到现在" ——
   * 于是同一屏出现 `93s` 与 `已等待 2 分 39 秒`。用户的原话是「你自己看看你做的这个
   * 合理吗？……用了多少时间？」。
   *
   * 现在：`elapsedSec` 由父组件给（与盒子同一个来源），
   * `currentSec` 是**当前这一步**已经走了多久 —— 它们相减没有意义，因为回答的是两个问题。
   */
  const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return (
    <div className="mb-1.5 min-w-0 rounded-md border border-base-700 bg-base-850/60 px-2.5 py-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? '收起这一轮的步骤' : '展开这一轮在做的每一步'}
        className="group flex w-full min-w-0 items-center gap-2 text-left"
      >
        <span aria-hidden className="shrink-0 text-ink-lo transition group-hover:text-ink-hi">
          {open ? '▾' : '▸'}
        </span>
        {/*
          运行指示点：折叠时也要一眼看出"它还在动"。
          与元数据行那个点是同一个类名 —— 同一个含义用同一个标记
          （`animate-pulse-soft` 是 `tailwind.config.js` 里注册的名字）。
        */}
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-accent" />

        {/* 最新一步 —— 折叠时这一格就是"它现在在做什么"。**最亮的一档**：它是本体。 */}
        <span className="min-w-0 truncate text-ink-hi">{last.message}</span>
        {/*
          两个数回答两个问题，**同一口径**（见上面 `elapsedSec` 的说明）：
          · `mmss(elapsedSec)`   —— 这一轮一共跑了多久
          · `currentSec`         —— **当前这一步**已经卡了多久（它才是"是不是卡住"的答案）
        */}
        {/*
          ⚠️ **就一个计时器，别的都不写（2026-10-10）。**
          
          上一版这里是「已 1:53 · 这一步 1s」。用户的原话是
          「这表述我他妈看得一头雾水，你就直接显示计时不就好了吗？
            搞些什么奇奇怪怪得非主流语言在上面」。
          
          **他说得对**：`已` / `这一步` 是我自己发明的说法，一个读数不需要前缀；
          计时器本身就是"从开始到现在"，跳动的秒数已经回答了"它还在动吗"。
          每一步各花了多久，去展开视图里看（那里是表格，列本身有含义）。
          
          唯一保留的判断是**颜色**：超过 2 分钟转琥珀色 —— 那是"比平常久"的
          无声提示，不占字。
        */}
        <span
          className={
            'num ml-auto shrink-0 tabular-nums ' +
            (elapsedSec >= 120 ? 'text-accent' : 'text-ink-hi')
          }
        >
          {mmss(elapsedSec)}
        </span>
      </button>
      {open && (
        <ol className="mt-2 space-y-1 border-t border-base-700 pt-2">
          {steps.map((s, i) => {
            const at = Date.parse(s.at);
            const prevAt = i > 0 ? Date.parse(steps[i - 1]!.at) : at;
            /*
             * **这一步花了多久** = 它自己的时刻 − 上一步的时刻。
             * 这是"慢在哪一步"唯一的答案 —— 只给绝对时刻的话，
             * 人还得自己心算相邻两行的差。
             */
            const deltaSec =
              Number.isFinite(at) && Number.isFinite(prevAt)
                ? Math.max(0, Math.round((at - prevAt) / 1000))
                : 0;
            const isCurrent = i === steps.length - 1;
            return (
              <li key={`${s.at}-${i}`} className="flex min-w-0 items-start gap-2">
                {/* 时刻与耗时都是**读数**，用能看清的一档。 */}
                <span className="num shrink-0 text-ink-lo">
                  {new Date(s.at).toLocaleTimeString('en-GB', { hour12: false })}
                </span>
                {/*
                  ⚠️ **状态标记说的是实话，不编造成功/失败。**
                  服务端只给了"发生过"与日志级别，没给"这一步成没成" ——
                  所以：最后一条 = **正在这一步**（转圈），其余 = **已发生**（对勾）；
                  级别是 error/warn 时用红/黄把**那一条日志本身**的严重性标出来。
                  **不要**把"日志级别"伪装成"步骤成败"：那正是本项目反复在消灭的
                  "一个字段说做成了、另一个字段说什么都没有"。
                */}
                <span
                  aria-hidden
                  className={
                    'w-3 shrink-0 text-center ' +
                    (isCurrent ? 'animate-pulse-soft text-accent' : 'text-ink-faint')
                  }
                >
                  {isCurrent ? '⟳' : '✓'}
                </span>
                <span className="num w-11 shrink-0 text-right text-ink-lo">
                  {deltaSec === 0 ? '—' : `${deltaSec}s`}
                </span>
                <span
                  className={
                    'min-w-0 break-words ' +
                    /* 正文比读数更亮一档：它是主角，时刻与耗时是配角。 */
                    (s.level === 'error' ? 'text-down' : s.level === 'warn' ? 'text-accent' : 'text-ink-hi')
                  }
                >
                  {s.message}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
export function LiveCycleBlock({ live }: { live: LiveCycle }) {
  const startedAt = live.startedAt;
  const [seconds, setSeconds] = useState(() => Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));

  useEffect(() => {
    // 先立刻对齐一次：从 `cycle_start` 进来到这一帧可能已经过了几百毫秒，
    // 而 0 秒和 1 秒对这个读数来说是两种不同的意思。
    setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    // 1 秒一跳就够了：显示的就是秒，再密只是白重渲染（一秒两次的转圈也不会更好看）。
    const timer = window.setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <article className="min-w-0 opacity-70">
      {/* 一行纯文字元数据（§2）：`呼吸圆点 │ 周期 #N │ 正在请求模型…` */}
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-0.5 text-xs text-ink-lo">
        <span
          className="flex items-center gap-1.5"
          title="这一轮的模型请求已经发出，结果还没回来。"
        >
          {/*
            用圆点而不是"刚刚"：这个条目一定是刚刚开始的，那两个字不带信息；
            圆点配 `@keyframes pulseSoft` 才是"还在动"的标记。
            ⚠️ `animate-pulse-soft`（带连字符）是 `tailwind.config.js` 里真正注册的
            动画名；写成 `animate-pulseSoft` 不会报错，只是**永远不生效** ——
            这个坑 `scripts/ui-smoke.mjs` 的注释里记着。
          */}
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-accent" />
          进行中
        </span>
        <span aria-hidden className="text-ink-faint">
          │
        </span>
        <span className="num">周期 #{live.cycleNumber}</span>
        {/*
          ⚠️ **这一格不再重复"当前步骤"（2026-10-10，用户实测）。**
          
          加了步骤流水之后，这里和下面折叠行的摘要显示的是**同一句话**，
          屏幕上连着两行一模一样的字 —— 用户的原话是「这 2 行重复了」。
          
          "现在在做什么"只该有一个出处：下面那一行（它同时还带步数与用时，
          并且是**可点的展开入口**）。这里保留状态与周期号即可。
        */}
      </div>

      {/*
        盒子：虚线边框 + 更弱的底色，**不是**成品的 `bg-base-850`。
        实线 + 抬升底色是"这一轮已经出结果"的语言，用在这里会被读成成品（§1）。
      */}
      {/* 步骤流水：默认折叠成一行摘要，点开看这一轮在做的每一步。 */}
      <CycleSteps steps={live.steps} elapsedSec={seconds} />

      <div className="min-w-0 rounded-lg border border-dashed border-base-600 bg-base-900/40 px-3 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <LoaderCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent" />
          <div className="min-w-0">
            <p className="text-xs leading-relaxed text-ink-mid" role="status">
              模型正在思考，已等待 <span className="num font-semibold text-ink-hi">{elapsedLabel(seconds)}</span>
            </p>
            {seconds >= SLOW_CYCLE_SECONDS && (
              // 越过 20 秒才说话，而且说的是"正常"而不是"出问题了"：这个系统
              // 见过 18.3 秒的一轮，在 20 秒就报警会让操作员去查一个不存在的事故。
              <p className="mt-1 text-xs leading-relaxed text-ink-faint">
                模型响应偏慢 —— 本系统单轮最长见过约 18 秒，等一会儿是正常的。
              </p>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * @param running 机器人是否正在运行。页面用 REST 的 `isRunning` 与推送到的实时状态
 *   合成后传进来；省略时退回到 store 里最后一次推送的状态 —— 页面忘了传也不会出现
 *   "停了还在转圈"。
 * @param actions 面板头里、刷新之前的那一组动作（交易页传的是「立即分析」）。
 *
 *   为什么是一个**元素**而不是 `onRunOnce` 之类的回调：那个动作依赖交易页自己的
 *   store 订阅与忙碌状态（`useRunOnce`），而这里的职责只是把它排在参考产品那一行的
 *   位置上（`DECISION-FEED.md` §1：`最近决策   ⚡立即分析   ↻`）。接收元素，这个面板
 *   就不必知道 run-once 调的是哪个接口、忙的是哪个机器人；省略时面板头只剩刷新与
 *   全部记录（见 §7：这两个入口必须保留）。
 */
/**
 * 「下一轮决策」倒计时。
 *
 * ## 为什么不由界面自己算
 *
 * 界面能拿到的只有"上一轮的时间"和配置里的周期，而**实际延迟还取决于两件界面看不到的事**：
 * 模型可以自己要求下次间隔（"这个突破正在形成，5 分钟后再叫我"），失败时系统会**短重试**
 * 而不是白等一整个周期。两者都只在服务端的 `scheduleNextCycle()` 里算得出来。
 *
 * 所以这个组件**只负责显示**：拿服务端给的 `nextCycleAt` 每秒刷新一次。
 * 自己推算会显示一个骗人的时间（模型说 5 分钟、界面显示 60 分钟），比没有更糟。
 */
export function CycleCountdown({ nextCycleAt }: { nextCycleAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (nextCycleAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [nextCycleAt]);

  if (nextCycleAt === null) return null;
  const leftSec = Math.max(0, Math.round((nextCycleAt - now) / 1000));
  const m = Math.floor(leftSec / 60);
  const s = leftSec % 60;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-base-700/80 bg-base-850/90 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-ink-lo"
      title="下一轮决策的预定时刻（由服务端给出，已包含模型要求的间隔与失败后的短重试）"
    >
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-up/85" />
      <span>下一轮</span>
      <span className="font-semibold text-ink-hi">
        {m}:{String(s).padStart(2, '0')}
      </span>
    </span>
  );
}


