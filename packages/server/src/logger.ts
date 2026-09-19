import { BEIJING_OFFSET_MS } from '@aq/shared';
import { env } from './env.js';

/**
 * Dependency-free structured logger. Emits one JSON object per line when
 * `LOG_LEVEL=debug`, and a readable aligned form otherwise.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

const useColor = process.stdout.isTTY === true;

/**
 * 控制台/文件日志的时间戳，**北京时间**。
 *
 * ## 为什么不用 `toISOString()`
 *
 * 那给出的是 UTC，而界面上显示的是浏览器本地时间（操作员在中国 = 北京时间）。
 * 于是同一条日志，在 `journalctl` 里和在「数据与日志」页上**差 8 小时** ——
 * 排查问题时要来回换算，而这一步经常出错。
 *
 * ## 为什么不用 `toLocaleString()`
 *
 * 那用的是**服务器**的时区，而部署环境的时区不受这个仓库控制：
 * 换一台 UTC 的机器，日志会静默变回 UTC，**而且不会有任何报错**。
 *
 * 所以显式按 UTC+8 算，与服务器时区无关（中国不实行夏令时，+8 是常量）。
 *
 * ⚠️ **这只影响给人看的那一行**：写进 `runtime_logs` 的仍是 UTC ISO
 * （`now()`，本项目的存储纪律），界面渲染时转成浏览器本地时间。
 */
function stamp(): string {
  const beijing = new Date(Date.now() + BEIJING_OFFSET_MS);
  return beijing.toISOString().replace('T', ' ').slice(0, 23);
}

/** Optional sink so the UI can stream server logs over the event bus. */
export type LogSink = (level: Level, scope: string, message: string, meta?: unknown) => void;
let sink: LogSink | null = null;
export function setLogSink(fn: LogSink | null): void {
  sink = fn;
}

function emit(level: Level, scope: string, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[env.logLevel]) return;

  if (useColor) {
    const head = `${DIM}${stamp()}${RESET} ${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET} ${DIM}[${scope}]${RESET}`;
    const tail = meta === undefined ? '' : ` ${DIM}${safeJson(meta)}${RESET}`;
    process.stdout.write(`${head} ${message}${tail}\n`);
  } else {
    const tail = meta === undefined ? '' : ` ${safeJson(meta)}`;
    process.stdout.write(`${stamp()} ${level.toUpperCase()} [${scope}] ${message}${tail}\n`);
  }

  sink?.(level, scope, message, meta);
}

function safeJson(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit('debug', scope, m, meta),
    info: (m, meta) => emit('info', scope, m, meta),
    warn: (m, meta) => emit('warn', scope, m, meta),
    error: (m, meta) => emit('error', scope, m, meta),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
