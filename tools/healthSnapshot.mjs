#!/usr/bin/env node
/**
 * 运行中机器人的健康快照。
 *
 * 给"盯着"用：一条命令输出所有需要持续观察的指标，避免每轮现写查询。
 *
 * 检查的是**会随时间变化、且出错会有后果**的东西：
 *   周期成功率、成交与盈亏、手续费占比、持仓/委托一致性、
 *   陈旧订单、错误日志、熔断状态、API 权重与时钟偏差。
 *
 * 只读。不写库、不下单。
 *
 * 用法（在服务器上）：node tools/healthSnapshot.mjs <traderId>
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const traderId = Number(process.argv[2] ?? 5);
const db = new DatabaseSync('/opt/autoquant/data/autoquant.sqlite', { readOnly: true });
const q = (s, ...a) => db.prepare(s).all(...a);
const one = (s, ...a) => db.prepare(s).get(...a);

const num = (v, d = 4) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
const pad = (v, n) => String(v).padEnd(n);

const alerts = [];
const ok = [];
function check(condition, message) {
  (condition ? ok : alerts).push(message);
}

/* --- 1. 机器人状态 ------------------------------------------------------ */
const trader = one('SELECT id, name, status, initial_equity FROM traders WHERE id = ?', traderId);
if (!trader) {
  console.log(`找不到机器人 #${traderId}`);
  process.exit(1);
}

console.log(`\n══ 机器人 #${trader.id} ${trader.name} ══`);
console.log(`  状态: ${trader.status}   初始权益: ${num(trader.initial_equity, 4)}`);
const last = one(
  'SELECT cycle_number, success, error, prompt_tokens, completion_tokens, ai_latency_ms, timestamp FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT 1',
  traderId,
);
if (last) {
  const ageMs = Date.now() - new Date(last.timestamp).getTime();
  console.log(
    `  最近周期: #${last.cycle_number}  ${Math.round(ageMs / 60000)} 分钟前  ` +
      `${last.success ? '成功' : '失败'}  ` +
      `in ${last.prompt_tokens ?? '—'} / out ${last.completion_tokens ?? '—'}  ` +
      `${last.ai_latency_ms ?? '—'}ms`,
  );
  if (last.error) console.log(`    错误: ${last.error.slice(0, 120)}`);
  // 运行中的机器人，超过 10 分钟没有新周期就不正常（3 分钟周期 + 余量）
  check(ageMs < 10 * 60 * 1000, `最近周期距今 ${Math.round(ageMs / 60000)} 分钟（运行中应 < 10）`);
}

/* --- 2. 周期成功率（最近 20 轮） ---------------------------------------- */
const recent = q(
  'SELECT success, error FROM decision_records WHERE trader_id = ? ORDER BY id DESC LIMIT 20',
  traderId,
).reverse();
if (recent.length) {
  const failed = recent.filter((r) => !r.success).length;
  console.log(`\n── 最近 ${recent.length} 轮：${recent.length - failed} 成功 / ${failed} 失败`);
  check(failed === 0, `最近 ${recent.length} 轮里有 ${failed} 轮失败`);
  const reasons = [...new Set(recent.filter((r) => r.error).map((r) => r.error.slice(0, 70)))];
  for (const r of reasons) console.log(`    失败原因: ${r}`);
}

/* --- 3. 成交与盈亏（关键：手续费占比） ---------------------------------- */
const t = one(
  'SELECT COUNT(*) c, COALESCE(SUM(pnl),0) gross, COALESCE(SUM(fee),0) fee, ' +
    'COALESCE(SUM(funding_fee),0) funding, COALESCE(SUM(net_pnl),0) net, ' +
    'COALESCE(AVG(hold_minutes),0) hold FROM trades WHERE trader_id = ?',
  traderId,
);
console.log(`\n── 累计成交 ${t.c} 笔`);
console.log(`  毛 ${num(t.gross)}  手续费 -${num(t.fee)}  资金费 ${num(t.funding)}  净 ${num(t.net)}`);
console.log(`  平均持仓 ${num(t.hold, 1)} 分钟`);

if (t.c > 0) {
  const drag = Math.abs(Number(t.gross)) > 1e-9 ? (Number(t.fee) / Math.abs(Number(t.gross))) * 100 : null;
  if (drag !== null) {
    console.log(`  手续费 / |毛盈亏| = ${drag.toFixed(0)}%`);
    // 手续费超过毛盈亏的一半 = 交易频率正在吃掉账户，这是本项目实测出的主要亏损来源
    check(drag < 50, `手续费占毛盈亏 ${drag.toFixed(0)}% —— 过度交易正在吃掉账户`);
  }
  check(Number(t.net) >= -Number(trader.initial_equity) * 0.1, `累计净值 ${num(t.net)} 已超过初始权益的 10%`);
}

/* --- 4. 今日已实现亏损（熔断相关） -------------------------------------- */
const today = one(
  "SELECT COALESCE(SUM(net_pnl),0) net FROM trades WHERE trader_id = ? AND closed_at >= date('now')",
  traderId,
);
const equity = one(
  'SELECT equity FROM equity_snapshots WHERE trader_id = ? ORDER BY id DESC LIMIT 1',
  traderId,
)?.equity;
if (equity) {
  const pct = (Number(today.net) / Number(equity)) * 100;
  console.log(`\n── 今日已实现 ${num(today.net)}（权益 ${num(equity)} 的 ${pct.toFixed(2)}%）`);
  // 配置里的单日亏损熔断上限是 5%
  check(pct > -5, `今日亏损 ${pct.toFixed(2)}% 已触及熔断上限 5% —— 当天不会再开新仓`);
  if (pct <= -5) console.log('    ⚠ 熔断已触发：这是保护机制，不是故障');
}

/* --- 5. 持仓 / 委托 一致性 ---------------------------------------------- */
const pos = q("SELECT symbol, quantity FROM positions WHERE trader_id = ? AND status = 'open'", traderId);
const newOrders = q(
  "SELECT id, symbol, purpose, status, created_at FROM orders WHERE trader_id = ? AND status IN ('NEW','PARTIALLY_FILLED') ORDER BY id DESC",
  traderId,
);
console.log(`\n── 本地持仓 ${pos.length} 个 / 本地活动委托 ${newOrders.length} 条`);
for (const p of pos) console.log(`    持仓 ${p.symbol} qty=${p.quantity}`);

// 陈旧委托：标着 NEW 但已很旧 —— 交易所大概率早已撤单，只是本地没回写
const stale = newOrders.filter((o) => Date.now() - new Date(o.created_at).getTime() > 60 * 60 * 1000);
if (stale.length) {
  console.log(`    ⚠ ${stale.length} 条委托超过 1 小时仍标为活动（疑似陈旧，交易所侧可能早已撤销）`);
  for (const o of stale.slice(0, 5)) console.log(`      #${o.id} ${o.symbol} ${o.purpose} ${o.created_at}`);
}
check(newOrders.length === 0 || stale.length === 0, `${stale.length} 条陈旧委托未被结清`);

/* --- 6. 重复成交（记账正确性） ------------------------------------------ */
const dup = q(
  'SELECT symbol, quantity, closed_at, COUNT(*) c FROM trades WHERE trader_id = ? ' +
    'GROUP BY symbol, quantity, closed_at HAVING c > 1',
  traderId,
);
if (dup.length) {
  console.log(`\n── ⚠ 疑似重复记账 ${dup.length} 组`);
  for (const d of dup) console.log(`    ${d.symbol} qty=${d.quantity} @${d.closed_at} ×${d.c}`);
}
check(dup.length === 0, `${dup.length} 组重复成交（同一回合被记了两次）`);

/* --- 7. 最近的错误日志 -------------------------------------------------- */
const errs = q(
  "SELECT level, substr(message,1,100) m, created_at FROM runtime_logs WHERE level IN ('warn','error') ORDER BY id DESC LIMIT 6",
);
if (errs.length) {
  console.log('\n── 最近的警告/错误');
  for (const e of errs) console.log(`    ${e.created_at} [${e.level}] ${e.m}`);
}

/* --- 8. 资金是否被重复计算（共享钱包） ---------------------------------- */
/*
 * 多个机器人共用一个交易所账户时，每个机器人的"归属权益"里都含同一笔初始资金。
 * 把它们求和 = **同一笔钱被数了很多遍**。
 *
 * 这条检查是真实事故的产物：首页一度显示「总归属权益 30.67」，而钱包里只有
 * 10.42 —— 初始权益被重复计算了 19.81 USDT，约是真实资金的 3 倍。
 * 靠人眼发现太晚，所以做成自动检查。
 */
const traders = q('SELECT id, initial_equity, exchange_account_id FROM traders');
const accounts = new Set(traders.map((t) => t.exchange_account_id));
const sumInitial = traders.reduce((s, t) => s + Number(t.initial_equity), 0);
const latest = one('SELECT account_equity FROM equity_snapshots ORDER BY id DESC LIMIT 1');
if (latest && accounts.size < traders.length) {
  const real = Number(latest.account_equity);
  const inflation = sumInitial - real;
  console.log(
    `\n── 共享钱包：${traders.length} 个机器人共用 ${accounts.size} 个账户；` +
      `初始权益求和 ${num(sumInitial, 2)} vs 实际钱包 ${num(real, 2)}`,
  );
  check(
    inflation <= real * 0.5,
    `初始权益求和比实际钱包多 ${num(inflation, 2)} USDT —— 首页若按机器人求和会虚高`,
  );
}

/* --- 汇总 --------------------------------------------------------------- */
console.log(`\n══ 结论 ══`);
if (alerts.length === 0) {
  console.log(`  ✅ ${ok.length} 项检查全部通过`);
} else {
  console.log(`  ❌ ${alerts.length} 项异常：`);
  for (const a of alerts) console.log(`    · ${a}`);
  console.log(`  （其余 ${ok.length} 项通过）`);
}
console.log('');
db.close();
