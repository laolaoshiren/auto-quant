import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import {
  EXCHANGES,
  LLM_PROVIDERS,
  STRATEGY_PRESETS,
  StrategyConfigSchema,
  defaultStrategyConfig,
  providerDefaults,
  type ServerEvent,
} from '@aq/shared';
import { z } from 'zod';
import type { ExchangeConnection } from '../binance/bootstrap.js';
import { preflight } from '../binance/bootstrap.js';
import type { Vault } from '../crypto/vault.js';
import { dbPath, env, webDistDir } from '../env.js';
import { eventBus } from '../events.js';
import { createLogger, setLogSink } from '../logger.js';
import { maskSecret, hashPassword, verifyPassword } from '../crypto/vault.js';
import {
  aiModels,
  computeTraderStats,
  decisions as decisionStore,
  equity as equityStore,
  exchanges,
  orders as orderStore,
  positions as positionStore,
  runtimeLogs,
  strategies,
  traders,
  trades as tradeStore,
  users,
} from '../store/repositories.js';
import type { TraderManager } from '../trader/manager.js';
import { requireAuth, signToken, verifyToken, generatePassword, type AuthedRequest } from './auth.js';
import type { BalanceService } from '../services/balance.js';

const log = createLogger('api');

/* -------------------------------------------------------------------------- */
/*  Request schemas                                                            */
/* -------------------------------------------------------------------------- */

const CredentialsSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(6).max(256),
});

const ExchangeAccountInputSchema = z.object({
  exchange: z.enum(['binance']).default('binance'),
  label: z.string().min(1).max(80),
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  testnet: z.boolean().default(true),
  canTrade: z.boolean().default(true),
});

/**
 * Only the three things a user should have to think about are required.
 *
 * The inference parameters are optional and fall back to the provider's own
 * sensible defaults — a trading bot needs a small, deterministic completion, so
 * there is no reason to make anyone choose a temperature. They remain settable
 * under "advanced" for the cases that genuinely need it.
 *
 * `maxTokens` has a deliberately generous ceiling: reasoning models burn output
 * budget on their thinking before emitting a single character, so a tight cap
 * manifests as an empty completion rather than a clear error.
 */
const AiModelInputSchema = z.object({
  provider: z.string().min(1),
  label: z.string().min(1).max(80),
  model: z.string().min(1),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(2_000_000).optional(),
  timeoutSeconds: z.number().int().min(5).max(3600).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
});

const DiscoverModelsInputSchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().default(''),
  baseUrl: z.string().default(''),
});

/**
 * Schema for probing an unsaved model.
 *
 * Deliberately does **not** require `label`: the probe saves nothing, and making
 * a display name mandatory to answer "does this key work?" is friction with no
 * purpose. Only the fields that actually determine whether the call can succeed
 * are required.
 */
const DraftModelInputSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(2_000_000).optional(),
  timeoutSeconds: z.number().int().min(5).max(3600).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
});

const StrategyCheckInputSchema = z.object({
  aiModelId: z.number().int().positive(),
  /** Restrict the universe to one symbol for a fast, focused check. */
  symbol: z.string().max(24).optional(),
});

const StrategyInputSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  presetId: z.string().nullable().default(null),
  config: StrategyConfigSchema,
});

const TraderInputSchema = z.object({
  name: z.string().min(1).max(80),
  exchangeAccountId: z.number().int().positive(),
  aiModelId: z.number().int().positive(),
  strategyId: z.number().int().positive(),
  cycleIntervalMinutes: z.number().int().min(1).max(1440).default(15),
  /**
   * Starting equity, used as the baseline for the return percentage.
   *
   * Optional on purpose. When omitted or zero the server reads the **real**
   * wallet balance from the configured exchange, because a hand-typed number can
   * silently disagree with the account and make every return figure wrong.
   */
  initialEquity: z.number().min(0).optional(),
});

/* -------------------------------------------------------------------------- */
/*  Server                                                                     */
/* -------------------------------------------------------------------------- */

export interface ApiDependencies {
  vault: Vault;
  manager: TraderManager;
  jwtSecret: string;
  /** A credential-free connection used for public market data. */
  publicConnection: ExchangeConnection;
  /** Reads and caches exchange account balances for display. */
  balance: BalanceService;
}

export async function buildServer(deps: ApiDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // The console is served from the same origin in production, and Vite proxies
    // /api during development.
    trustProxy: true,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(websocket);

  /**
   * Tolerate body-less and oddly-typed POSTs.
   *
   * Several endpoints (`/start`, `/stop`, `/run-once`, `/test`) are POSTs with
   * an optional body. Browsers omit `Content-Type` entirely when there is no
   * body, while curl and PowerShell tend to send
   * `application/x-www-form-urlencoded`; Fastify's default behaviour is to
   * reject the latter with a 415 before the route ever runs. Normalising here
   * keeps those routes callable from anything.
   */
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      const error = new Error('Request body must be valid JSON');
      (error as { statusCode?: number }).statusCode = 400;
      done(error, undefined);
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  Error handling                                                         */
  /* ---------------------------------------------------------------------- */

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) log.error(`unhandled API error: ${error.message}`, error);
    void reply.code(status).send({ error: error.message });
  });

  /** Wrap a handler so thrown errors become clean 400s with a message. */
  const guard =
    <T>(handler: (input: T, request: AuthedRequest, reply: FastifyReply) => Promise<unknown> | unknown) =>
    async (request: AuthedRequest, reply: FastifyReply) => {
      try {
        return await handler(request.body as T, request, reply);
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode ?? 400;
        return reply.code(status).send({ error: (error as Error).message });
      }
    };

  /* ---------------------------------------------------------------------- */
  /*  Health + auth (unauthenticated)                                        */
  /* ---------------------------------------------------------------------- */

  app.get('/api/health', async () => ({
    ok: true,
    version: '0.1.0',
    uptimeSeconds: Math.round(process.uptime()),
    hasOwner: users.count() > 0,
    dryRun: env.dryRun,
    tradingDisabled: env.globalTradingDisabled,
    environment: deps.publicConnection.environment,
    db: dbPath,
  }));

  /**
   * Registration is open only while the instance has no accounts: the first one
   * becomes the owner. After that, new accounts must be created by an owner.
   */
  app.post('/api/auth/register', async (request, reply) => {
    const parsed = CredentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '请填写用户名，以及至少 6 位字符的密码。' });
    }

    const isFirst = users.count() === 0;
    if (!isFirst) {
      const auth = requireAuth(deps.jwtSecret);
      await auth(request, reply);
      if (reply.sent) return;
      const actor = (request as AuthedRequest).user;
      if (actor?.role !== 'owner') {
        return reply.code(403).send({ error: '只有 owner 账户可以创建新账户。' });
      }
    }

    if (users.findByUsername(parsed.data.username)) {
      return reply.code(409).send({ error: '该用户名已被占用。' });
    }

    const user = users.create(parsed.data.username, hashPassword(parsed.data.password), isFirst ? 'owner' : 'user');
    const token = signToken({ sub: user.id, username: user.username, role: user.role }, deps.jwtSecret);
    return { token, user };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = CredentialsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请填写用户名与密码。' });

    const record = users.findByUsername(parsed.data.username);
    if (!record || !verifyPassword(parsed.data.password, record.passwordHash)) {
      return reply.code(401).send({ error: '用户名或密码不正确。' });
    }

    const token = signToken(
      { sub: record.id, username: record.username, role: record.role },
      deps.jwtSecret,
    );
    return {
      token,
      user: { id: record.id, username: record.username, role: record.role, createdAt: record.createdAt },
    };
  });

  /* ---------------------------------------------------------------------- */
  /*  Everything below requires a session                                    */
  /* ---------------------------------------------------------------------- */

  const authed = { preHandler: requireAuth(deps.jwtSecret) };

  app.get('/api/auth/me', authed, async (request: AuthedRequest) => ({
    user: request.user,
  }));

  app.post('/api/auth/password', authed, async (request: AuthedRequest, reply) => {
    const body = request.body as { currentPassword?: string; newPassword?: string };
    if (!body?.newPassword || body.newPassword.length < 6) {
      return reply.code(400).send({ error: '新密码至少需要 6 位字符。' });
    }
    const record = users.findById(request.user!.sub);
    if (!record) return reply.code(404).send({ error: '找不到该账户' });
    const full = users.findByUsername(record.username);
    if (!full || !verifyPassword(body.currentPassword ?? '', full.passwordHash)) {
      return reply.code(401).send({ error: '当前密码不正确。' });
    }
    users.updatePassword(record.id, hashPassword(body.newPassword));
    return { ok: true };
  });

  /* --- Static catalogues ------------------------------------------------- */

  app.get('/api/catalog', authed, async () => ({
    providers: LLM_PROVIDERS,
    exchanges: EXCHANGES,
    presets: STRATEGY_PRESETS,
    defaultStrategy: defaultStrategyConfig(),
  }));

  /* --- System status ----------------------------------------------------- */

  app.get('/api/system', authed, async () => ({
    dryRun: env.dryRun,
    tradingDisabled: env.globalTradingDisabled,
    environment: deps.publicConnection.environment,
    environmentLabel: deps.publicConnection.endpoints.label,
    clockOffsetMs: deps.publicConnection.clockOffsetMs,
    weightUsed: deps.publicConnection.rest.usedWeight1m,
    weightLimit: deps.publicConnection.rest.weightLimitPerMinute,
    tradableSymbols: deps.publicConnection.registry.size,
    runningTraders: deps.manager.runningIds(),
  }));

  app.get('/api/logs', authed, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 200);
    return { logs: runtimeLogs.list(Number.isFinite(limit) ? limit : 200) };
  });

  /* --- Exchange accounts ------------------------------------------------- */

  app.get('/api/exchange-accounts', authed, async () => {
    // Balances are read from the cache here so that a polling console stays
    // cheap; the dedicated endpoint below forces a fresh read on demand.
    const balances = await deps.balance.getAll();

    return exchanges.list().map((account) => {
      const result = balances.get(account.id);
      return {
        ...account,
        apiKeyMasked: maskSecret(account.apiKey),
        balance: result?.ok ? result.balance : null,
        balanceError: result && !result.ok ? result.error : null,
      };
    });
  });

  /**
   * Live balance for one credential.
   *
   * `?refresh=1` bypasses the cache — an operator pressing refresh is asking for
   * "now", and serving them a stale number would be a lie.
   */
  app.get('/api/exchange-accounts/:id/balance', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!exchanges.get(id)) return reply.code(404).send({ ok: false, error: '找不到该凭据' });

    const refresh = String((request.query as { refresh?: string }).refresh ?? '') === '1';
    const result = await deps.balance.get(id, { force: refresh });
    if (!result.ok) return reply.code(200).send({ ok: false, error: result.error });
    return { ok: true, balance: result.balance, cached: result.cached };
  });

  app.post('/api/exchange-accounts', authed, guard(async (body: unknown) => {
    const parsed = ExchangeAccountInputSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid input');
    const account = exchanges.create({
      exchange: parsed.data.exchange,
      label: parsed.data.label,
      apiKey: parsed.data.apiKey,
      apiSecretEnc: deps.vault.encrypt(parsed.data.apiSecret),
      testnet: parsed.data.testnet,
      canTrade: parsed.data.canTrade,
    });
    deps.balance.invalidate(account.id);
    return { ...account, apiKeyMasked: maskSecret(account.apiKey) };
  }));

  /**
   * Test **unsaved** exchange credentials.
   *
   * Mirrors the model draft probe: the point is to find out whether a key works
   * before it is committed to the database, rather than discovering a typo from a
   * failed trading cycle later.
   */
  app.post('/api/exchange-accounts/test-draft', authed, async (request, reply) => {
    const parsed = ExchangeAccountInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, checks: [], error: '请填写完整的交易所、API Key 与 Secret。' });
    }
    try {
      const { connectExchange } = await import('../binance/bootstrap.js');
      const connection = await connectExchange({
        environment: parsed.data.testnet ? 'demo' : 'production',
        apiKey: parsed.data.apiKey,
        apiSecret: parsed.data.apiSecret,
        dryRun: true,
      });
      const checks = await preflight(connection, { requireCredentials: true });
      return { ok: checks.every((c) => c.ok || !c.blocking), checks };
    } catch (error) {
      return reply.code(400).send({ ok: false, checks: [], error: (error as Error).message });
    }
  });

  app.patch('/api/exchange-accounts/:id', authed, guard(async (body: unknown, request) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = ExchangeAccountInputSchema.partial().safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid input');

    const patch: Parameters<typeof exchanges.update>[1] = {};
    if (parsed.data.label !== undefined) patch.label = parsed.data.label;
    if (parsed.data.apiKey !== undefined) patch.apiKey = parsed.data.apiKey;
    if (parsed.data.apiSecret) patch.apiSecretEnc = deps.vault.encrypt(parsed.data.apiSecret);
    if (parsed.data.testnet !== undefined) patch.testnet = parsed.data.testnet;
    if (parsed.data.canTrade !== undefined) patch.canTrade = parsed.data.canTrade;

    exchanges.update(id, patch);
    // The stored key may have changed, so the cached balance and REST client are
    // no longer trustworthy.
    deps.balance.invalidate(id);
    return { ok: true };
  }));

  app.delete('/api/exchange-accounts/:id', authed, guard(async (_body: unknown, request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const inUse = exchanges.usageCount(id);
    if (inUse > 0) {
      return reply.code(409).send({
        error: `该凭据正被 ${inUse} 个机器人使用，请先删除或改派它们。`,
      });
    }
    exchanges.remove(id);
    deps.balance.invalidate(id);
    return { ok: true };
  }));

  /** Connect with the stored key and report exactly what is wrong, if anything. */
  app.post('/api/exchange-accounts/:id/test', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = exchanges.getWithSecret(id);
    if (!row) return reply.code(404).send({ error: '找不到该凭据' });

    try {
      const { connectExchange } = await import('../binance/bootstrap.js');
      const connection = await connectExchange({
        environment: row.testnet === 1 ? 'demo' : 'production',
        apiKey: row.api_key,
        apiSecret: deps.vault.decrypt(row.api_secret_enc),
        dryRun: true,
      });
      const checks = await preflight(connection, { requireCredentials: true });
      return { ok: checks.every((c) => c.ok || !c.blocking), checks };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message, checks: [] });
    }
  });

  /* --- AI models --------------------------------------------------------- */

  app.get('/api/ai-models', authed, async () =>
    aiModels.list().map((model) => {
      const row = aiModels.getWithSecret(model.id);
      let masked = '';
      if (row?.api_key_enc) {
        try {
          masked = maskSecret(deps.vault.decrypt(row.api_key_enc));
        } catch {
          masked = 'unreadable';
        }
      }
      return { ...model, apiKeyMasked: masked, hasKey: Boolean(row?.api_key_enc) };
    }),
  );

  /**
   * Ask the provider which models this key can use.
   *
   * This is the primary way the UI learns about models. A static list would go
   * stale — and a stale default fails only at runtime, once a trader is already
   * trying to make a decision.
   */
  app.post('/api/ai-models/discover', authed, async (request, reply) => {
    const parsed = DiscoverModelsInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, models: [], source: 'fallback', message: '参数无效。' });

    const { discoverModels } = await import('../llm/discovery.js');
    return discoverModels({
      provider: parsed.data.provider as never,
      apiKey: parsed.data.apiKey,
      ...(parsed.data.baseUrl ? { baseUrl: parsed.data.baseUrl } : {}),
    });
  });

  /**
   * Probe an **unsaved** model configuration.
   *
   * The saved-model endpoint can only test what is already in the database, which
   * means a wrong key or a hallucinated model id could only be discovered after
   * committing it. This closes that gap.
   */
  app.post('/api/ai-models/test-draft', authed, async (request, reply) => {
    const parsed = DraftModelInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: parsed.error.issues[0]?.message ?? '参数无效。', latencyMs: 0 });
    }
    const descriptor = LLM_PROVIDERS.find((p) => p.id === parsed.data.provider);
    const baseUrl = parsed.data.baseUrl || descriptor?.baseUrl || '';
    if (!baseUrl) {
      return reply.code(400).send({ ok: false, message: '自定义提供商必须填写基础 URL。', latencyMs: 0 });
    }

    try {
      const { LlmClient } = await import('../llm/client.js');
      const defaults = providerDefaults(parsed.data.provider as never);
      const client = new LlmClient({
        provider: parsed.data.provider as never,
        apiKey: parsed.data.apiKey,
        model: parsed.data.model,
        baseUrl,
        temperature: parsed.data.temperature ?? defaults.temperature,
        maxTokens: parsed.data.maxTokens ?? defaults.maxTokens,
        // Cap the probe so a wrong endpoint fails fast instead of hanging.
        timeoutSeconds: Math.min(parsed.data.timeoutSeconds ?? defaults.timeoutSeconds, 60),
        maxRetries: 0,
      });
      return await client.testConnection();
    } catch (error) {
      return reply.code(400).send({ ok: false, message: (error as Error).message, latencyMs: 0 });
    }
  });

  app.post('/api/ai-models', authed, guard(async (body: unknown) => {
    const parsed = AiModelInputSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid input');
    const descriptor = LLM_PROVIDERS.find((p) => p.id === parsed.data.provider);
    const baseUrl = parsed.data.baseUrl || descriptor?.baseUrl || '';
    if (!baseUrl) throw new Error('自定义提供商必须填写基础 URL。');

    // Anything the user left alone falls back to the provider's own defaults, so
    // the common path really is just name + key + model id.
    const defaults = providerDefaults(parsed.data.provider as never);

    return aiModels.create({
      provider: parsed.data.provider as never,
      label: parsed.data.label,
      model: parsed.data.model,
      baseUrl,
      apiKeyEnc: deps.vault.encryptOptional(parsed.data.apiKey),
      temperature: parsed.data.temperature ?? defaults.temperature,
      maxTokens: parsed.data.maxTokens ?? defaults.maxTokens,
      timeoutSeconds: parsed.data.timeoutSeconds ?? defaults.timeoutSeconds,
      maxRetries: parsed.data.maxRetries ?? defaults.maxRetries,
    });
  }));

  app.patch('/api/ai-models/:id', authed, guard(async (body: unknown, request) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = AiModelInputSchema.partial().safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid input');

    const patch: Parameters<typeof aiModels.update>[1] = {};
    if (parsed.data.provider !== undefined) patch.provider = parsed.data.provider as never;
    if (parsed.data.label !== undefined) patch.label = parsed.data.label;
    if (parsed.data.model !== undefined) patch.model = parsed.data.model;
    if (parsed.data.baseUrl !== undefined) patch.baseUrl = parsed.data.baseUrl;
    if (parsed.data.apiKey) patch.apiKeyEnc = deps.vault.encrypt(parsed.data.apiKey);
    if (parsed.data.temperature !== undefined) patch.temperature = parsed.data.temperature;
    if (parsed.data.maxTokens !== undefined) patch.maxTokens = parsed.data.maxTokens;
    if (parsed.data.timeoutSeconds !== undefined) patch.timeoutSeconds = parsed.data.timeoutSeconds;
    if (parsed.data.maxRetries !== undefined) patch.maxRetries = parsed.data.maxRetries;

    aiModels.update(id, patch);
    return { ok: true };
  }));

  /**
   * Strategy health check — "策略体检".
   *
   * Runs the real pipeline (live market data → real prompts → a real model call
   * → real parsing → real risk review) against a **simulated** account, so a
   * strategy can be validated before any exchange credential exists. Reports
   * each stage separately, because "the model failed" and "the risk engine
   * refused everything" both look like "the bot did nothing" from outside.
   */
  app.post('/api/strategies/:id/check', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const strategy = strategies.get(id);
    if (!strategy) return reply.code(404).send({ ok: false, error: '找不到该策略' });

    const parsed = StrategyCheckInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: '请选择一个要用于测试的 LLM 模型。' });

    const modelRow = aiModels.getWithSecret(parsed.data.aiModelId);
    if (!modelRow) return reply.code(404).send({ ok: false, error: '找不到该 AI 模型' });

    const apiKey = deps.vault.decryptOptional(modelRow.api_key_enc);
    if (!apiKey && modelRow.provider !== 'custom') {
      return reply.code(400).send({ ok: false, error: `AI 模型「${modelRow.label}」还没有配置 API Key。` });
    }

    try {
      const { LlmClient } = await import('../llm/client.js');
      const { checkStrategy } = await import('../strategy/healthCheck.js');

      const client = new LlmClient({
        provider: modelRow.provider as never,
        apiKey,
        model: modelRow.model,
        ...(modelRow.base_url ? { baseUrl: modelRow.base_url } : {}),
        temperature: modelRow.temperature,
        maxTokens: modelRow.max_tokens,
        timeoutSeconds: modelRow.timeout_seconds,
        maxRetries: modelRow.max_retries,
      });

      const result = await checkStrategy({
        config: strategy.config,
        connection: deps.publicConnection,
        client,
        ...(parsed.data.symbol ? { symbol: parsed.data.symbol.toUpperCase() } : {}),
      });

      return { ...result, strategyName: strategy.name, modelLabel: modelRow.label, model: modelRow.model };
    } catch (error) {
      log.error(`策略体检失败：${(error as Error).message}`);
      return reply.code(500).send({ ok: false, error: (error as Error).message, stages: [], sample: null });
    }
  });

  app.delete('/api/ai-models/:id', authed, guard(async (_body: unknown, request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const inUse = aiModels.usageCount(id);
    if (inUse > 0) {
      return reply.code(409).send({ error: `该模型正被 ${inUse} 个机器人使用。` });
    }
    aiModels.remove(id);
    return { ok: true };
  }));

  /** Probe the model endpoint without starting a trader. */
  app.post('/api/ai-models/:id/test', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const row = aiModels.getWithSecret(id);
    if (!row) return reply.code(404).send({ error: '找不到该模型' });

    try {
      const { LlmClient } = await import('../llm/client.js');
      const client = new LlmClient({
        provider: row.provider as never,
        apiKey: deps.vault.decryptOptional(row.api_key_enc),
        model: row.model,
        ...(row.base_url ? { baseUrl: row.base_url } : {}),
        timeoutSeconds: Math.min(row.timeout_seconds, 60),
        maxRetries: 0,
      });
      const probe = await client.testConnection();
      return probe;
    } catch (error) {
      return reply.code(400).send({ ok: false, message: (error as Error).message, latencyMs: 0 });
    }
  });

  /* --- Strategies -------------------------------------------------------- */

  app.get('/api/strategies', authed, async () => strategies.list());

  app.get('/api/strategies/:id', authed, async (request, reply) => {
    const strategy = strategies.get(Number((request.params as { id: string }).id));
    if (!strategy) return reply.code(404).send({ error: '找不到该策略' });
    return strategy;
  });

  app.post('/api/strategies', authed, guard(async (body: unknown) => {
    const parsed = StrategyInputSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid strategy');
    return strategies.create({
      name: parsed.data.name,
      description: parsed.data.description,
      config: parsed.data.config,
      presetId: parsed.data.presetId,
    });
  }));

  app.patch('/api/strategies/:id', authed, guard(async (body: unknown, request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = StrategyInputSchema.partial().safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid strategy');

    const patch: Parameters<typeof strategies.update>[1] = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.config !== undefined) patch.config = parsed.data.config;

    strategies.update(id, patch);
    const updated = strategies.get(id);
    if (!updated) return reply.code(404).send({ error: '找不到该策略' });
    return updated;
  }));

  app.delete('/api/strategies/:id', authed, guard(async (_body: unknown, request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const inUse = strategies.usageCount(id);
    if (inUse > 0) {
      return reply.code(409).send({ error: `该策略正被 ${inUse} 个机器人使用。` });
    }
    strategies.remove(id);
    return { ok: true };
  }));

  /* --- Traders ----------------------------------------------------------- */

  app.get('/api/traders', authed, async () => {
    const running = new Set(deps.manager.runningIds());
    return traders.list().map((trader) => ({
      ...trader,
      // The live loop is the source of truth for status, not the stored value.
      status: running.has(trader.id) ? deps.manager.statusOf(trader.id) : ('stopped' as const),
      isRunning: running.has(trader.id),
    }));
  });

  app.post('/api/traders', authed, guard(async (body: unknown) => {
    const parsed = TraderInputSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid trader');
    const account = exchanges.get(parsed.data.exchangeAccountId);
    if (!account) throw new Error('未知的交易所账户');
    if (!aiModels.get(parsed.data.aiModelId)) throw new Error('未知的 AI 模型');
    if (!strategies.get(parsed.data.strategyId)) throw new Error('未知的策略');

    // Seed the return baseline from the exchange rather than from a typed number.
    let initialEquity = parsed.data.initialEquity ?? 0;
    let equitySource: 'exchange' | 'manual' | 'unavailable' = 'manual';
    if (initialEquity <= 0) {
      const live = await deps.balance.walletBalanceOf(account.id);
      if (live !== null && live > 0) {
        initialEquity = live;
        equitySource = 'exchange';
      } else {
        equitySource = 'unavailable';
      }
    }

    const trader = traders.create({
      name: parsed.data.name,
      exchangeAccountId: parsed.data.exchangeAccountId,
      aiModelId: parsed.data.aiModelId,
      strategyId: parsed.data.strategyId,
      cycleIntervalMinutes: parsed.data.cycleIntervalMinutes,
      initialEquity,
    });

    return { ...trader, equitySource };
  }));

  app.patch('/api/traders/:id', authed, guard(async (body: unknown, request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (deps.manager.isRunning(id)) {
      return reply.code(409).send({ error: '请先停止该机器人，再修改它的配置。' });
    }
    const parsed = TraderInputSchema.partial().safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid trader');
    traders.update(id, parsed.data);
    return traders.get(id);
  }));

  app.delete('/api/traders/:id', authed, guard(async (_body: unknown, request) => {
    const id = Number((request.params as { id: string }).id);
    await deps.manager.stopTrader(id);
    traders.remove(id);
    return { ok: true };
  }));

  app.post('/api/traders/:id/start', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (env.globalTradingDisabled) {
      return reply.code(503).send({
        error: '交易已被 GLOBAL_TRADING_DISABLED 全局禁用。要启动机器人请先移除该设置。',
        preflight: [],
      });
    }
    const body = (request.body ?? {}) as { dryRun?: boolean };
    // Paper mode is the default: a real-money start must be asked for explicitly.
    const dryRun = body.dryRun ?? true;
    const result = await deps.manager.startTrader(id, dryRun);
    if (!result.ok) return reply.code(400).send(result);
    return result;
  });

  app.post('/api/traders/:id/stop', authed, async (request) => {
    await deps.manager.stopTrader(Number((request.params as { id: string }).id));
    return { ok: true };
  });

  /** Force one decision cycle immediately instead of waiting for the interval. */
  app.post('/api/traders/:id/run-once', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (env.globalTradingDisabled) {
      return reply.code(503).send({ error: '交易已被全局禁用。' });
    }
    try {
      const summary = await deps.manager.runCycleNow(id);
      return { ok: true, summary };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message });
    }
  });

  /**
   * Rebuild a trader's ledger from the exchange's own history.
   *
   * Deliberately **not** gated by the global trading kill switch: it places no
   * orders and only corrects the books, which is exactly what you want to be
   * able to do while trading is disabled.
   */
  app.post('/api/traders/:id/reconcile', authed, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    try {
      const result = await deps.manager.reconcileTrader(id);
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: (error as Error).message });
    }
  });

  /* --- Trader data ------------------------------------------------------- */

  const traderIdOf = (request: { params: unknown }): number =>
    Number((request.params as { id: string }).id);

  /**
   * Read the exchange directly for a trader's live account and positions.
   *
   * Uses a throwaway read-only connection so the console always shows what the
   * exchange actually holds, rather than our local mirror — the whole point of
   * having a reconciliation loop is that the mirror can be wrong.
   */
  const liveExchangeView = async (traderId: number) => {
    const trader = traders.get(traderId);
    if (!trader || !deps.manager.isRunning(traderId)) {
      return { live: false, account: null, positions: [], error: undefined as string | undefined };
    }
    try {
      const row = exchanges.getWithSecret(trader.exchangeAccountId);
      if (!row) return { live: false, account: null, positions: [], error: '找不到该凭据' };
      const { connectExchange } = await import('../binance/bootstrap.js');
      const connection = await connectExchange({
        environment: row.testnet === 1 ? 'demo' : 'production',
        apiKey: row.api_key,
        apiSecret: deps.vault.decrypt(row.api_secret_enc),
        dryRun: true,
      });
      const [account, livePositions] = await Promise.all([
        connection.broker.getAccountState(),
        connection.broker.getPositions(),
      ]);
      // Layer the local records (stop/target ids, peak PnL, entry reasoning) on
      // top of the exchange's truth.
      const local = positionStore.open(traderId);
      const bySymbol = new Map(local.map((p) => [p.symbol, p]));
      const positions = livePositions.map((live) => {
        const record = bySymbol.get(live.symbol);
        return {
          id: record?.id ?? 0,
          traderId,
          symbol: live.symbol,
          side: live.side,
          quantity: live.quantity,
          entryPrice: live.entryPrice,
          markPrice: live.markPrice,
          leverage: live.leverage,
          liquidationPrice: live.liquidationPrice,
          unrealizedPnl: live.unrealizedPnl,
          unrealizedPnlPercent: live.unrealizedPnlPercent,
          peakPnlPercent: record?.peak_pnl_percent ?? 0,
          marginUsed: live.marginUsed,
          notional: live.notional,
          stopLoss: record?.stop_loss ?? null,
          takeProfit: record?.take_profit ?? null,
          openedAt: record?.opened_at ?? new Date().toISOString(),
          openReasoning: record?.open_reasoning ?? '',
        };
      });
      return { live: true, account, positions, error: undefined as string | undefined };
    } catch (error) {
      return { live: false, account: null, positions: [], error: (error as Error).message };
    }
  };

  app.get('/api/traders/:id/stats', authed, async (request) => computeTraderStats(traderIdOf(request)));

  app.get('/api/traders/:id/positions', authed, async (request) => {
    const id = traderIdOf(request);
    // Prefer the exchange's own view; fall back to the local mirror when the
    // trader is stopped or the exchange is unreachable.
    const live = await liveExchangeView(id);
    if (live.positions.length > 0 || live.live) return live.positions;

    return positionStore.open(id).map((row) => ({
      id: row.id,
      traderId: row.trader_id,
      symbol: row.symbol,
      side: row.side,
      quantity: row.quantity,
      entryPrice: row.entry_price,
      markPrice: row.entry_price,
      leverage: row.leverage,
      liquidationPrice: row.liquidation_price,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      peakPnlPercent: row.peak_pnl_percent,
      marginUsed: row.margin_used,
      notional: row.quantity * row.entry_price,
      stopLoss: row.stop_loss,
      takeProfit: row.take_profit,
      openedAt: row.opened_at,
      openReasoning: row.open_reasoning,
    }));
  });

  /** Live exchange view, so the console can show truth rather than our mirror. */
  app.get('/api/traders/:id/account', authed, async (request, reply) => {
    const trader = traders.get(traderIdOf(request));
    if (!trader) return reply.code(404).send({ error: '找不到该机器人' });
    return liveExchangeView(trader.id);
  });

  app.get('/api/traders/:id/orders', authed, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 100);
    return orderStore.list(traderIdOf(request), Number.isFinite(limit) ? limit : 100);
  });

  app.get('/api/traders/:id/trades', authed, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 100);
    return tradeStore.list(traderIdOf(request), Number.isFinite(limit) ? limit : 100);
  });

  app.get('/api/traders/:id/decisions', authed, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 50);
    return decisionStore.list(traderIdOf(request), Number.isFinite(limit) ? limit : 50);
  });

  app.get('/api/traders/:id/decisions/:recordId', authed, async (request, reply) => {
    const recordId = Number((request.params as { recordId: string }).recordId);
    const record = decisionStore.get(recordId);
    if (!record || record.traderId !== traderIdOf(request)) {
      return reply.code(404).send({ error: '找不到该决策记录' });
    }
    return record;
  });

  app.get('/api/traders/:id/equity', authed, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 500);
    return equityStore.list(traderIdOf(request), Number.isFinite(limit) ? limit : 500);
  });

  /* --- Public market data ------------------------------------------------ */

  app.get('/api/market/symbols', authed, async () => {
    const registry = deps.publicConnection.registry;
    const tickers = await deps.publicConnection.market.ticker24h().catch(() => []);
    const bySymbol = new Map(tickers.map((t) => [t.symbol, t]));
    return registry
      .all()
      .map((info) => {
        const ticker = bySymbol.get(info.symbol);
        return {
          symbol: info.symbol,
          baseAsset: info.baseAsset,
          price: Number(ticker?.lastPrice ?? 0),
          changePercent24h: Number(ticker?.priceChangePercent ?? 0),
          quoteVolume24h: Number(ticker?.quoteVolume ?? 0),
          minNotional: info.minNotional,
        };
      })
      .filter((s) => s.quoteVolume24h > 0)
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
  });

  app.get('/api/market/klines', authed, async (request, reply) => {
    const query = request.query as { symbol?: string; interval?: string; limit?: string };
    if (!query.symbol) return reply.code(400).send({ error: '缺少 symbol 参数' });
    const interval = (query.interval ?? '15m') as never;
    const limit = Math.min(Number(query.limit ?? 200) || 200, 1000);
    return deps.publicConnection.market.klines(query.symbol, interval, limit);
  });

  /* --- Live event stream ------------------------------------------------- */

  app.get('/api/events', { websocket: true }, (socket, request) => {
    const token = (request.query as { token?: string })?.token ?? null;
    if (!token) {
      socket.close(1008, '需要登录');
      return;
    }
    if (!verifyToken(token, deps.jwtSecret)) {
      socket.close(1008, 'Invalid session');
      return;
    }

    // Replay recent history so a freshly-opened console is not blank.
    for (const event of eventBus.history(30)) socket.send(JSON.stringify(event));

    const unsubscribe = eventBus.subscribe((event: ServerEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });

    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });

  /* --- Server logs to the console ---------------------------------------- */

  setLogSink((level, scope, message) => {
    if (level === 'debug') return;
    runtimeLogs.write(null, level, scope, message);
    eventBus.publish({
      type: 'log',
      traderId: null,
      level,
      message: `[${scope}] ${message}`,
      timestamp: new Date().toISOString(),
    });
  });

  /* --- Static console ---------------------------------------------------- */

  if (existsSync(webDistDir)) {
    await app.register(fastifyStatic, { root: webDistDir });
    app.setNotFoundHandler((request, reply) => {
      // SPA fallback: client-side routes must resolve to index.html.
      if (request.url.startsWith('/api')) {
        return reply.code(404).send({ error: '接口不存在' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

/** Create the owner account on first boot and report the credentials once. */
export function bootstrapOwnerAccount(): { created: boolean; password?: string } {
  if (users.count() > 0) return { created: false };

  const password = env.adminPassword || generatePassword();
  users.create('admin', hashPassword(password), 'owner');
  return { created: true, password };
}
