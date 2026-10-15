/**
 * **交易台 7 个角色的提示词必须真的送达，且 `COMMON` 不能漂移**（2026-10-15）
 *
 * ## 背景：一次真实审计发现
 *
 * `tradingDesk` 会通过 `ask()` 问 **10 个角色**，而其中 **7 个原来不在 `ROLES` 里**：
 * ```
 *   supervisor · technical · newscaster · sentiment · bull · bear · judge
 * ```
 * 于是它们拿到的 system **只有 `tradingDesk` 里的内联短句**。实测长度：
 * ```
 *   technical  172 字   ← 全部内容只有「只做指标与形态的客观描述，不要给交易建议。」
 *   bull       186 字
 *   bear       215 字
 * ```
 * 而 `judge`（裁决官）与 `bull`/`bear`（多空对抗）是**决策核心** ——
 * 用户需求 ⑤ 的原话是「有歧义的决策…总管还会安排不同人开会讨论、**投票**」。
 *
 * ## 本文件钉住三件事
 *
 * ```
 *   ① 那 7 个角色现在都在 ROLES 里（且有实质长度的 system）
 *   ② deskRoles.ts 的 COMMON 与 roles.ts 的 COMMON【逐字一致】
 *      （它是复制的 —— 复制的风险是漂移，钉住漂移的办法是测试）
 *   ③ 提示词正文里【没有反引号】—— 它嵌在模板字符串里，
 *      一个反引号就会终止字符串、让整个文件语法错误（我为它返工过两次）
 * ```
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ROLES } from './roles.js';
import { DESK_ROLE_SPECS, type DeskRole } from './deskRoles.js';

const ROLES_SRC = readFileSync(new URL('./roles.ts', import.meta.url), 'utf8');
const DESK_SRC = readFileSync(new URL('./deskRoles.ts', import.meta.url), 'utf8');

/** 那 7 个角色（与 `deskRoles.ts` 的 `DeskRole` 一致）。 */
const DESK_ROLES: readonly DeskRole[] = [
  'supervisor',
  'technical',
  'newscaster',
  'sentiment',
  'bull',
  'bear',
  'judge',
];

test('★★★ 7 个交易台角色必须都在 ROLES 里，且有实质长度的提示词', () => {
  /*
   * ⚠️ 阈值取 800 字 —— 修复前它们的 system 是 172–1515 字，
   * 而**只有 `judge` 超过 800**。所以这个阈值能区分"补过了"与"只有内联短句"：
   * ```
   *   内联短句（technical 22 字 + 标识行 + 无工具说明）≈ 172–215 字
   *   补过的提示词 ≈ 1335–2874 字
   * ```
   */
  for (const role of DESK_ROLES) {
    assert.ok(role in ROLES, `★ 「${role}」必须在 ROLES 里（否则它的提示词到不了模型）`);
    const len = ROLES[role].system.length;
    assert.ok(
      len >= 800,
      `★★★ 「${role}」的 system 只有 ${len} 字 —— 太短，说明它又退化回"只有内联短句"了。\n` +
        `   ⇒ 这正是线上「决策核心角色只拿到一句任务短句」的根因。`,
    );
  }
});

test('★★★ deskRoles.ts 的 COMMON 必须与 roles.ts 的【逐字一致】', () => {
  /*
   * `deskRoles.ts` 复制了一份 `COMMON`（那是 `roles.ts` 的私有常量，不能 import）。
   * 复制的风险是漂移 —— 而钉住漂移的办法是测试，不是"记得同步"。
   *
   * 判据：从两个文件里各取一次那个常量，比对相等。
   * 取法用"从 const COMMON = ` 到下一个独立的反引号行" —— 不手写内容。
   */
  const grab = (src: string): string => {
    const at = src.indexOf('const COMMON = `');
    assert.ok(at > 0, '★ 必须能找到 const COMMON');
    const from = at + 'const COMMON = `'.length;
    const to = src.indexOf('`', from);
    assert.ok(to > from, '★ 必须能找到 COMMON 的结束反引号');
    return src.slice(from, to);
  };
  const a = grab(ROLES_SRC);
  const b = grab(DESK_SRC);
  assert.ok(a.length > 100, `★ 从 roles.ts 取到的 COMMON 太短（${a.length} 字）—— 判据可能失效`);
  assert.equal(
    b,
    a,
    '★★★ deskRoles.ts 的 COMMON 与 roles.ts 的不一致 —— 两份铁律已经漂移了',
  );
});

test('★★★ 提示词正文里不能有反引号（它会终止模板字符串）', () => {
  /*
   * 这不是"风格问题"，是**语法问题**：`deskRoles.ts` 的每个 `system` 都是
   * 模板字符串，正文里出现一个反引号就会**终止字符串**，
   * 于是 `tsc` 报一堆 "Invalid character"，而错误位置在几百行之后 ——
   * 极难定位（我为它返工过两次）。
   *
   * 判据：`system: \`...\`,` 这一段里不能有裸反引号。
   * 用"成对匹配"来取每段（第一个反引号到下一个反引号之间就是正文）。
   */
  const segments: string[] = [];
  let i = 0;
  for (;;) {
    const at = DESK_SRC.indexOf('system: `', i);
    if (at < 0) break;
    const from = at + 'system: `'.length;
    const to = DESK_SRC.indexOf('`', from);
    assert.ok(to > from, '★ 模板字符串没有结束反引号 —— 正文里可能混进了反引号');
    segments.push(DESK_SRC.slice(from, to));
    i = to + 1;
  }
  assert.ok(segments.length >= 7, `★ 只解析出 ${segments.length} 段 system，太少了`);
  for (const [n, seg] of segments.entries()) {
    assert.ok(
      !seg.includes('`'),
      `★ 第 ${n + 1} 段 system 的正文里有反引号 —— 那会终止模板字符串`,
    );
  }
});

test('★★ 每个交易台角色都要有 label（界面与日志用中文名）', () => {
  for (const role of DESK_ROLES) {
    assert.ok(
      DESK_ROLE_SPECS[role].label.length > 0,
      `★ 「${role}」缺 label`,
    );
    assert.equal(DESK_ROLE_SPECS[role].role, role, `★ 「${role}」的 role 字段必须与键一致`);
  }
});
