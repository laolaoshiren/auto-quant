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

/** Result snapshot returned by `Db.maintenance()`. */
export interface DbMaintenanceResult {
  /** SQLite auto_vacuum mode: 0 = NONE, 1 = FULL, 2 = INCREMENTAL. */
  autoVacuumMode: number;
  freelistBefore: number;
  freelistAfter: number;
  reclaimedPages: number;
  checkpointBusy: number;
  checkpointLog: number;
  checkpointCheckpointed: number;
}

export interface DbMaintenanceOptions {
  /** Minimum freelist page count before triggering `incremental_vacuum` (default: 512 pages ≈ 2 MB). */
  minFreelistPages?: number;
  /** Maximum pages to reclaim in a single maintenance pass (default: 1024 pages ≈ 4 MB). */
  maxVacuumPages?: number;
  /** WAL checkpoint mode (default: 'PASSIVE', never blocks active writers). */
  checkpointMode?: 'PASSIVE' | 'TRUNCATE';
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
    // 新建空库默认开启 INCREMENTAL auto_vacuum；对已有旧库（auto_vacuum=0）为安全无副作用，
    // 待一次维护性 VACUUM 后即永久生效，彻底避免历史决策裁剪后空闲页无限累积。
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
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
      /*
       * ⚠️ **重建表的迁移必须在事务之外关外键。**
       *
       * `PRAGMA foreign_keys` 在事务**内**是 no-op —— 所以把它写进迁移 SQL 里
       * 没有任何作用，而 `DROP TABLE traders` 会顺着 `ON DELETE CASCADE`
       * 把持仓、成交、订单、决策记录**全部删掉**。
       *
       * 顺序：关外键 → BEGIN → 迁移 → **校验** → COMMIT → 开外键。
       *
       * ## ⚠️ 校验必须在 COMMIT **之前**（外部 issue #161）
       *
       * 原来校验写在 `finally` 里 —— 也就是 `COMMIT` **之后**。那时
       * `user_version = N` 已经提交，于是：
       *
       *   · 第一次失败**是响的**（这里抛错，`initDb` 失败，服务起不来，人会看见）；
       *   · 但**下一次启动**会因 `migration.version <= current`（第 55 行）
       *     **跳过**这个迁移 —— 而它留下的悬空引用被静默固化。
       *     `ON DELETE CASCADE` 的子表（持仓/成交/订单/决策 = **账本**）
       *     会在后续操作里以难读的方式出错。
       *
       * 也就是"第一次报警、第二次静默" —— 本仓库最忌讳的形态。
       *
       * 移进事务内之后，违规时 `throw` 会走**已有的 `ROLLBACK` 分支**，
       * `user_version` 一并回滚，下次启动会**重新尝试**该迁移。
       *
       * 修法的前提是"`PRAGMA foreign_key_check` 在事务内能看到未提交的违规" ——
       * 这一点由 `db/migrationOrder.test.ts` 用真实 SQLite 行为钉住。
       */
      if (migration.detachForeignKeys) this.db.exec('PRAGMA foreign_keys = OFF');
      this.db.exec('BEGIN');
      try {
        this.db.exec(migration.sql);
        // PRAGMA does not accept bound parameters, hence the interpolation of a
        // value that comes from our own frozen migration list.
        this.db.exec(`PRAGMA user_version = ${migration.version}`);

        /*
         * 重建之后必须确认没有留下悬空引用 —— 关着外键做的改动不会被自动检查，
         * 而一张引用了不存在的行的表会在很久以后以别的方式炸出来。
         *
         * **必须在 COMMIT 之前**：违规时 `throw` 走 ROLLBACK，
         * `user_version` 一起回滚，于是下次启动会重试这个迁移。
         */
        if (migration.detachForeignKeys) {
          const violations = this.db.prepare('PRAGMA foreign_key_check').all();
          if (violations.length > 0) {
            throw new Error(
              `迁移 v${migration.version}（${migration.name}）之后外键校验不通过：${violations.length} 处悬空引用`,
            );
          }
        }

        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw new Error(
          `Migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`,
        );
      } finally {
        /* 无论成败都要把外键开回来 —— 否则后续所有写操作都失去保护。 */
        if (migration.detachForeignKeys) this.db.exec('PRAGMA foreign_keys = ON');
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

  /**
   * 轻量级在线维护：在 `auto_vacuum = INCREMENTAL` 模式下按有界步长归还空闲页给操作系统，
   * 并执行非阻塞 WAL checkpoint，防止 SQLite 文件在长期裁剪 `decision_records` 后持续膨胀。
   */
  maintenance(options: DbMaintenanceOptions = {}): DbMaintenanceResult {
    const minFreelistPages = Math.max(1, Math.floor(options.minFreelistPages ?? 512));
    const maxVacuumPages = Math.max(1, Math.floor(options.maxVacuumPages ?? 1024));
    const checkpointMode = options.checkpointMode === 'TRUNCATE' ? 'TRUNCATE' : 'PASSIVE';

    const autoVacuumRow = this.db.prepare('PRAGMA auto_vacuum').get() as
      | { auto_vacuum: number }
      | undefined;
    const autoVacuumMode = Number(autoVacuumRow?.auto_vacuum ?? 0);

    const readFreelist = (): number => {
      const row = this.db.prepare('PRAGMA freelist_count').get() as
        | { freelist_count: number }
        | undefined;
      return Number(row?.freelist_count ?? 0);
    };

    const freelistBefore = readFreelist();
    if (autoVacuumMode === 2 && freelistBefore >= minFreelistPages) {
      this.db.exec(`PRAGMA incremental_vacuum(${maxVacuumPages})`);
    }
    const freelistAfter = readFreelist();

    const cpRow = this.db.prepare(`PRAGMA wal_checkpoint(${checkpointMode})`).get() as
      | { busy: number; log: number; checkpointed: number }
      | undefined;

    return {
      autoVacuumMode,
      freelistBefore,
      freelistAfter,
      reclaimedPages: Math.max(0, freelistBefore - freelistAfter),
      checkpointBusy: Number(cpRow?.busy ?? 0),
      checkpointLog: Number(cpRow?.log ?? 0),
      checkpointCheckpointed: Number(cpRow?.checkpointed ?? 0),
    };
  }

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
