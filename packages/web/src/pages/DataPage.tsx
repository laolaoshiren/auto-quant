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
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Pause, Play, RefreshCw, RotateCw, Trash2 } from 'lucide-react';
import { logScopeLabel } from '@aq/shared';
import { api, type LogLine } from '../lib/api';
import { useApp, useEvents, type LiveLogLine } from '../lib/store';
import { useDocumentTitle, usePolled, useTicker } from '../lib/hooks';
import { Badge, Button, CopyButton, ErrorNote, Panel, Spinner3, TextInput, cn } from '../components/ui';
import { fmtClockOffsetMs, fmtInt, timeAgo, tradingEnvironmentLabel } from '../lib/format';

type Level = 'all' | 'info' | 'warn' | 'error';

/**
 * 一次渲染的日志行上限。
 *
 * 推送缓冲可能有几千行，全量渲染会让展开/暂停/打字都卡住 ——
 * 而这恰恰是排查问题时最不能卡的时刻。超出部分从**最新的**开始截取，
 * 因为最新的行才是要看的。
 */
const MAX_RENDERED = 500;

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
  const tick = useTicker(5000);

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

  // Backfill the pane from the persisted log table on first load.
  useEffect(() => {
    if (source === 'socket' && restLines.length > 0 && liveLogs.length === 0) {
      hydrateLogs(restLines);
    }
  }, [restLines, liveLogs.length, hydrateLogs, source]);

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
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
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

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
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
              onClick={() => clearLogs()}
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
          </div>
        }
        bodyClassName="p-2"
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
            hasLines ? 'h-[min(70vh,560px)]' : 'min-h-0',
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
                className="flex items-start gap-2 rounded px-1 py-0.5 hover:bg-base-850/60"
              >
                <span className="num shrink-0 text-ink-faint" title={new Date(line.timestamp).toISOString()}>
                  {new Date(line.timestamp).toLocaleTimeString('en-GB', { hour12: false })}
                </span>
                <span
                  className={cn(
                    'w-8 shrink-0 select-none text-center text-xs font-semibold',
                    LEVEL_TEXT[line.level] ?? 'text-ink-lo',
                  )}
                >
                  {LEVEL_LABEL[line.level] ?? line.level}
                </span>
                {line.traderId !== null && (
                  <span className="num shrink-0 text-accent" title={`机器人 #${line.traderId}`}>
                    t{line.traderId}
                  </span>
                )}
                {/*
                  来源用**中文标签**渲染，`title` 里保留原始码。

                  服务端原来把 `[binance:bootstrap]` 拼在正文最前面 ——
                  那是**内部模块名出现在给人看的文本里**。现在来源单独传，
                  这里翻成中文（「币安 · 启动检查」），而原始码仍然可查
                  （悬停可见），按来源筛选也仍然用原始码。
                */}
                {line.scope && (
                  <span
                    className="shrink-0 rounded bg-base-850 px-1 text-xs text-ink-faint"
                    title={`来源：${line.scope}`}
                  >
                    {logScopeLabel(line.scope)}
                  </span>
                )}
                {/* break-all：交易所原文没有空格，break-words 兜不住 */}
                <span className="min-w-0 flex-1 break-all text-ink-mid">{line.message}</span>
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
          <span>
            最近事件 {timeAgo(lastEventAt ? new Date(lastEventAt).toISOString() : null)} · 时刻{' '}
            {new Date(tick).toLocaleTimeString('en-GB', { hour12: false })}
          </span>
        </div>
      </Panel>

      {/* 折叠说明：排查时用得到，平时不该占版面 */}
      <Panel title="本页数据来源">
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
    </div>
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
