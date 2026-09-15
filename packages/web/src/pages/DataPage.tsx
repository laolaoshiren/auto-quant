import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type LogLine } from '../lib/api';
import { useApp, useEvents, type LiveLogLine } from '../lib/store';
import { useDocumentTitle, usePolled, useTicker } from '../lib/hooks';
import { Badge, Button, Empty, Panel, Spinner3, TextInput } from '../components/ui';
import { SectionHeading } from '../components/Badges';
import { fmtClockOffset, fmtInt, timeAgo } from '../lib/format';

type Level = 'all' | 'info' | 'warn' | 'error';

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

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return visible.filter((line) => {
      if (level !== 'all' && line.level !== level) return false;
      if (term && !line.message.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [visible, level, search]);

  useEffect(() => {
    if (!follow || paused) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [filtered.length, follow, paused]);

  const counts = useMemo(() => {
    const acc = { info: 0, warn: 0, error: 0 };
    for (const line of visible) {
      if (line.level === 'warn') acc.warn += 1;
      else if (line.level === 'error') acc.error += 1;
      else acc.info += 1;
    }
    return acc;
  }, [visible]);

  return (
    <div className="space-y-3">
      <SectionHeading
        title="数据与日志"
        sub="运行时日志流、连接健康状态，以及控制台背后的原始行情计数器。"
        right={
          <span className="flex items-center gap-1.5">
            <Badge tone={socketStatus === 'open' ? 'up' : 'warn'}>
              {socketStatus === 'open' ? '推送已连接' : `推送 ${socketStatus}`}
            </Badge>
            {socketStatus !== 'open' && (
              <Button small onClick={() => connect()}>
                重新连接
              </Button>
            )}
          </span>
        }
      />

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Metric label="环境" value={system?.environment ?? '—'} sub={system?.environmentLabel} />
        <Metric label="时钟偏移" value={fmtClockOffset(system?.clockOffsetMs)} />
        <Metric
          label="API 权重"
          value={`${fmtInt(system?.weightUsed)} / ${fmtInt(system?.weightLimit)}`}
          sub="每分钟"
        />
        <Metric label="可交易对" value={fmtInt(system?.tradableSymbols)} />
        <Metric label="服务运行时长" value={health ? `${Math.floor(health.uptimeSeconds / 60)}分` : '—'} />
        <Metric
          label="日志行数"
          value={fmtInt(visible.length)}
          sub={`${counts.error} 错误 · ${counts.warn} 警告`}
        />
      </div>

      <Panel
        title="运行时日志"
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-0.5">
              {(['all', 'info', 'warn', 'error'] as Level[]).map((value) => (
                <Button key={value} small variant={level === value ? 'primary' : 'ghost'} onClick={() => setLevel(value)}>
                  {value}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-0.5">
              <Button small variant={source === 'socket' ? 'primary' : 'ghost'} onClick={() => setSource('socket')}>
                实时
              </Button>
              <Button small variant={source === 'rest' ? 'primary' : 'ghost'} onClick={() => setSource('rest')}>
                持久化
              </Button>
            </div>
            <Button small variant={follow ? 'primary' : 'ghost'} onClick={() => setFollow((value) => !value)}>
              跟随 {follow ? '开' : '关'}
            </Button>
            <Button small variant={paused ? 'warn' : 'ghost'} onClick={() => setPaused((value) => !value)}>
              {paused ? '已暂停' : '暂停'}
            </Button>
            <Button small onClick={() => clearLogs()} disabled={source !== 'socket'}>
              清空
            </Button>
            <Button small onClick={() => restQuery.reload()} busy={restQuery.loading}>
              重新加载
            </Button>
          </div>
        }
        bodyClassName="p-2"
        padded={false}
      >
        <TextInput
          className="mb-2"
          placeholder="过滤消息…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />

        <div
          ref={scrollRef}
          className="h-[520px] overflow-y-auto rounded border border-base-800 bg-base-950 p-1 font-mono text-xs leading-relaxed"
        >
          {source === 'rest' && restQuery.loading && filtered.length === 0 ? (
            <Spinner3 label="正在加载持久化日志" />
          ) : filtered.length === 0 ? (
            <Empty message="没有匹配的日志行。" hint="服务运行时，日志会通过 WebSocket 持续推送。" />
          ) : (
            filtered.map((line) => (
              <div key={`${line.id}-${line.timestamp}`} className="flex gap-2 rounded px-1 py-px hover:bg-base-850/60">
                <span className="shrink-0 text-ink-faint">
                  {new Date(line.timestamp).toLocaleTimeString('en-GB', { hour12: false })}
                </span>
                <span
                  className={`shrink-0 uppercase ${
                    line.level === 'error' ? 'text-down' : line.level === 'warn' ? 'text-warn' : 'text-ink-lo'
                  }`}
                >
                  {line.level.padEnd(5, ' ')}
                </span>
                {line.traderId !== null && <span className="shrink-0 text-accent">t{line.traderId}</span>}
                <span className="whitespace-pre-wrap break-words text-ink-mid">{line.message}</span>
              </div>
            ))
          )}
        </div>

        <div className="num mt-1 flex items-center justify-between text-2xs text-ink-faint">
          <span>
            {filtered.length} / {visible.length} 行 · {source === 'socket' ? '推送缓冲' : '来自 GET /api/logs'}
          </span>
          <span>
            最近事件 {timeAgo(lastEventAt ? new Date(lastEventAt).toISOString() : null)} · 时刻{' '}
            {new Date(tick).toLocaleTimeString('en-GB', { hour12: false })}
          </span>
        </div>
      </Panel>

      <Panel title="本页数据来源">
        <ul className="space-y-1 text-xs leading-relaxed text-ink-lo">
          <li>
            • <span className="text-ink-mid">实时</span> 渲染 WebSocket 缓冲：服务端推送的每条{' '}
            <code className="num">log</code> 事件，以及以浮层形式出现的委托、成交与状态事件。
          </li>
          <li>
            • <span className="text-ink-mid">持久化</span> 轮询 <code className="num">GET /api/logs</code>，读取裁剪过的{' '}
            <code className="num">runtime_logs</code> 表（最近 500 行）。
          </li>
          <li>
            • 推送断开后会以指数退避重连（0.8s → 15s），登出时干净关闭。REST 轮询始终继续，
            因此推送中断时控制台仍会更新。
          </li>
        </ul>
      </Panel>
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-base-800 bg-base-900 px-2.5 py-2">
      <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-ink-lo">{label}</div>
      <div className="num mt-1 truncate text-sm text-ink-hi" title={value}>
        {value}
      </div>
      {sub && <div className="truncate text-2xs text-ink-faint">{sub}</div>}
    </div>
  );
}
