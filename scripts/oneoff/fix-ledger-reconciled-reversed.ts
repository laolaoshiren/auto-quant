/**
 * **#10 历史账本校正** —— 最终版（默认 dry-run，--apply 才写）
 *
 * ## 校正范围：**只改那 38 笔的「已实现盈亏」**
 *
 * 三角对照证明残差有三个独立来源，而**只有第一个是这次要修的**：
 * ```
 *   分项        交易所      账本        差
 *   已实现盈亏  -3.4324    9.9679    +13.4003   ← 【本次修这个】
 *   手续费      -3.9422   -4.7250     -0.7828   ← 另一个问题，不混进来
 *   资金费       0.1213   -0.1174     -0.2387   ← 另一个问题，不混进来
 * ```
 * 把 38 笔的毛盈亏换成"按成交 id 精确认领"的值后：
 * ```
 *   账本毛 9.9679 → -3.6150  vs 交易所 -3.4324   ⇒ 毛残差 -0.1826（已经很准）
 * ```
 *
 * ⚠️ **为什么只改毛盈亏、不动 fee**：
 * 手续费差 0.78 与资金费差 0.24 是**全账户口径**的问题（可能涉及全部 192 笔），
 * 把它们混进"修 38 笔"会让改动范围不可控、也无法回滚干净。
 * **一次只改一件事** —— 这是改真钱数据的基本纪律。
 *
 * ## 修法
 *
 * 订单号精确匹配（38/38）→ 用整个回合的 `fillIds` 去 income 认领已实现盈亏，
 * **全局 `claimed` 集合去重**（穿零翻转时同一笔流水只算一次）。
 *
 * 实测（`NEARUSDT`）：19 条 REALIZED_PNL 与 33 笔成交，**19/19 的 tradeId 能对上**。
 *
 * ## 安全
 * ```
 *   ① 默认 dry-run
 *   ② --apply 前备份整库
 *   ③ 只 UPDATE 那 38 行（WHERE close_reason='reconciled_reversed'）
 *   ④ 只改 pnl / net_pnl / pnl_percent 三列（fee/funding 不动）
 *   ⑤ 改完回读校验
 * ```
 */
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { initDb, getDb } from '../../packages/server/src/db/index.js';
import { exchanges } from '../../packages/server/src/store/repositories.js';
import { Vault } from '../../packages/server/src/crypto/vault.js';
import { reconstructRoundTrips } from '../../packages/server/src/trader/roundTrips.js';
import { realizedInFills } from '../../packages/server/src/binance/income.js';

const APPLY = process.argv.includes('--apply');
/*
 * ⚠️ **站点专属值一律从环境变量取**（仓库约定 §4.4：不把主机、路径、凭据写进代码）。
 * 用法：
 * ` 
 *   AQ_DB=<数据目录>/autoquant.sqlite `n *   AQ_MASTER_KEY_FILE=<数据目录>/.master.key `n *   AQ_ACCOUNT_ID=3 `n *   node tsx fix-ledger-reconciled-reversed.ts [--apply] 
 * ` 
 */
const DB = process.env['AQ_DB'] ?? 'data/autoquant.sqlite';
const MASTER_KEY_FILE = process.env['AQ_MASTER_KEY_FILE'] ?? '.master.key';
const ACCOUNT_ID = Number(process.env['AQ_ACCOUNT_ID'] ?? '3');
const L = (s: string): void => process.stdout.write(s + '\n');

initDb(DB);
const vault = new Vault(Buffer.from(readFileSync(MASTER_KEY_FILE, 'utf8').trim(), 'hex'));
const acc = exchanges.getWithSecret(ACCOUNT_ID) as unknown as Record<string, unknown>;
const apiKey = String(acc['api_key']);
const secret = vault.decrypt(String(acc['api_secret_enc']));

async function signed<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: '10000' }).toString();
  const sig = createHmac('sha256', secret).update(qs).digest('hex');
  const res = await fetch(`https://fapi.binance.com${path}?${qs}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t) as T;
}

interface Row {
  id: number; symbol: string; entry_order_id: string | null; exit_order_id: string | null;
  opened_at: string; pnl: number; fee: number; funding_fee: number; net_pnl: number;
  pnl_percent: number; leverage: number; quantity: number; entry_price: number;
}

L('  ══════════════════════════════════════════════════════════════════');
L(`   #10 账本校正（只改 38 笔的已实现盈亏）  ${APPLY ? '⚠️ APPLY' : 'DRY-RUN'}`);
L('  ══════════════════════════════════════════════════════════════════');

const rows = getDb().all<Row>(
  "SELECT * FROM trades WHERE trader_id = 10 AND close_reason = 'reconciled_reversed' ORDER BY id",
);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const symbols = [...new Set(rows.map((r) => r.symbol))];

/* 拉数据。 */
const allIncome: Array<Record<string, unknown>> = [];
{
  let start = new Date(rows[0]!.opened_at).getTime() - 86_400_000;
  const end = Date.now();
  while (start < end) {
    const b = await signed<Array<Record<string, unknown>>>('/fapi/v1/income', {
      startTime: String(start), endTime: String(Math.min(start + 7 * 86_400_000, end)), limit: '1000',
    });
    allIncome.push(...b);
    start += 7 * 86_400_000;
  }
}
const incomeEvents = allIncome.map((e) => ({
  incomeType: String(e['incomeType']), income: String(e['income']),
  tradeId: String(e['tradeId'] ?? ''), time: Number(e['time']),
}));

const tradesBySymbol = new Map<string, Array<Record<string, unknown>>>();
for (const sym of symbols) {
  const collected: Array<Record<string, unknown>> = [];
  let start = new Date(rows[0]!.opened_at).getTime() - 86_400_000;
  const end = Date.now();
  while (start < end) {
    const b = await signed<Array<Record<string, unknown>>>('/fapi/v1/userTrades', {
      symbol: sym, startTime: String(start), endTime: String(Math.min(start + 7 * 86_400_000, end)), limit: '1000',
    });
    collected.push(...b);
    start += 7 * 86_400_000;
  }
  const seen = new Set<number>();
  tradesBySymbol.set(sym, collected.filter((f) => {
    const id = Number(f['id']);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }));
}
L(`  income ${allIncome.length} 条 · userTrades ${[...tradesBySymbol.values()].reduce((a, b) => a + b.length, 0)} 笔`);

/* 订单号索引。 */
interface Trip { fillIds: string[]; entryOrderId: string; exitOrderId: string; entryPrice: number; quantity: number }
const byOrder = new Map<string, Trip>();
for (const [sym, fills] of tradesBySymbol) {
  const trips = reconstructRoundTrips(
    fills.map((f) => ({
      id: Number(f['id']), orderId: Number(f['orderId']), symbol: String(f['symbol']),
      side: String(f['side']) as 'BUY' | 'SELL', price: String(f['price']), qty: String(f['qty']),
      realizedPnl: String(f['realizedPnl'] ?? '0'), commission: String(f['commission'] ?? '0'),
      commissionAsset: String(f['commissionAsset'] ?? 'USDT'), time: Number(f['time']),
    })) as never,
  );
  for (const t of trips) {
    const trip: Trip = {
      fillIds: t.fillIds, entryOrderId: t.entryOrderId, exitOrderId: t.exitOrderId,
      entryPrice: t.entryPrice, quantity: t.quantity,
    };
    if (trip.entryOrderId) byOrder.set(`${sym}|${trip.entryOrderId}`, trip);
    if (trip.exitOrderId) byOrder.set(`${sym}|${trip.exitOrderId}`, trip);
  }
}

/* 逐笔算新值。 */
const claimed = new Set<string>();
interface Fix { row: Row; newGross: number; newNet: number; newPercent: number; trip: Trip }
const fixes: Fix[] = [];
const skipped: number[] = [];

for (const row of rows) {
  const trip =
    (row.exit_order_id ? byOrder.get(`${row.symbol}|${row.exit_order_id}`) : undefined) ??
    (row.entry_order_id ? byOrder.get(`${row.symbol}|${row.entry_order_id}`) : undefined);
  if (!trip) { skipped.push(row.id); continue; }
  const newGross = realizedInFills(incomeEvents as never, trip.fillIds, claimed);
  /* ⚠️ fee / funding 不动（那是另一个问题）。 */
  const newNet = newGross - row.fee - row.funding_fee;
  const margin = trip.entryPrice > 0 && trip.quantity > 0
    ? Math.abs(trip.entryPrice * trip.quantity) / Math.max(1, row.leverage)
    : 0;
  fixes.push({
    row, newGross, newNet, trip,
    newPercent: margin > 0 ? (newNet / margin) * 100 : row.pnl_percent,
  });
}

L('');
L('  ── 逐笔 ──');
for (const f of fixes) {
  const d = f.newNet - f.row.net_pnl;
  L(`  #${String(f.row.id).padEnd(5)} ${f.row.symbol.padEnd(12)} 毛 ${f.row.pnl.toFixed(4).padStart(9)} → ${f.newGross.toFixed(4).padStart(9)}   净 ${f.row.net_pnl.toFixed(4).padStart(9)} → ${f.newNet.toFixed(4).padStart(9)}  Δ ${(d >= 0 ? '+' : '') + d.toFixed(4)}`);
}

const wasTotal = sum(rows.map((r) => r.net_pnl));
const newTotal = sum(fixes.map((f) => f.newNet));
const bookNet = getDb().get<{ net: number }>('SELECT ROUND(SUM(net_pnl),4) net FROM trades WHERE trader_id = 10')!.net;
const projected = bookNet - wasTotal + newTotal;
const exchangeNet = -7.253234;

L('');
L(`  可校正 ${fixes.length} 笔 · 跳过 ${skipped.length} 笔${skipped.length ? `（#${skipped.join(', #')}）` : ''}`);
L(`  这 38 笔合计 ${wasTotal.toFixed(4)} → ${newTotal.toFixed(4)}`);
L('');
L('  ══ 收敛性 ══');
L(`     账本净（当前）   ${bookNet.toFixed(4)}`);
L(`     校正后（预期）   ${projected.toFixed(4)}`);
L(`     交易所净额       ${exchangeNet.toFixed(4)}`);
L(`     残差             ${(projected - exchangeNet).toFixed(4)}   （校正前 ${(bookNet - exchangeNet).toFixed(4)}）`);
L('');
L(`  ⚠️ 剩余残差 ${(projected - exchangeNet).toFixed(4)} 来自【手续费与资金费口径】（本次不动）：`);
L('       手续费差 -0.7828 · 资金费差 -0.2387 —— 那是另一个独立问题。');

if (!APPLY) {
  L('');
  L('  DRY-RUN 结束 —— 没有写任何数据。要真改请加 --apply');
  process.exit(0);
}

/* 备份 + 应用。 */
const backupDir = process.env['AQ_BACKUP_DIR'] ?? 'data/backups';
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = `${backupDir}/autoquant-before-ledger-fix-${stamp}.sqlite`;
copyFileSync(DB, backup);
L('');
L(`  ✅ 已备份 → ${backup}`);

const db = getDb();
for (const f of fixes) {
  db.run(
    `UPDATE trades SET pnl = ?, net_pnl = ?, pnl_percent = ?
      WHERE id = ? AND trader_id = 10 AND close_reason = 'reconciled_reversed'`,
    f.newGross, f.newNet, f.newPercent, f.row.id,
  );
}
L(`  ✅ 已更新 ${fixes.length} 行（只改 pnl / net_pnl / pnl_percent）`);

const after = getDb().get<{ n: number; gross: number; fee: number; funding: number; net: number }>(
  'SELECT COUNT(*) n, ROUND(SUM(pnl),4) gross, ROUND(SUM(fee),4) fee, ROUND(SUM(funding_fee),4) funding, ROUND(SUM(net_pnl),4) net FROM trades WHERE trader_id = 10',
)!;
L('');
L('  ══ 回读校验 ══');
L(`     账本 ${after.n} 笔 · 毛 ${after.gross} · 费 ${after.fee} · 资金费 ${after.funding} · 净 ${after.net}`);
L(`     交易所净额 ${exchangeNet.toFixed(4)}  ⇒ 残差 ${(after.net - exchangeNet).toFixed(4)}`);
L('');
L(`  回滚：cp ${backup} ${DB} && systemctl restart autoquant`);
