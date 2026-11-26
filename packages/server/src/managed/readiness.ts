/**
 * M4.1 / M4.2 智能托管 2.0 长周期健康与子账号实盘就绪评估器（`packages/server/src/managed/readiness.ts`）
 *
 * 职责：
 *   1. 纯函数评估 `evaluateManagedReadiness()`：根据最近周期、成交、持仓与配置事实，
 *      输出客观可验证的 6 项上线门禁检查（周期稳定性、Prompt 3 万字红线、大盈亏比松绑、
 *      持仓裸奔/论点保护、期望收益与子账号安全红线）；
 *   2. 严格执行主账号保护红线：若某机器人误绑标签含 `主账号` 的实盘账户，直接标为红灯阻断警示；
 *   3. SQLite 只读汇总 `evaluateTraderManagedReadiness(traderId)`：供 `GET /api/traders/:id/managed-intel`
 *      与运维巡检直接消费，零副作用。
 */

import { getDb } from '../db/index.js';

/* -------------------------------------------------------------------------- */
/*  Public Types                                                               */
/* -------------------------------------------------------------------------- */

export type ReadinessLevel = 'pass' | 'warn' | 'fail';

export interface ReadinessCheckItem {
  id: string;
  label: string;
  status: ReadinessLevel;
  detail: string;
}

export interface ManagedReadinessMetrics {
  windowHours: number;
  totalCycles: number;
  successfulCycles: number;
  cycleSuccessRatePct: number;
  maxPromptChars: number;
  avgCacheHitPct: number;
  watchOrHoldRatioPct: number;
  closedTrades: number;
  wins: number;
  winRatePct: number;
  profitFactor: number | null;
  rewardRiskRatio: number | null;
  totalNetPnl: number;
  totalFees: number;
  totalFunding: number;
  thesisTriggerCount: number;
  unprotectedOpenCount: number;
  drawdownGuardEnabled: boolean;
}

export interface ManagedReadinessReport {
  overall: ReadinessLevel;
  summary: string;
  metrics: ManagedReadinessMetrics;
  checks: ReadinessCheckItem[];
  updatedAt: string;
}

export interface ReadinessEvalInput {
  windowHours: number;
  dryRun: boolean;
  exchangeAccountLabel: string | null;
  exchangeIsTestnet: boolean;
  drawdownGuardEnabled: boolean;
  cycles: ReadonlyArray<{
    success: boolean;
    promptChars: number;
    promptTokens: number;
    cachedTokens: number;
    watchOrHoldOnly: boolean;
  }>;
  trades: ReadonlyArray<{
    netPnl: number;
    fee: number;
    fundingFee: number;
    closeReason: string | null;
  }>;
  unprotectedOpenCount: number;
  nowIso?: string;
}

/* -------------------------------------------------------------------------- */
/*  Pure Evaluator                                                             */
/* -------------------------------------------------------------------------- */

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 识别受保护的主账户名称，防止测试/实验误触主实盘资金。 */
export function isProtectedMainAccountLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  return /主账号|主账户|main[\s_-]*account/i.test(label.trim());
}

export function evaluateManagedReadiness(input: ReadinessEvalInput): ManagedReadinessReport {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const totalCycles = input.cycles.length;
  const successfulCycles = input.cycles.filter((c) => c.success).length;
  const cycleSuccessRatePct = totalCycles > 0 ? round1((successfulCycles / totalCycles) * 100) : 100;
  const maxPromptChars = input.cycles.reduce((m, c) => Math.max(m, c.promptChars), 0);
  const sumPromptTokens = input.cycles.reduce((s, c) => s + Math.max(0, c.promptTokens), 0);
  const sumCachedTokens = input.cycles.reduce((s, c) => s + Math.max(0, c.cachedTokens), 0);
  const avgCacheHitPct = sumPromptTokens > 0 ? round1((sumCachedTokens / sumPromptTokens) * 100) : 0;
  const watchOrHoldCount = input.cycles.filter((c) => c.watchOrHoldOnly).length;
  const watchOrHoldRatioPct = totalCycles > 0 ? round1((watchOrHoldCount / totalCycles) * 100) : 0;

  const closedTrades = input.trades.length;
  const wins = input.trades.filter((t) => t.netPnl > 0).length;
  const losses = closedTrades - wins;
  const winRatePct = closedTrades > 0 ? round1((wins / closedTrades) * 100) : 0;
  const grossWin = input.trades.filter((t) => t.netPnl > 0).reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = input.trades.filter((t) => t.netPnl <= 0).reduce((s, t) => s + Math.abs(t.netPnl), 0);
  const avgWin = wins > 0 ? grossWin / wins : 0;
  const avgLoss = losses > 0 ? grossLoss / losses : 0;
  const profitFactor = grossLoss > 0 ? round2(grossWin / grossLoss) : grossWin > 0 ? 99 : null;
  const rewardRiskRatio = avgLoss > 0 ? round2(avgWin / avgLoss) : null;
  const totalNetPnl = round2(input.trades.reduce((s, t) => s + t.netPnl, 0));
  const totalFees = round2(input.trades.reduce((s, t) => s + t.fee, 0));
  const totalFunding = round2(input.trades.reduce((s, t) => s + t.fundingFee, 0));
  const thesisTriggerCount = input.trades.filter(
    (t) => t.closeReason === 'thesis_time_stop' || t.closeReason === 'thesis_mae_stop',
  ).length;

  const checks: ReadinessCheckItem[] = [];

  // 1) 决策稳定性
  checks.push({
    id: 'cycle_stability',
    label: '决策稳定性',
    status: totalCycles === 0 ? 'warn' : cycleSuccessRatePct >= 95 ? 'pass' : cycleSuccessRatePct >= 85 ? 'warn' : 'fail',
    detail:
      totalCycles === 0
        ? '窗口内暂无决策周期记录'
        : `${successfulCycles}/${totalCycles} 轮成功（${cycleSuccessRatePct}%），缓存命中 ${avgCacheHitPct}%`,
  });

  // 2) Prompt 3 万字红线
  checks.push({
    id: 'prompt_budget',
    label: '上下文红线',
    status: maxPromptChars <= 30_000 ? 'pass' : 'fail',
    detail: `峰值 ${maxPromptChars.toLocaleString()} 字（红线 ≤ 30,000）`,
  });

  // 3) 大盈亏比松绑（禁止早期回撤守卫砍死赢家）
  checks.push({
    id: 'drawdown_guard_off',
    label: '波段松绑',
    status: input.drawdownGuardEnabled ? 'warn' : 'pass',
    detail: input.drawdownGuardEnabled
      ? '检测到早期回撤守卫仍开启，易过早截断波段赢家，建议关闭'
      : '已关闭早期机械回撤守卫，由移动止损 + 论点硬线护航',
  });

  // 4) 持仓保护完整度
  checks.push({
    id: 'position_protection',
    label: '保护完整度',
    status: input.unprotectedOpenCount === 0 ? 'pass' : 'fail',
    detail:
      input.unprotectedOpenCount === 0
        ? '全部活跃持仓均有有效止损保护'
        : `发现 ${input.unprotectedOpenCount} 个缺少止损保护的仓位`,
  });

  // 5) 净期望与滑点后表现
  const expStatus: ReadinessLevel =
    closedTrades < 5
      ? 'warn'
      : totalNetPnl > 0 && (profitFactor === null || profitFactor >= 1.2)
        ? 'pass'
        : totalNetPnl >= 0
          ? 'warn'
          : 'fail';
  checks.push({
    id: 'net_expectancy',
    label: '净期望表现',
    status: expStatus,
    detail:
      closedTrades === 0
        ? '窗口内暂无已平仓成交'
        : `${closedTrades} 笔成交（胜率 ${winRatePct}% · PF ${profitFactor ?? '—'} · 净 ${totalNetPnl >= 0 ? '+' : ''}${totalNetPnl.toFixed(2)}U）`,
  });

  // 6) 实盘子账号安全红线
  const hitsMainAccount = !input.dryRun && !input.exchangeIsTestnet && isProtectedMainAccountLabel(input.exchangeAccountLabel);
  checks.push({
    id: 'subaccount_safety',
    label: '账号安全红线',
    status: hitsMainAccount ? 'fail' : 'pass',
    detail: hitsMainAccount
      ? `危险：当前绑定主账号「${input.exchangeAccountLabel}」，禁止用于实验或测试`
      : input.dryRun
        ? '模拟盘隔离运行（零真实资金风险）'
        : input.exchangeIsTestnet
          ? `测试网隔离运行（${input.exchangeAccountLabel ?? 'Testnet'}）`
          : `实盘子账号运行（${input.exchangeAccountLabel ?? 'Sub-account'}）`,
  });

  const hasFail = checks.some((c) => c.status === 'fail');
  const hasWarn = checks.some((c) => c.status === 'warn');
  const overall: ReadinessLevel = hasFail ? 'fail' : hasWarn ? 'warn' : 'pass';
  const passCount = checks.filter((c) => c.status === 'pass').length;
  const summary = hasFail
    ? `存在阻塞项（${passCount}/${checks.length} 项通过），需先修复后再放量实盘`
    : hasWarn
      ? `核心链路健康（${passCount}/${checks.length} 项通过），继续积累样本观察`
      : `全部 ${checks.length}/${checks.length} 项门禁通过，具备子账号小额实盘条件`;

  return {
    overall,
    summary,
    metrics: {
      windowHours: input.windowHours,
      totalCycles,
      successfulCycles,
      cycleSuccessRatePct,
      maxPromptChars,
      avgCacheHitPct,
      watchOrHoldRatioPct,
      closedTrades,
      wins,
      winRatePct,
      profitFactor,
      rewardRiskRatio,
      totalNetPnl,
      totalFees,
      totalFunding,
      thesisTriggerCount,
      unprotectedOpenCount: input.unprotectedOpenCount,
      drawdownGuardEnabled: input.drawdownGuardEnabled,
    },
    checks,
    updatedAt: nowIso,
  };
}

/* -------------------------------------------------------------------------- */
/*  SQLite Read-Only Loader                                                    */
/* -------------------------------------------------------------------------- */

interface TraderMetaRow {
  dry_run: number;
  exchange_account_id: number | null;
  agent_config_json: string | null;
}

interface ExchangeMetaRow {
  label: string;
  testnet: number;
}

interface DecisionWindowRow {
  success: number;
  prompt_chars: number;
  prompt_tokens: number | null;
  cached_tokens: number | null;
  decisions_json: string | null;
}

interface TradeWindowRow {
  net_pnl: number | null;
  pnl: number | null;
  fee: number | null;
  entry_fee: number | null;
  funding_fee: number | null;
  close_reason: string | null;
}

interface OpenPosRow {
  stop_loss: number | null;
  stop_order_id: string | null;
}

export function evaluateTraderManagedReadiness(
  traderId: number,
  windowHours = 72,
  nowMs = Date.now(),
): ManagedReadinessReport {
  const db = getDb();
  const sinceIso = new Date(nowMs - windowHours * 3600_000).toISOString();

  const trader = db.get<TraderMetaRow>(
    `SELECT dry_run, exchange_account_id, agent_config_json FROM traders WHERE id = ?`,
    traderId,
  );
  const dryRun = trader ? trader.dry_run !== 0 : true;
  let drawdownGuardEnabled = false;
  if (trader?.agent_config_json) {
    try {
      const cfg = JSON.parse(trader.agent_config_json) as {
        drawdownGuard?: { enabled?: boolean };
      };
      drawdownGuardEnabled = cfg.drawdownGuard?.enabled === true;
    } catch {
      /* ignore */
    }
  }

  let exchangeAccountLabel: string | null = null;
  let exchangeIsTestnet = false;
  if (trader?.exchange_account_id) {
    const acc = db.get<ExchangeMetaRow>(
      `SELECT label, testnet FROM exchange_accounts WHERE id = ?`,
      trader.exchange_account_id,
    );
    if (acc) {
      exchangeAccountLabel = acc.label;
      exchangeIsTestnet = acc.testnet !== 0;
    }
  }

  const decRows = db.all<DecisionWindowRow>(
    `SELECT success, length(coalesce(user_prompt, '')) as prompt_chars,
            prompt_tokens, cached_tokens, decisions_json
     FROM decision_records
     WHERE trader_id = ? AND timestamp >= ?
     ORDER BY id DESC
     LIMIT 300`,
    traderId,
    sinceIso,
  );

  const cycles = decRows.map((d) => {
    let watchOrHoldOnly = true;
    try {
      const arr = JSON.parse(d.decisions_json || '[]') as Array<{ action?: string }>;
      watchOrHoldOnly = !arr.some((a) => a.action && !['wait', 'hold', 'skip'].includes(a.action));
    } catch {
      watchOrHoldOnly = true;
    }
    return {
      success: d.success === 1,
      promptChars: d.prompt_chars ?? 0,
      promptTokens: d.prompt_tokens ?? 0,
      cachedTokens: d.cached_tokens ?? 0,
      watchOrHoldOnly,
    };
  });

  const tradeRows = db.all<
    TradeWindowRow & { symbol?: string | null; opened_at?: string | null }
  >(
    `SELECT symbol, opened_at, net_pnl, pnl, fee, entry_fee, funding_fee, close_reason
     FROM trades
     WHERE trader_id = ? AND closed_at >= ?
     ORDER BY id DESC
     LIMIT 300`,
    traderId,
    sinceIso,
  );

  /*
   * BUG-4 修复：
   *   1. `trades.fee` 落库时已等于 `entryFee + exitFee`（见 repositories.ts），绝不再累加 `entry_fee`；
   *   2. 按独立持仓回合（`symbol::opened_at`）聚合分批减仓拆分行，避免把 19 笔独立回合拆成 31 行虚抬胜率、压低盈亏比。
   */
  const grouped = new Map<
    string,
    { netPnl: number; fee: number; fundingFee: number; closeReason: string | null }
  >();
  tradeRows.forEach((t, idx) => {
    const key =
      t.symbol && t.opened_at ? `${t.symbol}::${t.opened_at}` : `row::${idx}`;
    const netPnl = t.net_pnl ?? t.pnl ?? 0;
    const fee = t.fee ?? 0;
    const fundingFee = t.funding_fee ?? 0;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        netPnl,
        fee,
        fundingFee,
        closeReason: t.close_reason,
      });
    } else {
      existing.netPnl += netPnl;
      existing.fee += fee;
      existing.fundingFee += fundingFee;
      if (
        (!existing.closeReason || existing.closeReason === 'manual_partial') &&
        t.close_reason &&
        t.close_reason !== 'manual_partial'
      ) {
        existing.closeReason = t.close_reason;
      }
    }
  });
  const trades = [...grouped.values()];

  const openPositions = db.all<OpenPosRow>(
    `SELECT stop_loss, stop_order_id FROM positions WHERE trader_id = ? AND status = 'open'`,
    traderId,
  );
  const unprotectedOpenCount = openPositions.filter(
    (p) => (p.stop_loss === null || !Number.isFinite(p.stop_loss)) && !p.stop_order_id,
  ).length;

  return evaluateManagedReadiness({
    windowHours,
    dryRun,
    exchangeAccountLabel,
    exchangeIsTestnet,
    drawdownGuardEnabled,
    cycles,
    trades,
    unprotectedOpenCount,
    nowIso: new Date(nowMs).toISOString(),
  });
}
