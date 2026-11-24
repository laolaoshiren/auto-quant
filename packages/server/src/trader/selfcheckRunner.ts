/**
 * **自检的执行层** —— 从库里取证据、把发现写回去。
 *
 * ## 与 `selfcheck.ts` 的分工
 *
 * | 文件 | 职责 | 有 IO 吗 |
 * |---|---|---|
 * | `selfcheck.ts` | **判断逻辑**（数问题、解析模型输出）| ❌ 纯函数 |
 * | `selfcheckRunner.ts`（本文件）| 读库、写库 | ✅ |
 *
 * 分开的理由：判断逻辑是**最该被测的部分**（漏报/误报都在那里），
 * 而纯函数测起来便宜。混进 IO 之后，那些测试就得造一整套数据库夹具。
 *
 * ## 为什么第一版**只做确定性层**
 *
 * 用户要的是"AI 自检"，但确定性层必须先落地，因为它**不依赖模型**：
 * 模型额度耗尽、网关挂掉的时候，恰恰是最需要自检的时候 ——
 * 如果自检也要模型，那它在那时**正好失效**。
 *
 * AI 层（把线索连起来）建在这一层之上，见 `runSelfCheck` 的 `ask` 参数。
 */

import { decisions, positions, runtimeLogs, traders } from '../store/repositories.js';
/*
 * ⚠️ 智能体那三张表在 `agentStore.js`，**不在** `repositories.js` ——
 * 它们有自己的生命周期（写入时按上限裁剪），所以单独一个模块。
 */
import { agentExperiments, agentRuns } from '../store/agentStore.js';
import {
  findDeterministicProblems,
  renderEvidenceForModel,
  parseAiFindings,
  type DeterministicFinding,
  type SelfCheckEvidence,
} from './selfcheck.js';

/** 自检在 `runtime_logs` 里用的 scope（界面按它过滤、开发侧按它检索）。 */
export const SELFCHECK_SCOPE = 'selfcheck';

/** 默认统计窗口。6 小时覆盖了"一个夜班"—— 无人值守最容易出问题的时段。 */
export const DEFAULT_WINDOW_HOURS = 6;

/**
 * 从数据库收集证据。
 *
 * ⚠️ **读失败不抛错**：自检本身不该成为新的故障源。
 * 某一项读不到时用"空/0"代替，并在结果里体现（例如 `failedCycles` 为空）。
 * 代价是"读失败"与"确实没有"看起来一样 —— 但那是可接受的：
 * 自检的输出是**给人看的提示**，不是**要执行的动作**。
 */
export function collectEvidenceFromDb(traderId: number, windowHours = DEFAULT_WINDOW_HOURS): SelfCheckEvidence {
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  /* ── 交易员本身（周期、连续失败计数）── */
  const trader = traders.get(traderId);
  const cycleIntervalMinutes = trader?.cycleIntervalMinutes ?? 15;
  const consecutiveFailures = trader?.consecutiveFailures ?? 0;

  /* ── 决策记录：失败轮次 + 距上次成功 ── */
  const failedCycles: SelfCheckEvidence['failedCycles'] = [];
  let minutesSinceLastSuccess: number | null = null;
  try {
    /* 取一批最近记录：既要找窗口内的失败，也要找"最后一次成功"（可能在窗口之外）。 */
    const recent = decisions.list(traderId, 200);
    for (const r of recent) {
      if (r.timestamp >= since && !r.success) {
        failedCycles.push({
          cycleNumber: r.cycleNumber,
          error: (r.error ?? '（没有错误信息）').slice(0, 200),
          at: r.timestamp,
        });
      }
      if (minutesSinceLastSuccess === null && r.success) {
        const ms = Date.now() - new Date(r.timestamp).getTime();
        if (Number.isFinite(ms)) minutesSinceLastSuccess = ms / 60_000;
      }
    }
  } catch {
    /* 用默认值 */
  }

  /* ── 日志：按 scope 归类（不逐条报，否则自检变成噪音源）── */
  const errorLogsByScope: SelfCheckEvidence['errorLogsByScope'] = [];
  const warnLogsByScope: SelfCheckEvidence['warnLogsByScope'] = [];
  try {
    const logs = runtimeLogs.list(500).filter((l) => l.traderId === traderId || l.traderId === null);
    const errMap = new Map<string, { count: number; sample: string }>();
    const warnMap = new Map<string, { count: number; sample: string }>();
    for (const l of logs) {
      /* 自检自己的日志不算问题来源 —— 否则它会报自己。 */
      if (l.scope === SELFCHECK_SCOPE) continue;
      const target = l.level === 'error' ? errMap : l.level === 'warn' ? warnMap : null;
      if (target === null) continue;
      const cur = target.get(l.scope);
      if (cur === undefined) {
        target.set(l.scope, { count: 1, sample: l.message.slice(0, 160) });
      } else {
        cur.count += 1;
      }
    }
    for (const [scope, v] of errMap) errorLogsByScope.push({ scope, ...v });
    for (const [scope, v] of warnMap) warnLogsByScope.push({ scope, ...v });
    /* 多的排前面 —— 界面第一眼要看到最吵的那个来源。 */
    errorLogsByScope.sort((a, b) => b.count - a.count);
    warnLogsByScope.sort((a, b) => b.count - a.count);
  } catch {
    /* 用空数组 */
  }

  /* ── 智能体运行与实验（ai_managed 2.0 已停用旧 1.0 参数实验，不再误报未结算）── */
  let pendingExperiments = 0;
  let totalRuns = 0;
  try {
    if (trader?.mode !== 'ai_managed') {
      pendingExperiments = agentExperiments.pending(traderId).length;
    }
    totalRuns = agentRuns.countSince(traderId, '1970-01-01T00:00:00Z');
  } catch {
    /* 用 0 */
  }

  /* ── 持仓保护（裸奔检查）── */
  let openPositions = 0;
  const nakedPositions: SelfCheckEvidence['nakedPositions'] = [];
  try {
    const rows = positions.open(traderId);
    openPositions = rows.length;
    for (const p of rows) {
      /*
       * 判据：**止损价与止损单都没有**才算裸奔。
       *
       * 只有其一也算"有保护"：
       *   · 有止损价、没挂单 → 本地会在下一轮补挂（`ensureStopsOnOpenPositions`）；
       *   · 有挂单、没止损价 → 交易所侧真的挡着，那是有效保护。
       *
       * 反过来说：**两个都没有**时，交易所侧与本地都拦不住 —— 那才是裸奔。
       */
      const hasStopPrice = p.stop_loss !== null && Number.isFinite(p.stop_loss);
      const hasStopOrder = p.stop_order_id !== null && String(p.stop_order_id).length > 0;
      if (!hasStopPrice && !hasStopOrder) {
        nakedPositions.push({ symbol: p.symbol, side: p.side, quantity: p.quantity });
      }
    }
  } catch {
    /*
     * 读不到持仓时**不报裸奔** —— 宁可漏报也不要误报。
     * 误报会让操作员开始忽略自检，那比漏一项更糟（见 `selfcheck.ts` 的说明）。
     */
  }

  return {
    windowHours,
    status: trader?.status ?? 'unknown',
    failedCycles,
    errorLogsByScope,
    warnLogsByScope,
    consecutiveFailures,
    minutesSinceLastSuccess,
    cycleIntervalMinutes,
    pendingExperiments,
    totalRuns,
    openPositions,
    nakedPositions,
  };
}

/** 把发现写进 `runtime_logs`（**留痕**）。 */
export function persistFindings(
  traderId: number,
  findings: readonly DeterministicFinding[],
  source: 'deterministic' | 'ai',
): void {
  for (const f of findings) {
    /*
     * 严重度映射到日志级别 —— 于是界面上的日志过滤**直接可用**，
     * 不需要为自检单独做一套 UI（用户要"看得见"，而日志页已经在了）。
     */
    const level = f.severity === 'critical' ? 'error' : f.severity === 'warning' ? 'warn' : 'info';
    runtimeLogs.write(
      traderId,
      level,
      SELFCHECK_SCOPE,
      `[自检/${source}] ${f.title}｜${f.detail}｜下一步：${f.nextStep}`,
    );
  }
}

/** 一次自检的结果。 */
export interface SelfCheckResult {
  evidence: SelfCheckEvidence;
  /** 确定性发现（不依赖模型）。 */
  deterministic: DeterministicFinding[];
  /** AI 的发现（没跑 AI 层时为空）。 */
  ai: Array<{ severity: string; title: string; detail: string; nextStep: string }>;
  /** AI 的原始输出（解析失败时仍保留 —— 用户要"快速定位"）。 */
  aiRaw: string | null;
}

/**
 * 跑一次自检。
 *
 * @param ask 可选的"问模型"函数。**不传就只跑确定性层** —— 这让自检
 *            在模型不可用时仍然有效（见文件头说明）。
 */
export async function runSelfCheck(
  traderId: number,
  options: { windowHours?: number; ask?: (prompt: string) => Promise<string> } = {},
): Promise<SelfCheckResult> {
  const evidence = collectEvidenceFromDb(traderId, options.windowHours ?? DEFAULT_WINDOW_HOURS);
  const deterministic = findDeterministicProblems(evidence);
  persistFindings(traderId, deterministic, 'deterministic');

  let ai: SelfCheckResult['ai'] = [];
  let aiRaw: string | null = null;

  if (options.ask !== undefined) {
    try {
      const text = await options.ask(
        renderEvidenceForModel(evidence) +
          '\n\n请找出**这份证据里值得警惕的东西**，特别是需要把几条线索连起来才能看出的问题' +
          '（例如"降级频繁 + 延迟升高 → 首选额度可能耗尽"）。\n' +
          '每行一条，格式严格如下（没有发现就只输出一行 `[info] 未发现异常 :: 证据充分 :: 无需处理`）：\n' +
          '`[critical|warning|info] 一句话标题 :: 具体证据 :: 下一步查什么`\n' +
          '⚠️ 只依据上面的证据，**不要猜测证据里没有的东西**。',
      );
      const parsed = parseAiFindings(text);
      ai = parsed.findings;
      aiRaw = parsed.raw;
      if (parsed.findings.length > 0) {
        persistFindings(
          traderId,
          parsed.findings.map((f) => ({ ...f, severity: f.severity })),
          'ai',
        );
      } else {
        /*
         * 解析失败也要留痕 —— 否则"AI 层跑了但没解析出来"与"AI 层没跑"
         * 长得一模一样（本项目反复踩的那类失败）。
         */
        runtimeLogs.write(
          traderId,
          'warn',
          SELFCHECK_SCOPE,
          `[自检/ai] 模型输出未能解析成结构化发现（原文已保留）：${aiRaw.slice(0, 300)}`,
        );
      }
    } catch (error) {
      runtimeLogs.write(
        traderId,
        'warn',
        SELFCHECK_SCOPE,
        `[自检/ai] AI 层调用失败（确定性层的结果仍然有效）：${(error as Error).message.slice(0, 200)}`,
      );
    }
  }

  return { evidence, deterministic, ai, aiRaw };
}
