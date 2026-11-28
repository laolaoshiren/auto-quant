import {
  ExchangeIdSchema,
  ManagedRiskProfileSchema,
  StrategyConfigSchema,
  TimeframeSchema,
} from '@aq/shared';
import { z } from 'zod';
import { env } from '../env.js';
import { checkOutboundUrl, parseHostAllowlist } from '../llm/urlGuard.js';

/* -------------------------------------------------------------------------- */
/*  Request schemas                                                            */
/* -------------------------------------------------------------------------- */

export const CredentialsSchema = z.object({
  username: z.string().min(1).max(64),
  /*
   * ⚠️ 登录的密码**不设最小长度**（2026-11-10 用户要求本地用 `admin/admin`）。
   *
   * 原来这里是 `.min(6)` —— 它挡住的不是攻击者（攻击者会直接发 6 位以上的猜测），
   * 而是**用户自己已经设过的短密码**：登录接口只负责"拿输入去比对哈希"，
   * 长度校验属于"设置密码"那条路（注册/改密码另有强度要求）。
   * 长度限制留在登录侧只会让一个合法密码返回 400「Bad Request」，
   * 用户看到的是"登录按钮没反应/格式错误"，与真实原因无关。
   */
  password: z.string().min(1).max(256),
});

/**
 * 修改账户凭据的请求体。
 *
 * 加 zod 不是为了拦攻击，而是为了拦住**类型错误**：`currentPassword` 传数字时，
 * 旧代码会把它一路送到 `scryptSync`，抛出的 `TypeError` 变成 HTTP 500。
 * 校验发生在任何写操作之前，所以这里没有绕过风险 —— 但 500 会让一个纯粹的
 * 客户端错误看起来像服务端故障，还会把内部栈信息回显出去。
 */
export const UpdateAccountSchema = z.object({
  currentPassword: z.string().describe('当前密码').min(1, '请填写当前密码。').max(256),
  username: z.string().max(64).optional(),
  newPassword: z.string().max(256).optional(),
});

/**
 * 自定义模型端点地址。
 *
 * 在这里（而不是只在真正发请求的地方）校验，是为了给操作员一条明确的 400，
 * 而不是把危险地址先存进数据库、等到交易循环才以一条看不懂的超时报错。
 * 真正的兜底在 `LlmClient` 构造函数里 —— 那里覆盖所有出站路径，
 * 包括本次改动之前就已经存进库里的旧地址。
 */
export const BaseUrlValueSchema = z.string().superRefine((value, ctx) => {
  if (!value) return;
  /*
   * ⚠️ **这里必须也传操作员的内网白名单（2026-10-11）。**
   *
   * 这是**保存模型时的校验**，也就是用户看到「baseUrl 不被允许：私有地址 172.16.0.0/12」
   * 的那一处。只改 `client.ts`/`discovery.ts` 的话，保存这一步照样拒绝 ——
   * 于是"允许内网端点"这个开关**在用户真正会碰到的那道门上不起作用**。
   *
   * 教训：一个开关接了几处、漏了一处，等于没接 —— 因为用户只会撞上漏的那一处。
   */
  const verdict = checkOutboundUrl(value, parseHostAllowlist(env.allowPrivateLlmHosts));
  if (!verdict.allowed) {
    ctx.addIssue({ code: 'custom', message: `baseUrl 不被允许：${verdict.reason}` });
  }
});
export const BaseUrlSchema = BaseUrlValueSchema.default('');

export const ExchangeAccountInputSchema = z.object({
  /* 交易所目录由共享的 `ExchangeIdSchema` 定义（binance/gate）—— 新增交易所只改 shared 一处。 */
  exchange: ExchangeIdSchema.default('binance'),
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
export const AiModelInputSchema = z.object({
  provider: z.string().min(1),
  label: z.string().min(1).max(80),
  model: z.string().min(1),
  baseUrl: BaseUrlSchema,
  apiKey: z.string().default(''),
  /*
   * ⚠️ **`temperature` / `maxTokens` / `timeoutSeconds` / `maxRetries`
   * 曾经在这里，已删除。**
   *
   * 它们现在**只由 `providerDefaults()` 决定**，不接受客户端传入 ——
   * 控制台上那个「高级设置」面板也已经删掉。
   *
   * 删掉而不是"保留但忽略"，是因为**保留一个不会生效的入参**会让人以为
   * 它有用（比如某个脚本按旧契约传 `maxTokens: 8192`，然后困惑为什么
   * 实际用的是 16384）。**契约要跟行为一致。**
   *
   * 具体风险见 `POST /api/ai-models` 里那段说明：一个被手工调低的
   * `maxTokens` 会把决策截断成空响应，而那看起来像密钥坏了。
   */
});

/**
 * 「获取可用模型」的请求体。
 *
 * `modelId` 存在的理由是一个**功能缺陷**：编辑已有模型时，界面刻意把 API Key 输入框
 * 留空（提示写着"留空则保留已存储的密钥"），而旧契约只有 `apiKey`，服务端拿到空串
 * 就只能回一句"请先填写 API Key" —— 于是**任何一个已保存的模型都获取不到模型列表**，
 * 哪怕界面上方的密钥标签正显示着"当前已存储"。`modelId` 就是"用那条记录里已存的密钥"
 * 这个意图的唯一表达方式。
 *
 * 可选而不是必填：新建模型时还没有 id；`apiKey` 非空时（用户正在输入替换密钥）
 * 也应当优先用用户刚输入的那把。
 */
export const DiscoverModelsInputSchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().default(''),
  baseUrl: BaseUrlSchema,
  modelId: z.number().int().positive().optional(),
});

/**
 * Schema for probing an unsaved model.
 *
 * Deliberately does **not** require `label`: the probe saves nothing, and making
 * a display name mandatory to answer "does this key work?" is friction with no
 * purpose. Only the fields that actually determine whether the call can succeed
 * are required.
 */
export const DraftModelInputSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  baseUrl: BaseUrlSchema,
  apiKey: z.string().default(''),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(2_000_000).optional(),
  timeoutSeconds: z.number().int().min(5).max(3600).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
});

export const StrategyCheckInputSchema = z.object({
  aiModelId: z.number().int().positive(),
  /** Restrict the universe to one symbol for a fast, focused check. */
  symbol: z.string().max(24).optional(),
  /** 可选指定体检使用的交易所行情（默认 binance；传 gate 时走 Gate 公共行情与合约表）。 */
  exchange: z.enum(['binance', 'gate']).optional(),
});

export const StrategyInputSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  presetId: z.string().nullable().default(null),
  config: StrategyConfigSchema,
});

/**
 * AI 托管模式的标记。
 *
 * 它**不是一个策略预设** —— 保留这个常量是为了让既有数据能被识别：
 * 早期版本把 AI 托管做成过策略预设，于是数据库里留下了 `preset_id='ai_managed'`
 * 的策略行。那行必须从策略列表里排除，否则它会出现在用户选策略的地方。
 *
 * 与 `packages/shared/src/strategy.ts` 的注释一致：AI 托管是**机器人自己的模式**
 * （`traders.mode`），不是策略的一种 —— 策略是"一组固定参数"，
 * 而 AI 模式的意思是"没有固定参数"。
 */
export const AI_MANAGED_PRESET = 'ai_managed';

export const TraderInputSchema = z.object({
  name: z.string().min(1).max(80),
  /**
   * 绑定的交易所账户。
   *
   * **可以省略 / 传 `null`** —— 那是纯模拟盘机器人（用户 2026-10-27 需求）：
   * 它不下真实订单、余额由本地台账折算，所以不需要任何真实账户。
   *
   * ⚠️ 省略与 `null` 在这里是**同一个意思**（都是"没有账户"），因为创建时
   * 没有"保持原值"这个语义（那是 PATCH 才有的事）。但实盘启动时服务端会
   * 明确拒绝没有账户的机器人 —— 见 `manager.connectionFor`。
   */
  exchangeAccountId: z.number().int().positive().nullable().optional(),
  /**
   * 固定策略模式必填；智能托管 / AI 团队统一走系统 magpie 网关，可省略。
   */
  aiModelId: z.number().int().positive().optional(),
  /**
   * 引用的策略 —— **AI 托管模式不需要它，传 `null`（或省略）**。
   *
   * 参数整份在 `traders.agent_config_json` 里（由 AI 自己写），策略对它不生效。
   * 三种取值都有意义，所以是 `nullable().optional()`：
   *   · 一个正数 → 固定策略模式引用它；
   *   · `null`   → 明确表示"不引用任何策略"（AI 托管）；
   *   · 省略     → `PATCH` 时不改动这个字段。
   *
   * 模式与它是否匹配由下面的端点校验 —— 那一层才知道 `mode`。
   */
  strategyId: z.number().int().positive().nullable().optional(),
  cycleIntervalMinutes: z.number().int().min(1).max(1440).default(15),
  /**
   * Starting equity, used as the baseline for the return percentage.
   *
   * Optional on purpose. When omitted or zero the server reads the **real**
   * wallet balance from the configured exchange, because a hand-typed number can
   * silently disagree with the account and make every return figure wrong.
   */
  initialEquity: z.number().min(0).optional(),
  /**
   * **模拟盘起始余额**（用户 2026-10-27 需求）。
   *
   * 用户原话：「模拟盘不应该根据真实钱包的余额，而应该可以自定义模拟盘的余额」。
   *
   * 省略 / 0 = 不指定：服务端回落到 `initialEquity`，再回落到 1000。
   * 只有模拟盘会读它；实盘忽略（它读交易所）。
   *
   * ⚠️ 与 `initialEquity` 分开传：后者是"收益率的分母"且会被真实余额覆盖，
   * 而这个是模拟账户的本金、永不被覆盖。混成一个字段会出现"我填了 5000，
   * 启动后变成 12.34"这种没人能解释的现象。
   */
  paperStartingBalance: z.number().min(0).optional(),
  /**
   * **运行模式：模拟盘 / 实盘 —— 创建时固定**（2026-11-10 用户要求）。
   *
   * 用户原话：「应该是由创建机器人的时候决定固定，而不是运行启动机器人的时候来决定」。
   *
   * · `true`（默认）→ 模拟盘：订单只在本地撮合，余额由本地台账折算；
   * · `false` → 实盘：真实资金下单，必须绑定真实交易所账户（否则创建会被拒）。
   *
   * 创建之后**不可修改**（PATCH 会拒绝）；`POST /start` 也不再接受这个选择。
   */
  dryRun: z.boolean().optional(),
  /**
   * 运行模式。
   *
   * `'ai_managed'` 表示由 **AI 智能体托管**：参数由它自己设定并持续调整，
   * 存在 `agent_config_json`（按机器人隔离），**策略参数被忽略**。
   *
   * `'ai_team'` 表示由 **AI 团队托管**（2026-10-12 新增的多智能体模式）：
   * 7×24 事件驱动、多个角色分工协作、辩论与裁决。**与 `ai_managed` 是两套独立的
   * 代码路径** —— 用户明确要求「不要影响我现在实盘跑的机器人」。
   *
   * 两种 AI 模式都**不引用策略**（参数由 AI 自己管），所以下面的校验对它们同等生效。
   *
   * 默认 `'strategy'`，所以既有调用点（前端与脚本）行为完全不变。
   */
  mode: z.enum(['strategy', 'ai_managed', 'ai_team']).default('strategy'),
  /**
   * 智能托管 2.0 风险护栏档位（`conservative` / `balanced` / `aggressive`）。
   * 仅对 `mode === 'ai_managed'` 生效，默认 `'balanced'`；支持运行中热切换。
   */
  managedRiskProfile: ManagedRiskProfileSchema.optional(),
});

/*
 * Zod v4 中 `schema.partial()` 仍会对省略字段执行 `.default()`。
 * PATCH 请求需要「省略 = 不改」，因此剥离默认值后再 `.partial()`，避免静默覆盖既有字段。
 */
export const ExchangeAccountPatchSchema = ExchangeAccountInputSchema.extend({
  exchange: ExchangeAccountInputSchema.shape.exchange.unwrap(),
  testnet: ExchangeAccountInputSchema.shape.testnet.unwrap(),
  canTrade: ExchangeAccountInputSchema.shape.canTrade.unwrap(),
}).partial();

export const AiModelPatchSchema = AiModelInputSchema.extend({
  baseUrl: BaseUrlValueSchema,
  apiKey: AiModelInputSchema.shape.apiKey.unwrap(),
}).partial();

export const StrategyPatchSchema = StrategyInputSchema.extend({
  description: StrategyInputSchema.shape.description.unwrap(),
  presetId: StrategyInputSchema.shape.presetId.unwrap(),
}).partial();

export const TraderPatchSchema = TraderInputSchema.extend({
  cycleIntervalMinutes: TraderInputSchema.shape.cycleIntervalMinutes.unwrap(),
  mode: TraderInputSchema.shape.mode.unwrap(),
}).partial();

