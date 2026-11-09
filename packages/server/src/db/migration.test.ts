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

/**
 * `M14_ORDER_MARGIN_TYPE` —— 订单行上的「全仓 / 逐仓」。
 *
 * ## 这条用例钉的是"迁移不许编事实"
 *
 * 加一列最省事的写法是 `ADD COLUMN margin_type TEXT NOT NULL DEFAULT 'cross'` ——
 * 它能让每一行立刻都有值、界面上一行 `—` 都不出现，看起来更"完整"。
 * **而那是错的**：币安的默认确实是全仓，可这是"交易所的默认"，不是"这些历史行当时
 * 的模式"。补上去之后，界面上「全仓」与「不知道」就再也分不开了 ——
 * 一个拿这张表复盘的人会把一批没记录的行当成"当时跑的是全仓"。
 *
 * 所以这里用一个**真实形状的 v13 库**（`orders` 已经有 `margin_used`、还没有
 * `margin_type`）走正式路径 `Db.migrate()` 升到 v14，断言：
 *
 *   ① 老行一条不少；
 *   ② 老行的 `margin_type` 是 `NULL` —— **没有被补成 `'cross'`**；
 *   ③ 新列确实可写（迁移不只是"加了一列名字"）。
 */
test('★ M14 给 orders 加 margin_type：老行保持 NULL，绝不补一个默认的「全仓」', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aq-mig-margin-type-'));
  const file = path.join(dir, 'margin-type.sqlite');
  let db: Db | null = null;
  try {
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys = ON');
    pushTo(raw, 13);

    raw.exec(`
      INSERT INTO exchange_accounts (id, exchange, label, api_key, api_secret_enc, testnet, can_trade, created_at, updated_at)
        VALUES (1, 'binance', 'acc', 'k', 'v1:00:00:00', 0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO ai_models (id, provider, label, model, base_url, api_key_enc, temperature, max_tokens, timeout_seconds, max_retries, created_at, updated_at)
        VALUES (1, 'deepseek', 'm', 'm', 'https://example.invalid', '', 0.2, 4096, 60, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO traders (id, name, exchange_account_id, ai_model_id, cycle_interval_minutes, initial_equity, status, last_cycle_number, consecutive_failures, created_at, updated_at, mode)
        VALUES (1, '机器人', 1, 1, 15, 10, 'running', 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'ai_managed');

      -- 升级前写下的订单行：有保证金占用（M13 已经加过），但那时还没有 margin_type 这一列。
      INSERT INTO orders (id, trader_id, symbol, side, type, purpose, status, quantity, filled_qty, client_order_id, margin_used, created_at, updated_at)
        VALUES (1, 1, 'BTCUSDT', 'BUY', 'MARKET', 'entry', 'FILLED', 0.01, 0.01, 'cid-legacy', 40.4, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    raw.close();

    /* 走正式路径升级（服务启动时就是这条）。 */
    db = new Db(file);
    db.migrate();

    assert.equal(
      db.get<{ user_version: number }>('PRAGMA user_version')!.user_version,
      /*
       * ⚠️ **不要写死数字**（2026-10-12 改）。
       *
       * 原来这里是字面量 `15`，注释说"追加新迁移时请把它一起往上调" ——
       * 我加 M16 时它如期失败了。**但那是个"假失败"**：
       * 这条用例真正要验的是"**迁移跑到了最新版**"，
       * 而不是"最新版恰好是 15"。
       *
       * 写死数字的代价：每加一个迁移都要改一处**与本用例目的无关**的地方，
       * 而忘了改就会得到一个**看起来像真 BUG** 的失败（实测就是如此 ——
       * 我第一反应是"我的迁移写坏了"）。
       *
       * 文件里 L259 早就用了 `MIGRATIONS[last].version`，这里只是漏改。
       */
      MIGRATIONS[MIGRATIONS.length - 1]!.version,
      '迁移应当跑到最新版本（与 MIGRATIONS 表一致，不写死数字）',
    );

    /* ① 老行一条不少。 */
    assert.equal(db.count('SELECT COUNT(*) AS n FROM orders'), 1, '加列不该动任何一行');

    /* ② ★ 老行是 NULL，不是 'cross' —— 这是这条用例存在的全部理由。 */
    const legacy = db.get<{ margin_type: string | null }>(
      'SELECT margin_type FROM orders WHERE id = 1',
    )!;
    assert.equal(
      legacy.margin_type,
      null,
      '历史行必须保持 NULL（界面显示 —）：补一个 cross 就是把"不知道"说成了"当时是全仓"',
    );

    /* ③ 新列可写 —— 迁移加的不是一个永远读不出值的名字。 */
    db.run("UPDATE orders SET margin_type = 'isolated' WHERE id = 1");
    assert.equal(
      db.get<{ margin_type: string | null }>('SELECT margin_type FROM orders WHERE id = 1')!
        .margin_type,
      'isolated',
    );
  } finally {
    try {
      db?.close();
    } catch {
      /* 已经关过就算了 —— 这里不该影响真正的断言结果。 */
    }
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

/**
 * `M19_PAPER_TRADING` —— **第二次重建 `traders` 表**（PR #185）。
 *
 * ## 为什么这条用例必须存在
 *
 * M19 做的是三件事，每一件单独都能把线上库弄坏：
 *
 *   ① `DROP TABLE traders` 再重建 —— 和 M12 一样，子表（持仓/成交/订单）全挂
 *      `ON DELETE CASCADE`，关不掉外键就是**删账本**；
 *   ② `INSERT ... SELECT` **按位置**复制数据 —— 列顺序一旦与旧表不一致，
 *      数据会静默串位（名字变成状态、权益变成周期数），而迁移不会报错；
 *   ③ 把 `exchange_account_id` 从 `NOT NULL` 改成可空，并把
 *      `ON DELETE RESTRICT` 换成 `SET NULL` —— 换错成 `CASCADE` 的话，
 *      操作员删一个交易所账户就会**连带删掉机器人和它的全部历史**。
 *
 * 这三条都是"跑起来没报错、但数据已经错了/没了"的形态。
 * 所以用一个**真实形状的 v18 库**（有账户、机器人、持仓、成交、订单）
 * 走正式路径 `Db.migrate()`，逐条钉住。
 *
 * ## 与本文件其它用例的区别
 *
 * M12 用的是"AI 托管却仍指向策略"的老数据；这里要验的是**列值的逐字保留**
 * 与**外键行为的变化**，所以两条机器人的字段都填了非默认值。
 */
test('★ M19 重建 traders：账本一条不少、删账户只置空、老行数据逐字保留', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aq-mig-paper-'));
  const file = path.join(dir, 'paper-trading.sqlite');
  let db: Db | null = null;
  try {
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys = ON');
    pushTo(raw, 18);

    const ts = '2026-01-01T00:00:00.000Z';
    raw.exec(`
      INSERT INTO exchange_accounts (id, exchange, label, api_key, api_secret_enc, testnet, can_trade, created_at, updated_at)
        VALUES (1, 'binance', 'acc-a', 'k', 'v1:00:00:00', 0, 1, '${ts}', '${ts}'),
               (2, 'binance', 'acc-b', 'k', 'v1:00:00:00', 0, 1, '${ts}', '${ts}');
      INSERT INTO ai_models (id, provider, label, model, base_url, api_key_enc, temperature, max_tokens, timeout_seconds, max_retries, created_at, updated_at)
        VALUES (1, 'deepseek', 'm', 'm', 'https://example.invalid', '', 0.2, 4096, 60, 1, '${ts}', '${ts}');
      INSERT INTO strategies (id, name, description, config_json, is_default, created_at, updated_at)
        VALUES (1, '默认策略 — 稳健', '', '{}', 1, '${ts}', '${ts}');

      /* 两台机器人都绑着账户（M19 之前 exchange_account_id 是 NOT NULL）。 */
      INSERT INTO traders (id, name, exchange_account_id, ai_model_id, strategy_id, cycle_interval_minutes,
                           initial_equity, status, last_cycle_number, consecutive_failures, last_error,
                           created_at, updated_at, agent_config_json, mode, dry_run)
        VALUES (9, '老模拟盘机器人', 1, 1, 1, 45, 123.45, 'running', 7, 2, '上次的错误',
                '${ts}', '${ts}', '{"foo":1}', 'strategy', 1),
               (10, '实盘机器人', 2, 1, 1, 30, 50, 'stopped', 3, 0, NULL,
                '${ts}', '${ts}', NULL, 'ai_managed', 0);

      INSERT INTO positions (id, trader_id, symbol, side, quantity, entry_price, leverage, liquidation_price,
                             margin_used, stop_loss, take_profit, stop_order_id, tp_order_id, open_reasoning,
                             opened_at, status)
        VALUES (1, 9, 'BTCUSDT', 'long', 0.01, 60000, 5, 50000, 120, 59000, 62000, 's1', 't1', '',
                '${ts}', 'open');
      INSERT INTO trades (id, trader_id, symbol, side, quantity, entry_price, exit_price, leverage, pnl, pnl_percent,
                          fee, close_reason, opened_at, closed_at, hold_minutes, entry_fee, funding_fee, net_pnl, source)
        VALUES (1, 9, 'BTCUSDT', 'long', 0.01, 60000, 61000, 5, 10, 8.3,
                0.01, 'take_profit', '${ts}', '${ts}', 60, 0.005, 0, 9.985, 'bot');
      INSERT INTO orders (id, trader_id, symbol, side, type, purpose, status, quantity, filled_qty,
                          client_order_id, created_at, updated_at)
        VALUES (1, 9, 'BTCUSDT', 'SELL', 'STOP_MARKET', 'stop_loss', 'FILLED', 0.01, 0.01,
                'cid-1', '${ts}', '${ts}');
    `);
    raw.close();

    /* 走正式路径（服务启动时就是这条）。 */
    db = new Db(file);
    db.migrate();

    assert.equal(
      db.get<{ user_version: number }>('PRAGMA user_version')!.user_version,
      MIGRATIONS[MIGRATIONS.length - 1]!.version,
      '迁移应当跑到最新版本',
    );

    /* ── ① 账本一条不少（重建表时外键必须真的被关掉） ────────────────── */
    assert.equal(db.count('SELECT COUNT(*) AS n FROM positions'), 1, 'positions 被级联删掉了');
    assert.equal(db.count('SELECT COUNT(*) AS n FROM trades'), 1, 'trades 被级联删掉了');
    assert.equal(db.count('SELECT COUNT(*) AS n FROM orders'), 1, 'orders 被级联删掉了');
    assert.equal(db.count('SELECT COUNT(*) AS n FROM traders'), 2, 'traders 自己少行了');

    /* ── ② 老行逐字保留 —— 钉住 INSERT ... SELECT 的列位置没串 ───────── */
    const legacy = db.get<{
      name: string;
      exchange_account_id: number | null;
      ai_model_id: number;
      strategy_id: number | null;
      cycle_interval_minutes: number;
      initial_equity: number;
      status: string;
      last_cycle_number: number;
      consecutive_failures: number;
      last_error: string | null;
      agent_config_json: string | null;
      mode: string;
      dry_run: number | null;
      paper_starting_balance: number;
    }>(
      `SELECT name, exchange_account_id, ai_model_id, strategy_id, cycle_interval_minutes,
              initial_equity, status, last_cycle_number, consecutive_failures, last_error,
              agent_config_json, mode, dry_run, paper_starting_balance
         FROM traders WHERE id = 9`,
    )!;
    assert.equal(legacy.name, '老模拟盘机器人', 'name 串位了（列顺序对应错了）');
    assert.equal(legacy.exchange_account_id, 1);
    assert.equal(legacy.ai_model_id, 1);
    assert.equal(legacy.strategy_id, 1);
    assert.equal(legacy.cycle_interval_minutes, 45);
    assert.equal(legacy.initial_equity, 123.45, 'initial_equity 串位了');
    assert.equal(legacy.status, 'running');
    assert.equal(legacy.last_cycle_number, 7);
    assert.equal(legacy.consecutive_failures, 2);
    assert.equal(legacy.last_error, '上次的错误');
    assert.equal(legacy.agent_config_json, '{"foo":1}');
    assert.equal(legacy.mode, 'strategy');
    assert.equal(legacy.dry_run, 1);

    /* ── ③ 新列默认 0 —— 老机器人没有"模拟本金"这个概念，不要补一个假数 ── */
    assert.equal(
      legacy.paper_starting_balance,
      0,
      '老行的模拟本金必须是 0（= 没填），不能编一个数字',
    );

    /* ── ④ 现在允许"没有交易所账户"的机器人（本次迁移的目的） ────────── */
    db.run(
      `INSERT INTO traders (name, exchange_account_id, ai_model_id, strategy_id, cycle_interval_minutes,
                            initial_equity, status, created_at, updated_at, mode, paper_starting_balance)
       VALUES ('纯模拟盘', NULL, 1, 1, 15, 1000, 'stopped', '${ts}', '${ts}', 'strategy', 1000)`,
    );
    assert.equal(db.count('SELECT COUNT(*) AS n FROM traders'), 3, '应能插入无账户的模拟盘机器人');

    /* ── ⑤ 删掉账户 → 引用置空，绝不能级联删机器人/账本 ─────────────── */
    db.run('DELETE FROM exchange_accounts WHERE id = 1');
    const afterDelete = db.get<{ exchange_account_id: number | null }>(
      'SELECT exchange_account_id FROM traders WHERE id = 9',
    )!;
    assert.equal(
      afterDelete.exchange_account_id,
      null,
      'ON DELETE SET NULL 应当把引用置空；若是 CASCADE，机器人已经被删了',
    );
    assert.equal(db.get<{ exchange_account_id: number | null }>(
      'SELECT exchange_account_id FROM traders WHERE id = 10',
    )!.exchange_account_id, 2, '把另一台机器人的账户引用也置空了（迁移写错了）');
    assert.equal(db.count('SELECT COUNT(*) AS n FROM traders'), 3, '删账户不该删机器人');
    assert.equal(db.count('SELECT COUNT(*) AS n FROM trades'), 1, '删账户不该动账本');

    /* ── ⑥ 重建表必须把索引也重建回来（否则状态筛选全表扫） ─────────── */
    const indexes = db.all<{ name: string }>(`PRAGMA index_list('traders')`);
    assert.ok(
      indexes.some((row) => row.name === 'idx_traders_status'),
      '重建 traders 后丢了 idx_traders_status 索引',
    );

    /* ── ⑦ 外键在迁移结束后必须被恢复（执行器的 finally 分支） ────────── */
    assert.equal(
      db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')!.foreign_keys,
      1,
      '迁移结束后必须把外键恢复成 ON',
    );
  } finally {
    try {
      db?.close();
    } catch {
      /* 已经关过就算了 —— 这里不该影响真正的断言结果。 */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[migration.test] 临时目录未能删除（不影响结论）：${(error as Error).message}`);
    }
  }
});
