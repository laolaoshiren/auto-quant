/**
 * **角色的系统提示词必须真的送进模型**（2026-10-15 修，一次"提示词写了但没用上"事故）
 *
 * ## 事故：`ROLES` 里的提示词，一部分从未到达模型
 *
 * `ask()`（`routedModel.ts`）原来拼的是：
 * ```
 *   `你是交易台的「${role}」。${task}`
 * ```
 * 而 `task` 全是 `tradingDesk.ts` 里的**内联短句** —— 于是 `roles.ts` 里
 * 精心写的那份 `system`（风控官的 `lossScenarios`、`symbol_scout` 的输出契约…）
 * **到不了模型**。
 *
 * ## 线上印证
 *
 * `decision_records` 里含 `<risk>` 的记录 **223 条**，其中含 `lossScenarios`
 * 的 **0 条**、含 `checked` 的 **0 条** —— 而那两个字段**只写在那份从未到达的
 * 提示词里**（`grep lossScenarios packages/` 只在 `roles.ts` 与测试里出现）。
 *
 * ## ⚠️ 我写这条测试时，前两版判据都是错的（都抓到了，记在这里）
 *
 * ```
 *   第一版：用 system 的【首 40 字符】做签名
 *     → 10 个角色的首 40 字符完全相同（都是 COMMON 前缀）
 *     → 检查它等于检查"有没有拼任何 ROLES 的 system" → 【假阳性】
 *
 *   第二版：用 system 的【最后 120 字符】做签名
 *     → 实际发出的 system 在角色提示词【之后】还拼了"你没有工具"那段
 *     → 收尾被挤到中间，`includes` 失败 → 【假阴性】
 * ```
 *
 * **教训：判据必须能区分"我要检查的那个东西"与"别的东西"。**
 * 所以这一版用**每个角色独有的中段子串**，并且先从源码里把那段子串取出来
 *（不手写 —— 手写清单会漂移，这个仓库为它付过代价）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createTeamDecisionModel } from './routedModel.js';
import { ROLES } from './agent/roles.js';

const DESK = readFileSync(new URL('./agent/tradingDesk.ts', import.meta.url), 'utf8');

/**
 * **够真实的行情材料**（让 `AQ_PER_SYMBOL` 那条分支真的进得去）。
 *
 * ⚠️ 我第一版用的是 `'## 候选池\nBTCUSDT'` —— 而 `splitMarketContext()`
 * 的判据是 `HEADING = /^### (\d+)\. (\S+?)(?:（|\s*$)/`，且**少于 2 个标的
 * 直接返回 `null`**。于是 `symbol_scout` 那条分支根本没进，测试报"未送达"，
 * 而真相是**这一轮压根没问它**。
 *
 * **教训：判据要喂真实输入，否则测的是"我的假材料"。**
 */
const REAL_MARKET_CONTEXT = [
  '## 候选池总览',
  '| 标的 | 24h |',
  '| BTCUSDT | +1.2% |',
  '',
  '### 1. BTCUSDT（coinpool）',
  '15m: 67000, 67100, 67200',
  '1H: 66800, 66900, 67000',
  '',
  '### 2. ETHUSDT（coinpool）',
  '15m: 3500, 3510, 3520',
  '1H: 3480, 3490, 3500',
  '',
  '### 3. SOLUSDT（ai_requested）',
  '15m: 150, 151, 152',
  '1H: 148, 149, 150',
].join('\n');

/** 假 router：记下每次实际发出的 system。 */
function captureSystems(): { systems: string[]; model: ReturnType<typeof createTeamDecisionModel> } {
  const systems: string[] = [];
  const model = createTeamDecisionModel({
    router: {
      callByTier: async (_t: unknown, messages: Array<{ role: string; content: string }>) => {
        systems.push(messages.find((m) => m.role === 'system')?.content ?? '');
        return { text: '{"note":"ok"}', modelId: 'fake', usage: {} };
      },
    },
    singleModel: { complete: async () => ({ text: '', usage: {}, latencyMs: 0 }) },
  } as never);
  return { systems, model };
}

/**
 * 取某角色 `system` 里**独有**的一段（用于判断它有没有真的被送出）。
 *
 * ⚠️ 做法：去掉所有角色共有的 `COMMON` 前缀（= 最长的公共前缀），
 * 再从剩下的部分取一段。这样得到的子串**只属于这个角色**。
 */
function uniqueSegment(system: string, all: readonly string[]): string {
  /* 求所有 system 的最长公共前缀长度。 */
  let common = 0;
  const first = all[0] ?? '';
  while (common < first.length && all.every((s) => s[common] === first[common])) common += 1;
  const rest = system.slice(common);
  /* 取中段 60 字符（避开可能的尾部拼接）。 */
  const start = Math.floor(rest.length / 3);
  const seg = rest.slice(start, start + 60);
  return seg.length >= 20 ? seg : rest.slice(0, 60);
}

test('★★★ 每个走 ask() 的角色，它的 system 必须真的送进模型', async () => {
  /*
   * ⚠️ **`symbol_scout` 只在 `AQ_PER_SYMBOL=on` 时被问**（见 `tradingDesk.ts`
   * 那个分支）—— 而线上确实开着（实测 `/opt/autoquant/.env` 里
   * `AQ_PER_SYMBOL=on`）。所以这里必须把它打开，否则这条测试
   * **测不到那个角色**（我第一版就是这样漏掉的：测试报"未送达"，
   * 而真相是"这一轮根本没问它"）。
   *
   * 这类"判据没覆盖到目标"的错误比"判据写松了"更隐蔽 ——
   * 它会让人去修一个不存在的 bug。
   */
  const prev = process.env['AQ_PER_SYMBOL'];
  process.env['AQ_PER_SYMBOL'] = 'on';
  try {
    const all = Object.values(ROLES).map((r) => r.system);
    const { systems, model } = captureSystems();

    /* 跑一次团队会议 —— 它会经 `ask()` 问多个角色。 */
    try {
      await model.complete(
        '你是交易台。请基于材料给出决策。',
        REAL_MARKET_CONTEXT,
      );
    } catch {
      /* 抛错不影响：我们只看已经发出的 system。 */
    }
    assert.ok(systems.length > 0, '★ 应当至少发出一次调用（否则这条测试没测到东西）');

    /*
     * 从 `tradingDesk` 源码里取它实际会问的角色（`role: 'x'`）——
     * **不手写清单**（手写会漂移）。
     */
    const code = DESK.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const asked = new Set(
      [...code.matchAll(/role:\s*'([a-z_]+)'/g)].map((m) => m[1] as string),
    );

    /*
     * 只检查"既在 ROLES 里、又被 ask() 问"的角色 —— 那是本次修复的范围。
     * ⚠️ 其余角色（`judge`/`bull`/`bear`/…）**根本不在 ROLES 里**，
     * 它们从来就没有 system 可送（那是另一件事：编制表不完整）。
     * 这里如实按交集检查，不假装覆盖了全部。
     */
    const inScope = [...asked].filter((r) => r in ROLES).sort();
    assert.ok(inScope.length >= 3, `★ 交集角色太少（${inScope.length}）—— 判据可能失效了`);

    /*symbol_scout 只在材料能切出 per-symbol 片段时被问 —— 必须真的触发到。 */
    assert.ok(
      inScope.includes('symbol_scout'),
      '★ 测试材料没能触发 symbol_scout（应当能切出 3 个标的的片段）—— ' +
        `交集是 ${inScope.join(', ')}。判据本身失效了。`,
    );

    for (const role of inScope) {
      const seg = uniqueSegment(ROLES[role as keyof typeof ROLES].system, all);
      assert.ok(
        systems.some((s) => s.includes(seg)),
        `★★★ 「${role}」的 system 没有送进模型 —— 它独有的那段「${seg.slice(0, 30)}…」` +
          `在 ${systems.length} 次实际调用里都找不到。\n` +
          `   ⇒ 这正是线上「<risk> 223 条、含 lossScenarios 0 条」的根因。`,
      );
    }
  } finally {
    if (prev === undefined) delete process.env['AQ_PER_SYMBOL'];
    else process.env['AQ_PER_SYMBOL'] = prev;
  }
});

test('★★★ 「你没有工具」的说明必须仍然在（那是另一条独立纪律）', async () => {
  /*
   * 修提示词接线时最容易的错是**把原来拼的东西挤掉**。
   * 这条钉住 2026-10-12 那次修复（模型反复"打算取数"、被拖到 299 秒）。
   */
  const { systems, model } = captureSystems();
  try {
    await model.complete('你是交易台。请基于材料给出决策。', '## 候选池\nBTCUSDT\n\n## 任务\n给出决策');
  } catch {
    /* 同上 */
  }
  assert.ok(systems.length > 0, '★ 应当至少发出一次调用');
  for (const [i, s] of systems.entries()) {
    assert.ok(
      s.includes('你没有工具'),
      `★ 第 ${i + 1} 次调用的 system 里没有"你没有工具"说明 —— ` +
        `模型会以为它能取数（实测被拖到 299 秒）。`,
    );
  }
});

test('★★★ tradingDesk 问的角色里，哪些不在 ROLES —— 如实记录这个缺口', () => {
  /*
   * ⚠️ 这条**不是**断言"没有缺口"，而是把缺口**钉成可见的事实**。
   *
   * 现状：`tradingDesk` 问 10 个角色，其中 7 个（`judge` / `bull` / `bear` /
   * `supervisor` / `technical` / `newscaster` / `sentiment`）**不在 `ROLES` 里** ——
   * 它们没有系统提示词，只有 `tradingDesk` 里的内联 task 短句。
   *
   * 所以"6/10 角色的提示词没送到"这个说法**不准确**：真相是
   * **那 7 个角色根本没有提示词可送**（编制表不完整），
   * 而 `ROLES` 里有的那几个，本次修复后已经能送达。
   *
   * 一旦将来给它们补上 `ROLES` 条目，这条测试会失败 → 提示把下面这个数字改掉。
   * 那正是我们要的：**缺口数量变化必须被看见**。
   */
  const code = DESK.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const asked = new Set([...code.matchAll(/role:\s*'([a-z_]+)'/g)].map((m) => m[1] as string));
  const missing = [...asked].filter((r) => !(r in ROLES)).sort();
  assert.deepEqual(
    missing,
    ['bear', 'bull', 'judge', 'newscaster', 'sentiment', 'supervisor', 'technical'],
    '★ 不在 ROLES 里的角色集合变了 —— 若是补上了提示词，请更新这份预期（那是好消息）',
  );
});

test('★★★ 风控官必须收到那份含 `lossScenarios` 的契约（线上 223 条 0 命中的根因）', async () => {
  /*
   * ## 这是本次修复**最强、最不会误判**的判据
   *
   * `lossScenarios` 与 `checked` **只写在 `ROLES.risk_officer.system` 里**
   *（`grep` 全仓库：只在 `roles.ts` 与测试里出现）。所以：
   * ```
   *   风控官收到的 system 里有 lossScenarios  ⇒ 契约送达了
   *   没有                                    ⇒ 只有内联短句
   * ```
   * 而线上实测：含 `<risk>` 的 **223 条**记录里，`lossScenarios` 出现 **0 次** ——
   * 这就是"提示词写了但从未到达模型"的铁证。
   *
   * ## 为什么要用一个"能产出真实动作"的桩
   *
   * 风控官**只在有真实动作时才被叫**（fail-closed 设计，见 `teamModel.test.ts`
   * 那条"有真实动作时必须叫风控官"的守卫）。所以这里让 `judge` 输出一条
   * 真实的 `open_long` —— 否则风控官根本不会被问，这条测试会变成摆设。
   */
  const seen: Array<{ role: string; system: string }> = [];
  const model = createTeamDecisionModel({
    router: {
      callByTier: async (_t: unknown, msgs: Array<{ role: string; content: string }>) => {
        const system = msgs.find((m) => m.role === 'system')?.content ?? '';
        const role = system.includes('「')
          ? system.slice(system.indexOf('「') + 1, system.indexOf('」'))
          : '?';
        seen.push({ role, system });
        if (role === 'risk_officer') {
          return { text: '批准。仓位与当前敞口匹配。', modelId: 'f', usage: {} };
        }
        if (role === 'judge') {
          return {
            text:
              '```json\n[{"symbol":"BTCUSDT","action":"open_long","leverage":3,' +
              '"positionSizeUsd":100,"stopLoss":60000,"takeProfit":70000,' +
              '"confidence":70,"reasoning":"测试"}]\n```',
            modelId: 'f',
            usage: {},
          };
        }
        return { text: `我是 ${role}，这是我的产出。`, modelId: 'f', usage: {} };
      },
    },
    baseMaxTokens: 4096,
  } as never);

  await model
    .complete('你是交易员。必须把决策放在 <decision> 块里。', '当前市场材料……')
    .catch(() => undefined);

  const ro = seen.find((s) => s.role === 'risk_officer');
  assert.ok(
    ro !== undefined,
    `★ 风控官必须被叫（有真实开仓动作）—— 实际调用了：${seen.map((s) => s.role).join(', ')}`,
  );
  assert.ok(
    ro.system.includes('lossScenarios'),
    '★★★ 风控官收到的 system 里没有 `lossScenarios` —— 那份契约又没送到。\n' +
      '   ⇒ 这正是线上「<risk> 223 条、含 lossScenarios 0 条」的根因。',
  );
  assert.ok(
    ro.system.includes(ROLES.risk_officer.system.slice(0, 40)),
    '★ 风控官收到的应当是 `ROLES.risk_officer.system`（不只是内联短句）',
  );
});
