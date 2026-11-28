import type { FastifyReply } from 'fastify';
import {
  AI_MANAGED_PRESET_MODEL,
  ExchangeIdSchema,
  LLM_PROVIDERS,
  providerDefaults,
  StrategyConfigSchema,
  defaultStrategyConfig,
} from '@aq/shared';
import { preflight } from '../../binance/bootstrap.js';
import { maskSecret } from '../../crypto/vault.js';
import { env } from '../../env.js';
import { checkOutboundUrl, parseHostAllowlist } from '../../llm/urlGuard.js';
import { createLogger } from '../../logger.js';
import { aiModels, exchanges, settings, strategies, traders } from '../../store/repositories.js';
import { readLlmHealth, recordLlmHealth } from '../../trader/manager.js';
import { DEFAULT_MAGPIE_URL } from '../../trader/teamGateway.js';
import type { AuthedRequest } from '../auth.js';
import {
  AI_MANAGED_PRESET,
  AiModelInputSchema,
  AiModelPatchSchema,
  BaseUrlSchema,
  DiscoverModelsInputSchema,
  DraftModelInputSchema,
  ExchangeAccountInputSchema,
  ExchangeAccountPatchSchema,
  StrategyCheckInputSchema,
  StrategyInputSchema,
  StrategyPatchSchema,
} from '../schemas.js';
import { publicAccount, type RouteContext } from './context.js';

const log = createLogger('api');

export function registerExchangeModelRoutes(ctx: RouteContext): void {
  const { app, deps, authed, idOf, guard } = ctx;

  /* --- Exchange accounts ------------------------------------------------- */

  app.get('/api/exchange-accounts', authed, async () => {
    /*
     * `deps.balance` 内部已按 `account.exchange` 分派（币安 / Gate 各自走对应客户端并共享缓存），
     * 绝不再出现"先拿全部账户（含 Gate Key）打币安、再单独重查 Gate"的凭据外泄。
     */
    const balances = await deps.balance.getAll();

    return exchanges.list().map((account) => {
      const result = balances.get(account.id);
      return {
        ...publicAccount(account),
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
    const id = idOf(request);
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
    return publicAccount(account);
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
      /*
       * ⚠️ **按交易所分派**（2026-11-11）：原来这里无条件走币安 —— Gate 账户点
       * 「测试连接」会拿 Gate 的 key 去打币安的端点，回报一条"认证失败"，
       * 让人以为 Gate key 配错了。Gate 走自己的连接与预检。
       */
      if (parsed.data.exchange === 'gate') {
        const { connectGate, gateStartupChecks, gateEnvironmentOf } = await import('../../gate/connection.js');
        const connection = await connectGate({
          apiKey: parsed.data.apiKey,
          apiSecret: parsed.data.apiSecret,
          environment: gateEnvironmentOf(parsed.data.testnet),
        });
        const checks = await gateStartupChecks(connection);
        return { ok: checks.every((c) => c.ok || !c.blocking), checks };
      }
      const { connectExchange } = await import('../../binance/bootstrap.js');
      const connection = await connectExchange({
        environment: parsed.data.testnet ? 'demo' : 'production',
        apiKey: parsed.data.apiKey,
        apiSecret: parsed.data.apiSecret,
        /* 仅执行只读 preflight：不能传 dryRun=true，否则 getPositions 短路为 [] 会漏检双向持仓下的真实持仓。 */
        dryRun: false,
        // 一次性的连通性自检：结论由下面的 preflight 报告，不必广播"已连接"。
        quiet: true,
      });
      const checks = await preflight(connection, { requireCredentials: true });
      return { ok: checks.every((c) => c.ok || !c.blocking), checks };
    } catch (error) {
      return reply.code(400).send({ ok: false, checks: [], error: (error as Error).message });
    }
  });

  app.patch('/api/exchange-accounts/:id', authed, guard(async (body: unknown, request) => {
    const id = idOf(request);
    const parsed = ExchangeAccountPatchSchema.safeParse(body);
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
    /* 机器人侧缓存的交易连接同理 —— 见 `invalidateConnectionsForAccount` 的说明。 */
    deps.manager.invalidateConnectionsForAccount(id);
    return { ok: true };
  }));

  app.delete('/api/exchange-accounts/:id', authed, guard(async (_body: unknown, request, reply) => {
    const id = idOf(request);
    /*
     * ══════════════════════════════════════════════════════════════════════════
     *  ⚠️ **只有「正在运行」的机器人能挡住删除**（2026-10-23 用户实测）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 原来的行为（用户报的 BUG）
     *
     * 界面上报「该凭据正被 3 个机器人使用，请先删除或改派它们」，
     * 而那 3 个机器人**全部是 stopped**。用户想删的是凭据，不是机器人 ——
     * 却被要求先去删机器人才能删凭据。
     *
     * ## 现在的行为
     *
     * ```
     *   还有 running 的机器人在用 → 仍然挡住（那是真的危险：
     *                                删了它，正在跑的仓位会失去管理）
     *   只剩 stopped 的机器人在用 → 解绑它们，然后删掉凭据
     * ```
     *
     * `usageCount()` 的判据已改成只数 running（见仓储里那段说明）。
     * 走到这里的 `inUse` 因此就是"真正在用的数量"。
     *
     * ## 那条 warn 的意义
     *
     * 解绑是**有后果的操作**：那些机器人下次启动时会报"没有配置交易所账户"。
     * 那不是故障，但操作员需要知道是他的删除导致的 —— 否则他会以为是新 BUG。
     */
    const activeInMemoryCount = traders
      .list()
      .filter(
        (t) =>
          t.exchangeAccountId === id &&
          (deps.manager.isRunning?.(t.id) || deps.manager.isStarting?.(t.id)),
      ).length;
    const inUse = Math.max(exchanges.usageCount(id), activeInMemoryCount);
    if (inUse > 0) {
      return reply.code(409).send({
        error:
          `该凭据正被 ${inUse} 个**正在运行或启动中**的机器人使用。请先停止它们再删除 —— ` +
          '运行中的机器人被解绑后，它手上的仓位会失去管理。',
      });
    }
    /*
     * 已停止的机器人仍然引用着它 —— 先解绑，避免留下指向幽灵 id 的行。
     * ⚠️ 失效连接必须在解绑**之前**：解绑后就查不出哪些机器人用过这个凭据了。
     */
    deps.manager.invalidateConnectionsForAccount(id);
    const detached = exchanges.detachAll(id);
    exchanges.remove(id);
    deps.balance.invalidate(id);
    if (detached > 0) {
      log.warn(
        `交易所凭据已删除，顺带解绑了 ${detached} 个已停止的机器人（它们下次启动需要重新选账户）`,
        { accountId: id, detachedTraders: detached },
      );
    }
    return { ok: true, detachedTraders: detached };
  }));

  /** Connect with the stored key and report exactly what is wrong, if anything. */
  app.post('/api/exchange-accounts/:id/test', authed, async (request, reply) => {
    const id = idOf(request);
    const row = exchanges.getWithSecret(id);
    if (!row) return reply.code(404).send({ error: '找不到该凭据' });

    try {
      if (row.exchange === 'gate') {
        const { connectGate, gateStartupChecks, gateEnvironmentOf } = await import('../../gate/connection.js');
        const connection = await connectGate({
          apiKey: row.api_key,
          apiSecret: deps.vault.decrypt(row.api_secret_enc),
          environment: gateEnvironmentOf(row.testnet === 1),
        });
        const checks = await gateStartupChecks(connection);
        return { ok: checks.every((c) => c.ok || !c.blocking), checks };
      }
      const { connectExchange } = await import('../../binance/bootstrap.js');
      const connection = await connectExchange({
        environment: row.testnet === 1 ? 'demo' : 'production',
        apiKey: row.api_key,
        apiSecret: deps.vault.decrypt(row.api_secret_enc),
        /* 仅执行只读 preflight，不短路 getPositions 以准确检测双向持仓。 */
        dryRun: false,
        // 同上：自检结果由 preflight 报告。
        quiet: true,
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
      return {
        ...model,
        apiKeyMasked: masked,
        hasKey: Boolean(row?.api_key_enc),
        /*
         * ⚠️ **把"这个模型最近一次调用成没成"一起返回。**
         *
         * 2026-09-29 实测：网关连着 12 次回 `insufficient credits`（HTTP 400），
         * 而界面上没有任何迹象 —— 只有服务器日志里有。这份 `health` 就是让
         * 控制台能说出"模型现在不能用"（见 `LlmHealth` 的完整说明）。
         */
        health: readLlmHealth(model.id),
      };
    }),
  );

  /**
   * Ask the provider which models this key can use.
   *
   * This is the primary way the UI learns about models. A static list would go
   * stale — and a stale default fails only at runtime, once a trader is already
   * trying to make a decision.
   *
   * 密钥来源有两条，**顺序不能反**：
   *
   *   1. 请求体里的 `apiKey` 非空 —— 用户正在输入一把替换密钥，以他输入的为准；
   *   2. `apiKey` 为空但带上了 `modelId` —— 编辑已保存的模型时界面刻意留空输入框
   *      （明文密钥从不回显），这时才回头读那条记录里加密存储的密钥。
   *
   * 这里的密钥**只**作为请求头发给提供商，绝不进日志、异常消息或响应体：
   * 失败路径回给用户的始终是 `discoverModels()` 里那条不含密钥的中文提示。
   * 另外 `modelId` 与其它模型端点一样走 `authed` 之后才可用，未认证的调用方
   * 无法借它去用别人的密钥。
   */
  app.post('/api/ai-models/discover', authed, async (request, reply) => {
    const parsed = DiscoverModelsInputSchema.safeParse(request.body);
    if (!parsed.success) {
      // baseUrl 被地址白名单拒绝时要把原因说出来（"为什么不能打这个地址"），
      // 其余字段的 zod 默认提示是英文，对操作员没用 —— 保持原来的中文兜底。
      const baseUrlIssue = parsed.error.issues.find((issue) => issue.path[0] === 'baseUrl');
      return reply.code(400).send({
        ok: false,
        models: [],
        source: 'fallback',
        message: baseUrlIssue?.message ?? '参数无效。',
      });
    }

    const { provider, modelId } = parsed.data;
    let apiKey = parsed.data.apiKey;

    if (!apiKey && modelId !== undefined) {
      const row = aiModels.getWithSecret(modelId);
      if (row?.api_key_enc) {
        try {
          apiKey = deps.vault.decrypt(row.api_key_enc);
        } catch {
          // 解密失败通常意味着主密钥换过、或密文损坏。把原因说清楚，
          // 但**不能**把密文或异常详情带出去 —— 那属于凭据材料。
          return reply.code(400).send({
            ok: false,
            models: [],
            source: 'fallback',
            message: '已存储的 API Key 无法解密，请在编辑框中重新填写一次。',
          });
        }
      }
      // 记录不存在、或存在但没存过密钥：与"没带 modelId"走同一条落空路径，
      // 统一由 discoverModels() 给出那句"请先填写 API Key"的中文提示。
    }

    if (!LLM_PROVIDERS.some((p) => p.id === provider)) {
      return reply.code(400).send({
        ok: false,
        models: [],
        source: 'fallback',
        message: `不支持的模型提供商：${provider}`,
      });
    }

    try {
      const { discoverModels } = await import('../../llm/discovery.js');
      return await discoverModels({
        provider: provider as never,
        apiKey,
        ...(parsed.data.baseUrl ? { baseUrl: parsed.data.baseUrl } : {}),
      });
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        models: [],
        source: 'fallback',
        message: (error as Error).message,
      });
    }
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

    /*
     * ⚠️ **编辑一个已存模型时，界面不会回传密钥（留空表示"不改它"）—— 所以这里必须回落。**
     *
     * 用户 2026-10-08 报的：「编辑一个已经添加过 key 的模型提供商时候需要重新填入 KEY，
     * 不然无法测试通过」。根因就是这一行原来直接吃表单里的 `apiKey`，
     * 而编辑态下它是空字符串 —— 拿空密钥去认证当然失败。
     * **界面上的提示写着"留空则保留已存储的密钥"，而测试连接却把"留空"当成了"空密钥"**：
     * 两句话互相矛盾，用户只能靠重新输入一遍来绕过。
     *
     * 修法：表单带了 `id`（编辑态）且 `apiKey` 为空时，**解密那条已存的密钥**用。
     * 前端因此不必判断该调 `/test-draft` 还是 `/:id/test` —— 那是实现细节，
     * 不该让用户（和界面的分支）去承担。
     */
    /*
     * ⚠️ **字段名是 `modelId`，不是 `id`** —— 与同一族的 `/discover` 保持一致
     * （那条路由的注释早就写明"`modelId` 是用已存密钥的唯一表达方式"）。
     *
     * 我第一版写成了 `id`，于是前端传的 `modelId` 被丢掉、回落逻辑永不触发，
     * 用户看到的仍是 `Missing API key.`。**同一个东西两个名字，就是这种结果。**
     */
    const draftModelId = Number((request.body as { modelId?: unknown } | null)?.modelId);
    let effectiveKey = parsed.data.apiKey;
    if (!effectiveKey && Number.isFinite(draftModelId) && draftModelId > 0) {
      const existing = aiModels.getWithSecret(draftModelId);
      if (existing) effectiveKey = deps.vault.decryptOptional(existing.api_key_enc);
    }

    try {
      const { LlmClient } = await import('../../llm/client.js');
      const defaults = providerDefaults(parsed.data.provider as never);
      const client = new LlmClient({
        provider: parsed.data.provider as never,
        apiKey: effectiveKey,
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
      return reply.code(400).send({ ok: false, message: explainProbeError((error as Error).message), latencyMs: 0 });
    }
  });

  /**
   * 把探针的原始报错翻成**操作员能照做**的一句话。
   *
   * 用户 2026-10-08 在 OpenCode GO 上选了 `claude-haiku-5-5`，界面只说
   * 「Model does not support this protocol.」—— 那句话既没说是**哪个**模型的问题，
   * 也没说**该怎么办**。实测两种情况都试过（`/chat/completions` 400 不支持该协议、
   * `/messages` 401 该模型不被支持），结论是**这个模型在那个网关上是不可用的**，
   * 而不是我们的协议实现错了。
   *
   * 所以这里补一句指向"换模型"的话 —— 否则人会一直去查密钥和 URL（那是提示里让他查的
   * 前三项），而真正的原因在第四项。
   */
  function explainProbeError(message: string): string {
    /*
     * ⚠️ **OpenCode Go 只覆盖【开源模型】，而它的 `/models` 返回的是网关全集。**
     *
     * 用户 2026-10-08 选了 `claude-haiku-5-5` 并报「连不上」。查官方文档
     * （<https://opencode.ai/docs/zh-cn/go/>）：
     *
     * > Go 通过两种用量方案，稳定访问**开源编程模型**……我们测试了一组精选的**开源模型**
     *
     * 而 Claude 是 Anthropic 的**专有**模型 —— **不在 Go / Go Plus 的范围内**。
     * 实测也印证：`chat/completions` 返 400「Model does not support this protocol」、
     * `messages` 返 401「is not supported」；而**同一个 key、同一个端点**跑
     * `deepseek-v4.1-flash` 是 **200**。所以不是协议实现的问题，是订阅没覆盖该模型。
     *
     * 而「获取可用模型」列的是**网关全集（37 个）**，没按订阅过滤 ——
     * 界面上因此看不出"哪些真的能用"。至少要让报错把这层说破，否则人会一直去查
     * 密钥和 URL（提示里让他查的前三项），而真正的原因在订阅范围上。
     */
    if (/ModelProtocolUnsupported|does not support this protocol/i.test(message)) {
      return (
        `${message} —— 这类模型在你的服务商侧不提供 OpenAI 兼容接口。` +
        '若用的是 OpenCode Go，注意它只覆盖**开源模型**（如 deepseek 系），' +
        'Claude / GPT 这类专有模型不在订阅范围内 —— 「获取可用模型」列的是网关全集，' +
        '但不等于你的订阅能用。请换一个开源模型 id 再测。'
      );
    }
    if (/is not supported|ModelError/i.test(message)) {
      return (
        `${message} —— 该模型在你的订阅下不可用。` +
        'OpenCode Go 只覆盖开源模型，专有模型需要另配 key。请换一个模型 id 再测。'
      );
    }
    return message;
  }

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
      /*
       * 四个参数**一律**取 provider 的默认值 —— 见 `AiModelInputSchema` 上的说明。
       * 控制台的「高级设置」面板已删掉，这里也不再接受客户端传入。
       */
      temperature: defaults.temperature,
      maxTokens: defaults.maxTokens,
      timeoutSeconds: defaults.timeoutSeconds,
      maxRetries: defaults.maxRetries,
    });
  }));

  app.patch('/api/ai-models/:id', authed, guard(async (body: unknown, request) => {
    const id = idOf(request);
    const parsed = AiModelPatchSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid input');

    const existing = aiModels.get(id);
    if (!existing) throw new Error('找不到该 AI 模型');
    const nextProvider = (parsed.data.provider ?? existing.provider) as string;
    const descriptor = LLM_PROVIDERS.find((p) => p.id === nextProvider);
    const nextBaseUrl =
      parsed.data.baseUrl !== undefined
        ? parsed.data.baseUrl || descriptor?.baseUrl || ''
        : existing.baseUrl || descriptor?.baseUrl || '';
    if (!nextBaseUrl) {
      throw new Error('自定义提供商必须填写基础 URL。');
    }

    const patch: Parameters<typeof aiModels.update>[1] = {};
    if (parsed.data.provider !== undefined) patch.provider = parsed.data.provider as never;
    if (parsed.data.label !== undefined) patch.label = parsed.data.label;
    if (parsed.data.model !== undefined) patch.model = parsed.data.model;
    if (parsed.data.baseUrl !== undefined || parsed.data.provider !== undefined) {
      patch.baseUrl = nextBaseUrl;
    }
    if (parsed.data.apiKey) patch.apiKeyEnc = deps.vault.encrypt(parsed.data.apiKey);
    /*
     * ⚠️ **改了 provider 就要把这四项刷新成它的默认值。**
     *
     * 它们现在是"provider 的属性"而不是"这条记录的属性"：把 kimi 的记录
     * 改成 commandcode、却留着 kimi 的超时与输出预算，会得到一个**两边都不对**
     * 的组合（比如 kimi 的 180s 超时配上一个更慢的网关）。
     *
     * 只在 provider 真的变了时候刷新：只是想改个名字的 PATCH 不该动它们。
     */
    if (patch.provider !== undefined) {
      const next = providerDefaults(patch.provider);
      patch.temperature = next.temperature;
      patch.maxTokens = next.maxTokens;
      patch.timeoutSeconds = next.timeoutSeconds;
      patch.maxRetries = next.maxRetries;
    }

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
    const id = idOf(request);
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
      const { LlmClient } = await import('../../llm/client.js');
      const { checkStrategy } = await import('../../strategy/healthCheck.js');

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

      const checkConnection =
        parsed.data.exchange === 'gate'
          ? await (async () => {
              const { connectGate } = await import('../../gate/connection.js');
              const gateConn = await connectGate({ apiKey: '', apiSecret: '', environment: 'live' });
              return {
                market: gateConn.market,
                registry: gateConn.registry,
                endpoints: { label: 'Gate.io 合约（公共行情）' },
                clockOffsetMs: gateConn.clockOffsetMs,
              };
            })()
          : deps.publicConnection;

      const result = await checkStrategy({
        config: strategy.config,
        connection: checkConnection,
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
    const id = idOf(request);
    const inUse = aiModels.usageCount(id);
    if (inUse > 0) {
      return reply.code(409).send({ error: `该模型正被 ${inUse} 个机器人使用。` });
    }
    aiModels.remove(id);
    return { ok: true };
  }));

  /**
   * Probe the model endpoint without starting a trader.
   *
   * 结果写进 `llm_health:<id>`(同一份记录机器人运行时的调用结果)。否则点完「测试」
   * 刷新页面,「最近测试」就回到"从未测试" —— 结果只活在前端内存里。
   */
  app.post('/api/ai-models/:id/test', authed, async (request, reply) => {
    const id = idOf(request);
    const row = aiModels.getWithSecret(id);
    if (!row) return reply.code(404).send({ error: '找不到该模型' });

    const at = () => new Date().toISOString();
    try {
      const { LlmClient } = await import('../../llm/client.js');
      const client = new LlmClient({
        provider: row.provider as never,
        apiKey: deps.vault.decryptOptional(row.api_key_enc),
        model: row.model,
        ...(row.base_url ? { baseUrl: row.base_url } : {}),
        timeoutSeconds: Math.min(row.timeout_seconds, 60),
        maxRetries: 0,
      });
      const probe = await client.testConnection();
      recordLlmHealth(id, probe.ok
        ? { ok: true, at: at(), latencyMs: probe.latencyMs }
        : { ok: false, at: at(), latencyMs: probe.latencyMs, error: probe.message.slice(0, 300) });
      return probe;
    } catch (error) {
      const message = (error as Error).message;
      recordLlmHealth(id, { ok: false, at: at(), error: message.slice(0, 300) });
      return reply.code(400).send({ ok: false, message, latencyMs: 0 });
    }
  });

  /**
   * 指定「创建新机器人时预选哪个模型」。
   *
   * ## 为什么需要它
   *
   * `GET /api/catalog` 早就在读 `settings.default_ai_model_id` 并把它交给
   * 前端（`catalog.defaultAiModelId`），那段注释写着它存在的理由：
   *
   *   原来是"列表第一个"，而列表按 id 排 —— 于是一个**余额不足或已失效**的模型
   *   只要 id 最小，就会成为每个新机器人的默认，每次创建都要手动改回来。
   *   **这里让操作员能指定。**
   *
   * **但没有任何地方写这个设置** —— 它读得到、用得上、改不了，
   * 于是"取不到就回落到第一个"那半句成了唯一会发生的行为，而操作员每次创建
   * 新机器人仍然要手动改回来。这个端点补上缺的那一头。
   */
  app.post('/api/ai-models/:id/set-default', authed, async (request, reply) => {
    const id = idOf(request);
    if (!aiModels.get(id)) return reply.code(404).send({ error: '找不到该模型' });
    settings.set('default_ai_model_id', String(id));
    return { ok: true, defaultAiModelId: id };
  });

  /* --- Strategies -------------------------------------------------------- */

  /*
   * 策略列表**排除 AI 托管模式用的那类策略**。
   *
   * ## 为什么
   *
   * AI 托管**不是一个策略** —— 策略是"一组固定参数"，而 AI 模式的意思是"没有固定参数"。
   * 它在创建机器人时作为一个**模式**被选中，而不是从策略列表里挑。
   *
   * 让它出现在这里有两个具体后果：
   *   1. 任何既有机器人都能选中它，包括那些本该按固定参数跑的；
   *   2. 它看上去像一个"可以编辑的策略"，而那个外壳是假的 ——
   *      用户改完，AI 下一轮就覆盖；或者用户的修改被静默忽略。
   *
   * ## ⚠️ 这是权宜之计，不是最终形态
   *
   * 真正干净的做法是让 `traders.strategy_id` 可空，使 AI 机器人**根本不需要**一个策略。
   * **那需要重建 traders 表，而它被 8 张表用 ON DELETE CASCADE 引用** ——
   * `DROP TABLE traders` 会连带删掉全部交易历史。那件事必须单独做、带备份、
   * 并且在能守在现场的时候做。**不能顺手做。**
   *
   * 在那之前，用这条过滤保证"它不出现在用户能选策略的任何地方"。
   */
  app.get('/api/strategies', authed, async () =>
    strategies.list().filter((s) => s.presetId !== AI_MANAGED_PRESET),
  );

  app.get('/api/strategies/:id', authed, async (request, reply) => {
    const strategy = strategies.get(idOf(request));
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
    const id = idOf(request);
    const parsed = StrategyPatchSchema.safeParse(body);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid strategy');

    const patch: Parameters<typeof strategies.update>[1] = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.config !== undefined) patch.config = parsed.data.config;

    strategies.update(id, patch);
    const updated = strategies.get(id);
    if (!updated) return reply.code(404).send({ error: '找不到该策略' });

    if (parsed.data.config !== undefined) {
      for (const trader of traders.list()) {
        if (
          trader.mode === 'strategy' &&
          trader.strategyId === id &&
          deps.manager.isRunning?.(trader.id)
        ) {
          deps.manager.applyLiveUpdate?.(trader.id, {
            config: updated.config,
            note: `策略「${updated.name}」参数已在线热更新 —— 下一轮决策立即生效，不影响当前持仓与挂单。`,
          });
        }
      }
    }

    return updated;
  }));

  app.delete('/api/strategies/:id', authed, guard(async (_body: unknown, request, reply) => {
    const id = idOf(request);
    const inUse = strategies.usageCount(id);
    if (inUse > 0) {
      return reply.code(409).send({ error: `该策略正被 ${inUse} 个机器人使用。` });
    }
    strategies.remove(id);
    return { ok: true };
  }));

}
