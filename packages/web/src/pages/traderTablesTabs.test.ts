/**
 * **`TraderTables` 的"显示哪些标签"与"渲染哪张表"必须一致**（issue #184 的收尾）。
 *
 * ## 这条守卫接的是什么
 *
 * `#184`（机器人详情页左下大片死区）的修法是：把「当前持仓」从下方通栏**移进左列**，
 * 于是同一页出现**两份** `<TraderTables>`：
 *
 * | 位置 | 用途 | 参数 |
 * | --- | --- | --- |
 * | 左列 | 只放「当前持仓」| `tab="positions"` + `hideTabBar` |
 * | 通栏 | 放其余三张 | `tab={tableTab === 'positions' ? 'orders' : tableTab}` + `visibleTabs={['orders','trades','history']}` |
 *
 * ⚠️ 而组件里这两件事是**分开的**（`TraderTables.tsx` 的注释自己承认）：
 *
 * ```
 * ⚠️ `visibleTabs` 只筛**标签栏**；"渲染哪张表"仍由调用方传的 `tab` 决定
 *   —— 调用方负责让两者一致。
 * ```
 *
 * ⚠️ **"调用方负责"是一句没有守卫的约定** —— 而这正是本仓库反复出现的形态：
 * 两处必须保持一致、没人检查，于是迟早不一致。
 *
 * ## 不一致会怎样（两种，都是真实可达的）
 *
 * 1. **`tab` 不在 `visibleTabs` 里** → 标签栏上没有任何一项高亮，而**内容却渲染了**
 *    —— 操作员看到"一张不属于任何标签的表"。
 * 2. **通栏的 `tab` 停在 `positions`** → 左列已经有一份持仓表，
 *    通栏再渲染一份 ⇒ **同一屏两份持仓表**（`#184` 的修复注释专门提过这一点）。
 *
 * ## 判据
 *
 * 从源码里取出**每一个** `<TraderTables ... />` 实例的属性，断言：
 * - 若传了 `visibleTabs`，则 `tab` 必须是**字面量**且**在该数组内**，
 *   或是一个**显式回落到数组内某个值**的表达式；
 * - 若传了 `visibleTabs`，则它**不得包含 `positions`**（那正是"移到左列"的语义）；
 * - 有且只有**一个**实例以 `positions` 为主表（否则同屏两份）。
 *
 * ## ⚠️ 这是**结构断言**，不是渲染验证
 *
 * `packages/web` **没有 jsdom / React Testing Library**（见 `docs/DEVELOPMENT.md`），
 * 所以这里只断言**源码结构**。⚠️ 它**不能证明**布局好看 ——
 * 布局要在浏览器里量（`#184` 的实测数据在 issue 里）。
 * 它防的是"**参数配错**"这一类回归，而那正是本页最容易错的地方。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/** 读源码。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

/**
 * 剥掉注释但**保留行号**（仓库注释里大量引用被讨论的代码，直接删会让行号漂）。
 *
 * ⚠️ 与 `outboundFetchGuard.test.ts` 用的是同一个手法 —— 那里踩过
 * "`filter` 式剥离让行号偏移、报错位置全错"的坑。
 */
function stripCommentsKeepLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') ? line : '';
    })
    .join('\n');
}

/**
 * 取出一个文件里所有 `<TraderTables … />` 实例的属性文本。
 *
 * ⚠️ 用**花括号配对**找实例结尾，而不是找第一个 `/>` ——
 * 因为属性里有箭头函数与对象字面量（`onSelectSymbol={(symbol) => { … }}`）。
 */
function traderTablesInstances(source: string): Array<{ startLine: number; attrs: string }> {
  const lines = source.split('\n');
  const out: Array<{ startLine: number; attrs: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/<TraderTables\b/.test(lines[i] ?? '')) continue;
    /* 从这一行往后收集，直到该元素闭合（`/>` 且花括号已配平）。 */
    let depth = 0;
    let buf = '';
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j] ?? '';
      buf += `${line}\n`;
      for (const ch of line) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      /* 该元素自己的开标签以 `/>` 结束；配平后遇到它就算收完。 */
      if (depth <= 0 && /\/>\s*$/.test(line.trim()) && j >= i) break;
      if (depth <= 0 && /\/>/.test(line) && j > i) break;
    }
    out.push({ startLine: i + 1, attrs: buf });
  }
  return out;
}

/*
 * ⚠️ 本文件与 `TraderPage.tsx` **同目录**（`src/pages/`），所以是 `./`。
 */
const PAGE = './TraderPage.tsx';

test('★★★ 每个 `<TraderTables>` 的 `tab` 必须落在它自己的 `visibleTabs` 里', () => {
  const source = stripCommentsKeepLines(read(PAGE));
  const instances = traderTablesInstances(source);

  /* 前置断言：必须真的找到实例（否则"零个问题"是因为没找到东西）。 */
  assert.ok(
    instances.length >= 2,
    `★ 只找到 ${instances.length} 个 \`<TraderTables>\` 实例 —— 扫描可能失效了。\n` +
      '    ⚠️ `#184` 之后这一页**应该有两个**（左列一份、通栏一份）。',
  );

  const problems: string[] = [];
  for (const { startLine, attrs } of instances) {
    const visible = /visibleTabs=\{?\[([^\]]*)\]\}?/.exec(attrs);
    if (!visible) continue; /* 没传 `visibleTabs` = 四张全显示，`tab` 任意合法。 */

    const allowed = [...visible[1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
    if (allowed.length === 0) {
      problems.push(`第 ${startLine} 行：\`visibleTabs\` 解析出空数组 —— 写法变了，请更新本测试`);
      continue;
    }

    /*
     * `tab` 的两种合法形态：
     *   ① 字面量：`tab="positions"` / `tab={'orders'}`；
     *   ② 回落到数组内某值的表达式：`tab={x === 'positions' ? 'orders' : x}`。
     * ⚠️ 形态 ② 的**回退值**必须落在 `allowed` 里 —— 否则用户点回那个标签就空白。
     */
    const literal = /tab="([a-z]+)"/.exec(attrs);
    const ternary = /tab=\{([^}]*)\?([^}]*)\}/.exec(attrs);

    if (literal) {
      const value = literal[1]!;
      if (!allowed.includes(value)) {
        problems.push(
          `第 ${startLine} 行：\`tab="${value}"\` 不在 \`visibleTabs\` 里（${allowed.join(', ')}）` +
            ' —— 标签栏不会有任何一项高亮，而内容却渲染了',
        );
      }
      continue;
    }

    if (ternary) {
      const fallback = [...ternary[2]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
      if (fallback.length === 0) {
        problems.push(`第 ${startLine} 行：\`tab\` 的回落分支里没有字面量 —— 写法变了，请更新本测试`);
      } else if (!fallback.some((f) => allowed.includes(f))) {
        problems.push(
          `第 ${startLine} 行：\`tab\` 的回落值（${fallback.join(', ')}）不在 \`visibleTabs\` 里` +
            `（${allowed.join(', ')}）—— 用户切回那个标签会看到空白`,
        );
      }
      continue;
    }

    problems.push(
      `第 ${startLine} 行：传了 \`visibleTabs\` 但 \`tab\` 既不是字面量也不是三元回落 —— ` +
        '本测试认不出它，请补判据（不要直接放行）',
    );
  }

  assert.deepEqual(
    problems,
    [],
    '★★★ 这些 `<TraderTables>` 的 `tab` 与 `visibleTabs` **可能不一致**：\n' +
      problems.map((p) => `      · ${p}`).join('\n') +
      '\n    ⚠️ `TraderTables.tsx` 的注释写着"**调用方负责让两者一致**" ——\n' +
      '    而这正是本仓库反复出现的形态：**两处必须一致、没人检查**。\n' +
      '    ⚠️ 不一致的后果：标签栏没有高亮项但内容渲染了；或同一屏出现两份表。',
  );
});

test('★★★ 通栏那份不得再渲染 `positions`（否则同屏两份持仓表）', () => {
  /*
   * ⚠️ `#184` 的修复把「当前持仓」移到了左列 —— 所以**通栏必须排除它**。
   * 这条守的是那次修复的**语义**，而不只是"参数自洽"。
   */
  const source = stripCommentsKeepLines(read(PAGE));
  const instances = traderTablesInstances(source);
  assert.ok(instances.length >= 2, `★ 只找到 ${instances.length} 个实例`);

  const withVisibleTabs = instances.filter((i) => /visibleTabs/.test(i.attrs));
  assert.ok(
    withVisibleTabs.length >= 1,
    '★ 没有找到带 `visibleTabs` 的实例 —— `#184` 的修复结构变了，请更新本测试',
  );

  const bad: string[] = [];
  for (const { startLine, attrs } of withVisibleTabs) {
    const visible = /visibleTabs=\{?\[([^\]]*)\]\}?/.exec(attrs);
    const allowed = [...(visible?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
    if (allowed.includes('positions')) {
      bad.push(`第 ${startLine} 行：\`visibleTabs\` 里含 \`positions\``);
    }
  }

  assert.deepEqual(
    bad,
    [],
    '★★★ 通栏的 `visibleTabs` **不该含 `positions`**：\n' +
      bad.map((b) => `      · ${b}`).join('\n') +
      '\n    ⚠️ 「当前持仓」已经被移到**左列**（`#184`）——\n' +
      '    通栏再渲染一份 ⇒ **同一屏两份持仓表**。',
  );

  /* 反向：必须**恰好一份**以 `positions` 为主表。 */
  const primary = instances.filter((i) => /tab="positions"/.test(i.attrs));
  assert.equal(
    primary.length,
    1,
    `★★ 应当**恰好有一个** \`<TraderTables>\` 以 \`positions\` 为主表，实际 ${primary.length} 个 ——\n` +
      '    ⚠️ 0 个 ⇒ 持仓表不见了；2 个 ⇒ 同一屏两份。',
  );
});

test('★★★ 判据必须能真的报出不一致 —— 用人造源码校准', () => {
  /*
   * ⚠️ "探针校准"：上面两条断言 `problems` / `bad` 为空，而**一个什么都没扫到的实现
   * 也返回空数组**。这里用同一套判据跑人造实例，断言它会被报出。
   */
  const checkTabInVisible = (attrs: string): boolean => {
    const visible = /visibleTabs=\{?\[([^\]]*)\]\}?/.exec(attrs);
    if (!visible) return true;
    const allowed = [...visible[1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
    const literal = /tab="([a-z]+)"/.exec(attrs);
    if (literal) return allowed.includes(literal[1]!);
    const ternary = /tab=\{([^}]*)\?([^}]*)\}/.exec(attrs);
    if (ternary) {
      const fallback = [...ternary[2]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
      return fallback.some((f) => allowed.includes(f));
    }
    return false;
  };

  /* ① 不一致必须被抓。 */
  assert.equal(
    checkTabInVisible("tab=\"positions\" visibleTabs={['orders','trades','history']}"),
    false,
    '★★★ 判据必须能报出"tab 不在 visibleTabs 里" —— 否则上面那条是在空转',
  );
  /* ② 一致必须被放过。 */
  assert.equal(
    checkTabInVisible("tab=\"orders\" visibleTabs={['orders','trades','history']}"),
    true,
    '★★ 合法的组合不能被误报',
  );
  /* ③ 三元回落到数组内的值 —— 正是通栏那份的写法。 */
  assert.equal(
    checkTabInVisible(
      "tab={tableTab === 'positions' ? 'orders' : tableTab} visibleTabs={['orders','trades','history']}",
    ),
    true,
    '★★ 通栏那份的写法必须被认作合法',
  );
  /* ④ 没传 `visibleTabs` = 四张全显示，任何 `tab` 都合法。 */
  assert.equal(checkTabInVisible('tab="positions"'), true, '★★ 没传 `visibleTabs` 时不该被报');
});
