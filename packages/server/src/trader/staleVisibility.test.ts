/**
 * **实盘机器人停摆必须有人看得见**（2026-10-17 · t99）。
 *
 * ## 现场（本批最贵的一次教训）
 *
 * ```
 *   #10「赚大钱」（dry_run=0，真实资金）
 *   连续失败 9 轮 / 331 分钟 ≈ 5.5 小时，零决策
 * ```
 *
 * **系统知道这件事** —— `/api/health` 一直在返回 `ok:false` 与 `staleTraders:[{id:10,…}]`。
 * 问题不是"没有信号"，而是**信号在没人看的地方**：`ok:false` 只发给容器编排器
 * （本部署是 systemd，没人读它），而控制台**连 `staleTraders` 这个字段都没有**。
 * 队长是在做"部署后回读"时**偶然**发现那 5.5 小时的。
 *
 * ## 本文件守两件事
 *
 * ① **服务端那一半**：停摆要被判出来（复用 `/api/health` 的同一判据）、
 *    要产出一条形状稳定的日志、**实盘升级为 `error`、模拟盘降为 `warn`**；
 * ② **前端那一半**：横幅只把**确证 `dry_run=0`** 的升级为显眼状态 —— 这条
 *    用源码守卫钉住（前端组件不在本任务的测试范围内，但**判据必须与
 *    服务端同口径**，否则同一个停摆会在两处得到相反的强度）。
 *
 * ⚠️ 每条断言都配**探针**：把"失败形态"喂给同一套判据必须先被判出来。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { buildStaleNotices } from './manager.js';
import { evaluateTraderHealth, STALE_CYCLE_MULTIPLIER, STARTUP_GRACE_MS } from '../api/server.js';
import { codeOnly } from '../testUtils/sourceText.js';

/* -------------------------------------------------------------------------- */
/*  ⓪ 复现：信号**本来就有**（这一点必须钉住，否则修法会被误解成"新建一套信号"）    */
/* -------------------------------------------------------------------------- */

test('★★★ 复现：一个 `dry_run=0` 的机器人卡住时，`/api/health` 的判据早就说 `ok:false`', () => {
  /*
   * 这是"事实更正"那一条的**可执行版本**：`t28` 说"项目没有任何主动告警机制"，
   * 但**停摆这个信号一直存在** —— 它由 `evaluateTraderHealth` 算出来，
   * `/api/health` 用 `ok: stale.length === 0` 转成状态码，只是**没有人看**。
   *
   * 所以本任务的重心是"把已有信号推到人眼前"，**不是新建一套信号**。
   * 这条用例就是这句话的证据：不碰任何新代码，只用现成的纯函数就能复现。
   */
  const now = Date.parse('2026-10-17T05:30:00Z');
  const staleForMs = 2_144_782; /* 与线上实测一致：≈35.7 分钟 */
  const verdict = evaluateTraderHealth(
    [
      {
        id: 10,
        name: '赚大钱',
        status: 'running',
        lastCycleAt: new Date(now - staleForMs).toISOString(),
        cycleIntervalMinutes: 15,
      },
    ],
    now,
    /* 关键前提：这个机器人**确实由当前进程持有**（否则库里残留的 running 会被误报）。 */
    new Map([[10, now - 6 * 3_600_000]]),
  );

  assert.equal(verdict.ok, false, '★★★ 停摆时 ok 必须是 false（这就是那个没人看的信号）');
  assert.equal(verdict.stale.length, 1, '★ 它必须出现在 staleTraders 里');
  assert.equal(verdict.stale[0]!.traderId, 10, '★ 要能指认是哪一台');
  assert.equal(verdict.stale[0]!.staleForMs, staleForMs, '★ 要带上停了多久');

  /* ★ 探针：刚跑完一轮（未超阈值）时**不该**判红 —— 否则上面几条是"永远红"。 */
  const healthy = evaluateTraderHealth(
    [
      {
        id: 10,
        name: '赚大钱',
        status: 'running',
        lastCycleAt: new Date(now - 60_000).toISOString(),
        cycleIntervalMinutes: 15,
      },
    ],
    now,
    new Map([[10, now - 6 * 3_600_000]]),
  );
  assert.equal(healthy.ok, true, '★ 探针：健康时必须 ok=true');
  assert.deepEqual(healthy.stale, []);
});

/** 一行 `traders` 记录（只取这条判据用到的列）。 */
function row(over: Partial<Parameters<typeof buildStaleNotices>[0]['rows'][number]> = {}) {
  return {
    id: 10,
    name: '赚大钱',
    cycleIntervalMinutes: 15,
    dryRun: false,
    consecutiveFailures: 9,
    lastError: 'request to https://gateway.example/v1/chat/completions failed, reason: body timeout',
    ...over,
  };
}

/** 一条停摆判定（`evaluateTraderHealth` 的 `stale` 元素形状）。 */
function stale(over: Partial<{ traderId: number; staleForMs: number | null; awaitingFirstCycle: boolean }> = {}) {
  return { traderId: 10, staleForMs: 2_144_782, awaitingFirstCycle: false, ...over };
}

const BASE = { envDryRun: false, multiplier: 2, graceMs: 300_000 } as const;

/* -------------------------------------------------------------------------- */
/*  ① 实盘停摆 → 必须产出可见的记录                                              */
/* -------------------------------------------------------------------------- */

test('★★★ 实盘机器人停摆 → 产出一条 `error` 记录，且四个事实都在同一行上', () => {
  /*
   * 这正是 `#10` 那 5.5 小时该留下的东西。四个事实缺一不可：
   *   trader_id（哪一台）· 停摆时长（多久了）· 连续失败轮数（是不是在空转）
   *   · 最近错误短句（为什么）
   */
  const notices = buildStaleNotices({ ...BASE, rows: [row()], stale: [stale()] });

  assert.equal(notices.length, 1, '★ 实盘停摆必须产出恰好一条');
  const notice = notices[0]!;
  assert.equal(notice.traderId, 10, '★★★ 必须能读出是哪一台（否则又回到"查不出是谁"）');
  assert.equal(notice.level, 'error', '★★★ 真钱停摆必须是 error 级 —— 这才叫"强信号"');
  assert.match(notice.message, /^\[停摆\]/, '★ 前缀固定，才能 grep 出这一类');
  assert.match(notice.message, /#10/, '★ 消息里要有 id');
  assert.match(notice.message, /赚大钱/, '★ 要有名字（人认名字比认 id 快）');
  assert.match(notice.message, /实盘/, '★ 要写明这是真钱');
  assert.match(notice.message, /已 36 分钟/, '★ 要有停摆时长');
  assert.match(notice.message, /连续失败 9 轮/, '★ 要有连续失败轮数');
  assert.match(notice.message, /body timeout/, '★ 要有最近错误短句');

  /* ★ 探针：健康（没有 stale）时必须一条都不产 —— 否则这条断言是瞎的。 */
  assert.deepEqual(buildStaleNotices({ ...BASE, rows: [row()], stale: [] }), []);
});

/* -------------------------------------------------------------------------- */
/*  ② 模拟盘停摆 → 留痕但不升级                                                  */
/* -------------------------------------------------------------------------- */

test('★★★ 模拟盘停摆 → 仍然是 `warn`（只对会影响真实资金的事发强信号）', () => {
  const notices = buildStaleNotices({
    ...BASE,
    rows: [row({ id: 11, name: '[团队测试] 多智能体', dryRun: true })],
    stale: [stale({ traderId: 11 })],
  });
  assert.equal(notices.length, 1, '模拟盘停摆也要留痕（只是强度低）');
  assert.equal(notices[0]!.level, 'warn', '★★★ 模拟盘不许升级为 error');
  assert.match(notices[0]!.message, /模拟盘/, '★ 要写清是模拟盘，别与真钱混淆');
});

test('★★★ `dryRun` 未记录时回落到进程级 env —— 口径与 `resumePersisted` 一致', () => {
  /*
   * `traders.dry_run` 为 NULL 表示"从未被显式指定过"，那时真实口径是**进程级 env**
   *（`manager.ts` 的 `resumePersisted` / `attemptStart` 都是 `trader.dryRun ?? env.dryRun`）。
   * 这里必须同口径 —— 否则"机器人自己没记"的那一类会被静默降级成 warn。
   */
  const fallbackReal = buildStaleNotices({
    envDryRun: false,
    multiplier: 2,
    graceMs: 300_000,
    rows: [row({ dryRun: undefined })],
    stale: [stale()],
  });
  assert.equal(fallbackReal[0]!.level, 'error', '★ env 说"不是模拟" ⇒ 应当升级');

  const fallbackPaper = buildStaleNotices({
    envDryRun: true,
    multiplier: 2,
    graceMs: 300_000,
    rows: [row({ dryRun: undefined })],
    stale: [stale()],
  });
  assert.equal(fallbackPaper[0]!.level, 'warn', '★ env 说"是模拟" ⇒ 不升级');

  /* ★ 探针：机器人自己记了值时必须**优先于** env（否则上面两条会因为"永远看 env"而恒真）。 */
  const explicit = buildStaleNotices({
    envDryRun: true,
    multiplier: 2,
    graceMs: 300_000,
    rows: [row({ dryRun: false })],
    stale: [stale()],
  });
  assert.equal(explicit[0]!.level, 'error', '★ 机器人自己记的 dryRun 优先于 env');
});

/* -------------------------------------------------------------------------- */
/*  ③ 不另造第二套阈值（值必须来自 /api/health 用的同一批常量）                    */
/* -------------------------------------------------------------------------- */

test('★★★ 消息里的阈值必须是**传进来的**常量，不是写死的 2 / 300', () => {
  /*
   * ## 这条为什么重要
   *
   * `/api/health` 的判据是 `max(周期 × STALE_CYCLE_MULTIPLIER, STARTUP_GRACE_MS)`。
   * 如果这条日志自己再写一遍 `× 2` 与 `300 秒`，两份阈值迟早分叉
   * ——**而分叉那天没人会发现**（一处改了、另一处没改，两处都"看起来对"）。
   *
   * 判据：传一组**不是 2 / 300** 的值，同一条消息必须跟着变。
   */
  const notices = buildStaleNotices({
    envDryRun: false,
    multiplier: 7,
    graceMs: 123_000,
    rows: [row()],
    stale: [stale()],
  });
  assert.match(notices[0]!.message, /× 7/, '★★★ 倍数必须来自参数（写死 2 的样本会在这里红）');
  assert.match(notices[0]!.message, /123 秒/, '★★★ 宽限必须来自参数（写死 300 的样本会在这里红）');

  /* ★ 探针：写死 2/300 的样本必须**不**满足上面的判据。 */
  const hardcoded = '[停摆] #10「赚大钱」实盘 · 已 36 分钟没有完成一轮决策（周期 15 分钟 × 2 与 300 秒起步宽限取较大者）';
  assert.ok(!/× 7/.test(hardcoded), '★ 探针：写死 2 的样本不该匹配 × 7');
});

test('★★ 生产调用点必须把常量**传进去**（而不是自己再写一遍数字）', () => {
  /*
   * 上一条守的是纯函数；这一条守的是**接线**：`auditStaleTraders` 必须从
   * `api/server.js` 导入那批常量并转手传给纯函数。若有人改成写死数字，
   * 纯函数那条用例照样绿（它总是收到传进来的值）——所以必须单独守这一处。
   */
  const code = codeOnly(readFileSync(new URL('./manager.ts', import.meta.url), 'utf8'));
  /*
   * ⚠️ **解构名单会变**（`t114` 加了 `healthContext`）—— 所以判据只认
   * "**这三个名字都在那次动态导入的解构里**"，不锁死顺序与集合。
   * 第一版写死了完整名单，于是 `t114` 合法地加一个名字就把它弄红了：
   * **那是守卫在报"我认不出了"，不是代码坏了。**
   */
  const importLine = /const \{([^}]*)\} =\s*\n?\s*await import\('\.\.\/api\/server\.js'\)/.exec(code);
  assert.ok(importLine, '★★★ 必须从 api/server.js 动态导入（同一个判据的来源）');
  const destructured = importLine![1]!;
  for (const name of ['evaluateTraderHealth', 'STALE_CYCLE_MULTIPLIER', 'STARTUP_GRACE_MS']) {
    assert.ok(
      new RegExp(`\\b${name}\\b`).test(destructured),
      `★★★ 解构里必须有 ${name}（同一个判据的来源）`,
    );
  }
  assert.match(
    code,
    /multiplier: STALE_CYCLE_MULTIPLIER/,
    '★★★ 必须把常量传进 buildStaleNotices，不许在消息里写死',
  );
  assert.match(
    code,
    /graceMs: STARTUP_GRACE_MS/,
    '★★★ 同上（起步宽限）',
  );
  /* ⚠️ 还得**被调用** —— 一个没人调用的审计等于没写（本仓库反复出现的"接线缺口"）。 */
  assert.match(
    code,
    /await this\.auditStaleTraders\(\);/,
    '★★★ 自检 sweep 里必须真的调用它（否则修复静默失效）',
  );

  /* ★ 探针：写死数字的样本必须被判违规。 */
  const hardcoded = 'const message = `…周期 ${c} 分钟 × 2 与 300 秒…`;';
  assert.ok(!/multiplier: STALE_CYCLE_MULTIPLIER/.test(hardcoded), '★ 探针：写死样本不该通过');
});

/* -------------------------------------------------------------------------- */
/*  ④ 前端那一半：只有确证"真钱"才升级为显眼状态                                  */
/* -------------------------------------------------------------------------- */

test('★★★ 横幅只把确证 `dry_run=0` 的升级为显眼状态（与服务端同口径）', () => {
  /*
   * 前端组件不在本任务的测试文件范围内（它是 `.tsx`，跑在 web 的测试里），
   * 但**这条判据必须与服务端同口径** —— 否则同一个停摆会在两处得到相反的强度：
   * 服务端记 `warn`、横幅却画成红色。
   *
   * 判据（读源码，剥掉注释）：
   *   · 用 `=== false` 而不是 `!== true` —— 后者会把"不知道是不是真钱"也画红；
   *   · `dryRun` 取不到时回落到 `health.dryRun`（进程级）—— 与服务端 `?? envDryRun` 同口径。
   */
  const src = codeOnly(
    readFileSync(new URL('../../../web/src/components/StaleTraderBanner.tsx', import.meta.url), 'utf8'),
  );
  assert.match(
    src,
    /=== false/,
    '★★★ 必须"确证真钱"才升级（`=== false`）—— 取不到就当非实盘，宁可不显示',
  );
  /*
   * ⚠️ 还要**短路**：服务端说 `ok:true` 时必须一条都不报。
   * 少了这道判断，横幅会拿一份"上一轮的 staleTraders"继续红着（而它已经不卡了）——
   * 那正是 `health.ts` 警告过的"长期亮着的假阳性会让运维对告警脱敏"。
   */
  assert.match(
    src,
    /if \(health\.ok\) return \[\]/,
    '★★★ ok:true 时必须短路返回空（不许拿过期的 staleTraders 继续报警）',
  );
  assert.ok(
    !/!== true/.test(src),
    '★★★ 不许用 `!== true`：那把"不知道"也算成真钱，会训练操作员忽略红条',
  );
  assert.match(
    src,
    /\?\? health\.dryRun/,
    '★★★ dryRun 取不到时要回落到进程级 health.dryRun（与服务端 `?? envDryRun` 同口径）',
  );
  /* 横幅必须真的在轮询 health —— 否则"推到人眼前"只是口号。 */
  assert.match(src, /api\.health\(\)/, '★ 必须读 /api/health');
  assert.match(src, /intervalMs: 60_000/, '★ 必须轮询（否则只在登录那一刻取一次，等于没有）');
  /* ⚠️ 不许引入外部通知依赖（超本批范围且需用户决定）。 */
  assert.ok(
    !/webhook|smtp|telegram|nodemailer/i.test(src),
    '★★ 不许引入外部通知依赖',
  );

  /* ★ 探针：`!== true` 的样本必须被判违规。 */
  const naive = 'const realMoney = (row.dryRun ?? health.dryRun) !== true;';
  assert.ok(/!== true/.test(naive), '★ 探针：宽松写法必须能被该判据认出来');
});

test('★★ 横幅挂在 `App.tsx` 的最顶层（跨页面可见，而不是某个页面顶部）', () => {
  /*
   * 队长指定落在 `App.tsx` 顶层，理由：停摆是**跨页面**的事 ——
   * 只挂某个页面顶部的话，人停在别的页面就看不见，那等于没解决
   * "信号在没人看的地方"。
   */
  /*
   * ⚠️ **这里刻意不用 `codeOnly()`** —— 它在这个文件上会**把语料洗坏**，值得记一笔：
   *
   * 它按"行首是不是星号 / 双斜杠 / 斜杠星号"过滤，而 JSX 注释的**收尾行以星号开头**
   *（后面紧跟"斜杠 + 花括号"）⇒ 那一行被删掉，于是 JSX 注释的**开记号**变成未闭合，
   * 后续任何"剥块注释"的正则都会从那里一路吃到文件里下一个收尾记号，
   * 把真正的代码（`<StaleTraderBanner />` 与 `<Routes>`）一起删掉 ——
   * 我第一版就因此假失败（判据没错，是语料没洗干净）。
   *
   * 正确顺序：**先在原样文本上剥 JSX 注释块，再比位置**。
   */
  const raw = readFileSync(new URL('../../../web/src/App.tsx', import.meta.url), 'utf8');
  const app = raw.replace(/\{\/\*[\s\S]*?\*\//g, '');
  assert.match(app, /import \{ StaleTraderBanner \} from '\.\/components\/StaleTraderBanner'/, '★ 必须导入');
  assert.match(app, /<StaleTraderBanner \/>/, '★ 必须渲染');
  /* 它在 `<Routes>` **之前** —— 于是所有路由都带着它。 */
  const bannerAt = app.indexOf('<StaleTraderBanner />');
  const routesAt = app.indexOf('<Routes>');
  assert.ok(bannerAt > 0 && routesAt > 0 && bannerAt < routesAt, '★ 横幅要在 <Routes> 之前（跨页面）');
  /* ★ 探针：顺序反过来的样本必须被判违规。 */
  const probe = '<Routes></Routes><StaleTraderBanner />';
  assert.ok(
    probe.indexOf('<StaleTraderBanner />') > probe.indexOf('<Routes>'),
    '★ 探针：挂在 Routes 之后的样本必须被这条判据判为违规',
  );
});
