/**
 * **详情页的表格只能有一份，且不得再被"按标签拆开"**（2026-10-16 回退后）。
 *
 * ## 这条守卫的方向变过一次（记下来，别又改回去）
 *
 * 2026-10-15，`#184`（机器人详情页左下大片死区）被这样修：把「当前持仓」从下方通栏
 * **移进左列**，于是同一页出现**两份** `<TraderTables>`：
 *
 * | 位置 | 用途 | 参数 |
 * | --- | --- | --- |
 * | 左列 | 只放「当前持仓」| `tab="positions"` + `hideTabBar` |
 * | 通栏 | 放其余三张 | `visibleTabs={['orders','trades','history']}` |
 *
 * 组件为此加了 `visibleTabs` / `hideTabBar` 两个参数，本文件当时守的是
 * "两份实例的参数必须自洽"。
 *
 * ## ⚠️ 2026-10-16 用户否决并回退了整个拆分
 *
 * 原话：
 * > 「你这不是乱来吗？怎么把当前持仓单独提出来改到上面了，**回退之前的 UI**」
 *
 * 现场症状（用户截图，两处都是拆分直接造成的）：
 * ```
 *   ① 标签栏被拆成两处：「当前持仓」在左列、其余三张在下方通栏
 *   ② 同一屏出现【两个】「全部平仓」按钮（两处工具栏各一个）
 * ```
 * 也就是说：那个改动**为了解决一块空白，引入了更明显的重复**。
 * 死区那件事应当是"接受现状或换别的方向"，不是拆表格。
 *
 * ## 所以现在守的是**反向**
 *
 * 1. `TraderPage.tsx` 里 `<TraderTables>` 实例 **有且只有一个**；
 * 2. 源码里**不得出现** `visibleTabs` / `hideTabBar`（拆分专用参数）；
 * 3. 那唯一的实例仍由 `tableTab` 驱动 —— 四张表在同一份标签栏里切换。
 *
 * ## ⚠️ 这是**结构断言**，不是渲染验证
 *
 * `packages/web` 没有 jsdom / React Testing Library（见 `docs/DEVELOPMENT.md`），
 * 所以这里只断言源码结构。它防的是"**有人又把表格拆成两份**"这一类回归；
 * 布局好不好看要在浏览器里量（`ui:smoke` / `ui:audit`）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/** 读源码。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

/**
 * 剥掉注释但**保留行号**（仓库注释里大量引用被讨论的代码，直接删会让行号漂）。
 *
 * ⚠️ 这个 helper 在本文件里**是必需的**：上面那段文件头就在解释
 * "为什么不得出现 `visibleTabs`"，**注释里必然有这个词** ——
 * 不剥注释，守卫会被自己的说明文字绊倒（假阳性）。
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

/** 剥注释后的 `TraderPage` 源码 —— 判据都建在它上面。 */
const pageCode = (): string => stripCommentsKeepLines(read('./TraderPage.tsx'));

test('★★★ 详情页只能有一份 `<TraderTables>` —— 拆成两份会把标签栏切开', () => {
  /*
   * ## 为什么这条值得钉
   *
   * 2026-10-15 那次拆分（已回退）把「当前持仓」提到左列，实测的现场是：
   * 标签栏变成两处、同一屏**两个「全部平仓」按钮** —— 用户的原话是
   * 「你这不是乱来吗」。
   *
   * 这不是"样式偏好"：两份实例 = 两套工具栏 = 两处状态，
   * 操作员会分不清"这一屏里哪个按钮管哪张表"。
   */
  const instances = traderTablesInstances(pageCode());
  assert.ok(instances.length > 0, '★ 一个 `<TraderTables>` 都没找到 —— 判据失效，先修这个');
  assert.equal(
    instances.length,
    1,
    `★★★ 详情页只该有一份表格（四张表在同一份标签栏里切换）。实际找到 ${instances.length} 份，` +
      `起始行：${instances.map((i) => i.startLine).join(', ')}。\n` +
      `   ⇒ 若要再次拆分，先读本文件头部那段：那次拆分因为"两个全部平仓按钮"被用户回退了。`,
  );
});

test('★★★ 源码里不得再出现 `visibleTabs` / `hideTabBar`（拆分专用参数）', () => {
  /*
   * 这两个参数是 2026-10-15 为"左列只放持仓、通栏放其余"而加的，
   * 随拆分一起被回退了。它们重新出现 = 有人又把表格拆了（或正准备拆）。
   *
   * ⚠️ 判据建在**剥掉注释**的源码上：文件头与 `TraderTables.tsx` 的注释里
   * 必然会提到这两个词（那是在解释为什么禁用），把它们算进来就是假阳性。
   */
  const page = pageCode();
  for (const banned of ['visibleTabs', 'hideTabBar']) {
    assert.ok(
      !page.includes(banned),
      `★★★ \`TraderPage.tsx\` 里出现了 \`${banned}\` —— 那是"把表格按标签拆开"的标记，` +
        `拆分已被用户否决（见本文件头部）。`,
    );
  }
});

test('★★ 唯一的实例仍由 `tableTab` 驱动（四张表在同一份标签栏里切换）', () => {
  /*
   * 回退后的形状：一个 `<TraderTables>`，`tab={tableTab}` + `onChange={setTableTab}`
   * —— 四张表共用一份标签栏。这条防的是"拆回去一半"：比如把 `tab` 写死成
   * `positions` 却忘了恢复标签栏（那样别的三张就再也点不出来了）。
   */
  const instances = traderTablesInstances(pageCode());
  const only = instances[0];
  assert.ok(only !== undefined, '★ 没有实例（上一条测试会先报）');
  assert.match(
    only.attrs,
    /tab=\{tableTab\}/,
    `★ 唯一的那个实例必须由 \`tableTab\` 驱动（而不是写死某张表）：\n${only.attrs.slice(0, 300)}`,
  );
  assert.match(
    only.attrs,
    /onChange=\{setTableTab\}/,
    `★ 标签栏必须能切换（\`onChange={setTableTab}\`）：\n${only.attrs.slice(0, 300)}`,
  );
});
