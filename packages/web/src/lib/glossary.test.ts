/**
 * **同一个概念只允许有一个用户可见名称**（2026-10-17 · 台账 UI-10 / 用户实测 U-2）。
 *
 * ## 这条守卫接的是什么
 *
 * 用户原话：「**智能托管模式 / 普通模式不清楚**」。查下来是同一件事有多个名字：
 * ```
 *   strategy 模式   固定策略（列表徽章）/ 普通（总览分布）/ 按策略参数（创建弹窗）
 *   页面            策略工作室（侧栏）/ 策略工坊（页面标题、返回链接、FAQ）
 *   三套模板        稳健/进取/短线（shared 的 label）/ 保守/激进/短线（编辑器按钮）
 * ```
 * 每个名字单独看都说得通，合起来就变成"用户要先判断这两个名字是不是一回事" ——
 * 而那正是他说的"不清楚"。
 *
 * ## 判据
 *
 * 1. `MODE_LABEL` 覆盖**全部** `TraderMode` 取值，且名称就是约定的那三个
 *    （期望值**写死在测试里**，不从 `MODE_LABEL` 自身派生 —— 否则改了名字测试跟着改，
 *    等于没测）；
 * 2. 源码的**字符串字面量**里不出现任何**禁用别名**
 *    （禁用清单在 `glossary.ts`，理由逐条写在注释里）。
 *
 * ⚠️ 扫的是字符串字面量：注释里允许出现旧名字（那些注释恰恰在记录"为什么改名"）。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { BANNED_ALIASES, MODE_HINT, MODE_LABEL, PAGE_LABEL, paperLabel, presetLabel } from './glossary';

const WEB_SRC = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (['node_modules', 'dist', '.git'].includes(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function maskComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    const three = text.slice(i, i + 3);
    if (three === '{/*') {
      const end = text.indexOf('*/}', i);
      const stop = end === -1 ? text.length : end + 3;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = text.indexOf('*/', i);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (two === '//') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

const LITERAL = /'([^'\\\n]|\\.)*'|"([^"\\\n]|\\.)*"|`([^`\\]|\\.)*`/g;

/** 字符串字面量的**内容**（去掉引号，保留转义原样）。 */
function literalBodies(source: string): string[] {
  const masked = maskComments(source);
  const bodies: string[] = [];
  for (const m of masked.matchAll(LITERAL)) {
    bodies.push(m[0].slice(1, -1));
  }
  return bodies;
}

/** 什么样算"用户可见名称里的禁用别名"。 */
function aliasOffendersIn(bodies: readonly string[]): string[] {
  const hits: string[] = [];
  for (const body of bodies) {
    for (const alias of BANNED_ALIASES) {
      if (body.includes(alias)) hits.push(`${alias} ← ${body.slice(0, 60)}`);
    }
    /* 整词「普通」也禁：它作为**模式名**的用法已经全部换成 `MODE_LABEL.strategy`。 */
    if (body.trim() === '普通') hits.push(`普通 ← ${body}`);
  }
  return hits;
}

test('★ 三种模式的用户可见名称必须唯一且齐全', () => {
  assert.deepEqual(
    Object.keys(MODE_LABEL).sort(),
    ['ai_managed', 'ai_team', 'strategy'],
    '★ `MODE_LABEL` 必须覆盖全部 TraderMode（VALUE 顺序无关，键必须齐全）',
  );
  assert.equal(MODE_LABEL.strategy, '固定策略', 'strategy 的名字由本用例钉住（改名字要改这里）');
  assert.equal(MODE_LABEL.ai_managed, '智能托管');
  assert.equal(MODE_LABEL.ai_team, 'AI 团队');
  /* 每种模式都要有一句"代价"说明 —— 用户靠它决定要不要一直开着。 */
  for (const mode of ['strategy', 'ai_managed', 'ai_team'] as const) {
    assert.ok(MODE_HINT[mode].length > 6, `★ ${mode} 的 hint 不能是空话`);
  }
});

test('★ 页面名与模板名也各只有一份', () => {
  assert.equal(PAGE_LABEL.strategy, '策略工作室');
  /* 三套模板的名字来自共享包，取不到时**回落到 id**（不编第三个中文名）。 */
  assert.equal(presetLabel('conservative'), '稳健');
  assert.equal(presetLabel('aggressive'), '进取');
  assert.equal(presetLabel('scalping'), '短线');
  assert.equal(presetLabel('不存在的预设'), '不存在的预设');
});

test('★ 模拟盘 / 实盘是**三态**，未知不许显示成实盘', () => {
  assert.equal(paperLabel(true), '模拟盘');
  assert.equal(paperLabel(false), '实盘');
  assert.equal(paperLabel(null), '未知（未在运行）');
});

test('★★★ 源码的字符串字面量里不得再出现任何禁用别名', () => {
  const files = walk(WEB_SRC);
  assert.ok(files.length >= 50, `★ 只扫到 ${files.length} 个文件 —— 扫描可能失效了`);

  /*
   * ⚠️ **唯一豁免：登记表自己**（`lib/glossary.ts`）。
   *
   * 它必须**写出**这些别名才能禁掉它们（`BANNED_ALIASES` 是字符串数组，
   * `MODE_LABEL` 的注释里也要点名旧写法）—— "登记处提到别名"与
   * "界面里用了别名"是两件事。
   *
   * 豁免要**自证**（下面两条前置断言）：文件存在、且它确实是登记表
   * （含 `BANNED_ALIASES` 与 `MODE_LABEL`）—— 否则有人把别名挪进一个
   * 恰好叫这个名字的空文件就能绕过判据。
   */
  const REGISTRY = 'lib/glossary.ts';
  const registryPath = files.find((f) => f.slice(WEB_SRC.length).replace(/\\/g, '/') === REGISTRY);
  assert.ok(registryPath !== undefined, `★ 豁免的文件必须存在：${REGISTRY}`);
  const registrySource = readFileSync(registryPath!, 'utf8');
  assert.ok(registrySource.includes('BANNED_ALIASES'), '★ 豁免的必须是登记表（含 BANNED_ALIASES）');
  assert.ok(registrySource.includes('MODE_LABEL'), '★ 豁免的必须是登记表（含 MODE_LABEL）');

  let bodies = 0;
  const offenders: string[] = [];
  for (const file of files) {
    const rel = file.slice(WEB_SRC.length).replace(/\\/g, '/');
    if (rel === REGISTRY) continue;
    const source = readFileSync(file, 'utf8');
    const own = literalBodies(source);
    bodies += own.length;
    for (const hit of aliasOffendersIn(own)) {
      offenders.push(`${rel}: ${hit}`);
    }
  }
  /* 前置断言：字面量太少说明扫描坏了（"零违规"不能是因为什么都没扫到）。 */
  assert.ok(bodies >= 2000, `★ 只扫到 ${bodies} 个字符串字面量 —— 扫描可能失效了`);

  assert.deepEqual(
    offenders,
    [],
    '★★★ 这些字符串字面量里还留着旧名字（同一个概念两个名字，用户就要自己判断）：\n' +
      offenders.map((o) => `      · ${o}`).join('\n') +
      '\n    ✅ 修法：从 `lib/glossary.ts` 取名字（`MODE_LABEL` / `PAGE_LABEL` / `presetLabel`）。',
  );
});

test('★★ 判据必须真的报得出来，而且不误伤注释 —— 用人造源码校准', () => {
  /* ① 旧名出现在字符串里 → 必须报。 */
  assert.deepEqual(aliasOffendersIn(['按策略参数']).length, 1, '★ 旧模式名必须报');
  assert.deepEqual(aliasOffendersIn(['策略工坊']).length, 1, '★ 旧页面名必须报');
  assert.deepEqual(aliasOffendersIn(['保守']).length, 1, '★ 旧模板名必须报');
  assert.deepEqual(aliasOffendersIn(['普通']).length, 1, '★ 整词「普通」必须报');

  /* ② 新名字不能误报。 */
  assert.deepEqual(aliasOffendersIn(['固定策略', '策略工作室', '稳健', '智能托管']), [], '★ 新名字不能被误报');

  /* ③ 注释里的旧名不能误报（那些注释在解释改名原因）。 */
  assert.deepEqual(aliasOffendersIn(literalBodies('// 原来叫「按策略参数」，改成 MODE_LABEL')), [], '★ 行注释不误报');
  assert.deepEqual(aliasOffendersIn(literalBodies('/* **策略工坊** 是旧名 */')), [], '★ 块注释不误报');
  assert.deepEqual(aliasOffendersIn(literalBodies('{/* 旧名：保守 */}')), [], '★ JSX 注释不误报');

  /* ④ "普通"出现在一句话里（不是模式名）不误报 —— 判据只抓整词字面量。 */
  assert.deepEqual(aliasOffendersIn(['这是一张普通表格']), [], '★ 正常中文里的"普通"不误报');
});
