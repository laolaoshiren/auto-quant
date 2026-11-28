import type {
  AiModelConfig,
  ExchangeAccount,
  ExchangeId,
  LlmProviderId,
  StrategyConfig,
  StrategyRecord,
  Trader,
  TraderMode,
  TraderStatus,
  User,
} from '@aq/shared';
import { StrategyConfigSchema, normalizeTraderMode } from '@aq/shared';
import { getDb } from '../db/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('store');
const now = (): string => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/*  Users                                                                      */
/* -------------------------------------------------------------------------- */

/** 在单个 SQLite 事务内原子执行多步写账，供业务层使用而不直接依赖 `db/`（§5.4）。 */
export function runInTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn);
}

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

  /**
   * 有多少个机器人**真的在靠这个凭据交易**（删除前的安全检查）。
   *
   * ## ⚠️ 只数「正在运行」的机器人 —— 已停止的不算（2026-10-23 用户实测）
   *
   * ## 症状
   *
   * 用户在「交易所」页面点删除，界面报：
   * ```
   *   ⚠️ 该凭据正被 3 个机器人使用，请先删除或改派它们。
   * ```
   * 而那 3 个机器人**全部是 stopped 状态**，其中两个是几个月前建的测试机器人。
   * ⇒ **一个没人用的凭据删不掉**，而唯一的"解法"是先去把那 3 个机器人删了 ——
   * 用户想删的是凭据，不是机器人。
   *
   * ## 为什么判据是 `status = 'running'`
   *
   * 一个停止的机器人**不会发起任何下单、查余额、对账** —— 它对这个凭据
   * 没有任何实际占用。真正危险的是"删凭据时还有个机器人正在用它下单"，
   * 那种情况必须挡住（否则正在跑的仓位会失去管理）。
   *
   * `status` 是**本地就能确定**的事实，不引入额外失败点（对比"去查交易所
   * 有没有持仓"—— 那要多一次网络往返，且账户本身可能就在故障中）。
   *
   * ⚠️ 与 `strategies.usageCount` 的修法同一条纪律（见那里 2026-10-19 那段）：
   * **把"没人用的东西删不掉"当成一个 BUG 来修，而不是让用户去清理垃圾数据。**
   */
  usageCount(id: number): number {
    return getDb().count(
      "SELECT COUNT(*) AS n FROM traders WHERE exchange_account_id = ? AND status = 'running'",
      id,
    );
  },

  /**
   * 把某个凭据从所有机器人上解绑（`exchange_account_id` 置 NULL）。
   *
   * ## 为什么删除凭据时必须解绑（2026-10-23）
   *
   * 停止的机器人仍然记着 `exchange_account_id`。直接 `DELETE` 那个凭据会让
   * 它们指向一个**不存在的账户 id** —— 下次有人启动它们时，报错会是
   * "找不到账户"（一个不明所以的失败），而不是"你需要先选一个账户"。
   *
   * ⇒ 删凭据时顺手把引用置空，让那些机器人的状态是**明确的「没有账户」**。
   * 界面上的"未配置"比"指向一个幽灵 id"诚实得多。
   *
   * @returns 被解绑的机器人数量
   */
  detachAll(id: number): number {
    const result = getDb().run(
      'UPDATE traders SET exchange_account_id = NULL, updated_at = ? WHERE exchange_account_id = ?',
      now(),
      id,
    );
    return Number(result.changes ?? 0);
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
  /** 模型能吃多大的输入；`0` = 不知道（服务商没报、用户没填）。 */
  input_token_limit: number;
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
    inputTokenLimit: row.input_token_limit,
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
    /** 可省。省略 = 不知道，提示词预算回落到保守值。 */
    inputTokenLimit?: number;
  }): AiModelConfig {
    const ts = now();
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO ai_models (provider, label, model, base_url, api_key_enc, temperature, max_tokens, timeout_seconds, max_retries, input_token_limit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.provider,
      input.label,
      input.model,
      input.baseUrl,
      input.apiKeyEnc,
      input.temperature,
      input.maxTokens,
      input.timeoutSeconds,
      input.maxRetries,
      input.inputTokenLimit ?? 0,
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
      inputTokenLimit: number;
    }>,
  ): void {
    const current = this.getWithSecret(id);
    if (!current) return;
    getDb().run(
      `UPDATE ai_models
         SET provider = ?, label = ?, model = ?, base_url = ?, api_key_enc = ?,
             temperature = ?, max_tokens = ?, timeout_seconds = ?, max_retries = ?,
             input_token_limit = ?, updated_at = ?
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
      input.inputTokenLimit ?? current.input_token_limit,
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

  /**
   * 有多少个机器人**真的在靠这个策略的参数运行**。
   *
   * ## ⚠️ 只数固定策略模式 —— AI 托管的机器人不算
   *
   * AI 托管的参数整份在它自己的 `agent_config_json` 里，**这个策略对它不生效**。
   * 把它算进来会造成两个具体的后果：
   *
   *   · 删除被 `409` 挡住（"该策略正被 N 个机器人使用"），而那个机器人
   *     根本没用它 —— 于是**一个没人用的策略删不掉**；
   *   · 界面上显示成"有机器人在引用它"，让人以为那台机器人在跑这个策略。
   *
   * 用户的原话：「就算策略工坊里面默认策略 — 稳健就算删除、没有任何策略，
   * 都不影响智能托管模式（做到完全独立）」。
   *
   * 加 `mode <> 'ai_managed'` 而不是只依赖"新数据里 AI 托管的 `strategy_id` 是
   * NULL"：**老数据里存在 `mode = 'ai_managed'` 却还指向某个策略的行**，
   * 只靠 NULL 判断就会漏掉它们。M12 会把那些行置空，但那之后的任何写入方
   * 也不该再制造出这种组合。
   */
  usageCount(id: number): number {
    return getDb().count(
      "SELECT COUNT(*) AS n FROM traders WHERE strategy_id = ? AND mode <> 'ai_managed'",
      id,
    );
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
  /**
   * ⚠️ **`null` 是真实可能的值**，不是防御性写法。
   *
   * 迁移 19（`M19_PAPER_TRADING`）把这一列改成了可空 + `ON DELETE SET NULL`：
   *   · 纯模拟盘机器人在创建时就是 `NULL`（用户 2026-10-27 需求）；
   *   · 删除交易所凭据时，引用它的机器人被置空而不是被连带删除。
   *
   * 这里原来写的是 `number` —— 类型检查照样通过（`number` 可以赋给
   * `Trader.exchangeAccountId: number | null`），但那个类型在**说假话**：
   * 任何以"行字段非空"为前提写下的逻辑都会在模拟盘机器人上静默走错分支，
   * 而 `tsc` 不会报警。与 PR #185 修掉的那个 `'LONG'` 是同一类错误。
   */
  exchange_account_id: number | null;
  ai_model_id: number;
  /** `null` = 这个机器人不依赖任何策略（AI 托管）。见 `Trader.strategyId`。 */
  strategy_id: number | null;
  cycle_interval_minutes: number;
  initial_equity: number;
  status: string;
  last_cycle_at: string | null;
  last_cycle_number: number;
  last_error: string | null;
  consecutive_failures: number;
  agent_config_json: string | null;
  mode: string;
  /**
   * 操作员启动时指定的"是否纸面模式"。
   *
   * `null` = **从未被显式指定过** → 回落到进程级 `env.dryRun`（不落库）。
   * 见 `M18_TRADER_DRY_RUN` 与 `setDryRun` 的说明 ——
   * 这一列是一条**安全修复**，不是便利性字段。
   */
  dry_run: number | null;
  /** 模拟盘起始余额。`0` = 没填（回落到 `initial_equity`）。见 M19。 */
  paper_starting_balance: number;
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
    mode: normalizeTraderMode(row.mode),
    /*
     * ⚠️ `undefined` 与 `false` 必须分得开（见 `Trader.dryRun` 的说明）：
     * 这一列是 NULL 时**不能**转成 `false`，否则"从未指定过"会被当成
     * "操作员指定了实盘"，env 的回落路径就被悄悄删掉了。
     */
    dryRun: row.dry_run === null ? undefined : row.dry_run !== 0,
    paperStartingBalance: row.paper_starting_balance ?? 0,
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
    /**
     * 绑定的交易所账户。
     *
     * **模拟盘机器人可以是 `null`**（用户 2026-10-27 需求）——
     * 它不下真实订单、余额由本地台账折算，所以不需要任何真实账户。
     * 实盘机器人必须给一个真实 id，由启动路径校验。
     */
    exchangeAccountId: number | null;
    aiModelId: number;
    /**
     * 引用的策略。**AI 托管（`mode: 'ai_managed'`）传 `null`** ——
     * 它的参数在 `agent_config_json` 里，策略对它不生效。
     * 固定策略模式下必填，由调用方（API 层）保证。
     */
    strategyId: number | null;
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
    /**
     * 模拟盘起始余额（操作员填的那个数）。省略 = `0` = 回落到 `initialEquity`。
     *
     * ⚠️ 与 `initialEquity` **不是一回事**：后者是"收益率的分母"，且会在首次启动时
     * 被真实钱包余额覆盖；这个字段是"模拟账户里有多少钱"，只给模拟盘用、永不被覆盖。
     */
    paperStartingBalance?: number;
    /**
     * **运行模式（模拟 / 实盘）—— 创建时固定**（2026-11-10 用户要求）。
     *
     * `undefined` = 没指定（老行为：首次启动时按启动参数固定一次）。
     * 新代码路径由 API 层传 `true`/`false`，**创建之后不再由启动参数决定**。
     */
    dryRun?: boolean | null;
  }): Trader {
    const ts = now();
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO traders (name, exchange_account_id, ai_model_id, strategy_id, cycle_interval_minutes, mode, initial_equity, paper_starting_balance, dry_run, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?)`,
      input.name,
      input.exchangeAccountId,
      input.aiModelId,
      input.strategyId,
      input.cycleIntervalMinutes,
      input.mode ?? 'strategy',
      input.initialEquity,
      input.paperStartingBalance ?? 0,
      input.dryRun === undefined || input.dryRun === null ? null : input.dryRun ? 1 : 0,
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
      strategyId: number | null;
      cycleIntervalMinutes: number;
      initialEquity: number;
      paperStartingBalance: number;
    }>,
  ): void {
    const current = this.get(id);
    if (!current) return;
    getDb().run(
      `UPDATE traders SET name = ?, ai_model_id = ?, strategy_id = ?, cycle_interval_minutes = ?, initial_equity = ?, paper_starting_balance = ?, updated_at = ? WHERE id = ?`,
      input.name ?? current.name,
      input.aiModelId ?? current.aiModelId,
      /*
       * ⚠️ **这里不能用 `??`。**
       *
       * `input.strategyId ?? current.strategyId` 会把显式传入的 `null` 当成
       * "没传"而回落到旧值 —— 于是"把机器人改成不依赖策略"这个操作**静默失败**，
       * 而它看起来完全正常（没有报错、字段也确实没变）。
       * 用 `in` 判断键是否存在，`null` 才能真的写进去。
       */
      'strategyId' in input ? (input.strategyId ?? null) : current.strategyId,
      input.cycleIntervalMinutes ?? current.cycleIntervalMinutes,
      input.initialEquity ?? current.initialEquity,
      input.paperStartingBalance ?? current.paperStartingBalance,
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

  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  **记下"操作员启动这一台时选的纸面模式"**（2026-10-13 实测安全修复）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 事故：测试机器人被服务重启**静默恢复成实盘**
   *
   * 用户要求"测试必须 `dryRun: true`"，而 `#11` 也确实以模拟盘启动 ——
   * **直到下一次部署重启服务**：
   * ```
   *   resumePersisted(env.dryRun)    ← 一个进程级开关，恢复【所有】机器人
   *   → env.dryRun 来自服务器 .env（DRY_RUN=false）
   *   → #11 被用 dryRun=false 恢复 → 实盘 🚨
   * ```
   * 线上 `runtime_logs` 证据：`#11 …「机器人已启动（实盘）」`。
   * 它当时 `orders=0`（全 skip）才没造成损失 —— **那是运气，不是保护**。
   *
   * ## 为什么之前不落库（那个理由现在不成立了）
   *
   * `api/server.ts` 原文：
   * > 「`dryRun` 是**运行时**的事实（它是启动参数、不落库），仓储层算不出来。」
   *
   * 那个理由在"所有机器人共用一个开关"时自洽。但**测试机器人必须与实盘
   * 机器人用不同的值** —— 那个前提被打破了，所以它必须成为机器人自己的属性。
   *
   * @param id 机器人 id
   * @param dryRun 启动时用的值；`null` 表示"清除显式指定、回到 env 回落"
   */
  setDryRun(id: number, dryRun: boolean | null): void {
    getDb().run(
      'UPDATE traders SET dry_run = ?, updated_at = ? WHERE id = ?',
      dryRun === null ? null : dryRun ? 1 : 0,
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

  /**
   * 删除一个机器人，连带它所有的从属数据。
   *
   * ## ⚠️ 必须先清这三张表，否则 **AI 托管的机器人一定删不掉**
   *
   * `agent_experiments` / `agent_memory` / `agent_runs` 引用 `traders(id)` 时
   * **没有写 `ON DELETE CASCADE`**（见 `schema.ts` 的建表语句），而 `trades` /
   * `positions` / `orders` / `equity_snapshots` / `trade_events` /
   * `decision_records` 那六张都写了。
   *
   * 后果非常具体，而且从界面上完全猜不出来：**策略模式的机器人能删，AI 托管的
   * 一定删不掉** —— 只有 AI 托管才会往这三张表里写行。操作员看到的只是一句
   * `FOREIGN KEY constraint failed`，于是很容易往"是不是最后一个才删不掉"
   * 这个方向猜（那是个无法证伪的猜测：删掉别的之后它确实是最后一个）。
   *
   * 顺序也不能反：`agent_memory` 另有一列 `trade_id REFERENCES trades(id)`，
   * 而 `trades` 是随 `traders` 级联删的 —— 先删 `traders` 会让 `agent_memory`
   * 指向不存在的成交，同样报外键失败。
   *
   * 为什么不加一个迁移把那三张表改成 `ON DELETE CASCADE`：SQLite 不支持给已有表
   * 添加外键，只能整表重建；而 §4.5 禁止改动已发布的迁移。在这里显式清一遍效果
   * 相同，而且能把原因写在它该在的地方。
   */
  remove(id: number): void {
    const db = getDb();
    db.transaction(() => {
      db.run('DELETE FROM agent_memory WHERE trader_id = ?', id);
      db.run('DELETE FROM agent_experiments WHERE trader_id = ?', id);
      db.run('DELETE FROM agent_runs WHERE trader_id = ?', id);
      db.run('DELETE FROM traders WHERE id = ?', id);
    });
  },
};

