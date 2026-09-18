/**
 * 智能体的工具面。
 *
 * ## 这份文件的两件事
 *
 * 1. **告诉模型它有什么工具**（`AGENT_TOOLS`）—— 名字、说明、参数。
 *    说明是写给模型看的，所以写"什么时候用它"，而不是"它返回什么字段"。
 * 2. **执行它要求的调用**（`dispatchTool`）—— 而这是危险的一半。
 *
 * ## 为什么参数校验必须自己做
 *
 * 模型的工具调用是**和参数补丁同一类东西：不可信输入**。
 * 它可能是坏 JSON、可能少给必填参数、可能给一个字符串当数量、
 * 可能给一个负的 limit。**直接用 `args.limit` 去查数据库就是拿模型的输出当代码用。**
 *
 * 所以每个工具声明自己的参数形状，`dispatchTool` 先校验再执行。
 * 不引入 zod 之外的东西 —— 这里的形状太简单，一个几十行的校验器比再拉一个库合适
 * （§4.3：默认答案是"自己写那 30 行"）。
 *
 * ## 工具为什么必须是"窄"的
 *
 * 每个工具只暴露**一个明确的查询**，而不是"给我一段 SQL"或"给我任意字段"。
 * 工具面就是模型的手：**手能伸多远，决定了它出错时能造成多大后果**。
 * 目前所有工具要么只读，要么只能收紧（`pause_trading`），只有 `set_params` 会
 * 改变系统状态，而它过守卫层（`patch.ts`）。
 */

import type { StrategyConfig } from '@aq/shared';

import { applyAgentPatch, type AgentPatchResult } from './patch.js';

/* -------------------------------------------------------------------------- */
/*  参数声明                                                                   */
/* -------------------------------------------------------------------------- */

type ArgType = 'string' | 'number' | 'boolean' | 'object';

interface ArgSpec {
  type: ArgType;
  required?: boolean;
  min?: number;
  max?: number;
  /** 只在这些值里取值。 */
  enum?: readonly string[];
  /** 缺省值（`type: 'number'` 时用于分页上限那种场景）。 */
  default?: unknown;
  describe: string;
}

interface ToolSpec {
  name: string;
  /** 写给模型看的：**什么时候用它**，而不是它返回什么。 */
  describe: string;
  args: Record<string, ArgSpec>;
}

/* -------------------------------------------------------------------------- */
/*  工具清单                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 九个工具。**改动这里之前先读文件头**：工具面就是模型的手。
 *
 * 命名与说明都用英文 —— 与 `StrategyConfig` 的字段名、`action` 枚举一样，
 * 它们是**机器契约**（§5.2）。喂给模型的内容本身用中文。
 */
export const AGENT_TOOLS: readonly ToolSpec[] = [
  {
    name: 'get_performance',
    describe:
      'Read the realised trading performance over a window. Use this first when you need to know whether the account is winning or losing, and why.',
    args: {
      window: {
        type: 'string',
        enum: ['24h', '7d', '30d', 'all'],
        default: '24h',
        describe: 'How far back to look.',
      },
    },
  },
  {
    name: 'get_equity_curve',
    describe:
      'Read the equity trajectory. Use this to judge drawdowns and recoveries — a single PnL number cannot tell you whether the account is bleeding steadily or just had one bad trade.',
    args: {
      limit: { type: 'number', min: 10, max: 300, default: 60, describe: 'How many recent snapshots.' },
    },
  },
  {
    name: 'get_experiments',
    describe:
      'Read your OWN past parameter changes together with what actually happened afterwards. This is the only place where you can see whether a change you made helped. Read it before changing anything.',
    args: {
      limit: { type: 'number', min: 1, max: 30, default: 10, describe: 'How many past experiments.' },
    },
  },
  {
    name: 'get_recent_decisions',
    describe:
      'Read what you decided in recent cycles, and what the risk engine rejected. A high rejection rate means your proposals do not match the parameters or the market.',
    args: {
      limit: { type: 'number', min: 1, max: 30, default: 10, describe: 'How many recent cycles.' },
    },
  },
  {
    name: 'get_market_overview',
    describe:
      'Read the current candidate universe and its volatility/volume profile. Use it to decide whether the pool itself is the problem (e.g. everything is chopping).',
    args: {
      limit: { type: 'number', min: 1, max: 30, default: 12, describe: 'How many candidate symbols.' },
    },
  },
  {
    name: 'get_current_params',
    describe:
      'Read the parameters currently in effect. Always read this before changing them — a patch is a delta, not a full replacement, and you need to know what you are changing FROM.',
    args: {},
  },
  {
    name: 'set_params',
    describe:
      'Change the parameters that govern YOUR OWN trading — including your own instructions. ' +
      'This is a DELTA: only the fields you include change. ' +
      'Adjustable: coin selection (coinSource.*), indicators (indicators.*), how much you risk ' +
      '(riskControl.*, throttle.*, circuitBreaker.*), AND YOUR OWN PROMPT ' +
      '(promptSections.roleDefinition / tradingFrequency / entryStandards / decisionProcess, and customPrompt). ' +
      'Your prompt is a parameter like any other: if it no longer fits the market, change it — ' +
      'a fixed prompt cannot be called intelligent. ' +
      'You MUST give a reason — an unexplained change cannot be reviewed later. ' +
      'Anything the structural guard overrides is reported back in clamps.',
    args: {
      patch: { type: 'object', required: true, describe: 'The fields to change.' },
      reason: {
        type: 'string',
        required: true,
        min: 1,
        max: 2000,
        describe: 'Why you are making this change. Written for a human reviewing it later.',
      },
    },
  },
  {
    name: 'set_cycle_interval',
    describe:
      'Change how often YOU wake up to make decisions, in minutes (1–1440). ' +
      'This is a first-class trading decision, not a setting: ' +
      'wake up often when the market is moving and you have room to act; ' +
      'wake up rarely when nothing is happening, when you are holding a position ' +
      'whose thesis needs time to play out, or when you keep deciding to do nothing ' +
      '(every cycle costs tokens and attention). ' +
      'The new value takes effect on your very next cycle — no restart needed. ' +
      'You MUST give a reason.',
    args: {
      minutes: {
        type: 'number',
        required: true,
        min: 1,
        max: 1440,
        describe: 'How many minutes between cycles.',
      },
      reason: {
        type: 'string',
        required: true,
        min: 1,
        max: 2000,
        describe: 'Why this frequency fits the current situation.',
      },
    },
  },
  {
    name: 'pause_trading',
    describe:
      'Stop opening new positions. Use it when the market or your own recent results say you should stand aside. This only ever TIGHTENS — there is no "resume" tool, because resuming is a decision the operator makes.',
    args: {
      reason: { type: 'string', required: true, min: 1, max: 2000, describe: 'Why you are standing aside.' },
    },
  },
  {
    name: 'finish',
    describe:
      'End this turn. Call it when you are done — do not keep calling tools to look busy. If you found nothing worth changing, say so; "no change" is a valid and often correct conclusion.',
    args: {
      summary: { type: 'string', required: true, min: 1, max: 2000, describe: 'What you concluded.' },
    },
  },
];

/* -------------------------------------------------------------------------- */
/*  参数校验                                                                   */
/* -------------------------------------------------------------------------- */

export interface ArgError {
  arg: string;
  why: string;
}

/**
 * 按声明校验参数。
 *
 * 返回 `errors` 非空时**不要执行工具** —— 把错误原样回喂给模型，
 * 它下一轮通常能自己改对。**不要静默用默认值兜底**：那会让模型以为
 * "我传了 limit=99999"生效了，而实际用了 30，于是它对结果的理解是错的。
 */
export function validateArgs(
  spec: ToolSpec,
  raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: ArgError[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ arg: '(root)', why: `参数必须是一个对象，收到 ${Array.isArray(raw) ? 'array' : typeof raw}` }] };
  }
  const input = raw as Record<string, unknown>;
  const errors: ArgError[] = [];
  const value: Record<string, unknown> = {};

  for (const [name, arg] of Object.entries(spec.args)) {
    const given = input[name];

    if (given === undefined || given === null) {
      if (arg.required) {
        errors.push({ arg: name, why: '必填参数缺失' });
      } else if (arg.default !== undefined) {
        value[name] = arg.default;
      }
      continue;
    }

    if (arg.type === 'number') {
      // 只接受真的数字。字符串数字要拒绝 —— 模型写 "10" 时它心里想的可能是别的东西，
      // 悄悄转成 10 会让一次参数错误变成一个看不见的行为差异。
      if (typeof given !== 'number' || !Number.isFinite(given)) {
        errors.push({ arg: name, why: `必须是有限数字，收到 ${JSON.stringify(given)}` });
        continue;
      }
      if (arg.min !== undefined && given < arg.min) {
        errors.push({ arg: name, why: `不得小于 ${arg.min}，收到 ${given}` });
        continue;
      }
      if (arg.max !== undefined && given > arg.max) {
        errors.push({ arg: name, why: `不得大于 ${arg.max}，收到 ${given}` });
        continue;
      }
      value[name] = given;
      continue;
    }

    if (typeof given !== arg.type) {
      errors.push({ arg: name, why: `必须是 ${arg.type}，收到 ${typeof given}` });
      continue;
    }

    if (arg.enum && !arg.enum.includes(given as string)) {
      errors.push({ arg: name, why: `只能是 ${arg.enum.join(' / ')} 之一，收到 ${JSON.stringify(given)}` });
      continue;
    }
    if (arg.type === 'string') {
      const s = given as string;
      if (arg.min !== undefined && s.length < arg.min) {
        errors.push({ arg: name, why: '不得为空' });
        continue;
      }
      if (arg.max !== undefined && s.length > arg.max) {
        errors.push({ arg: name, why: `不得超过 ${arg.max} 字，收到 ${s.length} 字` });
        continue;
      }
    }
    value[name] = given;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/* -------------------------------------------------------------------------- */
/*  分发                                                                       */
/* -------------------------------------------------------------------------- */

/** 分发需要的全部外部能力。做成注入，工具层就能在没有网络与数据库的情况下被测试。 */
export interface AgentToolDeps {
  /** 当前生效的配置（补丁的基准）。 */
  currentConfig: () => StrategyConfig;
  /** 写回一份新配置。由调用方决定怎么落库（策略表 / 机器人覆盖）。 */
  saveConfig: (config: StrategyConfig, context: { reason: string; patch: unknown; clamps: unknown }) => void;
  /** 读取工具的实现。返回**已经可以喂给模型**的结构化对象。 */
  read: {
    performance: (window: string) => unknown;
    equityCurve: (limit: number) => unknown;
    experiments: (limit: number) => unknown;
    recentDecisions: (limit: number) => unknown;
    marketOverview: (limit: number) => unknown;
  };
  /** 请求暂停交易（只收紧）。 */
  requestPause: (reason: string) => void;
  /**
   * 改变**自己的决策周期**（分钟）。
   *
   * 为什么单独一个能力、而不是塞进 `saveConfig`：
   * 决策周期不活在 `StrategyConfig` 里 —— 它是 `traders` 表上的一列
   * （因为调度器要在**配置之外**读它）。放在这里是让那件事**显式可见**，
   * 而不是让工具层去猜它属于哪张表。
   */
  /** 当前的决策周期（分钟）—— `get_current_params` 要把它一起给出。 */
  cycleInterval: () => number;
  setCycleInterval: (minutes: number, reason: string) => { minutes: number; clamped: boolean };
}

export interface ToolOutcome {
  /** 喂回给模型的内容。**必须可以用 JSON 序列化。** */
  result: unknown;
  /** `finish` 被调用时带上它的结论，循环据此结束。 */
  finished?: { summary: string };
  /** `set_params` 的守卫结果（含被钳制的项），调用方要落库。 */
  patch?: AgentPatchResult;
  /** `pause_trading` 被调用。 */
  paused?: { reason: string };
}

const MAX_JSON_CHARS = 6000;

/**
 * 把结果裁到模型读得下的长度。
 *
 * 工具不该把整张表倒进提示词。裁剪是**有损的**，所以一定要在结果里说明裁了，
 * 否则模型会以为自己看到了全部 —— 那比不给它数据更糟。
 */
function bound(result: unknown): unknown {
  const text = JSON.stringify(result);
  if (text.length <= MAX_JSON_CHARS) return result;
  return {
    truncated: true,
    note: `结果过长（${text.length} 字符）已截断，只看得到前 ${MAX_JSON_CHARS} 字符。需要更细的视图请缩小 limit。`,
    preview: text.slice(0, MAX_JSON_CHARS),
  };
}

/**
 * 执行一次工具调用。
 *
 * @param name 工具名。**不可信** —— 未知名字返回错误而不是抛异常：
 *             一次幻觉出来的工具名不该让整个循环崩掉。
 * @param args 参数。**不可信**，先过 `validateArgs`。
 */
export function dispatchTool(name: unknown, args: unknown, deps: AgentToolDeps): ToolOutcome {
  const spec = AGENT_TOOLS.find((t) => t.name === name);
  if (!spec) {
    return {
      result: {
        error: `没有名为 ${JSON.stringify(name)} 的工具。可用的工具：${AGENT_TOOLS.map((t) => t.name).join(' / ')}`,
      },
    };
  }

  const checked = validateArgs(spec, args ?? {});
  if (!checked.ok) {
    return {
      result: {
        error: '参数不合格，本次调用没有执行。',
        problems: checked.errors.map((e) => `${e.arg}: ${e.why}`),
      },
    };
  }
  const a = checked.value;

  switch (spec.name) {
    case 'get_performance':
      return { result: bound(deps.read.performance(a.window as string)) };
    case 'get_equity_curve':
      return { result: bound(deps.read.equityCurve(a.limit as number)) };
    case 'get_experiments':
      return { result: bound(deps.read.experiments(a.limit as number)) };
    case 'get_recent_decisions':
      return { result: bound(deps.read.recentDecisions(a.limit as number)) };
    case 'get_market_overview':
      return { result: bound(deps.read.marketOverview(a.limit as number)) };
    case 'get_current_params':
      /*
       * 「当前参数」**必须把决策周期一起给出来**。
       *
       * 它不在 `StrategyConfig` 里（是 `traders` 表上的一列），所以第一版
       * 这个工具读不到它 —— 于是 AI 想调频率时**不知道自己现在是多少**，
       * 只能瞎猜一个数。**不知道起点就没法判断该往哪边调。**
       */
      return { result: bound({ ...deps.currentConfig(), cycleIntervalMinutes: deps.cycleInterval() }) };
    case 'set_params': {
      const reason = a.reason as string;
      const patch = applyAgentPatch(deps.currentConfig(), a.patch);
      if (patch.rejected === null) {
        deps.saveConfig(patch.config, { reason, patch: a.patch, clamps: patch.clamps });
      }
      return {
        result: {
          applied: patch.rejected === null,
          rejected: patch.rejected,
          // 钳制必须回喂：AI 以为自己改成了、而实际被守卫改掉的话，
          // 下一轮它会基于一个错误前提继续推理。
          clamps: patch.clamps,
          note:
            patch.rejected === null
              ? patch.clamps.length > 0
                ? '补丁已生效，但有几项被结构性守卫改动（见 clamps）—— 请按 clamps 里的实际值理解现在的参数。'
                : '补丁已生效。'
              : '补丁被整体拒绝，一个字段都没改。',
        },
        patch,
      };
    }
    case 'set_cycle_interval': {
      const reason = a.reason as string;
      const requested = Number(a.minutes);
      const applied = deps.setCycleInterval(requested, reason);
      return {
        result: {
          minutes: applied.minutes,
          /*
           * 被钳制时**必须回喂实际值** —— 与 `set_params` 的 clamps 同一个理由：
           * AI 以为自己改成了 0.5 分钟、而实际是 1 的话，
           * 下一轮它会基于一个错误前提推理（"我刚提高了频率"）。
           */
          clamped: applied.clamped,
          note: applied.clamped
            ? `请求的 ${requested} 分钟超出允许范围（1–1440），实际设为 ${applied.minutes} 分钟。`
            : `决策周期已改为每 ${applied.minutes} 分钟一次，从下一轮起生效。`,
        },
      };
    }
    case 'pause_trading': {
      const reason = a.reason as string;
      deps.requestPause(reason);
      return {
        result: {
          paused: true,
          note: '已停止开新仓。恢复由操作员决定 —— 这条只能收紧，不能放宽。',
        },
        paused: { reason },
      };
    }
    case 'finish':
      return { result: { done: true }, finished: { summary: a.summary as string } };
    default:
      // 走到这里说明 AGENT_TOOLS 加了工具但忘了加分支 —— 类型上不可能，
      // 运行时也不该静默返回空结果。
      return { result: { error: `工具 ${spec.name} 已声明但没有实现` } };
  }
}

/** 把工具清单渲染成给模型看的说明。 */
export function renderToolCatalogue(): string {
  return AGENT_TOOLS.map((t) => {
    const args = Object.entries(t.args);
    const argText =
      args.length === 0
        ? '（无参数）'
        : args
            .map(([n, s]) => {
              const bits: string[] = [s.type];
              if (s.enum) bits.push(s.enum.join('|'));
              if (s.min !== undefined || s.max !== undefined) bits.push(`${s.min ?? ''}..${s.max ?? ''}`);
              if (s.required) bits.push('必填');
              return `  - ${n} (${bits.join(', ')})：${s.describe}`;
            })
            .join('\n');
    return `### ${t.name}\n${t.describe}\n${argText}`;
  }).join('\n\n');
}
