import type {
  AiModelConfig,
  DecisionRecord,
  EquitySnapshot,
  ExchangeAccount,
  ExchangeId,
  ExecutionLogEntry,
  LlmProviderId,
  OrderRecord,
  PositionView,
  StrategyConfig,
  StrategyRecord,
  TradeRecord,
  Trader,
  TraderStats,
  TraderStatus,
  User,
} from '@aq/shared';
import { StrategyConfigSchema } from '@aq/shared';
import { getDb } from '../db/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('store');

const now = (): string => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/*  Users                                                                      */
/* -------------------------------------------------------------------------- */

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
  credentials_changed_at: string;
}

export const users = {
  count(): number {
    return getDb().count('SELECT COUNT(*) AS n FROM users');
  },

  findByUsername(username: string): (User & { passwordHash: string }) | undefined {
    const row = getDb().get<UserRow>('SELECT * FROM users WHERE username = ?', username);
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      role: row.role === 'owner' ? 'owner' : 'user',
      createdAt: row.created_at,
      passwordHash: row.password_hash,
    };
  },

  findById(id: number): User | undefined {
    const row = getDb().get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      role: row.role === 'owner' ? 'owner' : 'user',
      createdAt: row.created_at,
    };
  },

  create(username: string, passwordHash: string, role: 'owner' | 'user'): User {
    const { lastInsertRowid } = getDb().run(
      'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
      username,
      passwordHash,
      role,
      now(),
    );
    log.info(`created ${role} account "${username}"`);
    return { id: lastInsertRowid, username, role, createdAt: now() };
  },

  updatePassword(id: number, passwordHash: string): void {
    getDb().run('UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, id);
  },

  /**
   * 改用户名。
   *
   * 调用方必须**先**自行检查新用户名未被占用。数据库上的 UNIQUE 约束虽然也会拦住，
   * 但抛出来的是一条 SQLite 错误，没法直接展示给用户。
   */
  updateUsername(id: number, username: string): void {
    getDb().run('UPDATE users SET username = ? WHERE id = ?', username, id);
    log.info(`renamed account #${id} to "${username}"`);
  },

  /** 所有管理员账号，按创建时间升序。用于密码重置时找到要改的那个账号。 */
  listOwners(): User[] {
    return getDb()
      .all<UserRow>("SELECT * FROM users WHERE role = 'owner' ORDER BY id")
      .map((row) => ({
        id: row.id,
        username: row.username,
        role: row.role === 'owner' ? 'owner' : 'user',
        createdAt: row.created_at,
      }));
  },

  /**
   * 该账户最后一次修改凭据的时间（epoch 毫秒），从未改过则为 `null`。
   *
   * 供 JWT 撤销使用：签发令牌时把这个值写进载荷，校验时与它等值比较，
   * 不等即说明令牌是在凭据变更之前签发的，必须拒绝。见 `api/auth.ts`。
   */
  credentialsChangedAt(id: number): number | null {
    const row = getDb().get<{ credentials_changed_at: string }>(
      'SELECT credentials_changed_at FROM users WHERE id = ?',
      id,
    );
    const raw = row?.credentials_changed_at;
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  },

  /**
   * 记录一次凭据变更，作废该账户此前签发的全部令牌。
   *
   * 调用点必须在**重新签发**令牌之前调用它，否则新令牌会带着旧的时间戳，
   * 一签发就是失效的（用户会被立刻踢回登录页，且看不出原因）。
   */
  markCredentialsChanged(id: number): number {
    const timestamp = now();
    getDb().run('UPDATE users SET credentials_changed_at = ? WHERE id = ?', timestamp, id);
    log.info(`account #${id} credentials changed — previously issued sessions are now revoked`);
    return Date.parse(timestamp);
  },
};

/* -------------------------------------------------------------------------- */
/*  Exchange accounts                                                          */
/* -------------------------------------------------------------------------- */

interface ExchangeRow {
  id: number;
  exchange: string;
  label: string;
  api_key: string;
  api_secret_enc: string;
  passphrase_enc: string;
  testnet: number;
  can_trade: number;
  created_at: string;
  updated_at: string;
}

function toExchangeAccount(row: ExchangeRow): ExchangeAccount {
  return {
    id: row.id,
    exchange: row.exchange as ExchangeId,
    label: row.label,
    apiKey: row.api_key,
    hasSecret: row.api_secret_enc.length > 0,
    testnet: row.testnet === 1,
    canTrade: row.can_trade === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const exchanges = {
  list(): ExchangeAccount[] {
    return getDb().all<ExchangeRow>('SELECT * FROM exchange_accounts ORDER BY id').map(toExchangeAccount);
  },

  get(id: number): ExchangeAccount | undefined {
    const row = getDb().get<ExchangeRow>('SELECT * FROM exchange_accounts WHERE id = ?', id);
    return row ? toExchangeAccount(row) : undefined;
  },

  /** Full row including the encrypted secret — server-internal use only. */
  getWithSecret(id: number): ExchangeRow | undefined {
    return getDb().get<ExchangeRow>('SELECT * FROM exchange_accounts WHERE id = ?', id);
  },

  create(input: {
    exchange: ExchangeId;
    label: string;
    apiKey: string;
    apiSecretEnc: string;
    testnet: boolean;
    canTrade: boolean;
  }): ExchangeAccount {
    const ts = now();
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO exchange_accounts (exchange, label, api_key, api_secret_enc, passphrase_enc, testnet, can_trade, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`,
      input.exchange,
      input.label,
      input.apiKey,
      input.apiSecretEnc,
      input.testnet,
      input.canTrade,
      ts,
      ts,
    );
    return this.get(lastInsertRowid) as ExchangeAccount;
  },

  update(
    id: number,
    input: Partial<{ label: string; apiKey: string; apiSecretEnc: string; testnet: boolean; canTrade: boolean }>,
  ): void {
    const current = this.getWithSecret(id);
    if (!current) return;
    getDb().run(
      `UPDATE exchange_accounts
         SET label = ?, api_key = ?, api_secret_enc = ?, testnet = ?, can_trade = ?, updated_at = ?
       WHERE id = ?`,
      input.label ?? current.label,
      input.apiKey ?? current.api_key,
      input.apiSecretEnc ?? current.api_secret_enc,
      (input.testnet ?? current.testnet === 1) ? 1 : 0,
      (input.canTrade ?? current.can_trade === 1) ? 1 : 0,
      now(),
      id,
    );
  },

  remove(id: number): void {
    getDb().run('DELETE FROM exchange_accounts WHERE id = ?', id);
  },

  /** Traders referencing this credential, used to block unsafe deletes. */
  usageCount(id: number): number {
    return getDb().count('SELECT COUNT(*) AS n FROM traders WHERE exchange_account_id = ?', id);
  },
};

/* -------------------------------------------------------------------------- */
/*  AI models                                                                  */
/* -------------------------------------------------------------------------- */

interface AiModelRow {
  id: number;
  provider: string;
  label: string;
  model: string;
  base_url: string;
  api_key_enc: string;
  temperature: number;
  max_tokens: number;
  timeout_seconds: number;
  max_retries: number;
  created_at: string;
  updated_at: string;
}

function toAiModel(row: AiModelRow): AiModelConfig {
  return {
    id: row.id,
    provider: row.provider as LlmProviderId,
    label: row.label,
    model: row.model,
    baseUrl: row.base_url,
    apiKeyMasked: '',
    temperature: row.temperature,
    maxTokens: row.max_tokens,
    timeoutSeconds: row.timeout_seconds,
    maxRetries: row.max_retries,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const aiModels = {
  list(): AiModelConfig[] {
    return getDb().all<AiModelRow>('SELECT * FROM ai_models ORDER BY id').map(toAiModel);
  },

  get(id: number): AiModelConfig | undefined {
    const row = getDb().get<AiModelRow>('SELECT * FROM ai_models WHERE id = ?', id);
    return row ? toAiModel(row) : undefined;
  },

  getWithSecret(id: number): AiModelRow | undefined {
    return getDb().get<AiModelRow>('SELECT * FROM ai_models WHERE id = ?', id);
  },

  create(input: {
    provider: LlmProviderId;
    label: string;
    model: string;
    baseUrl: string;
    apiKeyEnc: string;
    temperature: number;
    maxTokens: number;
    timeoutSeconds: number;
    maxRetries: number;
  }): AiModelConfig {
    const ts = now();
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO ai_models (provider, label, model, base_url, api_key_enc, temperature, max_tokens, timeout_seconds, max_retries, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.provider,
      input.label,
      input.model,
      input.baseUrl,
      input.apiKeyEnc,
      input.temperature,
      input.maxTokens,
      input.timeoutSeconds,
      input.maxRetries,
      ts,
      ts,
    );
    return this.get(lastInsertRowid) as AiModelConfig;
  },

  update(
    id: number,
    input: Partial<{
      provider: LlmProviderId;
      label: string;
      model: string;
      baseUrl: string;
      apiKeyEnc: string;
      temperature: number;
      maxTokens: number;
      timeoutSeconds: number;
      maxRetries: number;
    }>,
  ): void {
    const current = this.getWithSecret(id);
    if (!current) return;
    getDb().run(
      `UPDATE ai_models
         SET provider = ?, label = ?, model = ?, base_url = ?, api_key_enc = ?,
             temperature = ?, max_tokens = ?, timeout_seconds = ?, max_retries = ?, updated_at = ?
       WHERE id = ?`,
      input.provider ?? current.provider,
      input.label ?? current.label,
      input.model ?? current.model,
      input.baseUrl ?? current.base_url,
      input.apiKeyEnc ?? current.api_key_enc,
      input.temperature ?? current.temperature,
      input.maxTokens ?? current.max_tokens,
      input.timeoutSeconds ?? current.timeout_seconds,
      input.maxRetries ?? current.max_retries,
      now(),
      id,
    );
  },

  remove(id: number): void {
    getDb().run('DELETE FROM ai_models WHERE id = ?', id);
  },

  usageCount(id: number): number {
    return getDb().count('SELECT COUNT(*) AS n FROM traders WHERE ai_model_id = ?', id);
  },
};

/* -------------------------------------------------------------------------- */
/*  Strategies                                                                 */
/* -------------------------------------------------------------------------- */

interface StrategyRow {
  id: number;
  name: string;
  description: string;
  config_json: string;
  preset_id: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function toStrategy(row: StrategyRow): StrategyRecord {
  let parsed: StrategyConfig;
  try {
    const raw = JSON.parse(row.config_json) as unknown;
    // Parsing through the schema fills in any field added since the row was
    // written, so an old strategy keeps working after an upgrade.
    const result = StrategyConfigSchema.safeParse(raw);
    parsed = result.success ? result.data : StrategyConfigSchema.parse({});
  } catch {
    log.warn(`strategy ${row.id} has unreadable config JSON; falling back to defaults`);
    parsed = StrategyConfigSchema.parse({});
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    config: parsed,
    presetId: row.preset_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const strategies = {
  list(): StrategyRecord[] {
    return getDb()
      .all<StrategyRow>('SELECT * FROM strategies ORDER BY is_default DESC, id')
      .map(toStrategy);
  },

  get(id: number): StrategyRecord | undefined {
    const row = getDb().get<StrategyRow>('SELECT * FROM strategies WHERE id = ?', id);
    return row ? toStrategy(row) : undefined;
  },

  create(input: {
    name: string;
    description: string;
    config: StrategyConfig;
    presetId: string | null;
    isDefault?: boolean;
  }): StrategyRecord {
    const ts = now();
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO strategies (name, description, config_json, preset_id, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.name,
      input.description,
      JSON.stringify(input.config),
      input.presetId,
      input.isDefault ? 1 : 0,
      ts,
      ts,
    );
    return this.get(lastInsertRowid) as StrategyRecord;
  },

  update(
    id: number,
    input: Partial<{ name: string; description: string; config: StrategyConfig }>,
  ): void {
    const current = this.get(id);
    if (!current) return;
    getDb().run(
      `UPDATE strategies SET name = ?, description = ?, config_json = ?, updated_at = ? WHERE id = ?`,
      input.name ?? current.name,
      input.description ?? current.description,
      JSON.stringify(input.config ?? current.config),
      now(),
      id,
    );
  },

  remove(id: number): void {
    getDb().run('DELETE FROM strategies WHERE id = ?', id);
  },

  usageCount(id: number): number {
    return getDb().count('SELECT COUNT(*) AS n FROM traders WHERE strategy_id = ?', id);
  },

  /** The strategy a brand-new trader starts from. */
  getDefault(): StrategyRecord | undefined {
    const row = getDb().get<StrategyRow>('SELECT * FROM strategies ORDER BY is_default DESC, id LIMIT 1');
    return row ? toStrategy(row) : undefined;
  },
};

/* -------------------------------------------------------------------------- */
/*  Traders                                                                    */
/* -------------------------------------------------------------------------- */

interface TraderRow {
  id: number;
  name: string;
  exchange_account_id: number;
  ai_model_id: number;
  strategy_id: number;
  cycle_interval_minutes: number;
  initial_equity: number;
  status: string;
  last_cycle_at: string | null;
  last_cycle_number: number;
  last_error: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

function toTrader(row: TraderRow): Trader {
  return {
    id: row.id,
    name: row.name,
    exchangeAccountId: row.exchange_account_id,
    aiModelId: row.ai_model_id,
    strategyId: row.strategy_id,
    cycleIntervalMinutes: row.cycle_interval_minutes,
    initialEquity: row.initial_equity,
    status: row.status as TraderStatus,
    lastCycleAt: row.last_cycle_at,
    lastCycleNumber: row.last_cycle_number,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const traders = {
  list(): Trader[] {
    return getDb().all<TraderRow>('SELECT * FROM traders ORDER BY id').map(toTrader);
  },

  get(id: number): Trader | undefined {
    const row = getDb().get<TraderRow>('SELECT * FROM traders WHERE id = ?', id);
    return row ? toTrader(row) : undefined;
  },

  create(input: {
    name: string;
    exchangeAccountId: number;
    aiModelId: number;
    strategyId: number;
    cycleIntervalMinutes: number;
    initialEquity: number;
  }): Trader {
    const ts = now();
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO traders (name, exchange_account_id, ai_model_id, strategy_id, cycle_interval_minutes, initial_equity, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'stopped', ?, ?)`,
      input.name,
      input.exchangeAccountId,
      input.aiModelId,
      input.strategyId,
      input.cycleIntervalMinutes,
      input.initialEquity,
      ts,
      ts,
    );
    return this.get(lastInsertRowid) as Trader;
  },

  update(
    id: number,
    input: Partial<{
      name: string;
      aiModelId: number;
      strategyId: number;
      cycleIntervalMinutes: number;
      initialEquity: number;
    }>,
  ): void {
    const current = this.get(id);
    if (!current) return;
    getDb().run(
      `UPDATE traders SET name = ?, ai_model_id = ?, strategy_id = ?, cycle_interval_minutes = ?, initial_equity = ?, updated_at = ? WHERE id = ?`,
      input.name ?? current.name,
      input.aiModelId ?? current.aiModelId,
      input.strategyId ?? current.strategyId,
      input.cycleIntervalMinutes ?? current.cycleIntervalMinutes,
      input.initialEquity ?? current.initialEquity,
      now(),
      id,
    );
  },

  setStatus(id: number, status: TraderStatus, error: string | null = null): void {
    getDb().run(
      'UPDATE traders SET status = ?, last_error = ?, updated_at = ? WHERE id = ?',
      status,
      error,
      now(),
      id,
    );
  },

  recordCycle(id: number, cycleNumber: number, failures: number): void {
    getDb().run(
      'UPDATE traders SET last_cycle_at = ?, last_cycle_number = ?, consecutive_failures = ?, updated_at = ? WHERE id = ?',
      now(),
      cycleNumber,
      failures,
      now(),
      id,
    );
  },

  remove(id: number): void {
    getDb().run('DELETE FROM traders WHERE id = ?', id);
  },
};

/* -------------------------------------------------------------------------- */
/*  Positions                                                                  */
/* -------------------------------------------------------------------------- */

interface PositionRow {
  id: number;
  trader_id: number;
  symbol: string;
  side: string;
  quantity: number;
  entry_price: number;
  leverage: number;
  liquidation_price: number | null;
  margin_used: number;
  peak_pnl_percent: number;
  stop_loss: number | null;
  take_profit: number | null;
  stop_order_id: string | null;
  tp_order_id: string | null;
  open_reasoning: string;
  opened_at: string;
  status: string;
}

export const positions = {
  open(traderId: number): PositionRow[] {
    return getDb().all<PositionRow>(
      "SELECT * FROM positions WHERE trader_id = ? AND status = 'open' ORDER BY opened_at",
      traderId,
    );
  },

  getOpenBySymbol(traderId: number, symbol: string): PositionRow | undefined {
    return getDb().get<PositionRow>(
      "SELECT * FROM positions WHERE trader_id = ? AND symbol = ? AND status = 'open'",
      traderId,
      symbol,
    );
  },

  insert(input: {
    traderId: number;
    symbol: string;
    side: string;
    quantity: number;
    entryPrice: number;
    leverage: number;
    liquidationPrice: number | null;
    marginUsed: number;
    stopLoss: number | null;
    takeProfit: number | null;
    stopOrderId: string | null;
    tpOrderId: string | null;
    openReasoning: string;
  }): number {
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO positions (trader_id, symbol, side, quantity, entry_price, leverage, liquidation_price, margin_used, peak_pnl_percent, stop_loss, take_profit, stop_order_id, tp_order_id, open_reasoning, opened_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'open')`,
      input.traderId,
      input.symbol,
      input.side,
      input.quantity,
      input.entryPrice,
      input.leverage,
      input.liquidationPrice,
      input.marginUsed,
      input.stopLoss,
      input.takeProfit,
      input.stopOrderId,
      input.tpOrderId,
      input.openReasoning,
      now(),
    );
    return lastInsertRowid;
  },

  updatePeak(traderId: number, symbol: string, peakPnlPercent: number): void {
    const row = this.getOpenBySymbol(traderId, symbol);
    if (!row) return;
    // Peak only ever ratchets upward.
    if (peakPnlPercent <= row.peak_pnl_percent) return;
    getDb().run('UPDATE positions SET peak_pnl_percent = ? WHERE id = ?', peakPnlPercent, row.id);
  },

  setProtection(
    traderId: number,
    symbol: string,
    stopLoss: number | null,
    takeProfit: number | null,
    stopOrderId?: string | null,
    tpOrderId?: string | null,
  ): void {
    const row = this.getOpenBySymbol(traderId, symbol);
    if (!row) return;
    getDb().run(
      'UPDATE positions SET stop_loss = ?, take_profit = ?, stop_order_id = ?, tp_order_id = ? WHERE id = ?',
      stopLoss,
      takeProfit,
      stopOrderId === undefined ? row.stop_order_id : stopOrderId,
      tpOrderId === undefined ? row.tp_order_id : tpOrderId,
      row.id,
    );
  },

  close(id: number): void {
    getDb().run("UPDATE positions SET status = 'closed' WHERE id = ?", id);
  },

  closeAllForTrader(traderId: number): void {
    getDb().run(
      "UPDATE positions SET status = 'closed' WHERE trader_id = ? AND status = 'open'",
      traderId,
    );
  },
};

/* -------------------------------------------------------------------------- */
/*  Orders                                                                     */
/* -------------------------------------------------------------------------- */

interface OrderRow {
  id: number;
  trader_id: number;
  exchange_order_id: string | null;
  client_order_id: string;
  symbol: string;
  side: string;
  type: string;
  purpose: string;
  quantity: number;
  price: number | null;
  stop_price: number | null;
  status: string;
  avg_price: number | null;
  filled_qty: number;
  fee: number;
  error: string | null;
  raw_response: string | null;
  created_at: string;
  updated_at: string;
}

function toOrder(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    traderId: row.trader_id,
    exchangeOrderId: row.exchange_order_id,
    clientOrderId: row.client_order_id,
    symbol: row.symbol,
    side: row.side as 'BUY' | 'SELL',
    type: row.type,
    purpose: row.purpose as OrderRecord['purpose'],
    quantity: row.quantity,
    price: row.price,
    stopPrice: row.stop_price,
    status: row.status,
    avgPrice: row.avg_price,
    filledQty: row.filled_qty,
    fee: row.fee,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const orders = {
  /**
   * Exchange order ids this trader has placed, newest first.
   *
   * Reconciliation needs this to answer "did *this* trader open that
   * round-trip?" — two traders can share one exchange account, in which case
   * every fill in the account is visible to both and only the order history says
   * which one actually traded it.
   */
  exchangeOrderIds(traderId: number, limit = 2000): Set<string> {
    return new Set(
      getDb()
        .all<{ exchange_order_id: string | null }>(
          'SELECT exchange_order_id FROM orders WHERE trader_id = ? AND exchange_order_id IS NOT NULL ORDER BY id DESC LIMIT ?',
          traderId,
          limit,
        )
        .map((r) => String(r.exchange_order_id)),
    );
  },

  list(traderId: number, limit = 100): OrderRecord[] {
    return getDb()
      .all<OrderRow>(
        'SELECT * FROM orders WHERE trader_id = ? ORDER BY id DESC LIMIT ?',
        traderId,
        limit,
      )
      .map(toOrder);
  },

  insert(input: {
    traderId: number;
    exchangeOrderId: string | null;
    clientOrderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    type: string;
    purpose: OrderRecord['purpose'];
    quantity: number;
    price: number | null;
    stopPrice: number | null;
    status: string;
    /** Fill details. Omitted for orders that rest (stops, targets) or are rejected. */
    avgPrice?: number | null;
    filledQty?: number;
    fee?: number;
    error?: string | null;
    rawResponse?: unknown;
  }): number {
    const ts = now();
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO orders (trader_id, exchange_order_id, client_order_id, symbol, side, type, purpose, quantity, price, stop_price, status, avg_price, filled_qty, fee, error, raw_response, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traderId,
      input.exchangeOrderId,
      input.clientOrderId,
      input.symbol,
      input.side,
      input.type,
      input.purpose,
      input.quantity,
      input.price,
      input.stopPrice,
      input.status,
      input.avgPrice ?? null,
      input.filledQty ?? 0,
      input.fee ?? 0,
      input.error ?? null,
      input.rawResponse === undefined ? null : JSON.stringify(input.rawResponse),
      ts,
      ts,
    );
    return lastInsertRowid;
  },

  update(
    id: number,
    input: Partial<{
      status: string;
      avgPrice: number | null;
      filledQty: number;
      fee: number;
      error: string | null;
    }>,
  ): void {
    const row = getDb().get<OrderRow>('SELECT * FROM orders WHERE id = ?', id);
    if (!row) return;
    getDb().run(
      'UPDATE orders SET status = ?, avg_price = ?, filled_qty = ?, fee = ?, error = ?, updated_at = ? WHERE id = ?',
      input.status ?? row.status,
      input.avgPrice === undefined ? row.avg_price : input.avgPrice,
      input.filledQty ?? row.filled_qty,
      input.fee ?? row.fee,
      input.error === undefined ? row.error : input.error,
      now(),
      id,
    );
  },

  /** Fee total for a trader's trades, used in stats. */
  totalFees(traderId: number): number {
    const row = getDb().get<{ total: number | null }>(
      'SELECT SUM(fee) AS total FROM orders WHERE trader_id = ?',
      traderId,
    );
    return row?.total ?? 0;
  },
};

/* -------------------------------------------------------------------------- */
/*  Trades                                                                     */
/* -------------------------------------------------------------------------- */

interface TradeRow {
  id: number;
  trader_id: number;
  symbol: string;
  side: string;
  quantity: number;
  entry_price: number;
  exit_price: number;
  leverage: number;
  pnl: number;
  pnl_percent: number;
  fee: number;
  close_reason: string;
  opened_at: string;
  closed_at: string;
  hold_minutes: number;
  entry_fee: number;
  funding_fee: number;
  net_pnl: number;
  source: string;
  entry_order_id: string | null;
  exit_order_id: string | null;
}

function toTrade(row: TradeRow): TradeRecord {
  return {
    id: row.id,
    traderId: row.trader_id,
    symbol: row.symbol,
    side: row.side as 'long' | 'short',
    quantity: row.quantity,
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    leverage: row.leverage,
    pnl: row.pnl,
    entryFee: row.entry_fee,
    exitFee: Math.max(0, row.fee - row.entry_fee),
    fee: row.fee,
    fundingFee: row.funding_fee,
    netPnl: row.net_pnl,
    pnlPercent: row.pnl_percent,
    closeReason: row.close_reason,
    source: (row.source === 'reconciled' ? 'reconciled' : 'bot') as 'bot' | 'reconciled',
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    holdMinutes: row.hold_minutes,
  };
}

/** Margin committed by a round-trip, used to express net PnL as a percentage. */
function marginOf(entryPrice: number, quantity: number, leverage: number): number {
  const notional = Math.abs(entryPrice * quantity);
  return notional > 0 ? notional / Math.max(leverage, 1) : 0;
}

/**
 * How many round-trips the dashboard's trend window covers.
 *
 * 5000 is the same ceiling the console used to request, now applied **in SQL**
 * via `ORDER BY closed_at DESC LIMIT ?` instead of by loading every row and
 * slicing in JavaScript. For any trader under 5000 round-trips the numbers the
 * dashboard renders are byte-for-byte what they were before.
 */
export const TREND_WINDOW = 5000;

/**
 * How many equity snapshots the time-to-trough drawdown considers.
 *
 * Same number the console passed inline before (`equity.list(traderId, 5000)`),
 * hoisted to a named constant so the single read and any future caller agree on
 * it. With one snapshot per cycle, 5000 covers a 15-minute trader for ~52 days —
 * beyond that the dashboard's drawdown is "recent", and the *breaker* uses
 * `equity.realizedHighWaterMark()`, which is unaffected by this bound.
 */
export const EQUITY_CURVE_WINDOW = 5000;

/** One point of the PnL curve. Where the type says `snake_case`, SQL named it. */
export interface TradeCurvePoint {
  pnl: number;
  pnl_percent: number;
  net_pnl: number;
  fee: number;
  funding_fee: number;
  closedAt: string;
}

export interface TradeStats {
  totalTrades: number;
  wins: number;
  losses: number;
  grossProfit: number;
  grossLoss: number;
  best: number;
  worst: number;
  avgWin: number;
  avgLoss: number;
  grossPnl: number;
  totalFees: number;
  totalFunding: number;
  netPnl: number;
  /** Earliest close on the books, for "how long has this been running". */
  firstClosedAt: string | null;
}

/**
 * One pass over `trades`: aggregate in SQL, materialise only the trend window.
 *
 * Why: `computeTraderStats` used to pull every column of every round-trip into
 * JavaScript objects and reduce them there — twice per request, once for
 * `stats()` and once for the Sharpe input — and it is called every 5–12 s per
 * trader. `node:sqlite` is synchronous, so those object graphs were built on the
 * same event loop that places orders. SQLite counts and sums without leaving C,
 * so the JavaScript work drops from O(all round-trips) to O(window).
 *
 * `COUNT(*)` and `SUM(...)` deliberately still cover the **whole** table: the
 * headline totals (lifetime trades, net PnL, fees, funding) must stay lifetime
 * figures and must not silently follow the window.
 */
function aggregateTrades(traderId: number): { totals: TradeStats; curve: TradeCurvePoint[] } {
  const totals = getDb().get<{
    totalTrades: number;
    wins: number;
    losses: number;
    grossProfit: number | null;
    grossLoss: number | null;
    best: number | null;
    worst: number | null;
    grossPnl: number | null;
    totalFees: number | null;
    totalFunding: number | null;
    netPnl: number | null;
    firstClosedAt: string | null;
  }>(
    `SELECT
       COUNT(*)                                                   AS totalTrades,
       COALESCE(SUM(CASE WHEN net_pnl >  0 THEN 1 ELSE 0 END), 0) AS wins,
       COALESCE(SUM(CASE WHEN net_pnl <= 0 THEN 1 ELSE 0 END), 0) AS losses,
       COALESCE(SUM(CASE WHEN net_pnl >  0 THEN net_pnl ELSE 0 END), 0) AS grossProfit,
       ABS(COALESCE(SUM(CASE WHEN net_pnl <= 0 THEN net_pnl ELSE 0 END), 0)) AS grossLoss,
       MAX(net_pnl) AS best,
       MIN(net_pnl) AS worst,
       COALESCE(SUM(pnl), 0)         AS grossPnl,
       COALESCE(SUM(fee), 0)         AS totalFees,
       COALESCE(SUM(funding_fee), 0) AS totalFunding,
       COALESCE(SUM(net_pnl), 0)     AS netPnl,
       MIN(closed_at) AS firstClosedAt
     FROM trades WHERE trader_id = ?`,
    traderId,
  );

  const totalTrades = totals?.totalTrades ?? 0;
  const wins = totals?.wins ?? 0;
  const losses = totals?.losses ?? 0;
  const grossProfit = totals?.grossProfit ?? 0;
  const grossLoss = totals?.grossLoss ?? 0;

  return {
    totals: {
      totalTrades,
      wins,
      losses,
      grossProfit,
      grossLoss,
      // `MAX(net_pnl)` is NULL only when there are no rows, which is reported as 0
      // rather than left as a null the console would have to special-case.
      best: totals?.best ?? 0,
      worst: totals?.worst ?? 0,
      avgWin: wins > 0 ? grossProfit / wins : 0,
      avgLoss: losses > 0 ? grossLoss / losses : 0,
      grossPnl: totals?.grossPnl ?? 0,
      totalFees: totals?.totalFees ?? 0,
      totalFunding: totals?.totalFunding ?? 0,
      netPnl: totals?.netPnl ?? 0,
      firstClosedAt: totals?.firstClosedAt ?? null,
    },
    curve: getDb()
      .all<TradeCurvePoint>(
        `SELECT pnl, pnl_percent, net_pnl, fee, funding_fee, closed_at AS closedAt
           FROM trades WHERE trader_id = ? ORDER BY closed_at DESC LIMIT ?`,
        traderId,
        TREND_WINDOW,
      )
      // Reversed to chronological order: a drawdown walk is direction-sensitive,
      // so walking newest-first would silently report a different (smaller) one.
      .reverse(),
  };
}

export const trades = {
  list(traderId: number, limit = 100): TradeRecord[] {
    return getDb()
      .all<TradeRow>(
        'SELECT * FROM trades WHERE trader_id = ? ORDER BY closed_at DESC LIMIT ?',
        traderId,
        limit,
      )
      .map(toTrade);
  },

  recent(traderId: number, limit = 10): TradeRecord[] {
    return this.list(traderId, limit);
  },

  /**
   * Record a closed round-trip.
   *
   * `grossPnl` is the exchange's own realised figure and the costs are passed
   * separately, so `net_pnl` — the number the console shows — is derived in one
   * place instead of each caller doing its own arithmetic and disagreeing.
   * `pnlPercent` is deliberately computed here rather than accepted, for the
   * same reason.
   */
  insert(input: {
    traderId: number;
    symbol: string;
    side: 'long' | 'short';
    quantity: number;
    entryPrice: number;
    exitPrice: number;
    leverage: number;
    /** Gross, before costs. */
    grossPnl: number;
    entryFee?: number;
    exitFee?: number;
    fundingFee?: number;
    closeReason: string;
    openedAt: string;
    /** Exchange fill time. Defaults to now; reconciliation supplies the real one. */
    closedAt?: string;
    source?: 'bot' | 'reconciled';
    entryOrderId?: string | null;
    exitOrderId?: string | null;
  }): number {
    const closedAt = input.closedAt ?? now();
    const holdMinutes = Math.max(
      0,
      (new Date(closedAt).getTime() - new Date(input.openedAt).getTime()) / 60_000,
    );
    const entryFee = input.entryFee ?? 0;
    const exitFee = input.exitFee ?? 0;
    const fee = entryFee + exitFee;
    const fundingFee = input.fundingFee ?? 0;
    const netPnl = input.grossPnl - fee - fundingFee;
    const margin = marginOf(input.entryPrice, input.quantity, input.leverage);
    const pnlPercent = margin > 0 ? (netPnl / margin) * 100 : 0;

    const { lastInsertRowid } = getDb().run(
      `INSERT INTO trades (
         trader_id, symbol, side, quantity, entry_price, exit_price, leverage,
         pnl, pnl_percent, fee, close_reason, opened_at, closed_at, hold_minutes,
         entry_fee, funding_fee, net_pnl, source, entry_order_id, exit_order_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traderId,
      input.symbol,
      input.side,
      input.quantity,
      input.entryPrice,
      input.exitPrice,
      input.leverage,
      input.grossPnl,
      pnlPercent,
      fee,
      input.closeReason,
      input.openedAt,
      closedAt,
      holdMinutes,
      entryFee,
      fundingFee,
      netPnl,
      input.source ?? 'bot',
      input.entryOrderId ?? null,
      input.exitOrderId ?? null,
    );
    return lastInsertRowid;
  },

  /**
   * Correct a locally-booked trade with the exchange's authoritative figures.
   *
   * Used by reconciliation for round-trips the runtime *did* record, but whose
   * costs it only partly captured: the live path records the exit commission at
   * the moment of closing, so the entry leg's commission was missing and every
   * historical fee was understated by roughly half.
   */
  applyExchangeFigures(input: {
    id: number;
    grossPnl: number;
    entryFee: number;
    exitFee: number;
    fundingFee: number;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    leverage: number;
    entryOrderId: string | null;
    exitOrderId: string | null;
  }): void {
    const fee = input.entryFee + input.exitFee;
    const netPnl = input.grossPnl - fee - input.fundingFee;
    const margin = marginOf(input.entryPrice, input.quantity, input.leverage);
    getDb().run(
      `UPDATE trades
          SET pnl = ?, entry_fee = ?, fee = ?, funding_fee = ?, net_pnl = ?,
              pnl_percent = ?, entry_price = ?, exit_price = ?,
              entry_order_id = COALESCE(?, entry_order_id),
              exit_order_id = COALESCE(?, exit_order_id)
        WHERE id = ?`,
      input.grossPnl,
      input.entryFee,
      fee,
      input.fundingFee,
      netPnl,
      margin > 0 ? (netPnl / margin) * 100 : 0,
      input.entryPrice,
      input.exitPrice,
      input.entryOrderId,
      input.exitOrderId,
      input.id,
    );
  },

  /**
   * There is deliberately **no** `setFundingFee()` here.
   *
   * Funding cannot be read at the instant a position closes, and a setter that
   * writes a figure without recomputing `net_pnl` is an invitation to record a
   * number that never reaches the balance. Every close path therefore passes
   * `fundingFee` into `insert()` (read from `/fapi/v1/income`, or 0 and logged
   * when unreadable), and the reconcile pass rewrites it through
   * `applyExchangeFigures()`. Both of those derive `net_pnl` in one place.
   */

  /**
   * Round-trips already on the books, for matching against the exchange.
   *
   * `sinceIso` bounds the read to closes at or after that instant, and exists so
   * the **routine** reconciliation pass does not reload the trader's entire
   * lifetime every cycle. This method used to have no bound at all: a trader that
   * had been running for months rebuilt a map of every round-trip it had ever
   * booked, once per cycle, and `node:sqlite` is synchronous — so the cost was
   * paid on the event loop that runs the trading loop. The boot pass and the
   * periodic deep pass still read everything (omit the argument), which is what
   * keeps a close this trader slept through recoverable.
   */
  ledger(
    traderId: number,
    sinceIso?: string,
  ): Array<{
    id: number;
    symbol: string;
    quantity: number;
    entryPrice: number;
    openedAt: string;
    entryOrderId: string | null;
  }> {
    const sql =
      'SELECT id, symbol, quantity, entry_price, opened_at, entry_order_id FROM trades WHERE trader_id = ?' +
      (sinceIso ? ' AND closed_at >= ?' : '');
    return getDb()
      .all<{
        id: number;
        symbol: string;
        quantity: number;
        entry_price: number;
        opened_at: string;
        entry_order_id: string | null;
      }>(sql, ...(sinceIso ? [traderId, sinceIso] : [traderId]))
      .map((r) => ({
        id: r.id,
        symbol: r.symbol,
        quantity: r.quantity,
        entryPrice: r.entry_price,
        openedAt: r.opened_at,
        entryOrderId: r.entry_order_id,
      }));
  },

  /**
   * Distinct symbols this trader traded.
   *
   * `sinceIso` has the same purpose as on `ledger()`: reconciliation asks one
   * `userTrades` question per symbol, so an unbounded list keeps asking about
   * symbols that stopped trading months ago and spends weight every cycle on an
   * answer that cannot have changed.
   */
  tradedSymbols(traderId: number, sinceIso?: string): string[] {
    const sql =
      'SELECT DISTINCT symbol FROM trades WHERE trader_id = ?' +
      (sinceIso ? ' AND closed_at >= ?' : '');
    return getDb()
      .all<{ symbol: string }>(sql, ...(sinceIso ? [traderId, sinceIso] : [traderId]))
      .map((r) => r.symbol);
  },

  /**
   * Realised PnL since 00:00 UTC, for the daily circuit breaker.
   *
   * Net, not gross: fees are a real loss and a breaker that ignores them will
   * keep trading through a streak that is only breaking even on paper.
   */
  realizedPnlToday(traderId: number): number {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const row = getDb().get<{ total: number | null }>(
      'SELECT SUM(net_pnl) AS total FROM trades WHERE trader_id = ? AND closed_at >= ?',
      traderId,
      startOfDay.toISOString(),
    );
    return row?.total ?? 0;
  },

  /**
   * Aggregate performance.
   *
   * Classification is by **net** PnL: a trade that made a little on price but
   * less than it paid in commission lost money, and counting it as a win would
   * flatter the win rate and the profit factor.
   */
  /**
   * Aggregate performance.
   *
   * Classification is by **net** PnL: a trade that made a little on price but
   * less than it paid in commission lost money, and counting it as a win would
   * flatter the win rate and the profit factor. Kept as a repository method for
   * callers that only want the totals; the arithmetic itself lives in
   * `aggregateTrades()` so there is exactly one definition of every figure.
   */
  stats(traderId: number): TradeStats {
    return aggregateTrades(traderId).totals;
  },

  /**
   * The gross/net curve a Sharpe ratio and a drawdown are computed from.
   *
   * Time-ordered ascending and **bounded**, because `computeTraderStats` runs on
   * every dashboard refresh (every 5–12 s per trader) and `node:sqlite` is
   * synchronous — an unbounded `SELECT *` here is paid for with a blocked event
   * loop, i.e. with the trading loop. The bound is a display choice that is
   * stated in the code rather than hidden: beyond `TREND_WINDOW` round-trips the
   * dashboard's drawdown/Sharpe are "recent", not "lifetime".
   */
  curve(traderId: number, limit = TREND_WINDOW): TradeCurvePoint[] {
    return getDb()
      .all<TradeCurvePoint>(
        `SELECT pnl, pnl_percent, net_pnl, fee, funding_fee, closed_at AS closedAt
           FROM trades WHERE trader_id = ? ORDER BY closed_at DESC LIMIT ?`,
        traderId,
        limit,
      )
      .reverse();
  },
};

/* -------------------------------------------------------------------------- */
/*  Decision records                                                           */
/* -------------------------------------------------------------------------- */

interface DecisionRow {
  id: number;
  trader_id: number;
  cycle_number: number;
  timestamp: string;
  system_prompt: string;
  user_prompt: string;
  cot_trace: string;
  decisions_json: string;
  raw_response: string;
  execution_log_json: string;
  candidate_symbols_json: string;
  success: number;
  error: string | null;
  ai_latency_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

function toDecisionRecord(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    traderId: row.trader_id,
    cycleNumber: row.cycle_number,
    timestamp: row.timestamp,
    systemPrompt: row.system_prompt,
    userPrompt: row.user_prompt,
    cotTrace: row.cot_trace,
    decisions: safeJsonParse(row.decisions_json, []),
    rawResponse: row.raw_response,
    executionLog: safeJsonParse<ExecutionLogEntry[]>(row.execution_log_json, []),
    candidateSymbols: safeJsonParse<string[]>(row.candidate_symbols_json, []),
    success: row.success === 1,
    error: row.error,
    aiLatencyMs: row.ai_latency_ms,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
  };
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const decisions = {
  list(traderId: number, limit = 50): DecisionRecord[] {
    return getDb()
      .all<DecisionRow>(
        'SELECT * FROM decision_records WHERE trader_id = ? ORDER BY cycle_number DESC LIMIT ?',
        traderId,
        limit,
      )
      .map(toDecisionRecord);
  },

  get(id: number): DecisionRecord | undefined {
    const row = getDb().get<DecisionRow>('SELECT * FROM decision_records WHERE id = ?', id);
    return row ? toDecisionRecord(row) : undefined;
  },

  log(input: {
    traderId: number;
    cycleNumber: number;
    systemPrompt: string;
    userPrompt: string;
    cotTrace: string;
    decisions: unknown;
    rawResponse: string;
    executionLog: ExecutionLogEntry[];
    candidateSymbols: string[];
    success: boolean;
    error: string | null;
    aiLatencyMs: number;
    promptTokens: number | null;
    completionTokens: number | null;
  }): number {
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO decision_records (trader_id, cycle_number, timestamp, system_prompt, user_prompt, cot_trace, decisions_json, raw_response, execution_log_json, candidate_symbols_json, success, error, ai_latency_ms, prompt_tokens, completion_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.traderId,
      input.cycleNumber,
      now(),
      input.systemPrompt,
      input.userPrompt,
      input.cotTrace,
      JSON.stringify(input.decisions),
      input.rawResponse,
      JSON.stringify(input.executionLog),
      JSON.stringify(input.candidateSymbols),
      input.success,
      input.error,
      input.aiLatencyMs,
      input.promptTokens,
      input.completionTokens,
    );
    // Keep the audit trail bounded so the database does not grow without limit.
    getDb().run(
      `DELETE FROM decision_records
        WHERE trader_id = ?
          AND id NOT IN (SELECT id FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT 500)`,
      input.traderId,
      input.traderId,
    );
    return lastInsertRowid;
  },

  count(traderId: number): number {
    return getDb().count('SELECT COUNT(*) AS n FROM decision_records WHERE trader_id = ?', traderId);
  },
};

/* -------------------------------------------------------------------------- */
/*  Equity snapshots                                                           */
/* -------------------------------------------------------------------------- */

interface EquityRow {
  id: number;
  trader_id: number;
  timestamp: string;
  equity: number;
  available_balance: number;
  unrealized_pnl: number;
  margin_used: number;
  open_positions: number;
}

export const equity = {
  list(traderId: number, limit = 500): EquitySnapshot[] {
    return getDb()
      .all<EquityRow>(
        'SELECT * FROM equity_snapshots WHERE trader_id = ? ORDER BY timestamp DESC LIMIT ?',
        traderId,
        limit,
      )
      .reverse()
      .map((row) => ({
        traderId: row.trader_id,
        timestamp: row.timestamp,
        equity: row.equity,
        availableBalance: row.available_balance,
        unrealizedPnl: row.unrealized_pnl,
        marginUsed: row.margin_used,
        openPositions: row.open_positions,
      }));
  },

  insert(snapshot: EquitySnapshot): void {
    getDb().run(
      `INSERT INTO equity_snapshots (trader_id, timestamp, equity, available_balance, unrealized_pnl, margin_used, open_positions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      snapshot.traderId,
      snapshot.timestamp,
      snapshot.equity,
      snapshot.availableBalance,
      snapshot.unrealizedPnl,
      snapshot.marginUsed,
      snapshot.openPositions,
    );
  },

  /**
   * Highest equity ever recorded — **on closed positions only**.
   *
   * Snapshot `equity` is the margin balance, which includes unrealised PnL. Using
   * it as the circuit breaker's high-water mark was a live bug: one unrealised
   * spike (price wicks up on an open position for a few seconds) raised the
   * watermark, and when the spike retraced the mark-to-market went back to the
   * baseline, so every later cycle computed a drawdown that never happened and
   * `maxTotalDrawdownPercent` blocked **every** new position, permanently and
   * silently — the reason was logged but nothing ever cleared it.
   *
   * `equity - unrealized_pnl` is the balance the account would show with the
   * open positions marked at their entry, i.e. the figure that only moves when a
   * position is actually closed. Deposits still move it, which is correct: a
   * deposit genuinely raises the account's base.
   */
  realizedHighWaterMark(traderId: number): number {
    const row = getDb().get<{ peak: number | null }>(
      'SELECT MAX(equity - unrealized_pnl) AS peak FROM equity_snapshots WHERE trader_id = ?',
      traderId,
    );
    return row?.peak ?? 0;
  },

  latest(traderId: number): EquitySnapshot | undefined {
    const rows = this.list(traderId, 1);
    return rows[rows.length - 1];
  },
};

/* -------------------------------------------------------------------------- */
/*  Trade events (throttling bookkeeping)                                      */
/* -------------------------------------------------------------------------- */

/**
 * `trade_events` 保留窗口。
 *
 * 这张表原来**没有任何保留策略**，而每个回合至少写两行（entry + exit），
 * 于是它随交易次数线性增长、永不收缩。
 *
 * 7 天是"安全富余"而不是"刚好够用"，理由是这张表的**每一个读取者**都只看最近一小段：
 *
 *  · `entriesThisHour()` 只看 1 小时；
 *  · `isInCooldown()` 只问「这个标的上一次 exit 是什么时候」，而 cooldown 的上限由
 *    `StrategyConfigSchema` 钉死在 1440 分钟（24 小时）—— 超过 24 小时的记录
 *    无论存在与否都不改变判断结果。
 *
 * 所以 7 天 = 最长 cooldown 的 7 倍，即使出现时钟跳变或手工改过配置也不会读到
 * 被裁掉的行。反向的取舍：裁早了会**放开**一个本该仍在冷却的标的（更激进），
 * 所以窗口宁可给足，不能贴着 1440 分钟设。
 *
 * 注意：账目正确性不依赖这张表 —— 净盈亏来自 `trades`，节流只是运行时约束。
 */
const TRADE_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 一次 count 结果的阈值，到了才顺手裁剪一次。
 *
 * 这个数字同时是"多久裁一次"的开关：`countSince()` 的返回值是有界窗口内的条数，
 * 正常情况下是个位到两位数，所以稳态下这条 DELETE 一次都不会执行。只有当窗口内
 * 真的积压了 200 条以上事件时才触发一次裁剪 —— 那时删掉 7 天前的行是纯收益。
 */
const TRADE_EVENT_TRIM_THRESHOLD = 200;

/**
 * 裁掉保留窗口之外的节流事件。
 *
 * 模块级函数而不是 `tradeEvents.trim`：`countSince` 内部要调它，而对象字面量
 * 在初始化期间引用自身（`tradeEvents.trim()`）会抛 TDZ 的 ReferenceError ——
 * 一个只在阈值被突破时才现形的隐藏炸弹。
 */
function trimTradeEvents(retentionMs = TRADE_EVENT_RETENTION_MS): void {
  getDb().run(
    'DELETE FROM trade_events WHERE created_at < ?',
    new Date(Date.now() - retentionMs).toISOString(),
  );
}

export const tradeEvents = {
  record(traderId: number, symbol: string, kind: 'entry' | 'exit'): void {
    getDb().run(
      'INSERT INTO trade_events (trader_id, symbol, kind, created_at) VALUES (?, ?, ?, ?)',
      traderId,
      symbol,
      kind,
      now(),
    );
  },

  /** 裁剪到保留窗口内。**按批次调用**（入口是 `countSince()`），不是每次写入都调。 */
  trim(retentionMs = TRADE_EVENT_RETENTION_MS): void {
    trimTradeEvents(retentionMs);
  },

  countSince(traderId: number, kind: 'entry' | 'exit', sinceIso: string): number {
    const count = getDb().count(
      'SELECT COUNT(*) AS n FROM trade_events WHERE trader_id = ? AND kind = ? AND created_at >= ?',
      traderId,
      kind,
      sinceIso,
    );
    if (count >= TRADE_EVENT_TRIM_THRESHOLD) trimTradeEvents();
    return count;
  },

  /** Most recent event of a kind for a symbol — drives the re-entry cooldown. */
  lastFor(traderId: number, symbol: string, kind: 'entry' | 'exit'): string | undefined {
    const row = getDb().get<{ created_at: string }>(
      'SELECT created_at FROM trade_events WHERE trader_id = ? AND symbol = ? AND kind = ? ORDER BY created_at DESC LIMIT 1',
      traderId,
      symbol,
      kind,
    );
    return row?.created_at;
  },

  entriesThisHour(traderId: number): number {
    return this.countSince(traderId, 'entry', new Date(Date.now() - 3_600_000).toISOString());
  },

  entriesThisCycle(traderId: number, cycleNumber: number): number {
    const row = getDb().get<{ created_at: string }>(
      'SELECT created_at FROM decision_records WHERE trader_id = ? AND cycle_number = ? LIMIT 1',
      traderId,
      cycleNumber,
    );
    const since = row?.created_at ?? new Date(Date.now() - 60_000).toISOString();
    return this.countSince(traderId, 'entry', since);
  },
};

/* -------------------------------------------------------------------------- */
/*  Settings and logs                                                          */
/* -------------------------------------------------------------------------- */

export const settings = {
  get(key: string): string | undefined {
    return getDb().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
  },
  set(key: string, value: string): void {
    getDb().run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  },
};

/** 控制台日志保留的最新行数。表有界，但**不再每写一行就裁剪一次**。 */
export const RUNTIME_LOG_CAP = 500;
/**
 * 每写入这么多行才执行一次裁剪。
 *
 * 为什么不是每行一次：原实现的 DELETE 是
 * `DELETE … WHERE id NOT IN (SELECT id … LIMIT 500)`，每写一行扫一遍全表。
 * 而 `emit()` 会在**每个标的的循环里**调用它（对账补录、保护单挂不上、
 * 平仓失败……），一轮周期里能触发几十次；`node:sqlite` 是同步 API，
 * 这些全表扫描全部阻塞事件循环 —— 事件循环正是交易循环本身。
 *
 * 200 这个数字是"内存里多留 200 行"换"DELETE 次数降两个数量级"：
 * 表的上界变成 CAP + TRIM_EVERY = 700 行，而控制台只读最近 200 行，
 * 缓冲的那部分没有任何读取路径依赖它。
 */
const TRIM_EVERY_WRITES = 200;
/** 距离上次裁剪已写入的行数。模块级状态即可：裁剪是全局的，不区分 trader。 */
let writesSinceTrim = 0;

export const runtimeLogs = {
  write(traderId: number | null, level: string, scope: string, message: string): void {
    getDb().run(
      'INSERT INTO runtime_logs (trader_id, level, scope, message, created_at) VALUES (?, ?, ?, ?, ?)',
      traderId,
      level,
      scope,
      message,
      now(),
    );
    writesSinceTrim += 1;
    if (writesSinceTrim >= TRIM_EVERY_WRITES) {
      writesSinceTrim = 0;
      this.trim();
    }
  },

  /** 把表压回 `RUNTIME_LOG_CAP` 行。写路径按批次调用，不是每行调用。 */
  trim(): void {
    getDb().run(
      `DELETE FROM runtime_logs
        WHERE id NOT IN (SELECT id FROM runtime_logs ORDER BY id DESC LIMIT ${RUNTIME_LOG_CAP})`,
    );
  },

  list(limit = 200): Array<{ id: number; traderId: number | null; level: string; scope: string; message: string; createdAt: string }> {
    return getDb()
      .all<{ id: number; trader_id: number | null; level: string; scope: string; message: string; created_at: string }>(
        'SELECT * FROM runtime_logs ORDER BY id DESC LIMIT ?',
        limit,
      )
      .reverse()
      .map((row) => ({
        id: row.id,
        traderId: row.trader_id,
        level: row.level,
        scope: row.scope,
        message: row.message,
        createdAt: row.created_at,
      }));
  },
};

/* -------------------------------------------------------------------------- */
/*  Aggregated statistics                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Compute a trader's headline statistics.
 *
 * Sharpe is annualised from per-trade returns using the trade count as the
 * sample size, which is crude but honest — it is labelled as such in the UI and
 * is only comparable between traders on the same cadence.
 */
export function computeTraderStats(traderId: number): TraderStats {
  const trader = traders.get(traderId);
  /*
   * One pass over `trades` for both the totals and the Sharpe input.
   *
   * This used to be **four** full scans per request: `trades.stats()`, a second
   * `SELECT pnl, pnl_percent FROM trades` for the Sharpe, and `equity.list(5000)`
   * called *twice* — once for the drawdown walk and once again just to read
   * `[0].timestamp`. The dashboard refreshes this every 5–12 s per trader, and
   * `node:sqlite` is synchronous, so every one of those scans ran on the event
   * loop that also drives the trading cycle. Two of them were also unbounded.
   */
  const { totals: tradeStats, curve: closed } = aggregateTrades(traderId);
  const latest = equity.latest(traderId);
  const openPositions = positions.open(traderId);

  /*
   * `realizedPnl` is the **net** figure — gross minus fees minus funding —
   * because that is what the account actually gained and what the console must
   * show. Reporting gross here is what let the platform claim −0.3136 on an
   * account that had made +0.2586.
   */
  const realizedPnl = tradeStats.netPnl;
  const equityNow = latest?.equity ?? trader?.initialEquity ?? 0;
  const initial = trader?.initialEquity ?? 0;

  // Sharpe over **net** returns, matching the headline number.
  const returns = closed.map((t) => t.pnl_percent / 100);
  const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance =
    returns.length > 1
      ? returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(Math.min(returns.length, 252)) : null;

  /*
   * Equity curve for the drawdown walk and for uptime.
   *
   * Read **once**. The previous code called `equity.list(traderId, 5000)` twice
   * with identical arguments — the second time purely to read element `[0]` — so
   * every dashboard refresh scanned and materialised the same 5000 snapshots
   * twice.
   */
  const equityCurve = equity.list(traderId, EQUITY_CURVE_WINDOW);

  // Max peak-to-trough drawdown across the equity curve.
  let peak = 0;
  let maxDrawdown = 0;
  for (const snapshot of equityCurve) {
    const value = snapshot.equity;
    if (value > peak) peak = value;
    if (peak > 0) {
      const dd = ((peak - value) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  const firstSnapshot = equityCurve[0];
  const uptimeHours = firstSnapshot
    ? (Date.now() - new Date(firstSnapshot.timestamp).getTime()) / 3_600_000
    : 0;

  return {
    traderId,
    equity: equityNow,
    initialEquity: initial,
    totalReturnPercent: initial > 0 ? ((equityNow - initial) / initial) * 100 : 0,
    realizedPnl,
    grossRealizedPnl: tradeStats.grossPnl,
    totalFees: tradeStats.totalFees,
    totalFunding: tradeStats.totalFunding,
    unrealizedPnl: latest?.unrealizedPnl ?? 0,
    totalTrades: tradeStats.totalTrades,
    // Percentage in 0–100. The field name states the unit so no caller has to
    // guess — an earlier `winRate` with no unit was multiplied by 100 again on
    // the client and rendered one win as 10000.0%.
    winRatePercent:
      tradeStats.totalTrades > 0 ? (tradeStats.wins / tradeStats.totalTrades) * 100 : 0,
    // Sent as real counts rather than left for the client to back out of the
    // percentage, which is lossy and produced "1 笔已平仓 / 100 盈".
    wins: tradeStats.wins,
    losses: tradeStats.losses,
    profitFactor:
      tradeStats.grossLoss > 0
        ? tradeStats.grossProfit / tradeStats.grossLoss
        : tradeStats.grossProfit > 0
          ? Number.POSITIVE_INFINITY
          : 0,
    avgWin: tradeStats.avgWin,
    avgLoss: tradeStats.avgLoss,
    maxDrawdownPercent: maxDrawdown,
    sharpeRatio: sharpe,
    bestTrade: tradeStats.best,
    worstTrade: tradeStats.worst,
    openPositions: openPositions.length,
    cyclesRun: decisions.count(traderId),
    uptimeHours,
  };
}
