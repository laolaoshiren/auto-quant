/**
 * 数据与日志。
 *
 * 这一页的读者是"出事了正在排查的人"，所以一切让位于**可读**：
 *
 * - 日志行里有交易所原始的报错文本（例如 Binance 的 `-2019`），那些字符串就是
 *   唯一的诊断依据，必须原样显示 —— 不翻译、不省略。因此容器用 `break-all`
 *   而不是 `break-words`：没有空格的错误串会把整页顶出横向滚动条。
 * - 级别（info / warn / error）用颜色 + 固定宽度的文字标签，两者同时存在，
 *   不靠颜色单独传达信息。
 * - 长列表只渲染有上限的一段（见 `MAX_RENDERED`），并明确告诉操作员被截断了多少。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, Pause, Play, RefreshCw, RotateCw, Trash2 } from 'lucide-react';
import { LOG_LEVEL_ICONS, LOG_SCOPE_ICONS, logScopeKind, logScopeLabel } from '@aq/shared';
import { api, type LogLine } from '../lib/api';
import { useApp, useEvents, type LiveLogLine } from '../lib/store';
import { useDocumentTitle, usePolled, useTicker } from '../lib/hooks';
import { Badge, Button, CopyButton, ErrorNote, Panel, Spinner3, TextInput, cn } from '../components/ui';
import { fmtClockOffsetMs, fmtInt, timeAgo, tradingEnvironmentLabel } from '../lib/format';
import { shouldBackfill } from '../lib/logBackfill';

type Level = 'all' | 'info' | 'warn' | 'error';

/**
 * 一次渲染的日志行上限。
 *
 * 推送缓冲可能有几千行，全量渲染会让展开/暂停/打字都卡住 ——
 * 而这恰恰是排查问题时最不能卡的时刻。超出部分从**最新的**开始截取，
 * 因为最新的行才是要看的。
 */
const MAX_RENDERED = 500;

/**
 * 页脚那一格「最近事件 · 时刻」。
 *
 * ## 为什么它必须是一个独立组件 —— 这一页的性能问题就在这里
 *
 * 这一格每 5 秒要跳一次：`时刻` 是当前时钟，`最近事件` 是"3 分钟前"这种相对时间。
 *
 * 原来 `useTicker(5000)` 写在 `DataPage` 的**顶层** —— 于是每 5 秒整个页面重渲染
 * 一次，而那 500 行日志是**内联的 `<div>`**（不是 `memo` 组件），一点都省不下来：
 * **为了让这一格跳字，每 5 秒重建约 2000 个 DOM 节点。**
 *
 * 而这一页恰恰是"出事了要翻开看日志"的地方 —— 卡在这里最难受。
 * 把 ticker 收进这个叶子组件之后，重渲染只发生在这一个 `<span>` 里。
 */
function FeedClock({ lastEventAt }: { lastEventAt: number | null }) {
  const tick = useTicker(5000);
  return (
    <span>
      最近事件 {timeAgo(lastEventAt ? new Date(lastEventAt).toISOString() : null)} · 时刻{' '}
      {new Date(tick).toLocaleTimeString('en-GB', { hour12: false })}
    </span>
  );
}

const LEVELS: Array<{ id: Level; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'info', label: '信息' },
  { id: 'warn', label: '警告' },
  { id: 'error', label: '错误' },
];

const LEVEL_TEXT: Record<string, string> = {
  error: 'text-down',
  warn: 'text-warn',
  info: 'text-ink-lo',
};

const LEVEL_LABEL: Record<string, string> = {
  error: '错误',
  warn: '警告',
  info: '信息',
};

/*
 * 日志背景的**整行底色**。
 *
 * 只有警告与错误上色 —— 一条正常的日志刷一条底色，等于把所有行都变成
 * "需要注意"，而那正是**注意力被摊平**的成因。
 *
 * 用 `/8` 与 `/5` 的极低不透明度：那一行的**文字仍然比底色显眼**，
 * 底色只是把"这里有一件要处理的事"从余光里递过来。
 */
const LEVEL_ROW: Record<string, string> = {
  error: 'bg-down/10',
  warn: 'bg-warn/5',
  info: '',
};

/** 来源标签的配色，按**类别**分 —— 同类的东西在整页里长得一样。 */
const SCOPE_TONE: Record<string, string> = {
  exchange: 'bg-accent/15 text-accent',
  ai: 'bg-[#a78bfa]/15 text-[#a78bfa]',
  data: 'bg-[#22d3ee]/15 text-[#22d3ee]',
  runtime: 'bg-base-800 text-ink-mid',
  other: 'bg-base-850 text-ink-faint',
};

/**
 * 把正文里的**金额**挑出来上色。
 *
 * 日志的重点常常是一个数字（`净 +0.0771 USDT`、`时钟偏移 -75ms`），
 * 而它原来和周围的灰字一样 —— **重点埋在灰字里就等于没有重点**。
 *
 * 只认"带正负号或小数点的数字 + 可选单位"，**保守匹配**：
 * 匹配错了会让一段普通文字突然变色，那比不着色更糟。
 */
function highlightNumbers(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  /*
   * ⚠️ **只认「带正负号」或「带单位」的数字，不认裸小数。**
   *
   * 第一版还匹配 `\d+\.\d+`，于是 `http://172.17.0.1:3200` 里的
   * **`172.17` 被当成一个数值高亮了** —— 在一句 URL 中间突然冒出一个
   * 亮色数字。实测是在浏览器里读 DOM 才发现的。
   *
   * 裸小数太容易误伤（IP、版本号、时间、路径里的编号），
   * 而日志里真正值得关注的数字**几乎都带正负号或单位**
   * （`净 +0.0771 USDT`、`时钟偏移 -75ms`、`止损距离 0.4%`）。
   *
   * 捕获组 1/2 是「带符号 + 可选单位」，3/4 是「带单位」。
   * **只捕获数字本身**，编号/单位留给原文。
   */
  /*
   * ⚠️ 前瞻里**不能带 `\b`**：`%` 是非单词字符，`%\b` 永远不成立 ——
   * 于是 `0.147%` 这种最该高亮的比例**一个都没匹配上**。
   * `x` 单独加 `(?![a-z])`，免得把 `5xyz` 里的 `5x` 当成杠杆。
   */
  const re = /([+-]\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)(?=\s?(?:USDT|U|ms|%|x(?![a-z])))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const num = m[1] ?? m[2] ?? '';
    /*
     * 带正负号的用主题的涨跌色，带单位的用中性高亮。
     * **不按"好/坏"判断**：`-75ms` 是时钟偏移，不是亏损。
     */
    const tone = num.startsWith('-')
      ? 'text-down'
      : num.startsWith('+')
        ? 'text-up'
        : 'text-ink-hi';
    parts.push(
      <span key={key++} className={cn('num font-medium', tone)}>
        {num}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function DataPage() {
  useDocumentTitle('数据与日志');
  const liveLogs = useEvents((s) => s.logs);
  const hydrateLogs = useEvents((s) => s.hydrateLogs);
  const clearLogs = useEvents((s) => s.clearLogs);
  const socketStatus = useEvents((s) => s.status);
  const lastEventAt = useEvents((s) => s.lastEventAt);
  const connect = useEvents((s) => s.connect);
  const system = useApp((s) => s.system);
  const health = useApp((s) => s.health);

  const [level, setLevel] = useState<Level>('all');
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [source, setSource] = useState<'socket' | 'rest'>('socket');
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const restQuery = usePolled((signal) => api.logs(300, signal), { intervalMs: socketStatus === 'open' ? 30_000 : 8000 });

  const restLines: LiveLogLine[] = useMemo(
    () =>
      (restQuery.data?.logs ?? []).map((line: LogLine) => ({
        id: line.id,
        traderId: line.traderId,
        level: (line.level as LiveLogLine['level']) ?? 'info',
        message: line.message,
        timestamp: line.createdAt,
        scope: line.scope,
      })),
    [restQuery.data],
  );

  /*
   * ⚠️ **回填必须是一次性的，且清空之后不得再回填**（外部 issue #168）。
   *
   * 原来的判据是 `liveLogs.length === 0` —— 而「清空」按钮把缓冲区清成 0 之后，
   * 那个条件**成立**，于是 effect 立刻把同一批历史灌回（`restQuery` 每 8–30 秒
   * 轮询一次，所以是**持续**灌回，不是闪一下）。
   *
   * 根因：用"缓冲区是否为空"当"是否需要**首次**回填"的判据 ——
   * 而"用户主动清空"与"页面首次加载"在这个状态里长得一模一样。
   *
   * 修法：两个 `useRef` 标志（不触发重渲染），判据见 `lib/logBackfill.ts`：
   *   · `hydratedOnce`  —— 回填过就不再重复（否则每次轮询都重灌）；
   *   · `clearedByUser` —— 用户清空过就**闭嘴**（那是明确的意图，不是"重新加载"）。
   *
   * 要恢复请点「重新加载」按钮（下面工具栏里那个）或刷新页面。
   */
  const hydratedOnce = useRef(false);
  const clearedByUser = useRef(false);

  // Backfill the pane from the persisted log table on first load.
  useEffect(() => {
    if (
      shouldBackfill({
        source,
        restLineCount: restLines.length,
        alreadyHydrated: hydratedOnce.current,
        manuallyCleared: clearedByUser.current,
      })
    ) {
      hydrateLogs(restLines);
      hydratedOnce.current = true;
    }
  }, [restLines, hydrateLogs, source]);

  const lines = source === 'socket' ? liveLogs : restLines;

  // "pause" freezes the viewport on the current buffer without stopping the socket.
  const frozen = useRef<LiveLogLine[] | null>(null);
  if (paused && frozen.current === null) frozen.current = lines;
  if (!paused && frozen.current !== null) frozen.current = null;
  const visible = frozen.current ?? lines;

  const matched = useMemo(() => {
    const term = search.trim().toLowerCase();
    return visible.filter((line) => {
      if (level !== 'all' && line.level !== level) return false;
      if (term && !line.message.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [visible, level, search]);

  const shown = useMemo(() => matched.slice(Math.max(0, matched.length - MAX_RENDERED)), [matched]);
  const hiddenRows = matched.length - shown.length;

  useEffect(() => {
    if (!follow || paused) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [shown.length, follow, paused]);

  const counts = useMemo(() => {
    const acc = { info: 0, warn: 0, error: 0 };
    for (const line of visible) {
      if (line.level === 'warn') acc.warn += 1;
      else if (line.level === 'error') acc.error += 1;
      else acc.info += 1;
    }
    return acc;
  }, [visible]);

  const copyBuffer = async () => {
    const text = shown
      .map(
        (line) =>
          `${new Date(line.timestamp).toISOString()} ${line.level.toUpperCase().padEnd(5)} ${
            line.traderId !== null ? `t${line.traderId} ` : ''
          }${line.message}`,
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* 剪贴板被浏览器拒绝（非 https / 无权限）时不弹错：操作员可以手动选中复制 */
    }
  };

  const filtering = level !== 'all' || search.trim().length > 0;
  /** 有内容才给日志容器那一块固定高度；空状态只占一行（`LAYOUT.md` §4）。 */
  const hasLines = shown.length > 0;

  return (
    /*
     * ## ⚠️ 日志面板要**顶满到滚动区底部**，说明卡让到下一屏
     *
     * 用户的原话：「这一块直接钉满底部啊，各种窗口大小下这一块都是默认顶满、
     * 对齐底部的，下面那个文字说明用户不滚动页面就不显示」。
     *
     * 这是**第二次**说同一件事（上一次的浏览器批注：「这一块直接自动订满页面
     * 底部，不滚动就不展示下面那一块」）。上一轮的修法只把日志体改成
     * `flex-1`，但「本页数据来源」那张说明卡**还留在同一个 flex 列里**，
     * 于是它永远占住一块高度（实测 185px），日志面板只能拿剩下的 ——
     * 在 1405x722 下日志面板只有 160px，底部离滚动区下沿还差 211px，
     * 而日志恰恰是这一页要看的东西。
     *
     * 所以把说明卡移到 flex 列**外面**：日志面板吃满「视口 − 页头 − 指标带」
     * 之后的全部高度，底边正好落在滚动区下沿；说明卡排在它下面，页面因此
     * 比视口高一截，往下滚才看到 —— 这正是用户要的次序（日志是正文，
     * 说明是排查时才翻的参考）。
     *
     * ⚠️ `page-fill` 必须配 **`h-full`**，不能只靠它自己那条
     * `@media (min-width: 80em) { height: 100% }`：窄屏下那条规则不生效，
     * 没有确定高度时 `flex-1` 会退化成"按内容撑高"，日志面板反而被 31 行日志
     * 顶到 958px、页面溢出 799px（实测过）。内容区（`#main-scroll`）本身是
     * 确定高度的 flex 子项，`h-full` 在两种宽度、两套模板下都成立。
     *
     * 页头与指标带标 `shrink-0`：窗口再矮也只压缩日志面板（它有 `min-h-0`
     * 和内部滚动条），不挤压标题与读数。
     *
     * 最外层用 `Fragment`（而不是再包一层 div）：日志面板的 `flex-1` 需要
     * 直接看见 `.page-fill` 这个 flex 容器，中间多一层普通 div 会把
     * `height:100%` 的链断掉（实测会退化成按内容撑高）。
     */
    <>
      <div className="page-fill h-full gap-3">
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-wide text-ink-hi">数据与日志</h1>
          <p className="mt-0.5 text-xs text-ink-faint">
            运行时日志流、连接健康状态，以及控制台背后的原始行情计数器。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={socketStatus === 'open' ? 'up' : 'warn'}>
            {socketStatus === 'open' ? '推送已连接' : `推送 ${socketStatus}`}
          </Badge>
          {socketStatus !== 'open' && (
            <Button size="sm" onClick={() => connect()}>
              <RotateCw aria-hidden className="h-3.5 w-3.5" />
              重新连接
            </Button>
          )}
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {/*
                  显示**中文**，不是 `production`。
                  `environment` 是机器码，由 `tradingEnvironmentLabel` 翻译；
                  `environmentLabel`（交易所端点名）作为注解留在下面。
                */}
                <Metric
                  label="环境"
                  value={tradingEnvironmentLabel(system?.environment)}
                  sub={system?.environmentLabel}
                />
        <Metric label="时钟偏移" value={fmtClockOffsetMs(system?.clockOffsetMs)} sub="本机 − 交易所" />
        <Metric
          label="API 权重"
          value={`${fmtInt(system?.weightUsed)} / ${fmtInt(system?.weightLimit)}`}
          sub="每分钟"
        />
        <Metric label="可交易对" value={fmtInt(system?.tradableSymbols)} />
        <Metric label="服务运行时长" value={health ? `${Math.floor(health.uptimeSeconds / 60)} 分` : '—'} />
        <Metric
          label="日志行数"
          value={fmtInt(visible.length)}
          sub={`${counts.error} 错误 · ${counts.warn} 警告`}
        />
      </div>

      <Panel
        title="运行时日志"
        /*
         * 日志面板吃掉**这一页剩下的全部高度**，日志体再吃掉面板剩下的高度
         * （见下面 `flex-1`）。
         *
         * 原来日志体写死 `h-[min(70vh,560px)]`：屏幕一高，70vh 就比"面板真正
         * 剩下的高度"还大，页面被顶长 —— 用户必须滚动才能看到日志框的下沿和
         * 底下的说明卡，而下面明明还有空。用户的原话是「日志框也要动态大小，
         * 保证不同页面下这一块能完整显示，而不用用户滚动页面」。
         *
         * `min-h-0` 是必须的：flex 子项默认 `min-height:auto`，不加它日志体会
         * 被内容顶高、永远不产生内部滚动条，`flex-1` 就白写了。
         */
        className="flex min-h-0 flex-1 flex-col"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {/* 级别：文字 + 颜色，两者都在 */}
            <div role="group" aria-label="按级别过滤" className="flex items-center gap-0.5">
              {LEVELS.map((item) => (
                <Button
                  key={item.id}
                  size="sm"
                  variant={level === item.id ? 'primary' : 'ghost'}
                  aria-pressed={level === item.id}
                  onClick={() => setLevel(item.id)}
                >
                  {item.label}
                  {item.id !== 'all' && (
                    <span className="num text-ink-faint">{counts[item.id as 'info' | 'warn' | 'error']}</span>
                  )}
                </Button>
              ))}
            </div>

            <span aria-hidden className="mx-0.5 hidden h-4 w-px bg-base-700 sm:block" />

            <div role="group" aria-label="日志来源" className="flex items-center gap-0.5">
              <Button
                size="sm"
                variant={source === 'socket' ? 'primary' : 'ghost'}
                aria-pressed={source === 'socket'}
                onClick={() => setSource('socket')}
              >
                实时
              </Button>
              <Button
                size="sm"
                variant={source === 'rest' ? 'primary' : 'ghost'}
                aria-pressed={source === 'rest'}
                onClick={() => setSource('rest')}
              >
                持久化
              </Button>
            </div>

            <span aria-hidden className="mx-0.5 hidden h-4 w-px bg-base-700 sm:block" />

            <Button
              size="sm"
              variant={follow ? 'primary' : 'ghost'}
              aria-pressed={follow}
              title="开启后新日志会自动滚到底部"
              onClick={() => setFollow((value) => !value)}
            >
              {follow ? <ArrowDownToLine aria-hidden className="h-3.5 w-3.5" /> : null}
              跟随{follow ? '开' : '关'}
            </Button>
            <Button
              size="sm"
              variant={paused ? 'warn' : 'ghost'}
              aria-pressed={paused}
              title="暂停只冻结视图，不会停止接收推送"
              onClick={() => setPaused((value) => !value)}
            >
              {paused ? <Play aria-hidden className="h-3.5 w-3.5" /> : <Pause aria-hidden className="h-3.5 w-3.5" />}
              {paused ? '已暂停' : '暂停'}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                /*
                 * ⚠️ **先立起"用户主动清空"的标志，再清缓冲区**（外部 issue #168）。
                 *
                 * 顺序无所谓（同一个事件循环内两件事都会发生），但**标志必须立** ——
                 * 否则回填 effect 会立刻把同一批历史灌回，这个按钮等于没用。
                 */
                clearedByUser.current = true;
                clearLogs();
              }}
              disabled={source !== 'socket'}
              title={source === 'socket' ? '清空本页的推送缓冲' : '持久化日志来自服务端，不能在这里清空'}
            >
              <Trash2 aria-hidden className="h-3.5 w-3.5" />
              清空
            </Button>
            <Button size="sm" onClick={() => restQuery.reload()} busy={restQuery.loading}>
              <RefreshCw aria-hidden className="h-3.5 w-3.5" />
              重新加载
            </Button>
            {/*
              ⚠️ **这一整组不进工具栏，这是刻意的。**

              级别筛选、日志来源、跟随/暂停、清空缓冲看着像"页面的动作"，
              其实是**视图选项** —— 四件事共同描述"我现在在看什么"。
              搬进 40px 的工具栏会丢掉两样东西：

                · 按钮的**选中态**（`variant="primary"` 表示"当前就是这个筛选值"）
                  在工具栏的透明底上读不出来；
                · 它们和下面那张日志表是**一组**，分到两条横带上就断开了。

              工具栏只收"重新加载"这类真正的页面级动作。这条边界见
              `LAYOUT.md` §0：工具栏放**当前页面能做的事**，
              筛选与视图状态属于**当前页面在看的东西**。
            */}
          </div>
        }
        /*
         * 面板体也带 `min-h-0` —— 它是这一串里最容易漏的一环：flex 子项默认
         * `min-height:auto`，日志内容有 800px 高时，它会把面板体顶到 886px，
         * 面板再顶到 887px，`flex-1` 完全失效（实测就是这个数字）。
         */
        bodyClassName="flex min-h-0 flex-1 flex-col p-2"
        padded={false}
      >
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <TextInput
              className="num"
              placeholder="按原文过滤消息…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="过滤日志消息"
            />
          </div>
          {filtering && (
            <>
              <span className="num text-xs text-ink-faint">
                命中 {fmtInt(matched.length)} / {fmtInt(visible.length)}
              </span>
              <Button
                size="sm"
                onClick={() => {
                  setSearch('');
                  setLevel('all');
                }}
              >
                清除过滤
              </Button>
            </>
          )}
          <CopyButton onCopy={() => void copyBuffer()} copied={copied} />
        </div>

        {/*
         * 日志容器自己滚动、自己断词：任何一行都不许把页面撑宽。
         *
         * 高度分成两种（`LAYOUT.md` §4：空状态不占位）：
         * - 有内容时给足 `min(70vh,560px)` 并在内部滚动 —— 日志行又长又多，
         *   这是唯一能既不撑宽页面、又不让排查者频繁滚动的做法；
         * - 空/加载/出错时**不预留那块高度**，只占一行多一点。空列表撑满一屏
         *   正是这条规范要消掉的浪费。
         */}
        <div
          ref={scrollRef}
          className={cn(
            'overflow-y-auto overflow-x-hidden rounded-md border border-base-800 bg-base-950 p-1 font-mono text-base leading-relaxed',
            /*
             * 有内容时撑满面板剩下的高度（父级已经是 flex 列，见上面 Panel 的
             * `flex-1`）；空/加载/出错时**不预留那块高度**，只占一行多一点 ——
             * 空列表撑满一屏正是 `LAYOUT.md` §4 要消掉的浪费。
             *
             * `flex-1` 与 `min-h-0` 缺一不可：前者是"占满剩余"，后者是"允许被
             * 压到比内容矮" —— 没有后者，日志体永远按内容撑高，内部滚动条不会出现。
             */
            hasLines ? 'min-h-0 flex-1' : 'min-h-0',
          )}
        >
          {source === 'rest' && restQuery.loading && shown.length === 0 ? (
            <Spinner3 label="正在加载持久化日志" />
          ) : restQuery.error && shown.length === 0 ? (
            <div className="space-y-1.5 p-2">
              <ErrorNote>读取持久化日志失败：{restQuery.error}</ErrorNote>
              <Button size="sm" busy={restQuery.loading} onClick={() => restQuery.reload()}>
                重试
              </Button>
            </div>
          ) : shown.length === 0 ? (
            // 一行话 + 下一步动作：不用 `Empty`，它的 py-10 会为"没有日志"预留一屏高度。
            <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1.5">
              <span className="font-sans text-base text-ink-mid">
                {filtering
                  ? '没有匹配当前过滤条件的日志行 —— 放宽级别或清空过滤词。'
                  : '还没有日志。服务开始运行后会通过推送持续写入。'}
              </span>
              {filtering ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setSearch('');
                    setLevel('all');
                  }}
                >
                  清除过滤
                </Button>
              ) : (
                <Button size="sm" onClick={() => setSource('rest')}>
                  读取持久化日志
                </Button>
              )}
            </div>
          ) : (
            shown.map((line) => (
              <div
                // 同一毫秒可能有多行，id 会重复，所以把时间戳一起放进 key
                key={`${line.id}-${line.timestamp}`}
                className={cn(
                  'flex items-start gap-2 rounded px-1 py-0.5 hover:bg-base-850/60',
                  /* 只有警告与错误有底色 —— 见 `LEVEL_ROW` 上的说明。 */
                  LEVEL_ROW[line.level] ?? '',
                )}
              >
                <span className="num shrink-0 text-ink-faint" title={new Date(line.timestamp).toISOString()}>
                  {new Date(line.timestamp).toLocaleTimeString('en-GB', { hour12: false })}
                </span>
                {/*
                  级别用**图标**，文字标签退到 `title` 里。

                  这一栏原来写「信息」/「警告」/「错误」—— 三个词一样宽，
                  而九成以上的日志是"信息"。一列重复的"信息"占着地方，
                  却什么也没告诉你。图标占同样的宽度，而**形状本身就能扫**：
                  `⚠️` 与 `❌` 在余光里就认得出来，文字必须逐个读。

                  颜色、图标、`title` 三者都在 —— **不靠颜色单独传达信息**
                  （色盲、以及"打印成黑白"这两种情况都还在）。
                */}
                <span
                  className={cn(
                    'w-6 shrink-0 select-none text-center text-sm',
                    LEVEL_TEXT[line.level] ?? 'text-ink-lo',
                  )}
                  title={LEVEL_LABEL[line.level] ?? line.level}
                >
                  {LOG_LEVEL_ICONS[line.level] ?? '·'}
                </span>
                {line.traderId !== null && (
                  <span className="num shrink-0 text-accent" title={`机器人 #${line.traderId}`}>
                    t{line.traderId}
                  </span>
                )}
                {/*
                  来源：**图标 + 中文标签 + 类别配色**，`title` 里保留原始码。

                  服务端原来把 `[binance:bootstrap]` 拼在正文最前面 ——
                  那是**内部模块名出现在给人看的文本里**。现在来源单独传，
                  这里翻成中文（「币安 · 启动检查」）并配一个图标，
                  而原始码仍然可查（悬停可见），按来源筛选也仍然用原始码。

                  图标比文字更早被眼睛抓住：`🔌` 是交易所的事、`🧠` 是 AI 的事、
                  `💾` 是存储的事 —— **一眼把"哪个子系统在说话"分开**。
                */}
                {line.scope && (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1 text-xs',
                      SCOPE_TONE[logScopeKind(line.scope)] ?? SCOPE_TONE.other,
                    )}
                    /*
                      ⚠️ **悬浮提示里的来源也要翻译**（2026-10-17，t52 的 B1）。
                      
                      这一格的**可见文字**早就走了 `logScopeLabel`（中文 ✅），
                      而 `title` 里原来直接写 `来源：${line.scope}` ——
                      于是鼠标一停，浮出来的是 `来源：trader` / `来源：binance:rest`。
                      
                      这一行代码**同时管着页面上每一个日志行**（149 个实例实测），
                      所以改这一处就等于改全部。原始码留在括号里 ——
                      按 scope 去库里筛日志时要靠它（与面板那边同一个做法）。
                     */
                    title={`来源：${logScopeLabel(line.scope)}（原始码：${line.scope}）`}
                  >
                    {LOG_SCOPE_ICONS[line.scope] ? `${LOG_SCOPE_ICONS[line.scope]} ` : ''}
                    {logScopeLabel(line.scope)}
                  </span>
                )}
                {/*
                  break-all：交易所原文没有空格，break-words 兜不住。
                  数字单独上色 —— 日志的重点常常就是一个数字，而它原来
                  和周围的灰字一样，**重点埋在灰字里等于没有重点**。
                */}
                <span className="min-w-0 flex-1 break-all text-ink-mid">
                  {highlightNumbers(line.message)}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="num mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-ink-faint">
          <span>
            显示 {fmtInt(shown.length)} / {fmtInt(matched.length)} 行
            {hiddenRows > 0 && `（更早的 ${fmtInt(hiddenRows)} 行未渲染，先过滤缩小范围）`}
            {' · '}
            {source === 'socket' ? '推送缓冲' : '来自 GET /api/logs'}
            {paused && ' · 视图已冻结'}
          </span>
          {/*
            时钟收进独立组件：它每 5 秒跳一次，而**这一页不该为它重渲染**。
            详见 `FeedClock` 上的说明（这里是那约 2000 个节点的来源）。
          */}
          <FeedClock lastEventAt={lastEventAt} />
        </div>
      </Panel>
      </div>

      {/* 折叠说明：排查时用得到，平时不该占版面 */}
      <Panel title="本页数据来源" className="mt-3">
        <ul className="space-y-1.5 text-base leading-relaxed text-ink-lo">
          <li>
            • <span className="text-ink-mid">实时</span>：渲染 WebSocket 缓冲 —— 服务端推送的每条{' '}
            <code className="num">log</code> 事件，以及以浮层形式出现的委托、成交与状态事件。
          </li>
          <li>
            • <span className="text-ink-mid">持久化</span>：轮询 <code className="num">GET /api/logs</code>，读取裁剪过的{' '}
            <code className="num">runtime_logs</code> 表（最近 500 行）。
          </li>
          <li>
            • 推送断开后会以指数退避重连（0.8s → 15s），登出时干净关闭。REST 轮询始终继续，
            因此推送中断时本页仍会更新。
          </li>
          <li>
            • 交易所返回的报错文本<span className="text-ink-mid">原样展示</span>
            （例如 Binance 的 <code className="num">-2019</code>）—— 它通常是唯一能定位问题的线索。
          </li>
        </ul>
      </Panel>
    </>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-base-750 bg-base-850/60 px-3 py-2.5">
      <div className="truncate text-xs font-semibold uppercase tracking-[0.12em] text-ink-lo" title={label}>
        {label}
      </div>
      <div className="num mt-1.5 break-all text-2xl leading-tight text-ink-hi" title={value}>
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-xs text-ink-faint">{sub}</div>}
    </div>
  );
}
