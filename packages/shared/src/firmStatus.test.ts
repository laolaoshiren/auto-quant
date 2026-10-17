/**
 * **`firm.ts` 的岗位状态必须与真实接线一致**（2026-10-13 用户截图抓到的 BUG）。
 *
 * ## 事故：汇报员显示"规划中"，但它已在岗
 *
 * 用户截图（`#11` 的「其余岗位」面板）：
 * ```
 *   汇报员  规划中  ← ❌ 它 13:52 有真实运行日志（完成 1906ms）
 * ```
 * 根因：`tradingDesk.ts` 接线了 `reporter`，但 `firm.ts` 的 `status`
 * 没跟着改 —— 状态与实现脱节，而**界面上看不出任何异常**。
 *
 * ## 为什么"状态漂移"在这类项目里特别危险
 *
 * `planned` 的语义是"**还没实现，不会出现在任何编排里**"（firm.ts 自己的注释）。
 * 它是给操作员看的一份**诚实清单** —— 标错了等于让操作员
 * 对"团队里谁在干活"建立错误的心智模型。
 *
 * ## 判据：`staffed` ⟺ 生产代码里真的有调用点
 *
 * ⚠️ **调用点不只在一个文件里**（第一版只查 tradingDesk.ts，被三个"假阳性"打脸）：
 * ```
 *   risk_officer   → routedModel.ts（团队会议之外的风控路径）
 *   memory_curator → runtime.ts / orchestrator.ts（平仓后的复盘）
 *   execution      → autoTrader.ts（executeOpen/executeClose，纯代码）
 * ```
 * 所以判据是【整个 trader/ 目录】的 `role: '<id>'` 字面量调用点。
 *
 * ## 2026-10-15：第三种状态 `by_code` 也必须被这套判据覆盖
 *
 * 仅靠上面两条断言，`data_sentinel` / `ops_watchdog` 会**两边都不落**：
 * 它们不是 `staffed`（没有 LLM 角色在跑），也不是 `planned`（职责确实在跑）——
 * 于是它们可以随便标、没人检查。所以这里补上它们的**承担物**判据，
 * 并把 `planned` 清单一起钉死（见文件末尾）。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { FIRM_ROLES } from './firm.js';

/** 递归收集 trader/ 下全部非测试 .ts 源码（剥注释后的"纯代码"）。 */
function collectCode(dir: string): string {
  const parts: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      parts.push(collectCode(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      /*
       * ⚠️ **`agent/roles.ts` 是角色【定义表】，不是调用点** ——
       * 它里面每个角色都有 `role: 'xxx'` 字面量，把定义算成"接线"
       * 会把所有 planned 岗位误报成"接线后忘了改状态"。
       */
      if (full.endsWith(path.join('agent', 'roles.ts'))) continue;
      const raw = readFileSync(full, 'utf8');
      parts.push(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
    }
  }
  return parts.join('\n');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRADER_CODE = collectCode(path.join(HERE, '..', '..', 'server', 'src', 'trader'));

/**
 * 仓库根 —— 给"核对 `carriedBy` 说的那个模块真的存在"用。
 *
 * ⚠️ 这里**必须先断言它算对了**：算错时 `readFileSync` 会抛错（好），
 * 但如果改成"读不到就跳过"，这条测试就会**在零文件的情况下报绿** ——
 * 那正是 `configWiringGuard.test.ts` 文件头记录过的那种假绿（它第一版扫到 0 个文件
 * 却报告"没问题"）。所以下面有一条前置断言。
 */
const REPO_ROOT = path.join(HERE, '..', '..', '..');

function isWired(roleId: string): boolean {
  /*
   * ⚠️ 三个岗位的"承担方式"不是 `role: '<id>'` 字面量 —— 它们各有各的形态：
   * ```
   *   memory_curator  → 实际调用 id 是 'reviewer'（orchestrator.ts 的复盘，
   *                     firm.ts 的岗位名与角色名是两个体系）
   *   execution       → autoTrader.ts 的 executeOpen/executeClose —— 纯代码，
   *                     从不调 LLM（tier: T0_code 的本意）
   *   system_engineer → manager.ts 的 selfCheck 系（每 30 分钟自检）
   * ```
   * 硬编码这三个映射不优雅，但**诚实**：它们的承担方式本来就不是
   * "问一次模型"，硬套 `role: 'xxx'` 判据反而会把"在岗"误报成"漂移"。
   */
  const BEARERS: Record<string, RegExp> = {
    memory_curator: /role: 'reviewer'/,
    execution: /executeOpen\(/,
    system_engineer: /runSelfCheck\(/,
    /*
     * 这两个是 `status: 'by_code'`（2026-10-15）—— 职责由确定性代码承担，
     * **永远不会**有 `role: 'data_sentinel'` 这种调用点（它们不是 LLM 角色）。
     * 所以对它们的判据就是"承担物还在不在"，而这正是下面
     * 「by_code 岗位的承担物必须写在 carriedBy 里」那条测试要去文件里核对的。
     */
    data_sentinel: /staleTraders/,
    ops_watchdog: /findDeterministicProblems\(/,
  };
  const bearer = BEARERS[roleId];
  if (bearer !== undefined) return bearer.test(TRADER_CODE);
  return TRADER_CODE.includes(`role: '${roleId}'`);
}

test('★★★ 标了 staffed 的角色必须真的有调用点（防"装饰性在岗"）', () => {
  const liars = FIRM_ROLES.filter((r) => r.status === 'staffed' && !isWired(r.id)).map(
    (r) => `${r.label}(${r.id})`,
  );
  assert.deepEqual(
    liars,
    [],
    `★ 这些角色标了 staffed 但 trader/ 下没有任何调用点（状态漂移）：${liars.join('、')}`,
  );
});

test('★★★ 接了线的角色不能再标 planned（用户截图抓到的那类漂移）', () => {
  const drifted = FIRM_ROLES.filter((r) => r.status === 'planned' && isWired(r.id)).map(
    (r) => `${r.label}(${r.id})`,
  );
  assert.deepEqual(
    drifted,
    [],
    `★ 这些角色标了 planned 但生产代码里有调用点（接线后忘了改状态）：${drifted.join('、')}`,
  );
});

test('★ reporter 必须是 staffed（2026-10-13 接线，线上有运行日志）', () => {
  const reporter = FIRM_ROLES.find((r) => r.id === 'reporter');
  assert.ok(reporter !== undefined, '★ firm.ts 里必须有 reporter 这个岗位');
  assert.equal(reporter.status, 'staffed', '★ reporter 已接线（13:52 运行日志），不能标 planned');
});

test('★ planned 的岗位清单（新增/接线岗位时同步更新这条期望）', () => {
  const planned = FIRM_ROLES.filter((r) => r.status === 'planned').map((r) => r.id).sort();
  assert.deepEqual(
    planned,
    ['clerk', 'community_monitor', 'onchain_analyst', 'portfolio_manager', 'red_team'].sort(),
    '★ planned 清单变了 —— 若有岗位接线了，记得同步 firm.ts 的状态与这条期望',
  );
});

/* -------------------------------------------------------------------------- */
/*  `by_code`：职责由确定性代码承担（2026-10-15）                                 */
/* -------------------------------------------------------------------------- */

test('★★★ 每个岗位的实现状态必须是被明确分类过的，不允许"两不管"', () => {
  /*
   * ## 这个测试防的是什么
   *
   * 2026-10-15 之前只有 `staffed` / `planned` 两态，而 `data_sentinel` /
   * `ops_watchdog` 的职责**一直在跑**（`/api/health` 的 `staleTraders`、
   * `selfcheck.ts` 的 `findDeterministicProblems()`）却被标成 `planned` ——
   * 于是界面写着"规划中"，实际在跑。`docs/FINDING-planned-roles-audit.md` §4 ④
   * 把这件事的定性写得很清楚：**那本身是一种说谎**。
   *
   * 反过来把真没实现的岗位标成"在跑"同样是说谎。所以"必须有一个明确分类"
   * 本身值得一条断言：它保证不会再有第三种两不管的中间地带。
   */
  const classified = new Set(['staffed', 'by_code', 'planned']);
  const unclassified = FIRM_ROLES.filter((r) => !classified.has(r.status)).map(
    (r) => `${r.label}(${r.id})=${String(r.status)}`,
  );
  assert.deepEqual(unclassified, [], `★ 这些岗位的实现状态没有明确分类：${unclassified.join('、')}`);

  /* 前置断言：语料必须真的读到（防止上面那条在空集合上通过）。 */
  assert.ok(FIRM_ROLES.length >= 20, `★ 只读到 ${FIRM_ROLES.length} 个岗位 —— firm.ts 可能没被正确加载`);
});

test('★★★ data_sentinel / ops_watchdog 必须标 by_code —— 界面写"规划中"而实际在跑就是说谎', () => {
  /*
   * ## 为什么这两个必须**同时**从 planned 里消失
   *
   * 它们的职责有实测证据（`docs/FINDING-planned-roles-audit.md` §2.1/2.2）：
   *   · `data_sentinel` → `api/server.ts` 的 `/api/health` 返回 `staleTraders`（线上实测 `[]`）；
   *   · `ops_watchdog`  → `trader/selfcheck.ts` 的 `findDeterministicProblems()`，
   *                      由 `selfcheckRunner.ts` 每 30 分钟调度。
   *
   * ## 为什么不把它们标成 `staffed`（这条是这个测试真正防的事）
   *
   * `staffed` 在界面上渲染成"在岗 / 待命 / 最近活跃于 X 分钟前" —— 全是**模型出勤**的措辞。
   * 而它们是 `T0_code` 岗位，**没有模型**：标成 `staffed` 等于让操作员等一个永远不来的出勤。
   *
   * ## 为什么这个测试存在（而不是靠注释提醒）
   *
   * `docs/AGENTS.md` §3.5：新测试要写清它防的那个 bug。这一条防的是**下一次"顺手全改"**：
   * 上面那条 planned 清单断言只说了"别的岗位不许变成 planned"，
   * 若有人把这两个**顺手也改回 planned**（或改成 staffed），只有这条会红。
   */
  const byCode = FIRM_ROLES.filter((r) => r.status === 'by_code').map((r) => r.id).sort();
  assert.deepEqual(
    byCode,
    ['data_sentinel', 'ops_watchdog'],
    '★ by_code 岗位清单变了 —— 新增一个"已由代码承担"的岗位前，必须先在 carriedBy 里写出承担它的模块',
  );

  const planned = FIRM_ROLES.filter((r) => r.status === 'planned').map((r) => r.id);
  for (const id of ['data_sentinel', 'ops_watchdog']) {
    assert.ok(
      !planned.includes(id),
      `★ ${id} 的职责已经在跑（见 docs/FINDING-planned-roles-audit.md §2）—— 不能再标 planned`,
    );
  }
});

test('★★★ by_code 岗位必须写明【由哪段代码承担】，而且那段代码真的存在', () => {
  /*
   * ## 为什么"已由代码承担"这句话必须带模块名
   *
   * 操作员无法"打开一个模型"去核对它在不在跑，但可以去看那段代码或那个端点。
   * 只写"已由代码承担"是一句**无法被核对**的话 —— 和原来的"规划中"一样不可证伪。
   * 所以 `carriedBy` 里必须有确切的模块/函数，并且这条测试去**仓库里核对它真的在**。
   *
   * ⚠️ 判据是"那个位置确实存在这样的符号"：
   *   · `data_sentinel` 的产出端点 → `server.ts` 里**真在构造响应体**（`staleTraders: health.stale.map(`）
   *     且判据常量仍是 `STALE_CYCLE_MULTIPLIER = 2`
   *   · `ops_watchdog` 的判据函数 → `selfcheck.ts` 里有 `findDeterministicProblems(` 的定义
   *
   * 它抓不住"字段被读了但读错了"（那需要数据流分析），但能抓住**这个岗位的承担物被删掉
   * 或改名了，而界面还在说"已经由代码承担"** —— 那就是一条会永远留在屏幕上的假话。
   */
  /**
   * 每个 `by_code` 岗位 → 去哪个文件、按什么**形状**核对它的承担物。
   *
   * ## ⚠️ 为什么是正则（锚到构造处）而不是 `includes('字段名')`
   *
   * 第一版判据是 `text.includes('staleTraders')` —— 那**太宽**：
   * 字段名出现在注释、类型声明、或者别处的变量名里都能骗过它，
   * 而真正要保证的是"**这个端点仍然把它写进响应体**"。
   * （本仓库对这种"判据比它要防的东西宽"的形态记过教训：
   *  `docs/FINDING-clerk-unwired.md` 2026-10-14 补充 —— 判据本身也需要校准。）
   */
  const PLACES: Record<string, { file: string; needles: Array<{ pattern: RegExp; what: string }> }> = {
    data_sentinel: {
      file: 'packages/server/src/api/server.ts',
      needles: [
        {
          /* 响应体里的字段构造：`staleTraders: health.stale.map(...)`。 */
          pattern: /staleTraders:\s*health\.stale\.map\(/,
          what: '响应体里构造 staleTraders（`staleTraders: health.stale.map(…)`）',
        },
        {
          /* 判据来源：周期倍数。 */
          pattern: /STALE_CYCLE_MULTIPLIER\s*=\s*2/,
          what: '判据常量 STALE_CYCLE_MULTIPLIER = 2',
        },
      ],
    },
    ops_watchdog: {
      file: 'packages/server/src/trader/selfcheck.ts',
      needles: [
        {
          /* 函数定义处（不是调用点）—— `export function findDeterministicProblems(`。 */
          pattern: /function findDeterministicProblems\(/,
          what: 'findDeterministicProblems() 的定义',
        },
      ],
    },
  };

  /* 前置断言：REPO_ROOT 必须算对 —— 否则"读不到文件"会变成一条静默的假绿。 */
  assert.ok(
    existsSync(path.join(REPO_ROOT, 'package.json')),
    `★ 仓库根算错了（${REPO_ROOT} 里没有 package.json）—— 这条测试将无法核对任何东西`,
  );

  for (const role of FIRM_ROLES.filter((r) => r.status === 'by_code')) {
    assert.ok(
      role.carriedBy !== undefined && role.carriedBy.trim().length >= 10,
      `★ ${role.id} 标了 by_code，却没有写清"由哪段代码承担"（carriedBy）`,
    );
    const place = PLACES[role.id];
    assert.ok(
      place !== undefined,
      `★ ${role.id} 新标为 by_code，但这条测试还不知道去哪核对它的承担物 —— ` +
        `请把它写进 PLACES 并说明承担它的模块`,
    );
    const file = path.join(REPO_ROOT, place.file);
    assert.ok(existsSync(file), `★ ${role.id} 的 carriedBy 指向的文件不存在：${place.file}`);
    const text = readFileSync(file, 'utf8');
    for (const { pattern, what } of place.needles) {
      assert.ok(
        pattern.test(text),
        `★ ${role.id} 声称由 ${place.file} 承担，但那个文件里找不到「${what}」（${pattern}）—— ` +
          `界面会一直说"已由代码承担"，而承担物已经不在了`,
      );
    }
  }
});

test('★★ `by_code` 必须是"没有 LLM 出勤"的岗位（tier 为 T0_code）', () => {
  /*
   * ## 为什么这条状态必须与档位一致
   *
   * `by_code` 对操作员的承诺是"这件事在跑，但**没有模型出勤**"。
   * 若哪天有人把 `data_sentinel` 的 tier 改成 `T1_fast`（想给它接个模型），
   * 状态与档位就开始互相矛盾：界面说"没有模型"，路由表却在给它排模型档位。
   *
   * ⚠️ 这条断言**会**在"把 by_code 岗位改造成 LLM 岗位"时变红 —— 那是刻意的：
   * 那个改造正是本仓库付过两次代价的形状（`engineer` 被删、`clerk` 未接线，
   * 见 `docs/FINDING-clerk-unwired.md`）。要做的话，得先改状态、并说明谁消费它的产出。
   */
  const wrongTier = FIRM_ROLES.filter((r) => r.status === 'by_code' && r.tier !== 'T0_code').map(
    (r) => `${r.label}(${r.id}): tier=${r.tier}`,
  );
  assert.deepEqual(
    wrongTier,
    [],
    `★ 这些岗位标了 by_code 但 tier 不是 T0_code（状态说"没有模型"，档位却在排模型）：${wrongTier.join('、')}`,
  );
});

/* -------------------------------------------------------------------------- */
/*  ★ t112：planned + carriedBy 的组合必须被约束（防有人删了字段而界面不变）      */
/* -------------------------------------------------------------------------- */

test('★★ planned 岗位的 carriedBy 只能是"随批运行"那一类，且必须写清承担者', () => {
  /*
   * ## 这个组合是 2026-10-17（t112）新加的，必须钉死边界
   *
   * `status: planned` + `carriedBy` 的语义是：
   * 「**没有专门为它出勤的模型**，但职责由**批量调研的猎手**顺带承担」。
   * 界面对这一类显示「随批运行」而不是「规划中（还没实现）」——
   * 因为后者会让操作员以为"根本没人干这件事"
   *（用户原话：「我观察到很多岗位，似乎从未真正运行过」）。
   *
   * ## 为什么这条断言必须存在
   *
   * 界面侧的判据是 `isBatchedRole()`（`web/.../roster.ts`），它读的就是 `carriedBy`。
   * 于是有两种漂移会让界面**悄悄说错话**而没有任何测试变红：
   * ```
   *   ① 有人删了 carriedBy                → 状态词变回"规划中"，但没人发现
   *   ② 有人给真未接线的岗位也加上 carriedBy → 它被点亮成"随批运行"（那是说谎）
   * ```
   * 这里把**允许的集合写死**：只有这两个岗位可以有 `planned + carriedBy`。
   * 新增一个必须同时改这条断言 —— 那是刻意的摩擦。
   */
  const BATCHED = ['community_monitor', 'onchain_analyst'];
  const actually = FIRM_ROLES.filter((r) => r.status === 'planned' && r.carriedBy !== undefined)
    .map((r) => r.id)
    .sort();
  assert.deepEqual(
    actually,
    [...BATCHED].sort(),
    `★ planned + carriedBy 的岗位集合变了：实际 [${actually.join('、')}]，期望 [${BATCHED.join('、')}] —— ` +
      '界面会把这一类显示成"随批运行"，所以每加一个都必须有真实承担者（否则就是点亮了没在跑的岗位）',
  );
  for (const id of BATCHED) {
    const role = FIRM_ROLES.find((r) => r.id === id);
    assert.ok(role, `★ 找不到 ${id}`);
    assert.ok(
      (role.carriedBy ?? '').trim().length >= 10,
      `★ ${id} 标了随批运行，却没写清由谁承担（carriedBy）—— 那句话无法被操作员核对`,
    );
    assert.ok(
      /猎手|hunter/.test(role.carriedBy ?? ''),
      `★ ${id} 的承担者必须点名到具体猎手（community_hunter / flow_hunter），实际：${role.carriedBy}`,
    );
  }
});

test('★★ 真未接线的三个岗位不得有 carriedBy（防止被顺手点亮）', () => {
  const UNWIRED = ['red_team', 'portfolio_manager', 'clerk'];
  for (const id of UNWIRED) {
    const role = FIRM_ROLES.find((r) => r.id === id);
    assert.ok(role, `★ 找不到 ${id}`);
    assert.equal(
      role.status,
      'planned',
      `★ ${id} 确实没有任何东西在替它跑（0 调用点）—— 必须仍是 planned`,
    );
    assert.equal(
      role.carriedBy,
      undefined,
      `★ ${id} 没有承担者，不能有 carriedBy —— 有的话界面会把它点亮成"随批运行"（那是说谎）`,
    );
  }
});
