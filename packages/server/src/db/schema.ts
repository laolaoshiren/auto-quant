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

/**
 * 权益归属：把「账户权益」与「本机器人归属权益」分开存。
 *
 * 为什么需要这次迁移：`equity_snapshots.equity` 一直写的是
 * `broker.getAccountState().equity` —— **共享钱包**的保证金余额。同一个交易所
 * 账户下跑多个机器人时它们共用一份凭据，于是每个机器人每一行记的都是同一个数。
 * 实盘上量到的后果（三个机器人共用一个账户）：
 *
 *   #4 测试机器人1   0 笔平仓、净 0.000000 → 显示 +2.67%
 *   #5 测试2         4 笔平仓、净 +0.272133 → 显示 +2.67%（和 #4 一模一样）
 *   #6 实盘3小时验证  0 笔平仓、净 0.000000 → 显示 −0.06%
 *
 * 也就是说一个**从未交易**的机器人显示了别的机器人挣的钱，而两个机器人的收益率
 * 完全相同 —— 因为它们读的是同一个钱包。
 *
 * 迁移之后：
 *   · `equity` / `unrealized_pnl` 改记**本机器人**的归属口径；
 *   · `account_equity` / `account_unrealized_pnl` 记账户（共享钱包）的口径，
 *     风控的回撤高水位与「账户权益」展示读这两列（见 `realizedHighWaterMark`）。
 *
 * 回填的取舍（历史行无法精确重建，这里选**最不撒谎**的那种）：
 *   · 旧行的 `equity` 就是账户权益，先原样搬到 `account_equity` —— 高水位的历史
 *     因此不失真（`MAX` 是单调的，少一个点只会低估峰值）。
 *   · 本机器人当年的浮盈从没被记录过（那一列当时装的是账户的总浮盈，不是它的），
 *     无法反推，所以旧行 `unrealized_pnl` 置 0，`equity` 用
 *     `initial_equity + Σ(该时刻之前已平仓的 net_pnl)` 重建 —— 这是一条只有已实现
 *     盈亏的曲线，形状正确、数字有出处。
 *   · `open_positions` 旧行记的是账户的持仓数，同样无法按机器人重建，因此不动它
 *     （它只用于曲线 tooltip，不参与任何金额计算）。
 *
 * 注意 `net_pnl` 在这里只被**求和**，不重算：净额的唯一计算点仍然是
 * `trades.insert()` / `applyExchangeFigures()`（§2.5）。
 */
const M4_ATTRIBUTED_EQUITY = /* sql */ `
ALTER TABLE equity_snapshots ADD COLUMN account_equity         REAL NOT NULL DEFAULT 0;
ALTER TABLE equity_snapshots ADD COLUMN account_unrealized_pnl  REAL NOT NULL DEFAULT 0;

UPDATE equity_snapshots
   SET account_equity = equity,
       account_unrealized_pnl = unrealized_pnl;

UPDATE equity_snapshots
   SET equity = COALESCE(
         (SELECT t.initial_equity FROM traders t WHERE t.id = equity_snapshots.trader_id), 0)
       + COALESCE(
         (SELECT SUM(tr.net_pnl) FROM trades tr
           WHERE tr.trader_id = equity_snapshots.trader_id
             AND tr.closed_at <= equity_snapshots.timestamp), 0),
       unrealized_pnl = 0;
`;

const M5_AI_AGENT_MEMORY = /* sql */ `
-- ---------------------------------------------------------------------------
-- 全自动智能托管（AI Agent 模式）—— 三张表
--
-- 这个模式与之前所有策略的**本质区别**在于：模型的每一次决策不再孤立。
-- 它有自己的历史、自己的改动记录、以及**这些改动之后真实发生了什么**。
--
-- 所以「越跑越厉害」不靠一句"请反思"，而靠这三张表：
--   · agent_experiments —— 我改了什么 + 之后真实结果（学习的**事实**来源）
--   · agent_memory      —— 这个形态/这个失败原因，上次是怎么亏的（**前车之鉴**）
--   · agent_runs        —— 每次循环的完整轨迹（**可审计**，也是排查依据）
--
-- 没有这三张表，"AI 自我迭代"只是一段听起来很专业的文字。
-- ---------------------------------------------------------------------------

-- 每一次参数调整，以及之后真实发生了什么。
--
-- ⚠️ patch_json（AI 想改什么）与 applied_json（守卫之后实际生效什么）
-- 必须**分开存**：两者不同时要能一眼看出来。否则守卫钳制了、而 AI 以为自己改成了，
-- 下一轮它会基于一个错误的前提继续推理。
CREATE TABLE agent_experiments (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id             INTEGER NOT NULL REFERENCES traders(id),
  created_at            TEXT    NOT NULL,

  -- 为什么被唤醒：new_result / drawdown / losing_streak / timeout / rejections / manual
  trigger               TEXT    NOT NULL,
  -- 唤醒时它看到的绩效快照（JSON）。留着是为了回答"它当时凭什么这么改"。
  observed_json         TEXT    NOT NULL,
  patch_json            TEXT    NOT NULL,
  applied_json          TEXT    NOT NULL,
  -- 被守卫钳制的项及原因（[{"field","asked","allowed","why"}]）。空数组表示原样通过。
  clamps_json           TEXT    NOT NULL DEFAULT '[]',
  -- AI 自己写的判断。**必填** —— 一次没有理由的调参无法被审查。
  reason                TEXT    NOT NULL,
  -- 它查了什么（工具调用序列）。用来还原它的推理依据。
  tool_calls_json       TEXT    NOT NULL DEFAULT '[]',

  -- ↓ 由后续周期回填：这次调整之后真实发生了什么。**这是"学习"的落地处。**
  outcome_trades        INTEGER,
  outcome_net_pnl       REAL,
  outcome_evaluated_at  TEXT
);

CREATE INDEX idx_agent_experiments_trader ON agent_experiments(trader_id, created_at DESC);
-- 回填扫描用：只找还没结算的那些。
CREATE INDEX idx_agent_experiments_pending ON agent_experiments(trader_id, outcome_evaluated_at);

-- 复盘员在每笔平仓后写的因果结论。**这是"前车之鉴"的来源。**
--
-- 与 agent_experiments 的分工：那个记"我改了什么参数"，
-- 这个记"这笔为什么赚/亏" —— 前者是策略层的记忆，后者是执行层的记忆。
CREATE TABLE agent_memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id     INTEGER NOT NULL REFERENCES traders(id),
  -- 一笔平仓对应一条。UNIQUE 保证重复对账不会写出两条互相矛盾的经验。
  trade_id      INTEGER NOT NULL UNIQUE REFERENCES trades(id),
  created_at    TEXT    NOT NULL,

  symbol        TEXT    NOT NULL,
  close_reason  TEXT    NOT NULL,
  net_pnl       REAL    NOT NULL,
  -- 因果结论：这笔为什么赚/亏。面向模型，所以是散文。
  lesson        TEXT    NOT NULL,
  -- 可检索的标签（["追高","逆势","费用吃掉利润"]）。检索靠它，不靠全文匹配。
  tags_json     TEXT    NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_agent_memory_trader ON agent_memory(trader_id, created_at DESC);
CREATE INDEX idx_agent_memory_symbol ON agent_memory(trader_id, symbol, created_at DESC);

-- 每次智能体循环的完整轨迹。可审计，也是"这一步为什么花这么多 token"的依据。
CREATE TABLE agent_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trader_id     INTEGER NOT NULL REFERENCES traders(id),
  created_at    TEXT    NOT NULL,

  -- decision（每轮交易台）/ strategy（低频调参）/ review（复盘）
  kind          TEXT    NOT NULL,
  trigger       TEXT    NOT NULL,
  -- single（单次调用）/ panel（多角色并行）。**由程序决定用哪档，不让 AI 自己选。**
  intensity     TEXT    NOT NULL,
  steps         INTEGER NOT NULL DEFAULT 0,
  -- 各角色返回的结构化结论（JSON 数组）。
  agents_json   TEXT    NOT NULL DEFAULT '[]',
  -- ok / degraded（超预算降级）/ failed
  outcome       TEXT    NOT NULL,
  detail        TEXT    NOT NULL DEFAULT '',

  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_agent_runs_trader ON agent_runs(trader_id, created_at DESC);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: M1_INITIAL },
  { version: 2, name: 'trade-accounting', sql: M2_TRADE_ACCOUNTING },
  { version: 3, name: 'session-revocation', sql: M3_SESSION_REVOCATION },
  { version: 4, name: 'attributed-equity', sql: M4_ATTRIBUTED_EQUITY },
  { version: 5, name: 'ai-agent-memory', sql: M5_AI_AGENT_MEMORY },
];
