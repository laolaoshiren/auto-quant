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
  TraderMode,
  TraderStats,
  TraderStatus,
  User,
} from '@aq/shared';
import { StrategyConfigSchema, beijingDayStartIso } from '@aq/shared';
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
    log.info(`账户 #${id} 已改名为「${username}」`);
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
    log.info(`账户 #${id} 的凭据已变更 —— 之前签发的所有登录会话已作废`);
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
    log.warn(`策略 #${row.id} 的配置 JSON 无法解析，已回落到默认配置`);
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
  agent_config_json: string | null;
  mode: string;
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
    agentConfigJson: row.agent_config_json,
    mode: row.mode as TraderMode,
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
    /**
     * 运行模式。默认 `'strategy'`。
     *
     * ⚠️ 这个字段**靠列上的 `DEFAULT 'strategy'` 兜底也能跑** ——
     * 既有调用点不传就落到默认值，所以"这里漏了它"不会有任何症状：
     * 类型检查过、测试全绿、机器人照常创建，只是**建出来的永远不会是 AI 模式**。
     * 只能靠读这行代码发现。
     */
    mode?: TraderMode;
  }): Trader {
    const ts = now();
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO traders (name, exchange_account_id, ai_model_id, strategy_id, cycle_interval_minutes, mode, initial_equity, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?)`,
      input.name,
      input.exchangeAccountId,
      input.aiModelId,
      input.strategyId,
      input.cycleIntervalMinutes,
      input.mode ?? 'strategy',
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

  /**
   * 写入 AI 托管模式下的参数。**非空即代表这个机器人由 AI 托管。**
   *
   * 单独一个列而不是复用 `strategies.config`：一个策略可以被多个机器人共用，
   * 而 AI 模式下每个机器人的参数是各自演化的 —— 共用会让两个 AI 互相覆盖，
   * 且那种覆盖看起来完全正常（配置就是配置，看不出被谁改的）。
   *
   * 传 null 表示退出 AI 托管，回到策略里的固定参数。
   */
  setAgentConfig(id: number, configJson: string | null): void {
    getDb().run(
      'UPDATE traders SET agent_config_json = ?, updated_at = ? WHERE id = ?',
      configJson,
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


  /**
   * 支撑「加仓 / 减仓」的两个仓库方法。
   *
   * ## 为什么数量与均价要一起改
   *
   * 加仓改变的是**加权平均入场价**：`(旧均价×旧数量 + 新价×新数量) / 总数量`。
   * 只改数量、不改均价的话，平仓时算出来的盈亏是错的 ——
   * 而那个数字会一路传到 `trades`，成为永久的账面记录。
   *
   * **减仓反过来：均价不变。** 卖掉一部分不改变剩余部分当初的买入价
   * —— 这正是"加权平均"这个模型的含义。改它是记账错误。
   */
  resize(
    traderId: number,
    symbol: string,
    input: {
      /** 新的总数量（不是增量）。 */
      quantity: number;
      /** 新的加权均价；减仓时传原值。 */
      entryPrice: number;
      /** 保证金随之变化 —— 它由数量与杠杆决定。 */
      marginUsed: number;
      /** 部分平仓累计已记的净盈亏（只增不减）。 */
      addRealizedPartialPnl?: number;
      /** 部分平仓累计已记的数量（只增不减）。 */
      addBookedPartialQty?: number;
    },
  ): void {
    const row = this.getOpenBySymbol(traderId, symbol);
    if (!row) return;
    getDb().run(
      `UPDATE positions
         SET quantity = ?, entry_price = ?, margin_used = ?,
             realized_partial_pnl = realized_partial_pnl + ?,
             booked_partial_qty = booked_partial_qty + ?
       WHERE id = ?`,
      input.quantity,
      input.entryPrice,
      input.marginUsed,
      input.addRealizedPartialPnl ?? 0,
      input.addBookedPartialQty ?? 0,
      row.id,
    );
  },

  /**
   * 部分平仓已经记了多少。
   *
   * 最终平仓时要把它从交易所重建的整段往返里**减掉** —— 见迁移 M8 的说明：
   * 重复记账会让账面比账户好看，而那正是 §2.5 禁止的方向。
   */
  partialBooked(traderId: number, symbol: string): { pnl: number; qty: number } {
    const row = this.getOpenBySymbol(traderId, symbol);
    if (!row) return { pnl: 0, qty: 0 };
    const r = getDb().get(
      'SELECT realized_partial_pnl AS pnl, booked_partial_qty AS qty FROM positions WHERE id = ?',
      row.id,
    ) as { pnl: number | null; qty: number | null } | undefined;
    return { pnl: Number(r?.pnl) || 0, qty: Number(r?.qty) || 0 };
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

/* -------------------------------------------------------------------------- */
/*  Pagination caps                                                            */
/* -------------------------------------------------------------------------- */

/*
 * 历史表（订单 / 成交 / 决策）只回**一页**，三张表共用下面这一套钳制与游标。
 *
 * 为什么要共用一份实现：这三处各写一遍的话，迟早只改其中两处，而漏掉的那张表
 * 就是操作者说的"成千上万数据一次加载出来导致系统卡死"复发的地方
 * （`?limit=999999` 以前会被原样交给 SQL）。
 */

/**
 * 把调用方给的 `limit` 收进 `[1, max]`。**钳制而不是报错**。
 *
 * 翻页的控制台不该因为页大小写得大一点就收到 400，而一个手写的
 * `?limit=999999` 也绝不能真的返回 999999 条。
 * 非有限值（没传 / `NaN` / `Infinity`）回落到该表自己的默认页大小，
 * 等同于路由原来那半句 `Number.isFinite(limit) ? limit : 100`。
 *
 * 下界收到 1 而不是 0：`LIMIT 0` 返回的空数组和"这个机器人还没有记录"
 * 在响应里长得一模一样，会把一次参数错误伪装成一次空结果。
 */
function clampPageLimit(limit: number, max: number, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(limit)));
}

/**
 * 把调用方给的游标收成一个可用的 `id`；`null` 表示"第一页"。
 *
 * 非有限值（没传 / `?before=abc`）一律按第一页处理：发不出正确游标的调用方
 * 应该拿到**最新的一页**，而不是一个 400 —— 与 `clampPageLimit` 同一个取舍。
 */
function cursorOf(before: number | null | undefined): number | null {
  return before === undefined || before === null || !Number.isFinite(before) ? null : Math.trunc(before);
}

/**
 * 一次最多回多少条订单记录。
 *
 * 卡住的是**响应体的字节数**：订单行带着状态、均价、成交数量、手续费与错误文案
 * （12 列），而这张表是随机器人运行**无限增长**的 —— 一个跑了半年的机器人有几千行，
 * `?limit=999999` 一次就能把整张表拼进 JSON 占住 event loop，浏览器那侧也要一次
 * 建出几千个 DOM 节点。
 *
 * 200 与操作者上一版控制台每次轮询要的条数一致（那时候每 15 秒无条件拉 200 条），
 * 而一页 25 条的翻页只需要它的一小部分 —— 上限是给手写请求用的兜底，
 * 不是给界面用的页大小。
 */
export const ORDER_PAGE_MAX = 200;

/** 不传 `limit` 时返回多少条 —— 与历史契约一致（路由以前写死 100，`docs/API.md` 照旧）。 */
export const ORDER_PAGE_DEFAULT = 100;

/** `orders.list()` 的页大小：见 `clampPageLimit`。 */
export function clampOrderLimit(limit: number): number {
  return clampPageLimit(limit, ORDER_PAGE_MAX, ORDER_PAGE_DEFAULT);
}

/**
 * 「终态」委托状态：不会再变的状态码，其余任何值都还可能与交易所不一致（§2.2）。
 *
 * 覆盖两套词汇，因为 `orders.status` 里两套都会出现：
 *  · 普通订单 —— `binance/types.ts` 的 `BinanceOrderStatus`；
 *  · Algo 条件单 —— 同文件的 `BinanceAlgoStatus`（`NEW` / `FINISHED` / `TRIGGERED` / …）。
 *    两者只有 `NEW` 重合，所以 `FINISHED` 必须在这里列出来：漏掉它，一张已经触发成交的
 *    条件单就会被当成"还在挂"。
 *
 * 判据写成**否定**形式（`status NOT IN 终态`）而不是 `status IN (NEW, PARTIALLY_FILLED)`：
 * 交易所会新增状态码（`EXPIRED_IN_FUTURES` 就是后来补的），用肯定判据的话一个没见过的
 * 状态码会被当成"已经结清"，于是一张真的还挂着的单在本地被判成终态 —— 那正是这次要修的
 * 那类错误的方向。反过来，多结清一行是无害的：结清之前一定先问过交易所
 * （见 `AutoTrader.settleStaleOrders()`）。
 *
 * `TRIGGERED` 刻意**不在**终态里：条件单触发之后，它产生的那张市价单还要成交
 * （理由同 `binance/broker.ts` 的 `TERMINAL_ALGO_STATUSES`）。
 *
 * 控制台的 `TraderTables.tsx` 有一份等价实现（前端不能 import 服务端），两处要一起改。
 */
export const TERMINAL_ORDER_STATUSES: readonly string[] = [
  'FILLED',
  'FINISHED',
  'CANCELED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
  'EXPIRED_IN_FUTURES',
];

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

  /**
   * 某机器人的订单记录，**最新在前**，一次一页。`before` 是游标：只返回 `id < before` 的行。
   *
   * ## 为什么用 `before=id` 而不是 `offset`
   *
   * 这个列表**在顶部持续插入**：机器人每下一单就多一行。用 `OFFSET 25` 取"第二页"时，
   * 只要第一页之后又落了一张新订单，整个窗口就往下挪一格 —— 第二页的第一条会和第一页的
   * 最后一条**重复**（同一张订单在表格里出现两次，看起来像下了两单）。游标锚在一条具体
   * 订单的 `id` 上：新订单的 `id` 一定更大、永远落在游标之上，页与页之间既不重也不漏。
   * `trades.list()` / `decisions.list()` 是同一套契约。
   *
   * ## 排序键必须就是游标键
   *
   * 翻页边界要成立，`ORDER BY` 与游标只能是同一列，所以这里按自增主键 `id`（写入顺序）
   * 倒序。它同时仍然是"最新的一单在最上面"：订单是**下出去那一刻**写进来的，
   * `id` 倒序与原来的 `created_at DESC` 是同一个顺序。
   * 索引 `idx_orders_trader` 建在 `created_at` 上，所以这条查询会在按 `trader_id`
   * 过滤之后再排序，代价可以忽略 —— 换来的是页边界不可能漏行或重复。
   *
   * 页大小由 `clampOrderLimit` 钳制：`?limit=999999` 最多只会拿到 `ORDER_PAGE_MAX` 条。
   */
  list(traderId: number, limit = ORDER_PAGE_DEFAULT, before?: number | null): OrderRecord[] {
    const pageSize = clampOrderLimit(limit);
    const cursor = cursorOf(before);

    // 第一页与后续页只有 WHERE 一段不同：分成两条 SQL 是为了两条都能吃到索引，
    // 也不用把 `(? IS NULL OR id < ?)` 这种对优化器不友好的写法塞进热路径。
    if (cursor === null) {
      return getDb()
        .all<OrderRow>(
          'SELECT * FROM orders WHERE trader_id = ? ORDER BY id DESC LIMIT ?',
          traderId,
          pageSize,
        )
        .map(toOrder);
    }

    return getDb()
      .all<OrderRow>(
        'SELECT * FROM orders WHERE trader_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        traderId,
        cursor,
        pageSize,
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

  /**
   * 仍处于**非终态**、且早于 `createdBefore` 的委托行，最新在前。
   *
   * 这是"交易所已经不挂了、本地还停在 `NEW`"那些行的候选集。它只做筛选：
   * 这里**判断不了**哪一行真的已经不在交易所 —— 那只能问交易所，所以调用方
   * （`AutoTrader.settleStaleOrders()`）在改任何一行之前都会先去读挂单列表。
   *
   * `createdBefore` 是给刚下的单留的宽限窗口（窗口多长、为什么需要，见
   * `ORDER_SETTLE_GRACE_MS`）：挂单列表是一次**读**，而一张单从"我们记下它"到
   * "交易所的挂单列表里能看到它"之间可能有极短的时延，没有这个下界就会把刚挂上去的
   * 保护单结清掉 —— 那正好是 §2.6 最怕的事。
   */
  unsettled(traderId: number, createdBefore: string): OrderRecord[] {
    const placeholders = TERMINAL_ORDER_STATUSES.map(() => '?').join(', ');
    return getDb()
      .all<OrderRow>(
        `SELECT * FROM orders WHERE trader_id = ? AND created_at <= ? AND status NOT IN (${placeholders}) ORDER BY id DESC`,
        traderId,
        createdBefore,
        ...TERMINAL_ORDER_STATUSES,
      )
      .map(toOrder);
  },

  /**
   * 就地修正一行订单。
   *
   * `undefined` **保持原值**（而不是写成 null）：调用方只想改状态时不必先把整行读出来，
   * 也不会顺手把它没打算碰的成交数量清掉。
   */
  update(
    id: number,
    input: Partial<{
      status: string;
      avgPrice: number | null;
      filledQty: number;
      fee: number;
      error: string | null;
      /**
       * 交易所对这张单的**最终**答复。结清一张条件单时写在这里，
       * 于是 `raw_response` 从头到尾都是交易所说过的话（§2.2），而不是只剩一个状态码。
       */
      rawResponse: unknown;
    }>,
  ): void {
    const row = getDb().get<OrderRow>('SELECT * FROM orders WHERE id = ?', id);
    if (!row) return;
    getDb().run(
      'UPDATE orders SET status = ?, avg_price = ?, filled_qty = ?, fee = ?, error = ?, raw_response = ?, updated_at = ? WHERE id = ?',
      input.status ?? row.status,
      input.avgPrice === undefined ? row.avg_price : input.avgPrice,
      input.filledQty ?? row.filled_qty,
      input.fee ?? row.fee,
      input.error === undefined ? row.error : input.error,
      input.rawResponse === undefined ? row.raw_response : JSON.stringify(input.rawResponse),
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
 * 疑似重复行的**报告**窗口（毫秒）。
 *
 * 检测比写入守卫更宽：守卫要求 `closed_at` 毫秒精确相同（见 `findDuplicate()`），
 * 是因为它要**改账**；而这里只是把可疑的成对行报给人看，宁可多报也不能漏报 ——
 * 漏掉一对，操作者就永远不知道账上多了一份盈亏。所以窗口放到 1 秒。
 */
const DUPLICATE_REPORT_WINDOW_MS = 1000;

/**
 * 判定"这是同一个回合"时，数量与入场价允许的偏差（相对值）。
 *
 * ## 为什么数量不能当判据
 *
 * 同一回合的两条记账路径本来就按**不同口径**取数量：运行期记的是本地持仓行的
 * 数量（下单时按名义价值取整得到的），对账记的是交易所实际成交量（多笔成交加权后
 * 保留 12 位）。实盘上那三组重复行能被生成，正是因为这两个口径**不相等**时没有任何
 * 东西拦它；这次复现量到的偏差是 0.008823 对 0.008923（约 1.1%）。
 *
 * 所以容差不能按"浮点噪声"来定 —— 差 1.1% 完全正常，而 1e-6 这种要求浮点相等的
 * 判据正是这个 bug 钻过去的缝。20% 的用意是：数量只用来**排除明显不相干的同一标的
 * 其它回合**，真正的身份是 `closed_at`（同一个真实成交，两条路径拿到的时间戳一致，
 * 实测差 368ms）。单向持仓模式下同一标的同一毫秒不可能平掉两个仓位，所以
 * `closed_at` 命中就是同一个真实事件。
 */
const DUPLICATE_QUANTITY_TOLERANCE = 0.2;

/**
 * 入场价的相对容差。
 *
 * 两条路径的入场价都来自交易所，但一条是持仓行里的成交均价、另一条是多笔成交
 * 加权后保留 12 位的 VWAP，多笔分批成交时最后几位可以不同 —— 所以这里也是
 * 相对比较，而不是"浮点相等"。
 */
const DUPLICATE_PRICE_TOLERANCE = 1e-6;

/**
 * `closed_at` 允许的偏差（毫秒）—— **这是写入守卫的关键容差**。
 *
 * ## 为什么不能要求毫秒精确相等
 *
 * 这一处原来写的是
 * `strftime('%Y-%m-%dT%H:%M:%f', closed_at) = strftime('%Y-%m-%dT%H:%M:%f', ?)`，
 * 即**毫秒精确相等**。而同一回合的两条记账路径拿到的平仓时刻本来就不同：
 * 运行期用的是它在本地**察觉到仓位消失**的时刻，对账用的是交易所**成交记录**里的时刻。
 *
 * 上一条注释一边说这两者"一致、实测差 368ms"，一边把守卫写成精确相等 ——
 * **自相矛盾，于是守卫在它本该生效的那个场景里永远不会触发**。实盘后果实测到了：
 *
 *     #29 BULLAUSDT  closed_at 17:39:06.483  source=bot         费 0
 *     #30 BULLAUSDT  closed_at 17:39:06.033  source=reconciled  费 0.0249
 *
 * 同一个回合被记了两次，账面多算一笔 -0.156 的亏损。
 *
 * ## 为什么 2 秒是安全的
 *
 * 单向持仓模式下**同一标的同一时刻只能有一个仓位**；同一标的的两笔真实回合之间
 * 至少隔着再入场冷却（配置里是分钟级）。所以 2 秒远不足以把两笔真实回合并成一笔，
 * 而 450ms 这种路径差异又能被覆盖。
 */
const DUPLICATE_CLOSE_TOLERANCE_MS = 2000;

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
 * 一个**固定时间窗口**内的绩效聚合（`trades.performanceSince()`）。
 *
 * 与 `TradeStats` 的区别是"有没有界"：`TradeStats` 是终身口径（给控制台看的），
 * 这个结构是窗口口径（给模型看的）。它存在的全部理由是 §4 的 O(1) 性质 ——
 * 字段是固定的，所以提示词大小与 `trades` 的行数无关。
 */
export interface TradePerformance {
  totalTrades: number;
  wins: number;
  losses: number;
  grossProfit: number;
  /** 亏损单净额的绝对值之和（正数）。 */
  grossLoss: number;
  avgWin: number;
  /** 平均亏损额，**正数**；渲染成负数由调用方决定。 */
  avgLoss: number;
  grossPnl: number;
  totalFees: number;
  totalFunding: number;
  netPnl: number;
  /** Σ|入场价 × 数量|：窗口内回合的名义价值合计。 */
  notional: number;
  /** 往返手续费率（**小数比例**：0.001 = 0.10%）；窗口内没有成交时为 null。 */
  roundTripFeeRate: number | null;
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

/** One detected pair of rows that describe the same real round-trip. */
export interface TradeDuplicateSuspect {
  traderId: number;
  /** `reconciled` 那行与运行期那行的 id；顺序按 id 升序，与来源无关。 */
  idA: number;
  idB: number;
  symbol: string;
  quantity: number;
  closedAt: string;
  reasonA: string;
  reasonB: string;
  netA: number;
  netB: number;
}

/**
 * 一次最多回多少条成交记录。
 *
 * 与 `ORDER_PAGE_MAX` 同一个理由：成交行是最宽的一张（毛盈亏、开/平两侧手续费、
 * 资金费、净盈亏、来源、两个订单号、平仓原因…），而这张表随着每次平仓无限增长。
 * 200 是操作者上一版控制台每次轮询要的条数，上限只为手写请求兜底。
 */
export const TRADE_PAGE_MAX = 200;

/** 不传 `limit` 时返回多少条 —— 与历史契约一致（路由以前写死 100）。 */
export const TRADE_PAGE_DEFAULT = 100;

/** `trades.list()` 的页大小：见 `clampPageLimit`。 */
export function clampTradeLimit(limit: number): number {
  return clampPageLimit(limit, TRADE_PAGE_MAX, TRADE_PAGE_DEFAULT);
}

export const trades = {
  /**
   * 某机器人的成交记录，**最新在前**，一次一页。`before` 是游标：只返回 `id < before` 的行。
   *
   * ## 为什么用 `before=id` 而不是 `offset`
   *
   * 这个列表**在顶部持续插入**：每平一次仓就多一行。用 `OFFSET 25` 取"第二页"时，
   * 只要中间又平了一仓，窗口就整体下移一格 —— 第二页会重复第一页的最后一条
   * （同一笔成交在表格里出现两次，看起来像多平了一次仓，而这张表的数字是钱）。
   * 游标锚在具体一行的 `id` 上，新行的 `id` 一定更大、永远落在游标之上。
   *
   * ## 排序键必须就是游标键 —— 这里从 `closed_at DESC` 换成了 `id DESC`
   *
   * 页边界要成立，`ORDER BY` 与游标只能是同一列。`closed_at` 做不到：
   * 对账补录（`reconcileTradeHistory`）会把**进程未运行时**才平掉的回合现在写进来，
   * 这些行的 `closed_at` 比已经在库里的行更旧，于是"按 `closed_at` 排"与"按写入顺序排"
   * 是两种不同的顺序，用 `id` 当游标必然漏行或重复。
   *
   * `id` 倒序的实际含义是"最近记进来的在最上面"，运行期记账时它与 `closed_at` 完全同序
   * （平仓那一刻就写），只有对账补录的行会排到顶部 —— 那正好是该被看见的行
   * （表格里带 `对账补录` 徽章），也让"重复执行对账只修正、不重复插入"这件事一眼可查。
   * 代价是补录行不再按它的成交时间插回历史中间；页边界不重不漏优先于这一点。
   */
  list(traderId: number, limit = TRADE_PAGE_DEFAULT, before?: number | null): TradeRecord[] {
    const pageSize = clampTradeLimit(limit);
    const cursor = cursorOf(before);

    // 两条 SQL 各自都能吃到索引，也不用把 `(? IS NULL OR id < ?)` 塞进热路径。
    if (cursor === null) {
      return getDb()
        .all<TradeRow>(
          'SELECT * FROM trades WHERE trader_id = ? ORDER BY id DESC LIMIT ?',
          traderId,
          pageSize,
        )
        .map(toTrade);
    }

    return getDb()
      .all<TradeRow>(
        'SELECT * FROM trades WHERE trader_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        traderId,
        cursor,
        pageSize,
      )
      .map(toTrade);
  },

  recent(traderId: number, limit = 10): TradeRecord[] {
    return this.list(traderId, limit);
  },

  /**
   * 一个时间窗口内的成交绩效，**全部在 SQL 里聚合**。
   *
   * ## 为什么必须有这个函数（提案 §4 的 O(1) 性质）
   *
   * 提示词要告诉模型"你最近在亏钱"，而 `trades` 是**随时间无限增长**的表。
   * 这个函数对外只回**固定几个字段**：无论窗口里有 3 笔还是 30000 笔，进提示词的
   * 字节数完全一样。没有这条保证，"7×24 跑一年"就只是一个说法 —— 跑一年之后
   * 提示词会随历史长度线性膨胀，直到撑爆上下文。
   *
   * 分类口径与 `aggregateTrades()` 严格一致：按**净**盈亏判胜负。一笔毛赚了
   * 一点点、但不够付手续费的钱实际是亏的，算成盈利会同时抬高胜率与盈亏比 ——
   * 那是这个产品最容易骗自己的地方。
   *
   * @param sinceIso 窗口起点（含）。调用方给固定长度的窗口（例如最近 24 小时），
   *   所以窗口内的行数由**交易频率**决定，而不是由历史长度决定。
   */
  performanceSince(traderId: number, sinceIso: string): TradePerformance {
    const row = getDb().get<{
      totalTrades: number;
      wins: number;
      losses: number;
      grossProfit: number | null;
      grossLoss: number | null;
      grossPnl: number | null;
      totalFees: number | null;
      totalFunding: number | null;
      netPnl: number | null;
      notional: number | null;
    }>(
      `SELECT
         COUNT(*)                                                   AS totalTrades,
         COALESCE(SUM(CASE WHEN net_pnl >  0 THEN 1 ELSE 0 END), 0) AS wins,
         COALESCE(SUM(CASE WHEN net_pnl <= 0 THEN 1 ELSE 0 END), 0) AS losses,
         COALESCE(SUM(CASE WHEN net_pnl >  0 THEN net_pnl ELSE 0 END), 0) AS grossProfit,
         ABS(COALESCE(SUM(CASE WHEN net_pnl <= 0 THEN net_pnl ELSE 0 END), 0)) AS grossLoss,
         COALESCE(SUM(pnl), 0)          AS grossPnl,
         COALESCE(SUM(fee), 0)          AS totalFees,
         COALESCE(SUM(funding_fee), 0)  AS totalFunding,
         COALESCE(SUM(net_pnl), 0)      AS netPnl,
         COALESCE(SUM(ABS(entry_price * quantity)), 0) AS notional
       FROM trades WHERE trader_id = ? AND closed_at >= ?`,
      traderId,
      sinceIso,
    );

    const wins = row?.wins ?? 0;
    const losses = row?.losses ?? 0;
    const grossProfit = row?.grossProfit ?? 0;
    const grossLoss = row?.grossLoss ?? 0;
    const totalFees = row?.totalFees ?? 0;
    const notional = row?.notional ?? 0;

    return {
      totalTrades: row?.totalTrades ?? 0,
      wins,
      losses,
      grossProfit,
      grossLoss,
      avgWin: wins > 0 ? grossProfit / wins : 0,
      avgLoss: losses > 0 ? grossLoss / losses : 0,
      grossPnl: row?.grossPnl ?? 0,
      totalFees,
      totalFunding: row?.totalFunding ?? 0,
      netPnl: row?.netPnl ?? 0,
      notional,
      /*
       * 往返手续费率 = Σ手续费 / Σ名义价值。
       *
       * 为什么是"两个总和相除"而不是"逐笔成本率的平均"：一次往返在开、平两条腿上
       * 各付一次佣金，而两条腿的名义价值都约等于入场名义价值，所以这个比值就是
       * "每往返一次，成本占名义价值的百分之几"——实测 0.1000%。逐笔平均会让
       * 小额回合与小额手续费得到同等权重，一个 12 USDT 的回合和一个 1200 USDT 的
       * 回合会各算一票，得到的费率与本账户的真实成本无关。
       *
       * 读不到成交（窗口内没有行）时回 null —— 让调用方自己决定用什么兜底，
       * 而不是在这里编一个数出来（§5「不要假装算过」）。
       */
      roundTripFeeRate: notional > 0 ? totalFees / notional : null,
    };
  },

  /**
   * 最近若干笔平仓，附带**模型当时的入场理由**（提案 §2.2 的第二行）。
   *
   * 理由取自 `positions.open_reasoning` —— 模型下单时写进持仓行的原话。连接键是
   * `(trader_id, symbol, opened_at)`：运行期记账时 `trades.opened_at` 就是
   * `positions.opened_at` 那一行（`bookClosedPosition()` 直接把它抄过来），
   * 所以这是一次**身份匹配**，不是"看起来差不多"的猜测。
   *
   * 对账补录的行 `opened_at` 来自交易所成交时间，本来就匹配不到持仓行 ——
   * 那就回 null，让提示词如实写"未记录"，而不是猜一个理由出来。
   *
   * ⚠️ 这是提示词里唯一会出现的**逐笔**内容，所以调用方必须传固定的小数字
   * （`PROMPT_RECENT_CLOSE_COUNT`），否则 §4 的 O(1) 性质就没了。
   */
  recentWithReason(
    traderId: number,
    limit: number,
  ): Array<TradeRecord & { entryReason: string | null }> {
    return getDb()
      .all<TradeRow & { entry_reason: string | null }>(
        `SELECT t.*, (
           SELECT p.open_reasoning FROM positions p
            WHERE p.trader_id = t.trader_id
              AND p.symbol = t.symbol
              AND p.opened_at = t.opened_at
            LIMIT 1
         ) AS entry_reason
         FROM trades t WHERE t.trader_id = ? ORDER BY t.id DESC LIMIT ?`,
        traderId,
        Math.max(1, Math.trunc(limit)),
      )
      .map((row) => ({ ...toTrade(row), entryReason: row.entry_reason }));
  },

  /**
   * Record a closed round-trip.
   *
   * `grossPnl` is the exchange's own realised figure and the costs are passed
   * separately, so `net_pnl` — the number the console shows — is derived in one
   * place instead of each caller doing its own arithmetic and disagreeing.
   * `pnlPercent` is deliberately computed here rather than accepted, for the
   * same reason.
   *
   * ## 为什么幂等检查放在这一层（§2.5、§5.4「金额相关的算术只在一个地方算」）
   *
   * 平仓有两条记账路径：运行期（`executeClose` / `bookClosedPosition`，从本地持仓行）
   * 与对账（`reconcileTradeHistory`，从交易所成交历史重建）。它们对同一回合算出的
   * **数量口径可以不同**（本地持仓量 vs 交易所实际成交量），于是对账的严格键与描述
   * 回退键会同时落空，把同一回合插成两行 —— 详见 `findDuplicate()` 的说明。
   *
   * 身份判断只有一处实现（`findDuplicate()`），所以不可能出现"一条路径记得、
   * 另一条忘了"的分裂；调用方只要声明 `idempotent: true` 就拿到这个保证。
   *
   * 返回值带 `created`，让调用方能区分"我补录了一笔"和"这一笔本来就记过了"：
   * 对账靠它把 `recovered` 数准 —— 把重复回合也算成"补录"会让操作员以为账本有漏记，
   * 而实际上什么都没发生。
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
    /**
     * 这次写入代表**一笔真实平仓**，因此必须先查重（§2.5 的幂等）。
     *
     * 只有 `bookClosedPosition()` 与 `reconcileTradeHistory()` 会打开它。默认关闭，
     * 是因为判据以"平仓时刻"为身份，而测试 fixture 会连记多笔只差盈亏的假成交；
     * 见 `insert()` 内部的说明。
     */
    idempotent?: boolean;
  }): { id: number; created: boolean } {
    const closedAt = input.closedAt ?? now();

    /*
     * 幂等只在**真的在记一笔平仓**时生效：`bookClosedPosition()`（运行期）与
     * `reconcileTradeHistory()`（对账）都会显式打开 `idempotent`。
     *
     * 为什么做成显式开关而不是对每一次 `insert()` 都生效：判据依赖**平仓时刻**这个
     * 真实事件的身份，而测试与脚本会连记多笔"看起来一样"的 fixture（同一标的、
     * 同一数量与价位，只差盈亏）。那种行本来就不代表一个交易时刻，拿时间去做唯一性
     * 判定会把它们错误地合成一笔 —— 从而让 `totalTrades`、胜率、盈亏合计全部失真。
     * 两条真实记账路径打开它，才是这个不变量真正需要覆盖的范围。
     */
    const alreadyBooked = input.idempotent
      ? this.findDuplicate({
          traderId: input.traderId,
          symbol: input.symbol,
          quantity: input.quantity,
          entryPrice: input.entryPrice,
          closedAt,
          entryOrderId: input.entryOrderId,
        })
      : null;
    if (alreadyBooked !== null) return { id: alreadyBooked, created: false };

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
    return { id: lastInsertRowid, created: true };
  },

  /**
   * 找出这条"回合"是不是已经记过账了，返回已有行的 id。
   *
   * ## 为什么需要它（这是 §2.5「对账幂等」缺的那一环）
   *
   * 同一个真实回合有两条记账路径：运行期从**本地持仓行**记（`bookClosedPosition`），
   * 对账从**交易所成交历史**重建后再记（`reconcileTradeHistory`）。两条路各自算出的
   * 描述可以不一致 —— 最典型的是数量：本地记的是下单时的请求量 / 持仓行的数量，
   * 交易所重建的是实际成交量（摊到多笔成交上做加权）。一旦不一致，
   * `reconcileTradeHistory` 的严格键（symbol+qty+入场价+入口订单号）和描述回退键
   * **同时**落空，于是它把同一回合又插了一行。实盘上量到的症状：
   *
   *   #17 reconciled / #18 take_profit   SYNUSDT  99  -0.047554650
   *   #11 reconciled / #12 stop_loss     SYNUSDT 169  -0.75613135
   *   #9  reconciled / #10 take_profit   LSKUSDT  35  +0.66674843
   *
   * 12 行里 4 行是 reconciled，其中只有 #4 POWERUSDT 是真的漏记。重复的那 6 行
   * 凭空造出 **+0.4954** 的净盈亏（毛 − 手续费 − 资金费全部被算了两遍），
   * 而对账本来只该"修正、不重复插入"。
   *
   * ## 为什么用这个身份，而不是浮点相等
   *
   * 唯一能同时被两条路拿到的身份是**交易所那一笔的成交时间**（`closed_at`）：
   * 运行期有成交记录时用 `findRoundTrip()` 给出的交易所时间，对账用重建出的
   * `trip.closedAt`，两者来自同一笔平仓成交，实测精确到毫秒相同（上面三组重复行
   * 的 `closed_at` 逐字节一致）。所以判定条件是：
   *
   *   · `closed_at` 的**毫秒精度字符串相同**（`strftime('%Y-%m-%dT%H:%M:%f')`，
   *     纯字符串比较，不是浮点比较），或
   *   · `entry_order_id` 相同（两条路都拿到了交易所的入口订单号，这是铁证）
   *
   * 再加上 symbol + quantity（相对 20%）+ entry_price + exit_price 收窄。容差取相对值
   * 是因为同一回合的两条路径本来就按不同口径取值（本地持仓量 vs 交易所成交量），
   * 要求浮点相等正是这个 bug 钻过去的缝。
   *
   * **出场价为什么必须参与**：`closed_at` 精确相同时，唯一还能区分"同一回合被记两次"
   * 和"同一毫秒内平掉的两笔真实成交"的就是成交价。`retention.test.ts` / `stats.test.ts`
   * 的 fixture 正是后者——同一个标的、同一个入场价、连记四笔不同盈亏的回合；
   * 少了出场价这一项，它们会被判成一笔，`totalTrades` 从 4 变 1、盈亏合计跟着错。
   * 而同一回合被记两次时，交易所的成交价是同一个数（实盘那三组的入场价、出场价都
   * 逐字节相同），所以这一项不会漏判。
   *
   * 找到就返回已有行，调用方**不插新行**：重复执行只修正、不重复插入。
   */
  findDuplicate(input: {
    traderId: number;
    symbol: string;
    quantity: number;
    entryPrice: number;
    closedAt?: string;
    entryOrderId?: string | null;
  }): number | null {
    /*
     * 只有带交易所身份的（ISO 毫秒时间戳）才参与判定。`closed_at` 缺省时
     * `insert()` 会填当前时间，那种行没有可与交易所对齐的身份，宁可不判定，
     * 也不能拿"看起来差不多"当依据去吞掉一笔真实成交。
     */
    if (!input.closedAt || !/^\d{4}-\d{2}-\d{2}T/.test(input.closedAt)) return null;

    const byOrder =
      input.entryOrderId && input.entryOrderId.length > 0
        ? 'OR entry_order_id = ?'
        : '';
    const sql = `SELECT id FROM trades
       WHERE trader_id = ? AND symbol = ? AND quantity > 0
         AND ABS(quantity - ?) <= MAX(1e-6, ABS(?) * ${DUPLICATE_QUANTITY_TOLERANCE})
         AND ABS(entry_price - ?) <= MAX(1e-9, ABS(?) * ${DUPLICATE_PRICE_TOLERANCE})
         AND (ABS(julianday(closed_at) - julianday(?)) * 86400000 <= ${DUPLICATE_CLOSE_TOLERANCE_MS}
              ${byOrder})
       ORDER BY id ASC
       LIMIT 1`;
    const params: unknown[] = [
      input.traderId,
      input.symbol,
      input.quantity,
      input.quantity,
      input.entryPrice,
      input.entryPrice,
      input.closedAt,
    ];
    if (byOrder) params.push(String(input.entryOrderId));

    const row = getDb().get<{ id: number }>(sql, ...params);
    return row?.id ?? null;
  },

  /**
   * 修正一条已入账的回合，用交易所的权威口径。
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
    /*
     * `quantity` 与 `pnl_percent` 都由交易所在**同一笔成交记录**里给出，所以要一起写。
     *
     * 这里曾经漏掉 `quantity`：参数收了、SQL 里却没有这一列，于是对账算出来的
     * 权威成交量被**静默丢弃** —— 账本留下的仍是运行期那个较粗的口径（本地持仓量），
     * 与交易所的成交记录对不上，而 §2.5 要求的正是"平台记录能与交易所对得上"。
     * 本次修幂等时正是靠这一列才把同一回合的两条路径收敛到同一个数字上。
     */
    getDb().run(
      `UPDATE trades
          SET pnl = ?, entry_fee = ?, fee = ?, funding_fee = ?, net_pnl = ?,
              pnl_percent = ?, entry_price = ?, exit_price = ?, quantity = ?,
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
      input.quantity,
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
    /*
     * ⚠️ **日界是北京时间，不是 UTC。**
     *
     * 原来这里是 setUTCHours(0, 0, 0, 0) —— UTC 零点，
     * 也就是**北京时间早上 8 点**。于是北京时间 9-19 07:30 的一笔平仓
     * 会被算进「UTC 9-18」，操作员上午看到的「今日」实际覆盖
     * 9-18 08:00 → 9-19 08:00，与他的认知差 8 小时。
     *
     * 而这个数字正是熔断（maxDailyLossPercent）用来决定要不要停手的依据。
     *
     * 用 beijingDayStartIso() 而不是 setHours(0,0,0,0)：
     * 后者用的是**服务器**的时区，换一台 UTC 的机器就会静默变回 UTC 零点。
     */
    const row = getDb().get<{ total: number | null }>(
      'SELECT SUM(net_pnl) AS total FROM trades WHERE trader_id = ? AND closed_at >= ?',
      traderId,
      beijingDayStartIso(),
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

  /**
   * 疑似"同一回合记了两次"的成对行 —— **只报告，不删**。
   *
   * 为什么只报告：`data/` 里的账是历史，删一行等于改写历史，是人的决定。
   * 这次修复只保证**今后**不再产生重复（见 `findDuplicate()`），已经落库的三组
   * 重复行（SYNUSDT 99 / SYNUSDT 169 / LSKUSDT 35）要由操作者看过之后再决定。
   *
   * 判定条件与 `findDuplicate()` 同一个口径：`trader_id + symbol + quantity` 相同、
   * `closed_at` 相差 1 秒以内，且其中恰好一行是 `reconciled`。**`side` 不参与** ——
   * 重复行的 `side` 本来就一致，少一个条件只会让漏报更少。
   *
   * 注意 `close_reason`：运行期那行记的是"怎么平的"（`take_profit` / `stop_loss`），
   * 对账那行一律是 `reconciled`。所以**保留哪一行应当按信息量决定**，而不是简单地
   * "删掉 reconciled"：`#4 POWERUSDT 131` 是唯一一笔真正漏记的回合（没有运行期
   * 对应行），删掉它就把对账存在的意义一起删了。
   *
   * `traderId` 省略时扫描**所有**机器人：复核存量数据时不该要求操作者先知道
   * 是哪台机器人记的重复。
   */
  duplicateSuspects(traderId?: number): TradeDuplicateSuspect[] {
    const filter = traderId === undefined ? '' : 'WHERE a.trader_id = ?';
    return getDb().all<TradeDuplicateSuspect>(
      `SELECT
         a.trader_id    AS traderId,
         a.id           AS idA,
         b.id           AS idB,
         a.symbol       AS symbol,
         a.quantity     AS quantity,
         a.closed_at    AS closedAt,
         a.close_reason AS reasonA,
         b.close_reason AS reasonB,
         a.net_pnl      AS netA,
         b.net_pnl      AS netB
       FROM trades a
       JOIN trades b
         ON a.trader_id = b.trader_id
        AND a.symbol = b.symbol
        AND a.id < b.id
        AND ABS(a.quantity - b.quantity) <= MAX(1e-6, ABS(a.quantity) * ${DUPLICATE_QUANTITY_TOLERANCE})
        AND ABS(a.entry_price - b.entry_price) <= MAX(1e-9, ABS(a.entry_price) * ${DUPLICATE_PRICE_TOLERANCE})
        AND ABS((julianday(a.closed_at) - julianday(b.closed_at)) * 86400000.0) <= ${DUPLICATE_REPORT_WINDOW_MS}
        AND (a.source = 'reconciled' OR b.source = 'reconciled')
        AND NOT (a.source = 'reconciled' AND b.source = 'reconciled')
       ${filter}
       ORDER BY ABS(a.net_pnl) DESC, a.closed_at DESC`,
      ...(traderId === undefined ? [] : [traderId]),
    );
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
  /* 迁移 M9 加的；迁移之前的行是 NULL（= 当时没记，不是没命中）。 */
  cached_tokens: number | null;
  reasoning_tokens: number | null;
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
    /*
     * 缓存命中与思考 token。
     *
     * **`?? null` 而不是 `?? 0`**：迁移之前的历史行这两列是 NULL，
     * 而 NULL 的含义是"当时没记"、不是"没命中"。把它们读成 0
     * 会让所有历史记录看起来像缓存全没命中。
     */
    cachedTokens: row.cached_tokens ?? null,
    reasoningTokens: row.reasoning_tokens ?? null,
  };
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * 一次最多回多少条决策记录。
 *
 * 卡住的是**字节数**，不是行数：每条记录都带着完整提示词、思维链与原始响应
 * （单条几十 KB 很常见）。路由以前把 `?limit=999999` 原样交给 SQL，一次请求就能
 * 让服务端拼出几十 MB 的 JSON 占住 event loop，浏览器那侧也会直接卡死 ——
 * 这正是操作者说的"成千上万数据一次加载出来导致系统卡死"。
 * 200 条足够"全部记录"这类页面一次翻完一屏，也不至于把一次请求变成几 MB。
 */
export const DECISION_PAGE_MAX = 200;

/** 不传 `limit` 时返回多少条 —— 与历史行为和 `docs/API.md` 一致。 */
export const DECISION_PAGE_DEFAULT = 50;

/**
 * 把调用方给的 `limit` 收进 `[1, DECISION_PAGE_MAX]`。
 *
 * **钳制而不是报错**：翻页的控制台不该因为页大小写得大一点就收到 400，
 * 而一个手写的 `?limit=999999` 也绝不能真的返回 999999 条。
 * 非有限值（没传 / `NaN` / `Infinity`）回落到默认值，等同于路由原来那半句
 * `Number.isFinite(limit) ? limit : 50`。
 *
 * 实现与订单 / 成交两张表共用同一个 `clampPageLimit`（见该函数的说明）：
 * 三张历史表只有上限与默认值不同，钳制规则必须一模一样。
 */
export function clampDecisionLimit(limit: number): number {
  return clampPageLimit(limit, DECISION_PAGE_MAX, DECISION_PAGE_DEFAULT);
}

export const decisions = {
  /**
   * 某机器人的决策记录，**最新在前**。`before` 是游标：只返回 `id < before` 的记录。
   *
   * ## 为什么用 `before=id` 而不是 `offset`
   *
   * 这个列表是**在顶部持续插入**的：每跑完一轮就多一条新记录。用 `OFFSET 20` 取
   * "第二页"时，第一条新记录一插进来，整个窗口就往下挪一格 —— 第二页的第一条会
   * 和第一页的最后一条**重复**；反过来，如果两次请求之间旧记录被裁掉（见 `log()`），
   * 窗口往上挪一格，中间就会**漏掉**一行。游标锚在一条具体记录的 `id` 上，
   * 新记录拿到的 `id` 一定更大，永远落在游标之上，页与页之间既不重也不漏。
   *
   * ## 为什么排序键也换成 `id`
   *
   * 翻页边界要成立，排序键和游标键必须是同一列：这里用自增主键 `id`。
   * 它等于写入顺序，而 `log()` 每跑完一轮只写一行、周期号单调递增，
   * 所以 `id` 倒序与原来的 `cycle_number DESC` 是同一个顺序（最新的一轮在前）。
   * 索引 `idx_decisions_trader` 建在 `cycle_number` 上，因此这条查询会在按
   * `trader_id` 过滤之后再排序 —— 每个机器人最多留 500 行（见 `log()` 的保留上限），
   * 这点排序代价可以忽略，换来的是页边界不可能漏行或重复。
   */
  list(traderId: number, limit = DECISION_PAGE_DEFAULT, before?: number | null): DecisionRecord[] {
    const pageSize = clampDecisionLimit(limit);
    const cursor = cursorOf(before);

    // 第一页与后续页只有 WHERE 一段不同：分成两条 SQL 是为了两条都能吃到索引，
    // 也不用把 `(? IS NULL OR id < ?)` 这种对优化器不友好的写法塞进热路径。
    if (cursor === null) {
      return getDb()
        .all<DecisionRow>(
          'SELECT * FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT ?',
          traderId,
          pageSize,
        )
        .map(toDecisionRecord);
    }

    return getDb()
      .all<DecisionRow>(
        'SELECT * FROM decision_records WHERE trader_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        traderId,
        cursor,
        pageSize,
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
    /** 命中缓存的输入 token，`null` 表示服务商没报。 */
    cachedTokens?: number | null;
    /** 花在思考上的输出 token（已计入 completion）。 */
    reasoningTokens?: number | null;
  }): number {
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO decision_records (trader_id, cycle_number, timestamp, system_prompt, user_prompt, cot_trace, decisions_json, raw_response, execution_log_json, candidate_symbols_json, success, error, ai_latency_ms, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.cachedTokens ?? null,
      input.reasoningTokens ?? null,
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
  account_equity: number;
  account_unrealized_pnl: number;
}

/**
 * 本机器人**归属权益**。
 *
 * 一个机器人的权益是它自己的交易挣来的那部分，而不是共用的钱包余额：
 *
 *   initialEquity + Σ(本机器人 net_pnl) + 本机器人持仓浮盈
 *
 * `net_pnl` 是净额的唯一来源（§2.5：毛 − 手续费 − 资金费），这里**只做求和**，
 * 不重算任何一笔的净额。
 *
 * 为什么必须这样算：同一个交易所账户下可以跑多个机器人，它们共用凭据与钱包，
 * `account.equity` 对它们全都是同一个数。直接用它，一个从未成交的机器人就会
 * 显示别的机器人挣来的收益率（实盘上量到过 +2.67%），而一个已停止的机器人的
 * 数字会随着邻居继续交易而变化。
 */
export function attributedEquity(
  initialEquity: number,
  netRealizedPnl: number,
  unrealizedPnl: number,
): number {
  return initialEquity + netRealizedPnl + unrealizedPnl;
}

/**
 * 本机器人自己持仓的浮动盈亏。
 *
 * 为什么需要它：`equity_snapshots.unrealized_pnl` 原来抄的是
 * `account.unrealizedPnl` —— 整个交易所账户的浮盈。共用账户时每个机器人记的都是
 * 同一个数，控制台的「浮动盈亏」于是显示成账户的总浮盈（谁都能看到一个和自己
 * 无关的数）。控制台里两个机器人显示同一个浮盈，就是从这里来的。
 *
 * 自己的浮盈只能用自己的持仓算：**自己的**开仓价、数量、方向，乘上**市场**的
 * 标记价。标记价是行情事实（对所有机器人相同），借用它不引入归属错误；开仓价与
 * 数量必须来自本机器人的 `positions` 行，因为交易所那一行可能是多个机器人合起来
 * 的净头寸。
 *
 * 读不到标记价的持仓按 0 计并**把标的返回给调用方**：悄悄按 0 算是把浮盈/浮亏
 * 藏起来，和写账户数字是同一类错误，必须有人能说出来。
 */
export function ownUnrealizedPnlOf(
  openPositions: ReadonlyArray<{ symbol: string; side: string; quantity: number; entry_price: number }>,
  markPriceOf: (symbol: string) => number | undefined,
): { unrealizedPnl: number; missingMarkPrice: string[] } {
  let unrealizedPnl = 0;
  const missingMarkPrice: string[] = [];

  for (const position of openPositions) {
    const markPrice = markPriceOf(position.symbol);
    if (typeof markPrice !== 'number' || !(markPrice > 0)) {
      missingMarkPrice.push(position.symbol);
      continue;
    }
    // 数量在 `positions` 里恒为正，方向由 `side` 承载（与交易所侧一致）。
    const direction = position.side === 'short' ? -1 : 1;
    unrealizedPnl += (markPrice - position.entry_price) * position.quantity * direction;
  }

  return { unrealizedPnl, missingMarkPrice };
}

export const equity = {
  list(traderId: number, limit = 500): EquitySnapshot[] {
    return getDb()
      .all<EquityRow>(
        /*
         * `id DESC` 是 `timestamp DESC` 的**决胜键**，不是装饰。
         *
         * 一个周期写一条快照，而两个周期完全可能落在**同一毫秒**里（实测：整个测试跑完
         * 只要 3.9ms）。只按 `timestamp` 排序时，同一毫秒内的行序是未定义的 —— 实测
         * SQLite 会先回**先插入**的那一行，于是 `latest()` 拿到的是上一轮的快照：
         * 控制台显示的浮盈晚一轮，而依赖它的归属权益会算错。这不是理论问题：它让
         * `stats.test.ts` 里"开仓 + 平仓后权益应为 1001"的断言间歇性地得到 1002
         * （浮盈取到了平仓前那一轮的 +1），大约每 10 次全量测试出现一次。
         *
         * 时间戳相同时，"最新"只能是**最后写入**的那一条，所以用自增主键决胜。
         */
        'SELECT * FROM equity_snapshots WHERE trader_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?',
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
        accountEquity: row.account_equity,
        accountUnrealizedPnl: row.account_unrealized_pnl,
      }));
  },

  insert(snapshot: EquitySnapshot): void {
    getDb().run(
      `INSERT INTO equity_snapshots (trader_id, timestamp, equity, available_balance, unrealized_pnl, margin_used, open_positions, account_equity, account_unrealized_pnl)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      snapshot.traderId,
      snapshot.timestamp,
      snapshot.equity,
      snapshot.availableBalance,
      snapshot.unrealizedPnl,
      snapshot.marginUsed,
      snapshot.openPositions,
      snapshot.accountEquity,
      snapshot.accountUnrealizedPnl,
    );
  },

  /**
   * Highest equity ever recorded — **on closed positions only**.
   *
   * Snapshot 的账户权益（`account_equity`）是保证金余额，含未实现盈亏。拿它当
   * 熔断器的高水位是一次真实的 bug：一次未实现浮盈的尖峰（开仓价格瞬间上插）
   * 把高水位永久抬高，价格回落后标记口径回到基线，于是之后每一轮都算出一个
   * 从未发生过的回撤，`maxTotalDrawdownPercent` 从此**永久且静默地**拒绝开新仓
   * —— 原因只写进日志，没有任何东西会清除它。
   *
   * `account_equity - account_unrealized_pnl` 是"开仓按开仓价计价"时账户的余额，
   * 也就是只有真正平仓时才会动的那个数。入金同样会推动它，这是对的：入金确实
   * 抬高了账户的基数。
   *
   * 这一列必须用 `account_*`：`equity` 自 M4 起是**本机器人归属**口径，拿它当
   * 账户高水位会让风控的输入跟着单个机器人的账本走（§4.2，风控输入不变）。
   */
  realizedHighWaterMark(traderId: number): number {
    const row = getDb().get<{ peak: number | null }>(
      'SELECT MAX(account_equity - account_unrealized_pnl) AS peak FROM equity_snapshots WHERE trader_id = ?',
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

  /**
   * 这个机器人最后一次平仓是什么时候（任意标的）。
   *
   * 提示词的「本周期约束」区块要告诉模型它离再入场冷却还有多远。冷却本身是**按标的**
   * 计的（`isInCooldown(symbol)`），这里只回"最近一次平仓"，因为把每个仍在冷却的标的
   * 都列出来会让区块大小随标的数变化，破坏 §4 的 O(1) 要求。
   *
   * 这只是让模型**看见**约束；真正的判定仍然在 `AutoTrader.isInCooldown()` 与风控里，
   * 按标的执行。看不见的约束等于不存在 —— 但看得见的约束也不代替执行。
   */
  lastExit(traderId: number): string | undefined {
    const row = getDb().get<{ created_at: string }>(
      'SELECT created_at FROM trade_events WHERE trader_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1',
      traderId,
      'exit',
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
  const initial = trader?.initialEquity ?? 0;
  /*
   * 归属权益：**每次按定义重算**，不读快照里存的存量值。
   *
   * 两个理由：
   *  1. 升级前落库的 `equity` 装的是共享钱包余额（M4 之前的 bug），照读会把
   *     那个数字原样带到新版本 —— 一个从未成交的机器人就继续显示别人的收益。
   *  2. 对账补录的成交会立刻反映到控制台，不必等下一个快照；反过来，一个已停止
   *     的机器人没有新快照，这个数就冻在那里不动 —— 这正是它该有的行为。
   *
   * 浮盈取最近一条快照里**本机器人自己的**那个数（标记价只有周期才会重新读到），
   * 不是账户的总浮盈。
   */
  const unrealizedPnl = latest?.unrealizedPnl ?? 0;
  const equityNow = attributedEquity(initial, realizedPnl, unrealizedPnl);

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
    unrealizedPnl,
    /*
     * 共享钱包单独给出：同一账户下的多个机器人读数是同一个数，混进 `equity`
     * 就没法分辨"这个机器人挣了多少"和"账户里有多少钱"。没有快照时为 0，
     * 界面据此显示"—"而不是假装账户是空的。
     */
    accountEquity: latest?.accountEquity ?? 0,
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
