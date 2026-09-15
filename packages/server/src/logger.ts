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

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
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
