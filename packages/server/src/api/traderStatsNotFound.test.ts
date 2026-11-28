/**
 * **同一资源族的端点必须在"机器人不存在"上给同一个答案**
 *（外部 issue #162）。
 *
 * ## 这个测试防的是什么
 *
 * ```
 * GET /api/traders/99999/account  →  404 找不到该机器人     ✅
 * GET /api/traders/99999/stats    →  200 + 权益 0 / 收益 0%  ❌
 * ```
 *
 * `stats` 原来不检查存在性：`computeTraderStats()` 走 SQL 聚合，一个不存在的 id
 * 得到 `COUNT(*) = 0` 与 `SUM(...) = NULL`（被兜底成 0）—— 于是响应是
 * **200 + 全零**。
 *
 * 后果不是"不好看"：**"权益 0"会被读成"这个机器人亏光了"**。
 * 一个打错的 id、或一个刚被删掉的机器人，在界面上表现为"账户归零"——
 * 而这是一个下真实订单的项目，"权益 0"是最需要被当真的读数。
 *
 * ## 为什么用源码结构断言而不是起服务测
 *
 * `buildServer()` 要真实的交易所连接、金库、模型客户端才能装配起来
 *（见 `api/` 目录下现有测试：`auth.test.ts` / `health.test.ts` 等测的都是**纯函数**，
 *  没有一个是 `buildServer` 的集成测试）。为一个"加两行存在性检查"的修复
 * 引入半套服务桩，被测的会变成桩而不是这两行。
 *
 * 所以这里断言的是**接线本身**：`stats` 路由必须在调 `computeTraderStats()` **之前**
 * 检查 `traders.get(id)` 并回 404。这与 `trader/startCancellation.test.ts`、
 * `trader/researchLifecycle.test.ts` 是同一类判断 —— 接线缺陷的可观测面在源码结构上。
 *
 * ⚠️ 它**不能**证明运行时状态码，那一半要靠人工打一次请求。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SRC = readFileSync(new URL('./routes/traderDataRoutes.ts', import.meta.url), 'utf8');

/** 取出某个路由处理函数的源码片段（从 `app.get('<path>'` 到下一个 `app.` 声明）。 */
function routeBody(path: string): string {
  const start = SRC.indexOf(`app.get('${path}'`);
  assert.ok(start > 0, `找不到路由 ${path}`);
  const next = SRC.indexOf('\n  app.', start + 10);
  return SRC.slice(start, next > 0 ? next : SRC.length);
}

test('★★★ /api/traders/:id/stats 必须在算统计之前检查机器人存在，并回 404', () => {
  const body = routeBody('/api/traders/:id/stats');

  /*
   * 关键：检查要**在 computeTraderStats 之前** —— 放在之后等于先算出全零再丢掉，
   * 那既浪费又说明不了意图。
   */
  /*
   * ⚠️ **必须在"真正的代码行"里找这些锚点，不能直接 `indexOf`。**
   *
   * 本仓库的注释密度很高，而这段注释里**逐字引用了 `computeTraderStats()`**
   *（解释它为什么会对不存在的 id 返回全零）。直接 `indexOf('computeTraderStats(')`
   * 会命中注释里那一次（实测位置 191），而真正的调用在第 21 行（位置 691）——
   * 于是断言会算出"守卫在调用之后"的**假结论**。
   *
   * 这与 `trader/startCancellation.test.ts` 里踩过的坑是同一个：
   * 那个测试也曾因注释里引用了 `await autoTrader.start()` 而误判。
   *
   * 判据：跳过以 `*` 或 `//` 开头的行（注释行），只在其余行里找。
   */
  const codeLines = body
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');

  const guardIdx = codeLines.indexOf('traders.get(id)');
  const computeIdx = codeLines.indexOf('computeTraderStats(');
  assert.ok(computeIdx > 0, '找不到 computeTraderStats 调用 —— 结构变了，请更新本测试');
  assert.ok(
    guardIdx > 0,
    '★★★ stats 路由必须检查 `traders.get(id)` —— 否则不存在的机器人会回 200 + 全零，' +
      '而「权益 0」会被读成「这个机器人亏光了」',
  );
  assert.ok(
    guardIdx < computeIdx,
    '★★★ 存在性检查必须在 `computeTraderStats()` 之前 —— 放后面等于先算完全零再丢掉',
  );

  /* 必须回 404，而不是 200 或 400 —— 与 `/account` 同一个状态码。 */
  assert.match(
    body,
    /reply\.code\(404\)/,
    '★★★ 必须回 404 —— 与 /api/traders/:id/account 对同一个事实给出同一个答案',
  );
});

test('★★★ /api/traders/:id/account 也要保持 404（两侧一起看才有意义）', () => {
  const body = routeBody('/api/traders/:id/account');
  assert.ok(
    body.includes('traders.get(') && /reply\.code\(404\)/.test(body),
    '★★★ /account 必须继续回 404 —— 本条测试的意义就在于两个端点行为一致',
  );
});

test('★ 两条路由的 404 文案逐字一致 —— 同一件事不该有两种说法', () => {
  /*
   * 不只"都回 404"，还要**同一句话**。两种措辞会让操作员以为它们描述的是
   * 两种不同的情况（而这个项目反复记录过"同一件事多个说法"的代价）。
   */
  assert.equal(
    routeBody('/api/traders/:id/stats').includes("'找不到该机器人'"),
    true,
    'stats 的 404 文案要与 /account 一致：找不到该机器人',
  );
  assert.equal(
    routeBody('/api/traders/:id/account').includes("'找不到该机器人'"),
    true,
    '/account 的 404 文案（作为参照）',
  );
});
