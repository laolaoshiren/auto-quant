import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Db } from './index.js';
import { MIGRATIONS } from './schema.js';

/**
 * `M12_STRATEGY_OPTIONAL` —— 重建 `traders` 表的那个迁移。
 *
 * ## 为什么这个文件必须存在
 *
 * M12 是**本项目第一个 `DROP TABLE` 的迁移**，而 `traders` 被一大票子表引用
 * （`positions` / `trades` / `orders` / `decision_records` / `agent_*` … 全部
 * `ON DELETE CASCADE`）。DEFAULT 情况下 `DROP TABLE traders` 会顺着外键
 * **把那些表的数据全部删掉** —— 而那是账本。
 *
 * 之所以能安全，全靠执行器在 `BEGIN` **之前**关掉了外键
 * （`Migration.detachForeignKeys`，见 `db/index.ts` 的 `migrate()`）——
 * 因为 `PRAGMA foreign_keys` 在事务内是 no-op，写进迁移 SQL 里没有用。
 *
 * **这个"能安全"是一个前提，不是一个事实** —— 所以这里用一个真实形状的库
 * 把它钉住：推到 v11、插入账户/策略/两个机器人/持仓/成交/订单，
 * 再走**正式的 `Db.migrate()`**（就是服务启动时那条路径）应用 v12，
 * 然后断言子表**一条都没少**。
 *
 * 按 AGENTS.md §3.6：临时目录，绝不碰 `data/`。
 */

/** 迁移到 `upto` 为止（含），并把 `user_version` 设成它。 */
function pushTo(db: DatabaseSync, upto: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version > upto) break;
    db.exec(migration.sql);
  }
  db.exec(`PRAGMA user_version = ${upto}`);
}

test('★ M12 重建 traders 表时不会级联删掉子表数据', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aq-mig-'));
  const file = path.join(dir, 'migration.sqlite');
  /*
   * ⚠️ **`db` 必须在 `finally` 里关。**
   *
   * 第一版把它放在函数体末尾 —— 于是任何一条断言失败都会跳过关闭，
   * 而 Windows 上那个文件仍然被 sqlite 持有，`rmSync` 抛 `EBUSY`，
   * **把真正的断言错误盖掉**（看起来像"清理失败"，其实是"数据被删了"）。
   * 一个会把失败原因伪装成别的东西的测试，比没有测试更危险。
   */
  let db: Db | null = null;
  try {
    /* ── ① 把库推到 v11，并插入与 traders 有关系的数据 ───────────────── */
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys = ON');
    pushTo(raw, 11);

    raw.exec(`
      INSERT INTO exchange_accounts (id, exchange, label, api_key, api_secret_enc, testnet, can_trade, created_at, updated_at)
        VALUES (1, 'binance', 'acc', 'k', 'v1:00:00:00', 0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO ai_models (id, provider, label, model, base_url, api_key_enc, temperature, max_tokens, timeout_seconds, max_retries, created_at, updated_at)
        VALUES (1, 'deepseek', 'm', 'm', 'https://example.invalid', '', 0.2, 4096, 60, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO strategies (id, name, description, config_json, is_default, created_at, updated_at)
        VALUES (1, '默认策略 — 稳健', '', '{}', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      -- ① AI 托管的机器人：**仍然指向策略**（这正是迁移要修正的老数据形状）
      INSERT INTO traders (id, name, exchange_account_id, ai_model_id, strategy_id, cycle_interval_minutes,
                           initial_equity, status, last_cycle_number, consecutive_failures,
                           created_at, updated_at, mode)
        VALUES (9, 'AI托管测试', 1, 1, 1, 45, 20.78, 'running', 3, 0,
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'ai_managed');
      -- ② 固定策略的机器人：迁移后**必须保留**它的引用
      INSERT INTO traders (id, name, exchange_account_id, ai_model_id, strategy_id, cycle_interval_minutes,
                           initial_equity, status, last_cycle_number, consecutive_failures,
                           created_at, updated_at, mode)
        VALUES (10, '固定策略机器人', 1, 1, 1, 15, 5, 'stopped', 0, 0,
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'strategy');

      INSERT INTO positions (id, trader_id, symbol, side, quantity, entry_price, leverage, liquidation_price,
                             margin_used, stop_loss, take_profit, stop_order_id, tp_order_id, open_reasoning,
                             opened_at, status)
        VALUES (1, 9, 'HYPEUSDT', 'long', 0.21, 97.2, 5, 80, 4, 96.5, 99.45, 's1', 't1', '', '2026-01-01T00:00:00.000Z', 'closed');
      INSERT INTO trades (id, trader_id, symbol, side, quantity, entry_price, exit_price, leverage, pnl, pnl_percent,
                          fee, close_reason, opened_at, closed_at, hold_minutes, entry_fee, funding_fee, net_pnl, source)
        VALUES (1, 9, 'HYPEUSDT', 'long', 0.21, 97.2, 96.451, 5, -0.16, -4.2,
                0.01, 'stop_loss', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 60, 0.005, 0, -0.17, 'bot');
      INSERT INTO orders (id, trader_id, symbol, side, type, purpose, status, quantity, filled_qty,
                          client_order_id, created_at, updated_at)
        VALUES (1, 9, 'HYPEUSDT', 'SELL', 'STOP_MARKET', 'stop_loss', 'FILLED', 0.21, 0.21,
                'cid-1', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');
    `);
    raw.close();

    /* ── ② 走**正式路径**应用 v12（服务启动时就是这条） ────────────────── */
    db = new Db(file);
    db.exec('PRAGMA foreign_keys = ON');
    db.migrate();

    /* ── ③ 子表一条都没少 —— 这是这个迁移最要紧的性质 ────────────────── */
    assert.equal(db.count('SELECT COUNT(*) AS n FROM positions'), 1, 'positions 被级联删掉了');
    assert.equal(db.count('SELECT COUNT(*) AS n FROM trades'), 1, 'trades 被级联删掉了');
    assert.equal(db.count('SELECT COUNT(*) AS n FROM orders'), 1, 'orders 被级联删掉了');
    assert.equal(db.count('SELECT COUNT(*) AS n FROM traders'), 2, 'traders 自己少行了');

    /* ── ④ 老数据里"AI 托管却指向策略"的组合被置空 ──────────────────── */
    const ai = db.get<{ strategy_id: number | null; mode: string }>(
      'SELECT strategy_id, mode FROM traders WHERE id = 9',
    )!;
    assert.equal(ai.mode, 'ai_managed');
    assert.equal(
      ai.strategy_id,
      null,
      'AI 托管的机器人迁移后不该再引用任何策略 —— 否则"删掉所有策略"这件事仍然会被外键挡住',
    );

    /* ── ⑤ 固定策略的机器人保留引用（迁移不能一刀切） ──────────────── */
    const fixed = db.get<{ strategy_id: number | null }>(
      'SELECT strategy_id FROM traders WHERE id = 10',
    )!;
    assert.equal(fixed.strategy_id, 1, '固定策略模式的机器人必须保留它的策略引用');

    /* ── ⑥ 现在**删掉那个策略**：不再被外键挡住，引用被置空而不是级联删机器人 ── */
    db.run('DELETE FROM strategies WHERE id = 1');
    assert.equal(
      db.count('SELECT COUNT(*) AS n FROM traders'),
      2,
      '删策略不该把机器人一起删掉（那会连带删掉它的成交与持仓）',
    );
    assert.equal(
      db.get<{ strategy_id: number | null }>('SELECT strategy_id FROM traders WHERE id = 10')!.strategy_id,
      null,
      'ON DELETE SET NULL 应当把引用置空',
    );
    assert.equal(db.count('SELECT COUNT(*) AS n FROM trades'), 1, '删策略不该动账本');

    /* ── ⑦ 迁移之后外键是合着的（执行器要恢复它） ──────────────────── */
    const fk = db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')!;
    assert.equal(fk.foreign_keys, 1, '迁移结束后必须把外键恢复成 ON');
  } finally {
    try {
      db?.close();
    } catch {
      /* 已经关过就算了 —— 这里不该影响真正的断言结果。 */
    }
    /*
     * ⚠️ **临时目录删不掉不该让这个用例失败。**
     *
     * Windows 上 sqlite 关闭连接之后仍会短暂持有 `-wal` / `-shm`，`rmSync`
     * 于是抛 `EBUSY` —— 而它发生在**所有断言之后**，与"迁移有没有删掉数据"
     * 毫无关系。第一版没处理它，结果是清理阶段的异常**盖掉了真正的断言失败**
     * （看起来像"清理失败"，其实是"数据被级联删了"）—— 那比没有测试更危险。
     *
     * 所以：清理失败只记一笔，不改变测试结论。真正的证据是上面的断言。
     */
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[migration.test] 临时目录未能删除（不影响结论）：${(error as Error).message}`);
    }
  }
});

test('★ 没有数据的库上，M12 也能干净跑完（主路径）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aq-mig-empty-'));
  const file = path.join(dir, 'empty.sqlite');
  try {
    /* 空库 → 一次跑完全部迁移（新安装的机器就是这条路径）。 */
    const db = new Db(file);
    db.migrate();
    assert.equal(db.count('SELECT COUNT(*) AS n FROM traders'), 0);
    const version = db.get<{ user_version: number }>('PRAGMA user_version')!;
    assert.equal(version.user_version, MIGRATIONS[MIGRATIONS.length - 1]!.version);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
