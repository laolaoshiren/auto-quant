/**
 * **复盘失败必须留痕**（2026-10-15）
 *
 * ## 事故：团队模式的复盘 100% 静默死亡，而日志里一条错误都没有
 *
 * 两个独立审计各自抓到同一件事：
 * ```
 *   #11（ai_team）  :  39 笔成交 · agent_memory 【0 行】·「机器人 #11 复盘」日志 0 条
 *   #10（ai_managed）: 192 笔成交 · agent_memory 111 行 ·「机器人 #10 复盘」日志 111 条
 *   ⇒ 团队模式【从未从自己的交易结果里学到任何东西】
 * ```
 *
 * ## 两层根因
 *
 * ```
 *   ① `runSingleShot` 的 system 不含 agent 层标记
 *      → 复盘调用被团队模型当成"交易决策" → 跑整场 8 角色会议
 *      → 拿回 <decision> 文本 → 解析不出 lesson → 返回 {ok:false}
 *      （由 `toolLoopRouting.test.ts` 的另一条测试钉住）
 *
 *   ② `runtime.ts` 只写了 `if (r.ok) log.info(...)`，【没有 else】
 *      → `runReviewTrade` 是"正常返回 {ok:false}"，不是抛异常
 *      → 于是 `catch` 那一支也不会触发
 *      → **既没有异常、也没有日志** —— 从任何界面与日志都看不出它从未学习过
 * ```
 *
 * ⚠️ **"返回失败"与"抛异常"是两条不同的路，只记其中一条等于半盲。**
 * 这个仓库反复记过同一类教训：**静默失败的路径比会报错的路径危险得多。**
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { codeOnly } from '../../testUtils/sourceText.js';

const RUNTIME = readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8');

test('★★★ 复盘失败（ok:false）必须写日志 —— 不能只有 if (r.ok)', () => {
  const code = codeOnly(RUNTIME);

  /* 必须有 else 分支（或等价的失败日志）。 */
  assert.ok(
    /if \(r\.ok\)[\s\S]{0,400}?\}\s*else\s*\{/.test(code),
    '★ `if (r.ok)` 必须有 else —— 否则 ok:false 这条路完全静默',
  );
  /* 失败那一支必须真的写日志。 */
  const elseAt = code.search(/\}\s*else\s*\{/);
  assert.ok(elseAt > 0, '★ 应当能找到 else 分支');
  const elseBody = code.slice(elseAt, elseAt + 700);
  assert.ok(
    /log\.(warn|info|error)\(/.test(elseBody),
    '★ 失败分支必须写日志（否则"它从未学习过"这件事在运维眼里不存在）',
  );
  /*
   * ⚠️ 日志必须提到"未产出教训"或等价说法，并且**说明不影响交易** ——
   * 复盘是附加能力，不该让操作员以为出了大事。
   */
  assert.ok(
    /未产出教训|没有产出教训|复盘失败/.test(elseBody),
    '★ 日志要说清是"没产出教训"，而不是一句无信息的 warn',
  );
  assert.ok(
    /不影响交易/.test(elseBody),
    '★ 要说清它不影响交易（复盘是附加能力，不该让人以为出了大事）',
  );
});

test('★★★ 失败日志必须带原因（否则"为什么学不到"仍然是个谜）', () => {
  const code = codeOnly(RUNTIME);
  const elseAt = code.search(/\}\s*else\s*\{/);
  const elseBody = code.slice(elseAt, elseAt + 700);
  assert.ok(
    /r\.error/.test(elseBody),
    '★ 必须把 r.error 打进日志 —— 它是"为什么学不到"的唯一线索',
  );
});
