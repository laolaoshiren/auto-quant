/**
 * 数据与日志 —— 结构化、列对齐、全维度筛选的运行时日志台。
 *
 * 2026-11-25 UI/UX 全面重构：
 * - 严格固定列网格（时间 | 级别 | 对象 | 模块 | 内容），彻底告别参差不齐；
 * - 补齐多维度筛选：关键词搜索（含清空）、级别分段（全部/信息/警告/错误 + 计数）、
 *   子系统模块分类筛选、按机器人 / 系统级筛选、实时/持久化切换；
 * - 单行点击即复制，警告/错误带左侧色条；全高贴底不产生双重滚动条。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  Check,
  Copy,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { logScopeKind, logScopeLabel } from '@aq/shared';
import { api, type LogLine } from '../lib/api';
import { useApp, useEvents, type LiveLogLine } from '../lib/store';
import { useDocumentTitle, usePolled, useTicker } from '../lib/hooks';
import { Badge, Button, CopyButton, Dot, ErrorNote, Panel, Select, Spinner3, cn } from '../components/ui';
import { fmtClockOffsetMs, fmtInt, timeAgo } from '../lib/format';
import { shouldBackfill } from '../lib/logBackfill';

type Level = 'all' | 'info' | 'warn' | 'error';
type ScopeKind = 'all' | 'runtime' | 'ai' | 'exchange' | 'data' | 'other';

const MAX_RENDERED = 500;

function FeedClock({ lastEventAt }: { lastEventAt: number | null }) {
  const tick = useTicker(5000);
  return (
    <span>
      最近事件 {timeAgo(lastEventAt ? new Date(lastEventAt).toISOString() : null)} · 时刻{' '}
      {new Date(tick).toLocaleTimeString('en-GB', { hour12: false })}
    </span>
  );
}

function UptimeReadout({
  baseSeconds,
  loadedAt,
}: {
  baseSeconds: number | null;
  loadedAt: number | null;
}) {
  const now = useTicker(30_000);
  if (baseSeconds === null) return <span className="text-ink-mid">—</span>;
  const elapsedSec = loadedAt === null ? 0 : Math.max(0, Math.floor((now - loadedAt) / 1000));
  const totalMinutes = Math.floor((baseSeconds + elapsedSec) / 60);
  return <span className="text-ink-mid">{totalMinutes} 分</span>;
}

const SOCKET_STATUS_LABEL: Record<string, string> = {
  open: '实时推送在线',
  connecting: '推送连接中',
  closed: '推送已断开',
  idle: '推送未连接',
};

function safeIsoTime(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value || '—';
}

function safeClockTime(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString('en-GB', { hour12: false }) : '—';
}

const LEVELS: Array<{ id: Level; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'info', label: '信息' },
  { id: 'warn', label: '警告' },
  { id: 'error', label: '错误' },
];

const SCOPE_CATEGORIES: Array<{ id: ScopeKind; label: string }> = [
  { id: 'all', label: '全部模块' },
  { id: 'runtime', label: '交易与主程序' },
  { id: 'ai', label: 'AI 模型与智能体' },
  { id: 'exchange', label: '交易所接口' },
  { id: 'data', label: '数据与账本' },
  { id: 'other', label: '自检与其它' },
];

const LEVEL_PILL: Record<string, { label: string; cls: string; rowCls: string }> = {
  error: {
    label: '错误',
    cls: 'border-down/40 bg-down/15 text-down',
    rowCls: 'border-l-2 border-l-down bg-down/[0.08]',
  },
  warn: {
    label: '警告',
    cls: 'border-warn/40 bg-warn/15 text-warn',
    rowCls: 'border-l-2 border-l-warn bg-warn/[0.05]',
  },
  info: {
    label: '信息',
    cls: 'border-base-700 bg-base-850 text-ink-lo',
    rowCls: 'border-l-2 border-l-transparent',
  },
};

const SCOPE_TONE: Record<string, string> = {
  exchange: 'border-accent/30 bg-accent/12 text-accent',
  ai: "border-violet-500/30 bg-violet-500/12 text-violet-300 [[data-skin='light']_&]:text-violet-700",
  data: "border-cyan-500/30 bg-cyan-500/12 text-cyan-300 [[data-skin='light']_&]:text-cyan-700",
  runtime: 'border-base-700 bg-base-800/80 text-ink-mid',
  other: 'border-base-750 bg-base-850 text-ink-lo',
};

function highlightNumbers(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /([+-]\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)(?=\s?(?:USDT|U|ms|%|x(?![a-z])))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const num = m[1] ?? m[2] ?? '';
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
  const healthLoadedAt = useApp((s) => s.healthLoadedAt);
  const traders = useApp((s) => s.traders);

  const [level, setLevel] = useState<Level>('all');
  const [scopeKind, setScopeKind] = useState<ScopeKind>('all');
  const [traderFilter, setTraderFilter] = useState<string>('all'); // 'all' | 'system' | '<id>'
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [source, setSource] = useState<'socket' | 'rest'>('socket');
  const [copied, setCopied] = useState(false);
  const [copiedRowKey, setCopiedRowKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    },
    [],
  );

  const restQuery = usePolled((signal) => api.logs(500, signal), {
    intervalMs: socketStatus === 'open' ? 30_000 : 8000,
  });

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

  const hydratedOnce = useRef(false);
  const clearedByUser = useRef(false);

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

  const frozen = useRef<LiveLogLine[] | null>(null);
  if (paused && frozen.current === null) frozen.current = lines;
  if (!paused && frozen.current !== null) frozen.current = null;
  const visible = frozen.current ?? lines;

  const traderNameMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const t of traders) map.set(t.id, t.name);
    return map;
  }, [traders]);

  const traderOptions = useMemo(() => {
    const ids = new Set<number>();
    for (const t of traders) ids.add(t.id);
    for (const line of visible) {
      if (line.traderId !== null) ids.add(line.traderId);
    }
    return [...ids].sort((a, b) => a - b);
  }, [traders, visible]);

  const matched = useMemo(() => {
    const term = search.trim().toLowerCase();
    return visible.filter((line) => {
      if (level !== 'all' && line.level !== level) return false;
      if (scopeKind !== 'all') {
        const kind = line.scope ? logScopeKind(line.scope) : 'other';
        if (kind !== scopeKind) return false;
      }
      if (traderFilter === 'system') {
        if (line.traderId !== null) return false;
      } else if (traderFilter !== 'all') {
        if (String(line.traderId ?? '') !== traderFilter) return false;
      }
      if (term) {
        const scopeText = line.scope ? `${line.scope} ${logScopeLabel(line.scope)}`.toLowerCase() : '';
        if (!line.message.toLowerCase().includes(term) && !scopeText.includes(term)) return false;
      }
      return true;
    });
  }, [visible, level, scopeKind, traderFilter, search]);

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
          `${safeIsoTime(line.timestamp)} ${line.level.toUpperCase().padEnd(5)} ${
            line.traderId !== null ? `t${line.traderId} ` : 'sys '
          }${line.scope ? `[${line.scope}] ` : ''}${line.message}`,
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 1400);
    } catch {
      /* 浏览器拒绝剪贴板时不弹错 */
    }
  };

  const copySingleLine = async (rowKey: string, line: LiveLogLine) => {
    const text = `${safeIsoTime(line.timestamp)} ${line.level.toUpperCase()} ${
      line.traderId !== null ? `t${line.traderId} ` : ''
    }${line.scope ? `[${line.scope}] ` : ''}${line.message}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedRowKey(rowKey);
      window.setTimeout(() => setCopiedRowKey((prev) => (prev === rowKey ? null : prev)), 1200);
    } catch {
      /* ignore */
    }
  };

  const filtering =
    level !== 'all' || scopeKind !== 'all' || traderFilter !== 'all' || search.trim().length > 0;
  const resetFilters = () => {
    setLevel('all');
    setScopeKind('all');
    setTraderFilter('all');
    setSearch('');
  };
  const hasLines = shown.length > 0;

  return (
    <div className="page-fill h-full gap-3">
      {/* 页头 + 运行遥测概览条 */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight text-ink-hi">数据与日志</h1>
          <Badge tone={socketStatus === 'open' ? 'up' : 'warn'}>
            <Dot tone={socketStatus === 'open' ? 'up' : 'warn'} pulse={socketStatus === 'open'} />
            {SOCKET_STATUS_LABEL[socketStatus] ?? '推送状态未知'}
          </Badge>
          {socketStatus !== 'open' && (
            <Button size="sm" onClick={() => connect()}>
              <RotateCw aria-hidden className="h-3.5 w-3.5" />
              重新连接
            </Button>
          )}
        </div>

        <div className="num flex flex-wrap items-center gap-2 text-xs text-ink-lo">
          <span className="rounded-md border border-base-750 bg-base-900 px-2.5 py-1">
            时钟偏移 <span className="font-medium text-ink-hi">{fmtClockOffsetMs(system?.clockOffsetMs)}</span>
          </span>
          <span className="rounded-md border border-base-750 bg-base-900 px-2.5 py-1">
            API 权重{' '}
            <span className="font-medium text-ink-hi">
              {fmtInt(system?.weightUsed)} / {fmtInt(system?.weightLimit)}
            </span>
          </span>
          <span className="rounded-md border border-base-750 bg-base-900 px-2.5 py-1">
            可交易对 <span className="font-medium text-ink-hi">{fmtInt(system?.tradableSymbols)}</span>
          </span>
          <span className="rounded-md border border-base-750 bg-base-900 px-2.5 py-1">
            已运行 <UptimeReadout baseSeconds={health?.uptimeSeconds ?? null} loadedAt={healthLoadedAt} />
          </span>
        </div>
      </div>

      {/* 日志主面板：吃满剩余高度 */}
      <Panel
        padded={false}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        bodyClassName="flex min-h-0 flex-1 flex-col p-0"
      >
        {/* 顶部工具与多维筛选栏 */}
        <div className="flex shrink-0 flex-col gap-2 border-b border-base-800 bg-base-900 px-3 py-2.5">
          {/* 第一行：级别分段 + 来源切换 + 操作组 */}
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="按级别过滤"
              className="inline-flex items-center rounded-lg border border-base-750 bg-base-950 p-0.5"
            >
              {LEVELS.map((item) => {
                const active = level === item.id;
                const count =
                  item.id === 'all' ? visible.length : counts[item.id as 'info' | 'warn' | 'error'];
                const countTone =
                  item.id === 'error' && count > 0
                    ? 'text-down'
                    : item.id === 'warn' && count > 0
                      ? 'text-warn'
                      : active
                        ? 'text-ink-hi/80'
                        : 'text-ink-faint';
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setLevel(item.id)}
                    className={cn(
                      'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition',
                      active
                        ? 'bg-base-800 text-ink-strong shadow-sm'
                        : 'text-ink-lo hover:text-ink-hi',
                    )}
                  >
                    <span>{item.label}</span>
                    <span className={cn('num text-[11px]', countTone)}>{fmtInt(count)}</span>
                  </button>
                );
              })}
            </div>

            <div
              role="group"
              aria-label="日志来源"
              className="inline-flex items-center rounded-lg border border-base-750 bg-base-950 p-0.5"
            >
              <button
                type="button"
                aria-pressed={source === 'socket'}
                onClick={() => setSource('socket')}
                className={cn(
                  'h-7 rounded-md px-2.5 text-xs font-medium transition',
                  source === 'socket' ? 'bg-base-800 text-ink-strong' : 'text-ink-lo hover:text-ink-hi',
                )}
              >
                实时流
              </button>
              <button
                type="button"
                aria-pressed={source === 'rest'}
                onClick={() => setSource('rest')}
                className={cn(
                  'h-7 rounded-md px-2.5 text-xs font-medium transition',
                  source === 'rest' ? 'bg-base-800 text-ink-strong' : 'text-ink-lo hover:text-ink-hi',
                )}
              >
                持久化
              </button>
            </div>

            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant={follow ? 'primary' : 'ghost'}
                aria-pressed={follow}
                title="开启后新日志到达自动滚到底部"
                onClick={() => setFollow((value) => !value)}
              >
                <ArrowDownToLine aria-hidden className="h-3.5 w-3.5" />
                跟随
              </Button>
              <Button
                size="sm"
                variant={paused ? 'warn' : 'ghost'}
                aria-pressed={paused}
                title="暂停仅冻结视图，后台继续接收推送"
                onClick={() => setPaused((value) => !value)}
              >
                {paused ? <Play aria-hidden className="h-3.5 w-3.5" /> : <Pause aria-hidden className="h-3.5 w-3.5" />}
                {paused ? '恢复' : '暂停'}
              </Button>
              <CopyButton onCopy={() => void copyBuffer()} copied={copied} />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  clearedByUser.current = false;
                  hydratedOnce.current = false;
                  void restQuery.reload();
                }}
                busy={restQuery.loading}
                title="重新拉取服务端持久化日志"
              >
                <RefreshCw aria-hidden className="h-3.5 w-3.5" />
                刷新
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-down hover:border-down/40 hover:bg-down/10 hover:text-down"
                onClick={() => {
                  clearedByUser.current = true;
                  clearLogs();
                }}
                disabled={source !== 'socket'}
                title={source === 'socket' ? '清空当前实时推送缓冲' : '持久化日志来自服务端，无法在此清空'}
              >
                <Trash2 aria-hidden className="h-3.5 w-3.5" />
                清空
              </Button>
            </div>
          </div>

          {/* 第二行：关键词搜索 + 模块过滤 + 对象过滤 + 命中计数 */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1 sm:max-w-sm">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
              />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索日志内容、币种、错误码或模块…"
                aria-label="过滤日志消息"
                className="input num h-8 w-full pl-8 pr-7 text-xs"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="清空搜索词"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-faint hover:text-ink-hi"
                >
                  <X aria-hidden className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="w-40">
              <Select
                aria-label="按模块过滤"
                value={scopeKind}
                onChange={(event) => setScopeKind(event.target.value as ScopeKind)}
              >
                {SCOPE_CATEGORIES.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.label}
                  </option>
                ))}
              </Select>
            </div>

            <div className="w-44">
              <Select
                aria-label="按机器人或系统过滤"
                value={traderFilter}
                onChange={(event) => setTraderFilter(event.target.value)}
              >
                <option value="all">全部对象（系统 + 机器人）</option>
                <option value="system">仅系统级日志</option>
                {traderOptions.map((id) => (
                  <option key={id} value={String(id)}>
                    #{id} {traderNameMap.get(id) ?? `机器人 ${id}`}
                  </option>
                ))}
              </Select>
            </div>

            {filtering && (
              <div className="flex items-center gap-2 text-xs">
                <span className="num text-ink-lo">
                  命中 <strong className="text-ink-hi">{fmtInt(matched.length)}</strong> / {fmtInt(visible.length)}
                </span>
                <button
                  type="button"
                  onClick={resetFilters}
                  className="text-accent hover:underline"
                >
                  重置筛选
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 固定表头（桌面端严格列对齐） */}
        <div className="hidden shrink-0 grid-cols-[72px_54px_76px_132px_minmax(0,1fr)_28px] items-center gap-2 border-b border-base-800 bg-base-850/80 px-3 py-1.5 text-[11px] font-semibold tracking-wider text-ink-lo md:grid">
          <span>时间</span>
          <span className="text-center">级别</span>
          <span>对象</span>
          <span>模块</span>
          <span>消息内容</span>
          <span className="sr-only">复制</span>
        </div>

        {/* 日志主体滚动区 */}
        <div
          ref={scrollRef}
          className={cn(
            'overflow-y-auto overflow-x-hidden bg-base-950 font-mono text-[12.5px] leading-relaxed',
            hasLines ? 'min-h-0 flex-1' : 'min-h-0',
          )}
        >
          {source === 'rest' && restQuery.loading && shown.length === 0 ? (
            <Spinner3 label="正在加载持久化日志" />
          ) : source === 'rest' && restQuery.error && shown.length === 0 ? (
            <div className="space-y-2 p-3">
              <ErrorNote>读取持久化日志失败：{restQuery.error}</ErrorNote>
              <Button size="sm" busy={restQuery.loading} onClick={() => restQuery.reload()}>
                重试
              </Button>
            </div>
          ) : shown.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-6">
              <span className="font-sans text-sm text-ink-lo">
                {filtering
                  ? '没有匹配当前筛选条件的日志 —— 请放宽级别、模块或关键词。'
                  : '暂无日志记录，服务运行后将自动推送写入。'}
              </span>
              {filtering ? (
                <Button size="sm" onClick={resetFilters}>
                  清除全部筛选
                </Button>
              ) : (
                <Button size="sm" onClick={() => setSource('rest')}>
                  查看持久化日志
                </Button>
              )}
            </div>
          ) : (
            <div className="divide-y divide-base-800/40">
              {shown.map((line) => {
                const rowKey = `${line.id}-${line.timestamp}`;
                const lvl = LEVEL_PILL[line.level] ?? LEVEL_PILL.info!;
                const kind = line.scope ? logScopeKind(line.scope) : 'other';
                const scopeName = line.scope ? logScopeLabel(line.scope) : '主程序';
                const traderName = line.traderId !== null ? traderNameMap.get(line.traderId) : null;
                const isCopied = copiedRowKey === rowKey;

                return (
                  <div
                    key={rowKey}
                    className={cn(
                      'group grid grid-cols-1 items-start gap-x-2 gap-y-1 px-3 py-1.5 transition-colors hover:bg-base-850/70 md:grid-cols-[72px_54px_76px_132px_minmax(0,1fr)_28px]',
                      lvl.rowCls,
                    )}
                  >
                    {/* 时间 */}
                    <span
                      className="num text-xs text-ink-faint"
                      title={safeIsoTime(line.timestamp)}
                    >
                      {safeClockTime(line.timestamp)}
                    </span>

                    {/* 级别 */}
                    <span className="flex md:justify-center">
                      <span
                        className={cn(
                          'inline-flex h-5 w-11 items-center justify-center rounded border text-[11px] font-medium leading-none',
                          lvl.cls,
                        )}
                      >
                        {lvl.label}
                      </span>
                    </span>

                    {/* 对象（机器人 / 系统） */}
                    <span className="min-w-0 truncate text-xs">
                      {line.traderId !== null ? (
                        <span
                          className="num inline-flex max-w-full items-center truncate rounded border border-accent/25 bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent"
                          title={traderName ? `机器人 #${line.traderId} · ${traderName}` : `机器人 #${line.traderId}`}
                        >
                          #{line.traderId}
                          {traderName ? ` ${traderName}` : ''}
                        </span>
                      ) : (
                        <span className="text-ink-faint">系统</span>
                      )}
                    </span>

                    {/* 模块 */}
                    <span className="min-w-0">
                      <span
                        className={cn(
                          'inline-flex max-w-full items-center truncate rounded border px-1.5 py-0.5 font-sans text-[11px] font-medium leading-tight',
                          SCOPE_TONE[kind] ?? SCOPE_TONE.other,
                        )}
                        title={line.scope ? `模块：${scopeName}（${line.scope}）` : '主程序'}
                      >
                        {scopeName}
                      </span>
                    </span>

                    {/* 正文 */}
                    <span className="min-w-0 break-words text-ink-mid">
                      {highlightNumbers(line.message)}
                    </span>

                    {/* 单行快捷复制 */}
                    <button
                      type="button"
                      onClick={() => void copySingleLine(rowKey, line)}
                      title="复制此行日志"
                      aria-label="复制此行日志"
                      className="hidden h-6 w-6 items-center justify-center rounded text-ink-faint opacity-0 transition hover:bg-base-800 hover:text-ink-hi group-hover:opacity-100 md:inline-flex"
                    >
                      {isCopied ? (
                        <Check aria-hidden className="h-3.5 w-3.5 text-up" />
                      ) : (
                        <Copy aria-hidden className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 状态底栏 */}
        <div className="num flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-base-800 bg-base-900 px-3 py-1.5 text-xs text-ink-faint">
          <span>
            显示 <span className="text-ink-mid">{fmtInt(shown.length)}</span> / {fmtInt(matched.length)} 行
            {hiddenRows > 0 && `（已省略更早 ${fmtInt(hiddenRows)} 行，请用筛选缩小范围）`}
            {' · '}
            {source === 'socket' ? '实时 WebSocket 缓冲' : '持久化数据库（最近 500 行）'}
            {paused && ' · 已暂停滚动'}
          </span>
          <FeedClock lastEventAt={lastEventAt} />
        </div>
      </Panel>
    </div>
  );
}
