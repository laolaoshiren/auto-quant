/**
 * SQLite schema. Applied as a sequence of numbered migrations tracked in
 * `PRAGMA user_version`, so upgrading an existing database is safe.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const M1_INITIAL = /* sql */ `
-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',
  created_at    TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Exchange credentials (secrets encrypted with AES-256-GCM)
-- ---------------------------------------------------------------------------
CREATE TABLE exchange_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange       TEXT    NOT NULL DEFAULT 'binance',
  label          TEXT    NOT NULL,
  api_key        TEXT    NOT NULL,
  api_secret_enc TEXT    NOT NULL,
  passphrase_enc TEXT    NOT NULL DEFAULT '',
  testnet        INTEGER NOT NULL DEFAULT 1,
  can_trade      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- LLM endpoints
-- ---------------------------------------------------------------------------
CREATE TABLE ai_models (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider        TEXT    NOT NULL,
  label           TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  base_url        TEXT    NOT NULL DEFAULT '',
  api_key_enc     TEXT    NOT NULL DEFAULT '',
  temperature     REAL    NOT NULL DEFAULT 0.2,
  max_tokens      INTEGER NOT NULL DEFAULT 4096,
  timeout_seconds INTEGER NOT NULL DEFAULT 120,
  max_retries     INTEGER NOT NULL DEFAULT 3,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Strategies — the full StrategyConfig blob plus display metadata
-- ---------------------------------------------------------------------------
CREATE TABLE strategies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  config_json TEXT    NOT NULL,
  preset_id   TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Traders — a (credential, model, strategy) triple wired to a live loop
-- ---------------------------------------------------------------------------
CREATE TABLE traders (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT    NOT NULL,
  exchange_account_id    INTEGER NOT NULL REFERENCES exchange_accounts(id) ON DELETE RESTRICT,
  ai_model_id            INTEGER NOT NULL REFERENCES ai_models(id) ON DELETE RESTRICT,
  strategy_id            INTEGER NOT NULL REFERENCES strategies(id) ON DELETE RESTRICT,
  cycle_interval_minutes INTEGER NOT NULL DEFAULT 15,
  initial_equity         REAL    NOT NULL DEFAULT 0,
  status                 TEXT    NOT NULL DEFAULT 'stopped',
  last_cycle_at          TEXT,
  last_cycle_number      INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL
);
CREATE INDEX idx_traders_status ON traders(status);

-- ---------------------------------------------------------------------------
-- Open positions (mirrored from the exchange, enriched with our own state)
-- ---------------------------------------------------------------------------
CREATE TABLE positions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id        INTEGER NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
  symbol           TEXT    NOT NULL,
  side             TEXT    NOT NULL,
  quantity         REAL    NOT NULL,
  entry_price      REAL    NOT NULL,
  leverage         INTEGER NOT NULL,
  liquidation_price REAL,
  margin_used      REAL    NOT NULL DEFAULT 0,
  peak_pnl_percent REAL    NOT NULL DEFAULT 0,
  stop_loss        REAL,
  take_profit      REAL,
  stop_order_id    TEXT,
  tp_order_id      TEXT,
  open_reasoning   TEXT    NOT NULL DEFAULT '',
  opened_at        TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'open'
);
CREATE INDEX idx_positions_trader_status ON positions(trader_id, status);
CREATE UNIQUE INDEX idx_positions_open_symbol ON positions(trader_id, symbol) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Every order we ever sent, including rejects
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id         INTEGER NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
  exchange_order_id TEXT,
  client_order_id   TEXT    NOT NULL,
  symbol            TEXT    NOT NULL,
  side              TEXT    NOT NULL,
  type              TEXT    NOT NULL,
  purpose           TEXT    NOT NULL,
  quantity          REAL    NOT NULL DEFAULT 0,
  price             REAL,
  stop_price        REAL,
  status            TEXT    NOT NULL,
  avg_price         REAL,
  filled_qty        REAL    NOT NULL DEFAULT 0,
  fee               REAL    NOT NULL DEFAULT 0,
  error             TEXT,
  raw_response      TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);
CREATE INDEX idx_orders_trader ON orders(trader_id, created_at DESC);
CREATE INDEX idx_orders_symbol ON orders(trader_id, symbol);

-- ---------------------------------------------------------------------------
-- Closed round-trips
-- ---------------------------------------------------------------------------
CREATE TABLE trades (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id    INTEGER NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
  symbol       TEXT    NOT NULL,
  side         TEXT    NOT NULL,
  quantity     REAL    NOT NULL,
  entry_price  REAL    NOT NULL,
  exit_price   REAL    NOT NULL,
  leverage     INTEGER NOT NULL,
  pnl          REAL    NOT NULL,
  pnl_percent  REAL    NOT NULL,
  fee          REAL    NOT NULL DEFAULT 0,
  close_reason TEXT    NOT NULL DEFAULT '',
  opened_at    TEXT    NOT NULL,
  closed_at    TEXT    NOT NULL,
  hold_minutes REAL    NOT NULL DEFAULT 0
);
CREATE INDEX idx_trades_trader ON trades(trader_id, closed_at DESC);

-- ---------------------------------------------------------------------------
-- Full audit trail of every decision cycle
-- ---------------------------------------------------------------------------
CREATE TABLE decision_records (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id            INTEGER NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
  cycle_number         INTEGER NOT NULL,
  timestamp            TEXT    NOT NULL,
  system_prompt        TEXT    NOT NULL DEFAULT '',
  user_prompt          TEXT    NOT NULL DEFAULT '',
  cot_trace            TEXT    NOT NULL DEFAULT '',
  decisions_json       TEXT    NOT NULL DEFAULT '[]',
  raw_response         TEXT    NOT NULL DEFAULT '',
  execution_log_json   TEXT    NOT NULL DEFAULT '[]',
  candidate_symbols_json TEXT  NOT NULL DEFAULT '[]',
  success              INTEGER NOT NULL DEFAULT 1,
  error                TEXT,
  ai_latency_ms        INTEGER NOT NULL DEFAULT 0,
  prompt_tokens        INTEGER,
  completion_tokens    INTEGER
);
CREATE INDEX idx_decisions_trader ON decision_records(trader_id, cycle_number DESC);

-- ---------------------------------------------------------------------------
-- Equity curve
-- ---------------------------------------------------------------------------
CREATE TABLE equity_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id         INTEGER NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
  timestamp         TEXT    NOT NULL,
  equity            REAL    NOT NULL,
  available_balance REAL    NOT NULL DEFAULT 0,
  unrealized_pnl    REAL    NOT NULL DEFAULT 0,
  margin_used       REAL    NOT NULL DEFAULT 0,
  open_positions    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_equity_trader ON equity_snapshots(trader_id, timestamp DESC);

-- ---------------------------------------------------------------------------
-- Throttling bookkeeping so limits survive restarts
-- ---------------------------------------------------------------------------
CREATE TABLE trade_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id  INTEGER NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
  symbol     TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE INDEX idx_trade_events ON trade_events(trader_id, kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- Key/value instance settings
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Rolling live log for the console's log pane
-- ---------------------------------------------------------------------------
CREATE TABLE runtime_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id  INTEGER,
  level      TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'server',
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_runtime_logs ON runtime_logs(id DESC);
`;

/**
 * Accounting columns on `trades`.
 *
 * Why this exists: the platform used to record `pnl` as **gross** and `fee` as
 * only the **exit** side's commission, and it only learned about a close if it
 * happened to be running a cycle at that moment. A position whose exchange-side
 * take profit fired while the bot was stopped was never recorded at all — a live
 * account showed +0.2586 net while the console reported −0.3136, a sign-flipped
 * error of 0.57 USDT on a 10 USDT account.
 *
 * So `pnl` keeps its meaning (gross, straight from the exchange's realizedPnl),
 * and the costs become explicit columns so the displayed figure can be **net**
 * and can be shown broken down:
 *
 *   net_pnl = gross_pnl − entry_fee − exit_fee − funding_fee
 *
 * `source` records provenance: `bot` for trades the runtime booked live,
 * `reconciled` for round-trips recovered from the exchange's fill history. Both
 * are legitimate; knowing which is which is what makes a discrepancy debuggable.
 */
const M2_TRADE_ACCOUNTING = /* sql */ `
ALTER TABLE trades ADD COLUMN entry_fee   REAL NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN funding_fee REAL NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN net_pnl     REAL NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN source      TEXT NOT NULL DEFAULT 'bot';
ALTER TABLE trades ADD COLUMN entry_order_id TEXT;
ALTER TABLE trades ADD COLUMN exit_order_id  TEXT;

-- Backfill: for rows written before this migration, pnl is gross and fee holds
-- whatever commission the runtime managed to capture (the exit side only).
-- Copying it across keeps the arithmetic consistent for historical rows; a
-- reconciliation pass corrects the fee to the exchange's true total.
UPDATE trades SET net_pnl = pnl - fee;

CREATE INDEX idx_trades_exit_order ON trades(trader_id, exit_order_id);
`;

/**
 * 可撤销的会话。
 *
 * 为什么需要：JWT 是无状态的，签发之后服务端没有任何办法让它失效。
 * 于是「修改密码」这个唯一的补救动作在最需要它的时候是**无效的** ——
 * 令牌一旦泄漏（浏览器残留、代理日志、旧设备），攻击者可以在剩下的
 * 有效期内继续下单，而所有者改密码、甚至改用户名都不会把它踢下线。
 *
 * 做法：在 `users` 上记一个「凭据变更时间」。签发令牌时把这个时间写进载荷
 * （`credAt`），校验时与数据库里的当前值等值比较；改密码或改用户名会刷新它，
 * 于是所有更早签发的令牌立即失配。为什么不是「iat 早于变更时间」的比大小：
 * 见 `api/auth.ts` 的 `isTokenRevoked()`。
 *
 * 默认空串 = 「从未改过」，因此**升级不会把现有会话全部踢下线**：
 * 只有真正发生凭据变更时才作废旧令牌。这是刻意的 —— 升级本身不该让操作员
 * 在一个正在跑真实订单的系统上失去控制台访问。
 */
const M3_SESSION_REVOCATION = /* sql */ `
ALTER TABLE users ADD COLUMN credentials_changed_at TEXT NOT NULL DEFAULT '';
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: M1_INITIAL },
  { version: 2, name: 'trade-accounting', sql: M2_TRADE_ACCOUNTING },
  { version: 3, name: 'session-revocation', sql: M3_SESSION_REVOCATION },
];
