import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MIGRATIONS } from './schema.js';

/**
 * 追加迁移必须能在**已经有数据**的库上跑通。
 *
 * 为什么这个测试存在：权益归属那次修复要求 `equity_snapshots.equity` 从"共享钱包
 * 余额"改成"本机器人归属权益"，而线上的库里有几百行旧口径的快照。改语义的迁移
 * 有两个容易出错的地方，两个都会静默地毁掉风控的输入（§4.2）：
 *
 *  1. 旧行的账户权益没有搬到新列 → 回撤高水位从 0 开始，熔断器形同虚设；
 *  2. 旧行的 `equity` 不做重建 → 曲线里全是账户数字，一个从未成交的机器人又显示
 *     出别人的钱。
 *
 * 这里**手工建一个 v3 的库**（只跑到 M3）、塞进旧口径的行，再单独贴上 M4，
 * 断言搬家与重建的结果。注意它不碰仓库的 `initDb()` 单例，也不碰 `data/`。
 */
test('M4 迁移把旧口径的权益快照搬成账户列，并按机器人重建归属权益', () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'aq-migration-'));
  const db = new DatabaseSync(path.join(workDir, 'legacy.sqlite'));

  try {
    // 升级前的库：只到 M3，`equity_snapshots` 还没有 account_* 两列。
    for (const migration of MIGRATIONS) {
      if (migration.version > 3) continue;
      db.exec(migration.sql);
    }

    db.exec(`
      INSERT INTO exchange_accounts (label, api_key, api_secret_enc, created_at, updated_at)
        VALUES ('legacy', 'k', 'v1:00:00:00', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO ai_models (provider, label, model, created_at, updated_at)
        VALUES ('deepseek', 'legacy', 'm', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO strategies (name, config_json, created_at, updated_at)
        VALUES ('legacy', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO traders (name, exchange_account_id, ai_model_id, strategy_id, initial_equity, created_at, updated_at)
        VALUES ('legacy', 1, 1, 1, 1000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

    // 两个已实现的回合：+50（01-02 平仓）与 −20（01-03 平仓）。
    const insertTrade = (closedAt: string, netPnl: number): void => {
      db.exec(`
        INSERT INTO trades (trader_id, symbol, side, quantity, entry_price, exit_price, leverage,
                            pnl, pnl_percent, fee, close_reason, opened_at, closed_at, hold_minutes, net_pnl)
        VALUES (1, 'BTCUSDT', 'long', 0.01, 68000, 69000, 3, ${netPnl}, 0, 0, 'model_decision',
                '2026-01-01T00:00:00.000Z', '${closedAt}', 60, ${netPnl});
      `);
    };
    insertTrade('2026-01-02T00:00:00.000Z', 50);
    insertTrade('2026-01-03T00:00:00.000Z', -20);

    /*
     * 旧口径的快照：`equity` 是共享钱包的保证金余额（两次读数 1200 / 1300），
     * `unrealized_pnl` 是账户的浮盈。这是线上真实的样子。
     */
    const insertLegacySnapshot = (timestamp: string, equity: number, unrealized: number): void => {
      db.exec(`
        INSERT INTO equity_snapshots (trader_id, timestamp, equity, available_balance, unrealized_pnl, margin_used, open_positions)
        VALUES (1, '${timestamp}', ${equity}, 1000, ${unrealized}, 200, 1);
      `);
    };
    insertLegacySnapshot('2026-01-01T12:00:00.000Z', 1200, 100); // 第一个回合之前
    insertLegacySnapshot('2026-01-02T12:00:00.000Z', 1300, 0); // 第一个回合之后
    const highWaterBefore = db
      .prepare('SELECT MAX(equity - unrealized_pnl) AS peak FROM equity_snapshots')
      .get() as { peak: number };

    // 贴上这次修复的迁移。
    const m4 = MIGRATIONS.find((migration) => migration.version === 4);
    assert.ok(m4, 'M4（权益归属）必须存在');
    db.exec(m4.sql);

    const rows = db
      .prepare('SELECT timestamp, equity, unrealized_pnl, account_equity, account_unrealized_pnl FROM equity_snapshots ORDER BY timestamp')
      .all() as Array<{
      timestamp: string;
      equity: number;
      unrealized_pnl: number;
      account_equity: number;
      account_unrealized_pnl: number;
    }>;

    // 1. 账户口径原样保留：风控高水位的历史不能因为改语义而丢失。
    const highWaterAfter = db
      .prepare('SELECT MAX(account_equity - account_unrealized_pnl) AS peak FROM equity_snapshots')
      .get() as { peak: number };
    assert.equal(
      highWaterAfter.peak,
      highWaterBefore.peak,
      '旧行的账户权益必须搬到 account_* 两列，否则回撤高水位归零、熔断器失效',
    );
    assert.equal(rows[0]!.account_equity, 1200);
    assert.equal(rows[0]!.account_unrealized_pnl, 100);

    // 2. 归属口径按 `initial_equity + Σ(该时刻之前已平仓的 net_pnl)` 重建。
    assert.equal(rows[0]!.equity, 1000, '第一个回合还没平仓，归属权益就是初始权益');
    assert.equal(rows[1]!.equity, 1050, '1000 + 50');
    // 3. 旧行的账户浮盈无法反推成本机器人的浮盈，只能置 0（如实记录，不冒充）。
    assert.equal(rows[0]!.unrealized_pnl, 0);
    assert.equal(rows[1]!.unrealized_pnl, 0);
  } finally {
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});
