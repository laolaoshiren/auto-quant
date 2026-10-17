/**
 * **策略编辑器的"套预设"接线必须仍然是"整份替换"**（台账 `NTM-03`）。
 *
 * ## 为什么用「源码结构断言」而不是行为测试
 *
 * 本仓库的 web 测试脚本是 `tsx --test "src/**\/*.test.ts"`，**没有 jsdom / RTL**
 * —— 挂不了组件、点不了 `<select>`（同一取舍见 `strategyEditorSave.test.ts` 的文件头）。
 * 而本缺陷的根因是**接线**：套预设那一步到底是
 *   · 以"当前草稿"为底叠 patch（旧写法，会把上一份预设的值带过来），还是
 *   · 以 schema 默认值为底叠 patch（本修复）；
 * 以及解析失败时是**静默不动**还是**说出来**。
 * 两件事都在源码结构上完全可观测。
 *
 * ## 这些断言不是恒真式
 *
 * 每一条都对应一种**会重新引入缺陷的具体写法**（见每条 `assert` 的说明）。
 * 负向校准见任务包裹：把 `resolvePreset(preset)` 换回
 * `applyPreset(state.config, preset)` 后，第 2 条断言会变红（已实测）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const EDITOR = readFileSync(new URL('../pages/StrategyEditorPage.tsx', import.meta.url), 'utf8');
const LIB = readFileSync(new URL('./strategy.ts', import.meta.url), 'utf8');

/**
 * 去掉注释再断言 —— **注释里出现被禁的写法不算违反**。
 *
 * ⚠️ 这条不是洁癖：本修复刻意把"原来的写法"写进注释（那个写法正是缺陷本身，
 * 不写下来下一个人就会把它加回来），于是"源码里不得出现 X"这类断言必须只看代码。
 * （`testUtils/sourceText.js` 的 `codeOnly()` 是同一手法，但那在 server 包里。）
 */
function codeOnly(source: string): string {
  /* 按行剥 `//`，再整体去掉块注释（本仓库没有正则字面量里带 `/* ` 的用法）。 */
  return source
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//');
      return at >= 0 ? line.slice(0, at) : line;
    })
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** 取名为 `name` 的函数体的配平切片（从 `{` 到配平 `}`）。 */
function bodyOf(source: string, name: string): string {
  const at = source.indexOf(name);
  assert.ok(at >= 0, `★ 前提：源码里必须能找到 ${name}`);
  const open = source.indexOf('{', at);
  assert.ok(open > 0, `★ 前提：${name} 的函数体应当存在`);
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  assert.fail(`★ 前提：${name} 的函数体配平失败`);
}

const DRAFT = bodyOf(EDITOR, 'const applyPresetToDraft =');

test('★★★ 套预设必须从 schema 默认值解析（`resolvePreset(preset)`），不得以当前草稿为底', () => {
  /*
   * 正向：`resolvePreset(preset)` 必须出现。
   * 反向：函数体里**不得**出现 `applyPreset(state.config, …)` ——
   * 那正是旧写法（把当前草稿当底），它会把上一份预设的 `indicators` /
   * `drawdownGuard` 带过来。用一条能命中两种写法的正则同时钉住两端。
   */
  assert.match(
    DRAFT,
    /resolvePreset\(\s*preset\s*\)/,
    '★★★ applyPresetToDraft 必须调 `resolvePreset(preset)` —— ' +
      `它是"先重置到该预设、再叠 patch"的唯一实现（第 ${lineOf(EDITOR, EDITOR.indexOf('const applyPresetToDraft ='))} 行起）`,
  );
  assert.equal(
    /applyPreset\(\s*state\.config/.test(DRAFT),
    false,
    '★★★ applyPresetToDraft 不得再把当前草稿当底传给 applyPreset —— ' +
      '那个写法会让"短线 → 稳健"留下短线的回撤守卫（activationPercent=0.4），' +
      '而提示词与徽章都按"稳健"渲染',
  );
});

test('★★★ 解析失败必须说出来，不得静默不动（旧实现的 `safeParse ? data : current`）', () => {
  /*
   * 旧实现在 `safeParse` 失败时 `return current` —— 草稿一个字不变，
   * 而提示语照样弹"已应用"。这里断言套预设这一步有 `try/catch` 且 catch 里
   * 调用了 `setError`。
   */
  assert.match(DRAFT, /catch\s*\(/, '★★★ 套预设必须有失败分支（解析可能抛错）');
  assert.match(
    DRAFT,
    /setError\(/,
    '★★★ 解析失败必须 `setError(...)` 把原因显示出来 —— ' +
      '静默不动等于"它告诉你成功了，而什么都没发生"',
  );
});

test('★★★ `presetId` 只是自证锚点：显示必须再核对一次配置（`activePreset`）', () => {
  /*
   * 库里 `strategies.preset_id` 只记"从哪份模板克隆来的"，且
   * `PATCH /api/strategies/:id` 根本不收它（`api/server.ts:1662-1667`）——
   * 所以显示层读它必然会在"克隆后又手改"的场景说假话。
   * 断言：编辑器确实从配置派生了一个变量，并用它决定回显。
   */
  assert.match(
    EDITOR,
    /const\s+activePresetNow\s*=\s*activePreset\(/,
    '★★★ 编辑器必须从**配置**派生"当前等于哪份预设"',
  );
  /*
   * 取「应用预设」这个 `<Select>` 的 `value={…}`。
   *
   * ⚠️ 不能用"从 aria-label 往后找第一个 `{`"那种切法：JSX 里 `value` 之后还有
   * `onChange={(event) => …}`，第一个平衡块会命中 **onChange** 而不是 value ——
   * 这条断言第一次写出来时就是这样**假红**的（切到了 `(event) => …`）。
   * 所以这里**向前**找最近的 `value={…}`。
   */
  const labelAt = EDITOR.indexOf('aria-label="应用预设"');
  assert.ok(labelAt > 0, '★ 前提：找得到「应用预设」这个 Select');
  const valueAt = EDITOR.lastIndexOf('value={', labelAt);
  assert.ok(valueAt > 0, '★ 前提：这个 Select 有 value 属性');
  const valueExpr = EDITOR.slice(valueAt, EDITOR.indexOf('aria-label="应用预设"', valueAt));
  assert.match(
    valueExpr,
    /value=\{\s*activePresetNow\?\.id/,
    '★★★ 预设下拉框的回显必须用派生值，不得直接读 `state.presetId` —— ' +
      '那个字段在"克隆后手改"时不更新，于是回显"稳健"而参数已经是别的',
  );
  assert.equal(
    /value=\{\s*state\.presetId/.test(valueExpr),
    false,
    '★★★ 回显不得再读 `state.presetId`（构造那条会把库里的过期标签当成真相）',
  );
});

test('★★★ 手动改配置必须清掉 `presetId`（否则徽章与下拉框会继续说旧预设名）', () => {
  for (const fn of ['const patchConfig =', 'const patchHeader =']) {
    const body = bodyOf(EDITOR, fn);
    assert.match(
      body,
      /presetId:\s*null/,
      `★★★ ${fn.slice(6)} 必须把 presetId 置空 —— ` +
        '手动改任何一处之后这份草稿已经不等于任何预设，而徽章/下拉框读的就是它',
    );
  }
});

test('★★★ `applyPreset(current, preset)` 这个"以草稿为底"的入口必须彻底不存在', () => {
  /*
   * 它是本缺陷的载体：签名逼调用方交出一份"当前配置"，而那条路会把**未在 patch 里
   * 声明的字段**从上一份预设继承过来（`indicators` / `drawdownGuard` 三套预设
   * 声明得不一样）。删掉它比"记得不要传"可靠 —— 所以这里断言它真的没了。
   *
   * ⚠️ 只看**代码**（`codeOnly`）：本文件与 `strategy.ts` 的注释里刻意写着
   * "原来的写法是什么"（不写下来下一个人就会加回去），那些文字不算违反。
   */
  assert.equal(
    /export function applyPreset/.test(codeOnly(LIB)),
    false,
    '★★★ lib/strategy.ts 不得再导出 `applyPreset` —— 套预设只能走 `resolvePreset(preset)`',
  );
  assert.match(
    codeOnly(LIB),
    /export function resolvePreset|resolvePreset,|resolvePreset\b/,
    '★ 前提：`resolvePreset` 仍然从这里被引用（否则这条守卫盯错了文件）',
  );
});

test('★★★ 策略仓库那一层的"新建自预设"也必须走同一份解析（否则两条入口给两份配置）', () => {
  /*
   * `StrategyListPage` 的"从预设新建"是**第二条套预设的入口**（它走
   * `applyPreset(cloneConfig(base), preset)`）。两条入口若各实现一份合并，
   * 就会"在列表页从预设新建"与"在编辑器里套预设"得到不同的配置 ——
   * 而它们在看板上长得一模一样。
   *
   * 这里断言列表页**不再自己合并**，而是用共享包的 `resolvePreset`。
   */
  const listPage = codeOnly(readFileSync(new URL('../pages/StrategyListPage.tsx', import.meta.url), 'utf8'));
  assert.equal(
    /applyPreset\(/.test(listPage),
    false,
    '★★★ StrategyListPage 不得再调 `applyPreset`（那条浅合并入口已废弃）—— 改用 `resolvePreset`',
  );
  assert.match(
    listPage,
    /resolvePreset\(/,
    '★★★ StrategyListPage 的"从预设新建"必须用共享包的 `resolvePreset`',
  );
  assert.match(
    listPage,
    /cloneConfig/,
    '★ 前提：「复制策略」那条路径仍然需要 cloneConfig（不要顺手把它删掉）',
  );
});
