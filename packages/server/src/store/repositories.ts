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

  /** Set the funding fee on a trade after the fact (funding settles every 8h). */
  setFundingFee(id: number, fundingFee: number): void {
    const row = getDb().get<{ pnl: number; fee: number }>(
      'SELECT pnl, fee FROM trades WHERE id = ?',
      id,
    );
    if (!row) return;
    const netPnl = row.pnl - row.fee - fundingFee;
    getDb().run('UPDATE trades SET funding_fee = ?, net_pnl = ? WHERE id = ?', fundingFee, netPnl, id);
  },

  /** Round-trips already on the books, for matching against the exchange. */
  ledger(
    traderId: number,
  ): Array<{ id: number; symbol: string; quantity: number; entryPrice: number; openedAt: string }> {
    return getDb()
      .all<{ id: number; symbol: string; quantity: number; entry_price: number; opened_at: string }>(
        'SELECT id, symbol, quantity, entry_price, opened_at FROM trades WHERE trader_id = ?',
        traderId,
      )
      .map((r) => ({
        id: r.id,
        symbol: r.symbol,
        quantity: r.quantity,
        entryPrice: r.entry_price,
        openedAt: r.opened_at,
      }));
  },

  /** Distinct symbols this trader has ever traded, so reconciliation can scope its queries. */
  tradedSymbols(traderId: number): string[] {
    return getDb()
      .all<{ symbol: string }>('SELECT DISTINCT symbol FROM trades WHERE trader_id = ?', traderId)
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
  stats(traderId: number): {
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
  } {
    const rows = getDb().all<{
      net_pnl: number;
      pnl: number;
      fee: number;
      funding_fee: number;
    }>('SELECT net_pnl, pnl, fee, funding_fee FROM trades WHERE trader_id = ? ORDER BY closed_at', traderId);

    const wins = rows.filter((r) => r.net_pnl > 0);
    const losses = rows.filter((r) => r.net_pnl <= 0);
    const grossProfit = wins.reduce((a, b) => a + b.net_pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b.net_pnl, 0));

    return {
      totalTrades: rows.length,
      wins: wins.length,
      losses: losses.length,
      grossProfit,
      grossLoss,
      best: rows.length > 0 ? Math.max(...rows.map((r) => r.net_pnl)) : 0,
      worst: rows.length > 0 ? Math.min(...rows.map((r) => r.net_pnl)) : 0,
      avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
      avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
      grossPnl: rows.reduce((a, b) => a + b.pnl, 0),
      totalFees: rows.reduce((a, b) => a + b.fee, 0),
      totalFunding: rows.reduce((a, b) => a + b.funding_fee, 0),
      netPnl: rows.reduce((a, b) => a + b.net_pnl, 0),
    };
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

  highWaterMark(traderId: number): number {
    const row = getDb().get<{ peak: number | null }>(
      'SELECT MAX(equity) AS peak FROM equity_snapshots WHERE trader_id = ?',
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

  countSince(traderId: number, kind: 'entry' | 'exit', sinceIso: string): number {
    return getDb().count(
      'SELECT COUNT(*) AS n FROM trade_events WHERE trader_id = ? AND kind = ? AND created_at >= ?',
      traderId,
      kind,
      sinceIso,
    );
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
    // Trim aggressively: this is a console convenience, not an audit trail.
    getDb().run(
      'DELETE FROM runtime_logs WHERE id NOT IN (SELECT id FROM runtime_logs ORDER BY id DESC LIMIT 500)',
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
  const tradeStats = trades.stats(traderId);
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

  const closed = getDb().all<{ pnl: number; pnl_percent: number }>(
    'SELECT pnl, pnl_percent FROM trades WHERE trader_id = ? ORDER BY closed_at',
    traderId,
  );
  // Sharpe over **net** returns, matching the headline number.
  const returns = closed.map((t) => t.pnl_percent / 100);
  const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance =
    returns.length > 1
      ? returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(Math.min(returns.length, 252)) : null;

  // Max peak-to-trough drawdown across the equity curve.
  const curve = equity.list(traderId, 5000).map((e) => e.equity);
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of curve) {
    if (value > peak) peak = value;
    if (peak > 0) {
      const dd = ((peak - value) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  const firstSnapshot = equity.list(traderId, 5000)[0];
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
