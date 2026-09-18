import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createLogger } from '../logger.js';
import { MIGRATIONS } from './schema.js';

const log = createLogger('db');

/** Values SQLite can bind directly. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * node:sqlite binds `undefined` and booleans poorly, and silently coerces
 * `NaN` to null in surprising ways. Normalise everything at the boundary.
 */
function normalise(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (typeof value === 'string' || typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  // Objects and arrays are stored as JSON — convenient for config blobs.
  return JSON.stringify(value);
}

function bind(params: unknown[]): SqlValue[] {
  return params.map(normalise);
}

/**
 * Thin, typed wrapper over `node:sqlite`. Using the built-in driver keeps the
 * project free of native build steps — there is nothing to compile on install.
 */
export class Db {
  private readonly db: DatabaseSync;
  /** Small prepared-statement cache: the trading loop reuses a few hot queries. */
  private readonly cache = new Map<string, StatementSync>();

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA synchronous = NORMAL');
  }

  /** Apply any migrations the database has not seen yet. */
  migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    const current = row?.user_version ?? 0;

    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      log.info(`正在应用数据库迁移 v${migration.version}（${migration.name}）`);
      this.db.exec('BEGIN');
      try {
        this.db.exec(migration.sql);
        // PRAGMA does not accept bound parameters, hence the interpolation of a
        // value that comes from our own frozen migration list.
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw new Error(
          `Migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`,
        );
      }
    }
  }

  private prepare(sql: string): StatementSync {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const result = this.prepare(sql).run(...bind(params));
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    const row = this.prepare(sql).get(...bind(params));
    return row === undefined ? undefined : (row as T);
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.prepare(sql).all(...bind(params)) as T[];
  }

  /** Convenience for `SELECT COUNT(*)`. */
  count(sql: string, ...params: unknown[]): number {
    const row = this.get<{ n: number }>(sql, ...params);
    return row?.n ?? 0;
  }

  /**
   * Run `fn` inside a transaction. Nested calls join the outer transaction so
   * that multi-store operations stay atomic without the callers coordinating.
   */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  private inTransaction = false;

  close(): void {
    this.cache.clear();
    this.db.close();
  }
}

let instance: Db | null = null;

export function initDb(file: string): Db {
  if (instance) return instance;
  instance = new Db(file);
  instance.migrate();
  return instance;
}

export function getDb(): Db {
  if (!instance) throw new Error('Database has not been initialised — call initDb() first');
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}
