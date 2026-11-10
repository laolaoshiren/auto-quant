import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultStrategyConfig } from '@aq/shared';
import { closeDb, initDb } from '../db/index.js';
import { aiModels, exchanges, strategies, traders } from '../store/repositories.js';
import { TraderManager } from './manager.js';
import { Vault } from '../crypto/vault.js';

/* -------------------------------------------------------------------------- */
/*  开机恢复：一台失败不能拖垮其余                                                */
/* -------------------------------------------------------------------------- */

/**
 * ## 用户 2026-10-03 的实盘事故
 *
 * `resumePersisted()` 的循环原来是：
 *
 * ```ts
 * if (this.cancelledStarts.has(trader.id) || this.stopping) break;
 * const result = await this.startTrader(trader.id, dryRun, { retryTransient: true });
 * ```
 *
 * 两个问题叠加：
 *
 *   · `cancelledStarts` 含**任意一台**就 `break` 整个循环 —— 而它的语义只是"这一台别启动"；
 *   · `startTrader` 调用**没有 try/catch** —— 一抛异常，循环带堆栈退出。
 *
 * 后果：`#9`（id 小、排在前）在启动途中出问题，循环中断，
 * **排在后面的 `#10`（主账户实盘、3 个仓位 6 张保护单）连一条日志都没有** ——
 * 它静默停摆 **8 小时**（09:07 最后一轮 → 17:11 人工发现）。
 *
 * 而这段代码上方的注释自己就写着：**「一个持有杠杆仓位的机器人静默停摆是钱的问题」**。
 *
 * 这两条用例把"一台失败不影响其余"钉死。
 */
let workDir: string;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-resume-'));
  initDb(path.join(workDir, 'resume.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // 每例都从空表开始，避免上一例的 trader 干扰。
  for (const t of traders.list()) traders.remove(t.id);
});

function seedTrader(name: string): number {
  const account = exchanges.create({
    exchange: 'binance',
    label: name,
    apiKey: 'k',
    apiSecretEnc: 'v1:00:00:00',
    testnet: true,
    canTrade: true,
  });
  const model = aiModels.create({
    provider: 'deepseek',
    label: name,
    model: 'm',
    baseUrl: 'https://example.invalid',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 1,
  });
  const strategy = strategies.create({
    name,
    description: '',
    config: defaultStrategyConfig(),
    presetId: null,
  });
  return traders.create({
    name,
    exchangeAccountId: account.id,
    aiModelId: model.id,
    strategyId: strategy.id,
    cycleIntervalMinutes: 15,
    initialEquity: 100,
  }).id;
}

test('★ 一台机器人启动抛异常，后面那台【仍然要被尝试】—— 实盘曾因此静默停摆 8 小时', async () => {
  const first = seedTrader('first');
  const second = seedTrader('second');
  traders.setStatus(first, 'running', null);
  traders.setStatus(second, 'running', null);

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  const attempted: number[] = [];
  manager.startTrader = (async (id: number) => {
    attempted.push(id);
    if (id === first) throw new Error('模拟：这一台启动时抛异常');
    return { ok: true, preflight: [] };
  }) as unknown as TraderManager['startTrader'];

  await manager.resumePersisted(false);

  assert.deepEqual(
    attempted,
    [first, second],
    '★ 第一台抛异常之后，第二台必须照样被尝试 —— 否则一台的问题会让所有机器人一起不恢复',
  );
});

test('★ 一台启动【失败】（返回 ok:false）同样不能挡住后面的', async () => {
  const first = seedTrader('fail-first');
  const second = seedTrader('after-fail');
  traders.setStatus(first, 'running', null);
  traders.setStatus(second, 'running', null);

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  const attempted: number[] = [];
  manager.startTrader = (async (id: number) => {
    attempted.push(id);
    return id === first ? { ok: false, error: '预检没过' } : { ok: true, preflight: [] };
  }) as unknown as TraderManager['startTrader'];

  await manager.resumePersisted(false);

  assert.deepEqual(attempted, [first, second], '★ 失败（返回 ok:false）也要继续下一台');
  /* 失败那台必须被标成 error，让人看得见 —— 那是 F2 的另一半。 */
  assert.equal(traders.get(first)?.status, 'error');
});

test('操作员主动停掉的机器人【不】被恢复 —— 那次停手是人做的决定', async () => {
  const stopped = seedTrader('operator-stopped');
  traders.setStatus(stopped, 'stopped', null);

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  const attempted: number[] = [];
  manager.startTrader = (async (id: number) => {
    attempted.push(id);
    return { ok: true, preflight: [] };
  }) as unknown as TraderManager['startTrader'];

  await manager.resumePersisted(false);

  assert.deepEqual(attempted, [], '★ `stopped` 是人做的决定，开机不该把它翻过来');
});

/* -------------------------------------------------------------------------- */
/*  启动飞行中点「停止」：不能被 .then 覆盖成 error                               */
/* -------------------------------------------------------------------------- */

/*
 * ## 缺陷形状（2026-10-14 审查）
 *
 * `attemptStart()` 的两个取消分支自己把状态写成 `stopped`（那是操作员的决定），
 * 并返回 `{ ok:false, cancelled:true }`。但 `startTraderAsync` 的 `.then`
 * 原来只看 `ok`：
 *
 * ```ts
 * if (result.ok) return;
 * this.setTraderStatus(traderId, 'error', result.error ?? '启动失败');   // ← 无条件覆盖
 * ```
 *
 * 于是「停止 → 停止 → **error**」。而 `resumePersisted()` 的可恢复集合是
 * `{ running, safe_mode, error }` —— **刻意不恢复 `stopped`**（那是人的决定）。
 * 覆盖的代价：**下一次部署/重启把刚被叫停的机器人重新拉起并下单。**
 * 这正是 `d938926` 那次修复（取消守卫 + 永久标志）漏掉的 `.then` 尾巴。
 *
 * ⚠️ 修复不能改用 `cancelledStarts.has(id)`：那面旗子在 `startTrader` 的
 * `finally` 里就收掉了，而 `.then` 在它之后运行 —— 等于什么都没看见。
 * 所以判据必须由 `startTrader` 自己通过 `result.cancelled` 传出来。
 */
test('★★ 启动被操作员取消时，状态保持 stopped —— 不被 .then 覆盖成 error', async () => {
  const id = seedTrader('cancel-during-start');
  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));

  manager.startTrader = (async (traderId: number) => {
    /* 模拟 attemptStart 的取消分支：先把状态写成 stopped，再返回带 cancelled 的失败。 */
    traders.setStatus(traderId, 'stopped', null);
    return {
      ok: false,
      error: '启动过程中被操作员取消。',
      preflight: [],
      cancelled: true,
    };
  }) as unknown as TraderManager['startTrader'];

  manager.startTraderAsync(id, false);

  /* .then 是 fire-and-forget：等微任务队列排空再断言。 */
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(
    traders.get(id)?.status,
    'stopped',
    '★★ 一次显式的操作员停止被 .then 覆盖成 error 了 —— 而 error 会被下次开机恢复，等于停手作废',
  );
});

test('★ 真正的启动失败（非取消）仍要落 error —— 修复不能把看门狗语义一起删掉', async () => {
  const id = seedTrader('real-start-failure');
  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));

  manager.startTrader = (async () => ({
    ok: false,
    error: '交易所不可达',
    preflight: [],
  })) as unknown as TraderManager['startTrader'];

  manager.startTraderAsync(id, false);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(
    traders.get(id)?.status,
    'error',
    '真正的失败必须落 error（否则状态停在 starting，操作员看不见也重试不了）',
  );
});

/* -------------------------------------------------------------------------- */
/*  持久态停在 starting 的机器人必须被恢复                                        */
/* -------------------------------------------------------------------------- */

/*
 * ## 缺陷形状（外部 issue #147）
 *
 * `resumePersisted()` 的可恢复集合原来是 `{running, safe_mode, error}` ——
 * **漏了 `starting`**。
 *
 * 而 `starting` 是**会落库**的：`attemptStart()` 在真正启动交易循环之前
 * 先 `setTraderStatus(traderId, 'starting', null)`（`manager.ts:3095`，同步写库），
 * 而那之后还要建连接、校时、拉 exchangeInfo、探测模型 —— **几秒到几十秒**。
 *
 * 如果进程恰好死在那个窗口里（部署重启、OOM、断电）：
 *
 *   · `stopAll()` 只遍历 `this.running`，而这一台**还没进去** —— DB 状态原样留成 `starting`；
 *   · 看门狗是**内存定时器**，进程一死就没了；
 *   · `resumePersisted()` 不认 `starting` → 不恢复；
 *   · `api/server.ts` 会把非 running 的状态覆写成 `'stopped'` → 界面显示**「已停止」**；
 *   · `failedTraders()` 只收 `error` → 不告警。
 *
 * 于是这台机器人**既不恢复、也不告警**，而界面上那个"已停止"看起来
 * **就像有人手动停的** —— 没有人会去查它为什么停。这正是仓库记过的那类事故
 *（`autoTrader.ts:1503-1519`：一次部署静默停掉了正在跑的机器人）。
 *
 * ## 为什么可以安全地加进去
 *
 * `starting` **只可能因进程死亡而残留**：只要进程活着，看门狗一定会把它推到
 * `running` 或 `error`（`startTraderAsync` 的 `.then` / `.catch` 两条路径都写状态）。
 * 所以"恢复它"不会覆盖任何人的决定 —— 与 `stopped`（人停的）不同。
 */
test('★★★ 持久态停在 starting 的机器人必须被开机恢复 —— 否则它永久隐身', async () => {
  const id = seedTrader('stuck-starting');
  /*
   * 模拟"进程死在 starting 窗口"留下的持久态。
   * 注意：这不是构造出来的假象 —— `attemptStart()` 真的会写这个状态（`:3095`）。
   */
  traders.setStatus(id, 'starting', null);

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  const attempted: number[] = [];
  manager.startTrader = (async (traderId: number) => {
    attempted.push(traderId);
    return { ok: true, preflight: [] };
  }) as unknown as TraderManager['startTrader'];

  await manager.resumePersisted(false);

  assert.deepEqual(
    attempted,
    [id],
    '★★★ `starting` 必须被恢复 —— 它只可能因进程死亡残留（看门狗在进程活着时必把它推到 running/error），' +
      '所以恢复它不会覆盖任何人的决定。漏了它 = 这台机器人既不恢复也不告警，' +
      '而界面显示「已停止」，看起来像有人手动停的（issue #147）',
  );
});

test('★★ 恢复集合必须仍然排除 stopped —— 那是人的决定，加 starting 不能顺带把它放进来', async () => {
  /*
   * 反向守卫：修 issue #147 时最容易犯的错是"干脆把集合放宽"。
   * `stopped` 是人做的决定，开机不得越过 —— 这条把它钉住。
   */
  const id = seedTrader('operator-stopped');
  traders.setStatus(id, 'stopped', null);

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  const attempted: number[] = [];
  manager.startTrader = (async (traderId: number) => {
    attempted.push(traderId);
    return { ok: true, preflight: [] };
  }) as unknown as TraderManager['startTrader'];

  await manager.resumePersisted(false);

  assert.deepEqual(attempted, [], '★★ `stopped` 是人做的决定，开机不该把它翻过来');
});

test('★★ 四类该恢复的持久态都要被恢复 —— 逐一钉住，防下次再漏一个', async () => {
  /*
   * `running` / `safe_mode` / `error` / `starting` 四个都要恢复。
   * 分成四个独立 trader 一次断言，这样将来漏掉任何一个都会精确报出是哪个。
   */
  const ids = {
    running: seedTrader('resume-running'),
    safe_mode: seedTrader('resume-safe-mode'),
    error: seedTrader('resume-error'),
    starting: seedTrader('resume-starting'),
  };
  for (const [status, id] of Object.entries(ids)) {
    traders.setStatus(id, status as 'running' | 'safe_mode' | 'error' | 'starting', null);
  }

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  const attempted = new Set<number>();
  manager.startTrader = (async (traderId: number) => {
    attempted.add(traderId);
    return { ok: true, preflight: [] };
  }) as unknown as TraderManager['startTrader'];

  await manager.resumePersisted(false);

  for (const [status, id] of Object.entries(ids)) {
    assert.ok(attempted.has(id), `★★ 持久态 ${status} 的机器人必须被恢复`);
  }
});

/* -------------------------------------------------------------------------- */
/*  纯模拟盘机器人的对账：没有交易所侧可对                                        */
/* -------------------------------------------------------------------------- */

test('★★ 纯模拟盘机器人点「对账」直接返回空结果 —— 不去建交易所连接（PR #185 传播缺口）', async () => {
  /*
   * Why this test exists（2026-11-09）。
   *
   * PR #185 允许机器人不绑交易所账户（`exchange_account_id = NULL`），但
   * `reconcileTrader()` 仍无条件走 `connectionFor(traderId, exchangeAccountId, dryRun)`。
   * 对一台**从未启动过**的纯模拟盘机器人：库里 `dry_run = NULL`，
   * `effectiveDryRun()` 于是回落读环境（实盘部署下为 `false`）→
   * `connectionFor(null, false)` 抛出「没有绑定交易所账户，只能以模拟盘运行」
   * → 操作员点「对账」得到 400，功能看起来是坏的。
   *
   * 而它本来就没有可对的东西：模拟盘的成交/持仓/盈亏全在本地台账里，
   * 交易所流水里从来没有它的单。所以正确行为是**短路返回空结果**，
   * 与 `autoTrader` 总账校验对 `exchangeAccountId === null` 的处理一致。
   *
   * 负向校准：把 `reconcileTrader()` 里的 null 短路删掉 → 本用例立刻红
   * （抛「只能以模拟盘运行」，而不是返回 0）。
   */
  const model = aiModels.create({
    provider: 'deepseek',
    label: '纯模拟盘模型',
    model: 'm',
    baseUrl: 'https://example.invalid',
    apiKeyEnc: '',
    temperature: 0.2,
    maxTokens: 4096,
    timeoutSeconds: 60,
    maxRetries: 1,
  });
  const id = traders.create({
    name: '纯模拟盘',
    exchangeAccountId: null,
    aiModelId: model.id,
    strategyId: null,
    cycleIntervalMinutes: 15,
    initialEquity: 1000,
    paperStartingBalance: 1000,
  }).id;
  /* 从未启动过 —— 这正是复现条件（`dryRun` 为 undefined 时回落读环境）。 */
  assert.equal(traders.get(id)?.dryRun, undefined);

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  const result = await manager.reconcileTrader(id);

  assert.deepEqual(
    result,
    { recovered: 0, corrected: 0, correctedAttempted: 0, correctedKept: 0, funding: 0 },
    '纯模拟盘没有交易所侧可对，必须返回空结果而不是抛错',
  );
});

/* -------------------------------------------------------------------------- */
/*  开机恢复期间的操作员动作（2026-11-10 审查 #5 / #6）                           */
/* -------------------------------------------------------------------------- */

/** 读写 manager 的私有状态 —— 只在测试里用，用来摆出"恢复途中"的竞争现场。 */
type ManagerInternals = {
  running: Map<number, unknown>;
  starting: Set<number>;
  cancelledStarts: Set<number>;
  stopping: boolean;
  attemptStart: (...args: unknown[]) => Promise<unknown>;
  waitForRetry: (waitMs: number, traderId: number) => Promise<void>;
};

function internals(manager: TraderManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

test('★★ #5 退避等待中被操作员停止：startTrader 必须带 cancelled 返回（不是普通失败）', async () => {
  const id = seedTrader('stop-during-backoff');
  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  const m = internals(manager);
  m.attemptStart = async () => ({
    result: { ok: false, error: '交易所 503', preflight: [] },
    permanent: false,
  });
  /* 模拟：退避等待期间操作员点了「停止」（stopTrader 第一句就是 add）。 */
  m.waitForRetry = async (_ms, traderId) => {
    m.cancelledStarts.add(traderId);
  };

  const result = await manager.startTrader(id, true, { retryTransient: true });

  assert.equal(result.ok, false);
  assert.equal(
    result.cancelled,
    true,
    '★★ 退避中被叫停返回的是上一轮失败结果 —— 不带 cancelled，开机恢复就会把它写成 error 并在下次重启拉起',
  );
});

test('★ #5 进程关闭（stopping）导致的取消【不】标 cancelled —— 那时写 error 才能在下次重启恢复', async () => {
  const id = seedTrader('shutdown-during-backoff');
  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  const m = internals(manager);
  m.attemptStart = async () => ({
    result: { ok: false, error: '交易所 503', preflight: [] },
    permanent: false,
  });
  m.waitForRetry = async (_ms, traderId) => {
    m.cancelledStarts.add(traderId);
    m.stopping = true;
  };

  const result = await manager.startTrader(id, true, { retryTransient: true });

  assert.equal(result.ok, false);
  assert.notEqual(result.cancelled, true, '关机不是操作员的决定，不能把它当成「停止」');
});

test('★★ #5 恢复途中被操作员停止：resumePersisted 不得覆写成 error（否则下次重启被拉起）', async () => {
  const id = seedTrader('stopped-while-resuming');
  traders.setStatus(id, 'running', null);

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  manager.startTrader = (async (traderId: number) => {
    /*
     * 模拟最坏的写入顺序：stopTrader 先写 stopped，启动失败分支随后又写了 error，
     * 然后 startTrader 带 cancelled 返回。
     */
    traders.setStatus(traderId, 'stopped', null);
    traders.setStatus(traderId, 'error', '交易所 503');
    return { ok: false, error: '交易所 503', preflight: [], cancelled: true };
  }) as unknown as TraderManager['startTrader'];

  await manager.resumePersisted(false);

  assert.equal(
    traders.get(id)?.status,
    'stopped',
    '★★ 操作员在恢复途中点了停止 —— 必须保持 stopped；error 在可恢复集合里，等于停手作废',
  );
});

test('★ #6 恢复轮到它时已在运行（操作员手动启动）：不再启动、不写 error', async () => {
  const id = seedTrader('manually-started-while-queued');
  traders.setStatus(id, 'running', null);

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  internals(manager).running.set(id, {});
  const attempted: number[] = [];
  manager.startTrader = (async (traderId: number) => {
    attempted.push(traderId);
    /* 与真实 startGuard 一致：已在运行 → 拒绝。 */
    return { ok: false, error: '该机器人已经在运行中', preflight: [] };
  }) as unknown as TraderManager['startTrader'];

  await manager.resumePersisted(false);

  assert.deepEqual(attempted, [], '已在运行的机器人不该再走一次恢复');
  assert.equal(
    traders.get(id)?.status,
    'running',
    '★ 机器人明明在跑，却被写成「启动恢复失败，需要人工处理」',
  );
});

test('★ #6 恢复轮到它时正在启动中：同样跳过', async () => {
  const id = seedTrader('starting-while-queued');
  traders.setStatus(id, 'running', null);

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  internals(manager).starting.add(id);
  const attempted: number[] = [];
  manager.startTrader = (async (traderId: number) => {
    attempted.push(traderId);
    return { ok: false, error: '该机器人正在启动中', preflight: [] };
  }) as unknown as TraderManager['startTrader'];

  await manager.resumePersisted(false);

  assert.deepEqual(attempted, []);
  assert.notEqual(traders.get(id)?.status, 'error');
});

test('★ #6 排队中被操作员停成 stopped：轮到它时按实时状态跳过，不按开头的快照拉起', async () => {
  const first = seedTrader('resume-first');
  const second = seedTrader('resume-second-stopped-meanwhile');
  traders.setStatus(first, 'running', null);
  traders.setStatus(second, 'running', null);

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  const attempted: number[] = [];
  manager.startTrader = (async (traderId: number) => {
    attempted.push(traderId);
    /* 恢复第一台期间，操作员把第二台停成了 stopped（快照里它仍是 running）。 */
    if (traderId === first) traders.setStatus(second, 'stopped', null);
    return { ok: true, preflight: [] };
  }) as unknown as TraderManager['startTrader'];

  await manager.resumePersisted(false);

  assert.deepEqual(attempted, [first], '被人停掉的那台不该再被开机恢复拉起');
  assert.equal(traders.get(second)?.status, 'stopped');
});

/* ------------------- 2026-11-11：凭据变更后失效缓存连接 ------------------- */

test('★ 凭据变更 → 只丢掉【未运行】且【引用该凭据】的机器人的缓存连接', () => {
  /*
   * `connectionFor` 命中缓存就直接返回，不比对凭据与环境。未运行机器人的
   * 对账 / 手工平仓会把连接留在缓存里，而凭据路由原来只失效余额缓存 ——
   * 换 Key 或切测试网之后对已停止的机器人点"平仓"，订单仍发往旧账户、旧环境。
   */
  const stopped = seedTrader('acct-stopped');
  const other = seedTrader('acct-other');
  const live = seedTrader('acct-running');
  const accountId = traders.get(stopped)!.exchangeAccountId!;
  /* 让 live 与 stopped 共用同一个凭据；other 用它自己的。 */
  const db = initDb(path.join(workDir, 'resume.sqlite'));
  db.run('UPDATE traders SET exchange_account_id = ? WHERE id = ?', accountId, live);

  const manager = new TraderManager(new Vault(Buffer.alloc(32, 7)));
  const internals = manager as unknown as {
    connections: Map<string, unknown>;
    running: Map<number, unknown>;
  };
  for (const id of [stopped, other, live]) {
    internals.connections.set(`${id}:paper`, {});
    internals.connections.set(`${id}:live`, {});
  }
  internals.running.set(live, {});

  assert.equal(manager.invalidateConnectionsForAccount(accountId), 1);
  assert.equal(internals.connections.has(`${stopped}:live`), false, '★ 已停止机器人的实盘连接必须被丢掉');
  assert.equal(internals.connections.has(`${stopped}:paper`), false, '两种模式的连接都要丢');
  assert.equal(internals.connections.has(`${other}:live`), true, '别的凭据的机器人不受影响');
  assert.equal(internals.connections.has(`${live}:live`), true, '运行中的不动 —— 它的 broker 正被交易循环持有');
  internals.running.clear();
});
