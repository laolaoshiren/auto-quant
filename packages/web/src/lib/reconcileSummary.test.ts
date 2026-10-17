/**
 * 对账 toast 的那句话**不许和后端日志相反**（2026-10-17 · t101）。
 *
 * ## 这个测试防的是什么
 *
 * 后端 `6a39c46` 把 `corrected` 从"尝试修正的次数"改成"**真的生效**的次数"，
 * 并新增 `correctedAttempted` / `correctedKept`（那两笔因为"重建腿边界存疑"被保留）。
 * 前端 `reconcileSummary()` 当时没跟上，于是同一个事件在两处被说成相反的话：
 *
 * ```
 *   后端（`manager.ts` 的 warn）「尝试修正 3 笔，一笔都没真的生效 —— 全部因"重建腿边界存疑"保留本地口径」
 *   前端（本函数，修复前）      「对账完成：账本与交易所一致，无需补录或修正。」   ← 说反话
 * ```
 *
 * 这不是显示问题：操作员读到的"一致"会让他以为差额已经清干净，
 * 而实际上那几笔下一轮还会撞上同一批。
 *
 * ## 为什么它必须待在仓库里
 *
 * 这 10 条判据原来只在 `.dsh/` 的一份验证脚本里跑（`t101`），**它不在 CI 里** ——
 * 下次谁再动这段文案，没有任何东西会红。这份文件就是那次搬运的落点。
 *
 * ## 判据的两条纪律（继承自那份脚本，写在这里免得后人重踩）
 *
 * 1. **盯那个断言本身，不要只搜「一致」两个字。** 修复后的正确输出里会出现
 *    「不判断账实是否一致」这句**诚实的话**；用裸「一致」当禁词会把正确输出判成失败。
 *    所以禁词是完整的 `CLAIM_CONSISTENT`。
 * 2. **入参形状 = HTTP 响应里真实的形状**（路由 `{ ok: true, ...result }` 透传，
 *    见 `api/server.ts` 的 `/reconcile`；字段来自 `manager.reconcileTrader`）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileSummary } from './actions';

/**
 * 「账本与交易所一致」这句断言**只在真的什么都没发生时**才允许出现。
 *
 * ⚠️ 必须整句匹配：见文件头第 1 条纪律 —— 裸「一致」会误伤
 * 「未收到"边界存疑保留"计数，不判断账实是否一致」。
 */
const CLAIM_CONSISTENT = '账本与交易所一致';

/** 一次对账返回的五个计数（`corrected` 是**生效**数，不是尝试数）。 */
interface Counts {
  recovered: number;
  corrected: number;
  correctedAttempted: number;
  correctedKept: number;
  funding: number;
}

function counts(over: Partial<Counts> = {}): Counts {
  return { recovered: 0, corrected: 0, correctedAttempted: 0, correctedKept: 0, funding: 0, ...over };
}

/* -------------------------------------------------------------------------- */
/*  六种组合：两次出现的数各说各的，零生效与全保留必须说清                         */
/* -------------------------------------------------------------------------- */

test('① 有生效（尝试 3 / 生效 2 / 保留 1）—— 两个数都要说，且不能说"一致"', () => {
  const got = reconcileSummary(counts({ corrected: 2, correctedAttempted: 3, correctedKept: 1 }));

  assert.ok(got.includes('修正 2 笔'), `要说出生效的那 2 笔：${got}`);
  assert.ok(got.includes('保留本地 1 笔'), `要说清还有 1 笔被保留（下一轮还会撞上）：${got}`);
  assert.ok(!got.includes(CLAIM_CONSISTENT), `还有被保留的笔数时不许说"一致"：${got}`);
});

test('★★★ ② 零生效但全保留（尝试 3 / 生效 0 / 保留 3）—— t95 报的那个回归', () => {
  /*
   * 这是本条守卫存在的**唯一理由**：修复前 `corrected === 0` 会直接掉进兜底句，
   * 把"判不出来、保持原样"读成"账实相符"。而 `correctedAttempted` 是 3 ——
   * 明明试过、只是没敢改，这绝不能读成"无需修正"。
   *
   * ⚠️ 负向校准：删掉 `actions.ts` 里 `if (result.corrected === 0 && kept > 0)`
   * 那一支，本用例立刻红（同时会红掉 ④）—— 与 t101 脚本的实测一致。
   */
  const got = reconcileSummary(counts({ correctedAttempted: 3, correctedKept: 3 }));

  assert.ok(got.includes('一笔都没生效'), `必须显式说"一笔都没生效"：${got}`);
  assert.ok(got.includes('尝试修正 3 笔'), `要说清试过 3 笔：${got}`);
  assert.ok(got.includes('保留本地 3 笔'), `要说清 3 笔都被保留：${got}`);
  assert.ok(!got.includes(CLAIM_CONSISTENT), `差异还在，绝不能说"一致"：${got}`);
  assert.ok(!got.includes('无需补录或修正'), `"无需修正"是同一句反话的另一半：${got}`);
});

test('③ 真的无需修正（四个数全 0）—— 这是唯一允许说"一致"的形状', () => {
  const got = reconcileSummary(counts());

  assert.ok(got.includes(CLAIM_CONSISTENT), `什么都没发生时这句话是对的：${got}`);
  assert.ok(got.includes('无需补录或修正'), `它该把结论说完：${got}`);
});

test('④ 补录 + 零生效保留（既有补录又有保留）', () => {
  /*
   * 边界：`recovered > 0` 走的是零生效那一支里的"顺带一句"，
   * 而不是把补录数丢进普通拼接 —— 否则"一笔都没生效"会被吃掉。
   */
  const got = reconcileSummary(counts({ recovered: 1, correctedAttempted: 2, correctedKept: 2 }));

  assert.ok(got.includes('补录 1 笔'), `补录数要说：${got}`);
  assert.ok(got.includes('一笔都没生效'), `零生效仍然必须说清：${got}`);
  assert.ok(got.includes('保留本地 2 笔'), `保留数要说：${got}`);
  assert.ok(!got.includes(CLAIM_CONSISTENT), `还有保留，不许说"一致"：${got}`);
});

test('⑤ 有生效 + 有保留 + 资金费 —— 三样都要出现（资金费是钱，不是计数）', () => {
  const got = reconcileSummary(
    counts({ recovered: 1, corrected: 1, correctedAttempted: 2, correctedKept: 1, funding: -0.5 }),
  );

  assert.ok(got.includes('补录 1 笔'), `补录数要说：${got}`);
  assert.ok(got.includes('修正 1 笔'), `生效数要说：${got}`);
  assert.ok(got.includes('保留本地 1 笔'), `保留数要说：${got}`);
  assert.ok(got.includes('资金费'), `资金费不是计数，只在非 0 时出现，但必须出现：${got}`);
  assert.ok(!got.includes(CLAIM_CONSISTENT), `有保留时不许说"一致"：${got}`);
});

test('⑥ 只有资金费（没有笔数）—— 也不等于"账本与交易所一致"', () => {
  /*
   * 资金费发生了 = 账目确实动过。兜底句的判据里含 `funding === 0`，
   * 这条把那个条件钉住：漏掉它就会把"只结算了资金费"说成"无需修正"。
   */
  const got = reconcileSummary(counts({ funding: -0.3 }));

  assert.ok(got.includes('资金费'), `资金费要说出来：${got}`);
  assert.ok(!got.includes(CLAIM_CONSISTENT), `账目动过就不许说"一致"：${got}`);
});

/* -------------------------------------------------------------------------- */
/*  全局不变量：只要有"保留 / 生效 / 补录"，就绝不许说「账本与交易所一致」           */
/* -------------------------------------------------------------------------- */

/*
 * 三条都刻意用**极端数字**（9 笔、1 笔、5 笔）：组合用例里用的是 1~3，
 * 这里换一组值，防止"判据只在某个量级上成立"。
 */
test('★★★ 不变量：保留 9 笔时不许说"一致"', () => {
  const got = reconcileSummary(counts({ correctedAttempted: 9, correctedKept: 9 }));
  assert.ok(!got.includes(CLAIM_CONSISTENT), `实得「${got}」`);
});

test('★★★ 不变量：生效 1 笔时不许说"一致"', () => {
  const got = reconcileSummary(counts({ corrected: 1, correctedAttempted: 1 }));
  assert.ok(!got.includes(CLAIM_CONSISTENT), `实得「${got}」`);
});

test('★★★ 不变量：补录 5 笔时不许说"一致"', () => {
  const got = reconcileSummary(counts({ recovered: 5 }));
  assert.ok(!got.includes(CLAIM_CONSISTENT), `实得「${got}」`);
});

/* -------------------------------------------------------------------------- */
/*  漏传新字段（旧形状调用）也不许说「一致」                                      */
/* -------------------------------------------------------------------------- */

test('★★★ 漏传 correctedKept/correctedAttempted 时不许替它断言"一致"', () => {
  /*
   * ⚠️ 这段刻意用 `as never` 绕过类型：类型上这两个字段是必填，
   * 但**运行期漏传是真实存在的** —— t95 那份最小复现脚本写的就是
   * `{ recovered, corrected, funding }`。任何按旧形状写的调用点都会得到
   * `undefined`，而 `undefined > 0` 恒为 false ⇒ 于是又悄悄落回兜底句说"一致"。
   * 那正是本条要修的病，不能留一条没被堵住的同形通道。
   *
   * ⚠️ 负向校准：把 `actions.ts` 的 `keptKnown` 判断删掉（无条件走兜底句），
   * 本用例立刻红 —— 这正是 t101 实测到的那条（脚本里那 1 条 FAIL）。
   */
  const got = reconcileSummary({ recovered: 0, corrected: 0, funding: 0 } as never);

  assert.ok(!got.includes(CLAIM_CONSISTENT), `拿不到计数就不能下"一致"的结论：${got}`);
  assert.ok(
    got.includes('不判断账实是否一致'),
    `它应当明说自己不下这个结论（这才是诚实的那句话）：${got}`,
  );
});
