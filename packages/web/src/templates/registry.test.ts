/**
 * 模板系统的**契约测试**。
 *
 * ## 为什么这些断言值得写
 *
 * 用户对这套改造的要求里有一条是硬的：**「只改 UI，不影响任何功能」**，
 * 而且「原版必须保留、可以切回去」。这两句话没法靠 code review 保证 ——
 * 它们全都是**静默失败**：
 *
 *   · `PageActions` 找不到工具栏挂载点 → 按钮就地渲染，**看起来正常**；
 *   · 内容区少了 `MAIN_SCROLL_ID` → 帮助页目录不再跟随高亮，**看起来正常**；
 *   · 某套模板忘了带 rootClass → 它的样式一条都不命中，只是"没生效"；
 *   · localStorage 里存着孤儿的模板 id → 抛异常 = **整个应用白屏**。
 *
 * 没有一条会报错。所以这里把它们变成可执行的断言：改坏了开发时就红，
 * 而不是等用户切到某套模板、发现按钮"不知道跑哪去了"。
 *
 * ## 这里跑的是**纯数据**
 *
 * `registry.ts` 刻意不 import CSS（理由见那里的注释），所以这个文件能在
 * Node 里直接跑，不需要 jsdom、不需要打包。这不是运气，是那条约束换来的。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { getTemplate, listTemplates, registerTemplate, FALLBACK_TEMPLATE } from './registry';
import { MAIN_SCROLL_ID, TOOLBAR_END_ID, TOOLBAR_START_ID } from './ids';

const SRC = new URL('../', import.meta.url);

/** 读一个源文件，路径相对 `src/`。 */
function src(rel: string): string {
  return readFileSync(new URL(rel, SRC), 'utf8');
}

/** 去掉块注释 —— 注释里举例写的选择器不是真规则。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 把 CSS 拆成一条条 `{ 选择器, 声明体 }`。
 *
 * 足够处理本仓库的样式表（没有嵌套规则）：
 *
 *   · `@media … { … }` 这种条件块**整体匹配不上**（它内部还有花括号），
 *     但它里面的规则会被同一个正则单独匹配到，那正是我们要的；
 *   · `@media … {` 自己那条 prelude 以 `@` 开头，被下面的判断跳过；
 *   · `@keyframes` 的 `from` / `to` 会被当成选择器收进来，但它们不包含
 *     `.select` 之类的类名，查询时自然过滤掉。
 */
function cssRules(css: string): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = [];
  for (const match of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const prelude = (match[1] ?? '').trim();
    if (!prelude || prelude.startsWith('@')) continue;
    out.push({
      selectors: prelude.split(',').map((selector) => selector.trim()).filter(Boolean),
      body: match[2] ?? '',
    });
  }
  return out;
}

/**
 * 这条规则命中的是不是**下拉框**。
 *
 * ⚠️ 用**类名的词边界**，不是 `includes('.select')`：`tr.selected`（数据表格的
 * 选中行）里也含 `.select` 这七个字符，但它是一个不同的类。假阳性在这里的
 * 代价是**测试报出一条并不存在的 bug**，而那种红会训练人以后忽略这条用例。
 *
 * 提成模块级是因为**两条用例都要用它**（箭头那条、竖向 padding 那条）。
 */
const hitsSelect = (selector: string): boolean => /\.select(?![\w-])/.test(selector);

/* -------------------------------------------------------------------------- */
/*  注册表本身                                                                  */
/* -------------------------------------------------------------------------- */

test('★ 内置模板必须存在、id 唯一，且第一个是原版（回落目标）', () => {
  const all = listTemplates();
  assert.ok(all.length >= 2, `至少要内置两套模板（原版 + 控制台），实际 ${all.length} 套。`);

  const ids = all.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, `模板 id 必须唯一，实际 ${ids.join(' / ')}。`);

  /*
   * 第一项是 `readInitial()` 的默认值，也是 `getTemplate()` 的兜底目标 ——
   * 它**必须**是原版。否则一个 localStorage 里存着未知 id 的用户（或第一次
   * 打开的新用户）会直接落进改造版，而那与"原版是默认"相矛盾。
   */
  assert.equal(FALLBACK_TEMPLATE.id, 'classic', '兜底模板必须是原版 classic。');
});

test('★ 未知模板 id 必须回落到默认模板，绝不抛异常', () => {
  /*
   * 这条防的是**白屏**：id 存在用户的 localStorage 里，下游删掉一套模板、
   * 或用户从别人的分支切回来时它就是孤儿。抛异常 = 应用起不来，而用户
   * 根本不知道自己该做什么。回落只是"外观变回去了"，他能自己再选一次。
   */
  assert.doesNotThrow(() => getTemplate('没有这一套'));
  assert.equal(getTemplate('没有这一套').id, FALLBACK_TEMPLATE.id);
  assert.equal(getTemplate('').id, FALLBACK_TEMPLATE.id);
});

test('每套模板都要有可用的 id / label / hint / rootClass / Shell', () => {
  for (const t of listTemplates()) {
    assert.ok(t.id.trim(), '模板 id 不能是空的（要写进 localStorage）。');
    assert.ok(t.label.trim(), `${t.id} 缺少 label —— 设置页上的卡片会是空白。`);
    assert.ok(t.hint.trim(), `${t.id} 缺少 hint —— 用户不知道该选哪一套。`);
    assert.match(
      t.rootClass,
      /^[a-z][a-z0-9-]*$/,
      `${t.id} 的 rootClass「${t.rootClass}」不像一个类名 —— 它会挂到 <html> 上。`,
    );
    assert.equal(typeof t.Shell, 'function', `${t.id} 的 Shell 不是组件。`);
  }

  /*
   * 两套模板的 rootClass 不能相同。
   *
   * `applyTemplateClass()` 切换时靠"摘掉别的、挂上自己的"来避免两套样式同时
   * 命中。类名撞车的话两家样式会永远一起生效 —— 表现是"颜色对了一半"。
   */
  const classes = listTemplates().map((t) => t.rootClass);
  assert.equal(
    new Set(classes).size,
    classes.length,
    `模板的 rootClass 必须互不相同，实际 ${classes.join(' / ')}。`,
  );
});

test('运行时注册可以加新模板、也可以按 id 覆盖内置，但不会重复列出', () => {
  const before = listTemplates().length;

  registerTemplate({
    id: 'test-only',
    label: '测试',
    hint: '只在这个用例里存在。',
    rootClass: 'aq-test-only',
    Shell: () => null,
    ownsPalette: false,
  });
  assert.equal(listTemplates().length, before + 1, '运行时注册的模板应该出现在列表里。');
  assert.equal(getTemplate('test-only').label, '测试');

  /*
   * 同名覆盖：允许下游替换内置实现，但**列表里不能出现两条同 id 的卡片**
   * —— 那会让设置页上有两张长得一样、点哪个都"没反应"的选项。
   */
  registerTemplate({
    id: 'classic',
    label: '被覆盖的经典',
    hint: '测试用。',
    rootClass: 'aq-classic',
    Shell: () => null,
    ownsPalette: false,
  });
  const ids = listTemplates().map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, '覆盖内置模板后，列表里不该出现重复 id。');
  assert.equal(getTemplate('classic').label, '被覆盖的经典');
});

/* -------------------------------------------------------------------------- */
/*  模板作者最容易漏的几件事                                                    */
/* -------------------------------------------------------------------------- */

/** 找出所有 `templates/<目录>/*Shell.tsx`，路径相对 `src/`。 */
function shellFiles(): string[] {
  const out: string[] = [];
  /*
   * ⚠️ 基准是 `SRC`（= `src/`），所以这里要写 `templates/`。
   *
   * 第一版只写了 `./`，等于去 `src/` 根下找外壳 —— 于是扫出 0 个，
   * 而用例的报错是"应该能找到两套外壳，实际 0 个"。至少它红得很快。
   */
  for (const dir of readdirSync(new URL('templates/', SRC), { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === 'lib') continue;
    for (const entry of readdirSync(new URL(`templates/${dir.name}/`, SRC), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('Shell.tsx')) {
        out.push(`templates/${dir.name}/${entry.name}`);
      }
    }
  }
  return out;
}

test('★ 每套外壳的内容区都要写成 id={MAIN_SCROLL_ID}（不许手写字符串）', () => {
  const shells = shellFiles();
  assert.ok(shells.length >= 2, `应该能找到两套外壳，实际 ${shells.length} 个：${shells.join(', ')}`);

  /*
   * 断言的是**常量名**而不是写死的字符串 `'main-scroll'`。
   *
   * 这正是这条用例的价值：手写字符串时两边**当下**是能对上的 —— 直到有人改了
   * `ids.ts` 里的值。那时页面的 `getElementById` 返回 null、功能静默失效，
   * 而源码里"看起来有个 id"。要求 import 常量，改一处两边一起改。
   *
   * ⚠️ 第一版这里写的是 `id={${MAIN_SCROLL_ID}}`，展开成 `id={main-scroll}`
   * —— 断言的是**值**，而源码里写的是**常量名**，于是必然失败。要判的是
   * "这里引用了那个常量"，所以比的是常量名这个标识符。
   */
  const expected = ['MAIN_SCROLL_ID'];
  for (const rel of shells) {
    const code = src(rel);
    for (const name of expected) {
      assert.ok(
        code.includes(`id={${name}}`),
        `${rel} 的内容区必须写成 id={${name}} —— 页面靠这个 id 找滚动容器（帮助页的目录跟随高亮）。`,
      );
    }
    assert.ok(
      !code.includes(`id="${MAIN_SCROLL_ID}"`),
      `${rel} 里把手写死了：请用 id={${MAIN_SCROLL_ID}} 引用 templates/ids.ts 里的常量。`,
    );
  }
});

test('★ 每套外壳都要在顶栏渲染模板切换器 —— 漏了用户会被困在这一套里', () => {
  /*
   * 这是模板系统里唯一一条**会把人困住**的漏项。
   *
   * 外观页在侧栏，而侧栏的位置每套模板都不一样。用户切到一套没有切换器的
   * 模板之后，唯一换回去的办法是猜出「外观」藏在第几行 —— 而界面上不会有
   * 任何报错，看起来只是"这个软件好像没法换回去"。
   *
   * 所以实现放在公共库（`templates/lib/TemplateSwitcher.tsx`），每套外壳
   * **只写一行**。这条约束对第三方模板同样成立，而它也正是"别人只需专注 UI"
   * 的一部分：他不必自己实现一遍下拉菜单。
   */
  for (const rel of shellFiles()) {
    const code = src(rel);
    assert.ok(
      code.includes('<TemplateSwitcher'),
      `${rel} 没有渲染 <TemplateSwitcher />：用户切到这套模板后就找不到换回去的入口。`,
    );
    assert.ok(
      code.includes("from '../lib/TemplateSwitcher'"),
      `${rel} 必须从 templates/lib/TemplateSwitcher 引入切换器，不要各自实现一份。`,
    );
  }
});

test('★ 渲染了工具栏槽的外壳，槽必须带 className="contents"', () => {
  /*
   * ## 这条断言为什么遍历而不是写死一个文件
   *
   * 它一度只查 `console/ConsoleShell.tsx`，于是 quill 的槽完全不在覆盖内。
   * 而这条抓的正是**最典型的静默失败**：
   *
   * 槽只用来定位（`createPortal` 找 DOM 节点），**不该参与布局** ——
   * 少了 `display: contents`，两个空 div 会成为工具栏的 flex 子项，
   * 于是那条 `flex-1` 弹簧被夹在中间、左右两组动作不再贴边，
   * 而"按钮位置有点怪"没人会当成 bug 报。
   *
   * ## 为什么不强制每套外壳都渲染槽
   *
   * `classic` 刻意**不渲染**它 —— 那是原版行为（动作就地渲染，
   * 见 `PageActions` 的兜底分支）。所以这条只对**渲染了槽的**外壳生效。
   */
  const slots = [
    ['TOOLBAR_START_ID', '左槽（刷新 / 筛选）'],
    ['TOOLBAR_END_ID', '右槽（新建 / 危险动作）'],
  ] as const;

  let checked = 0;
  for (const rel of shellFiles()) {
    const code = src(rel);
    const rendersAny = slots.some(([name]) => code.includes(`id={${name}}`));
    if (!rendersAny) continue; // 不渲染槽的外壳（classic）走就地渲染兜底，功能不丢。
    checked += 1;

    for (const [name, what] of slots) {
      /* 同理：比的是常量名，不是它的值（见上面那条用例里的说明）。 */
      assert.ok(code.includes(`id={${name}}`), `${rel} 缺少${what}：应该渲染 id={${name}}。`);
      const line = code.split('\n').find((l) => l.includes(`id={${name}}`));
      assert.match(line!, /className="contents"/, `${rel} 的 ${name} 必须带 className="contents"。`);
    }
  }

  assert.ok(checked >= 1, '至少要有一套外壳渲染工具栏槽，实际一套都没有。');
});

test('★ 模板样式必须全部挂在根类名下面（不得裸写选择器）', () => {
  /*
   * 这是"多套模板互不影响"的底线，也是"合并进上游时不污染原版"的底线。
   *
   * 一条不带 `html.aq-*` 前缀的选择器会**开始影响别的模板**，而且是静默的：
   * 写它的人在控制台模板下看，一切正常；切回原版才发现某个颜色变了 ——
   * 那时已经没人记得是哪次改动引入的。
   *
   * 顺带它也是"特异性保险"：`html.aq-console` 是 0,2,1，压得过 `index.css`
   * 里的单类名（0,1,0），所以两段 CSS 的加载顺序不再重要。
   *
   * ⚠️ **这张表要跟着内置模板一起长。** 它一度只列了 console，于是 quill
   * 的 1600 行 CSS 完全不在覆盖内 —— 而这条断言抓的正是最难自查的一类
   * 错误（漏前缀的选择器在写它的人眼里"一切正常"）。加一套模板就加一行。
   */
  const themes = [
    ['templates/console/theme.css', 'aq-console'],
    ['templates/quill/theme.css', 'aq-quill'],
  ] as const;

  for (const [rel, rootClass] of themes) {
    const code = stripComments(src(rel));

    /*
     * 解析方式：CSS 里 `{` 只出现在"一条规则开始"的地方，所以每个 `{` **之前**
     * 到上一个 `}`（或文件开头）之间的那段文本，就是选择器（或 `@media` 的
     * 条件）。这样写同时覆盖了三件靠"逐行看"会翻车的事：
     *
     *   · 选择器写成多行、或者用逗号分成好几行（`html.x .a,\nhtml.x .b {`）；
     *   · 属性值里有逗号并且跨行（渐变、`transition` 列表）—— 那些**不是**
     *     选择器，因为 `{` 不在它们前面；
     *   · `@media … {` 里的嵌套规则。
     *
     * 第一版是按行 + `endsWith(',')` 判的，结果把
     * `background: radial-gradient(…),` 那一行当成了选择器，报出一堆假阳性。
     */
    const offenders: string[] = [];
    for (const match of code.matchAll(/([^{}]*)\{/g)) {
      const prelude = (match[1] ?? '').trim();
      if (!prelude) continue;
      /* `@media` / `@keyframes` 这类前缀不是选择器。 */
      if (prelude.startsWith('@')) continue;
      for (const raw of prelude.split(',')) {
        const sel = raw.trim();
        if (!sel) continue;
        /* keyframes 的步进（`from` / `to` / `50%`）不是选择器。 */
        if (/^(from|to|[\d.]+%)$/.test(sel)) continue;
        /*
         * `:where(html.aq-x)` 也是合规的写法 —— 它是**刻意的低特异性**：
         * `:where()` 把整条规则的特异性清零，于是模板的默认色**不会**压掉
         * 页面里的 `text-down` / `text-up` 这类语义工具类。
         *
         * 这条不是理论：quill 模板第一版给 `.td` 写了 `color`（0,2,1），
         * 结果**整列盈亏褪成同一种灰** —— 而表格看起来"只是有点淡"。
         * 所以这里必须同时接受两种前缀写法。
         */
        if (!sel.includes(`html.${rootClass}`) && !sel.includes(`:where(html.${rootClass})`)) {
          offenders.push(sel);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `${rel} 里有不带 html.${rootClass} 前缀的选择器，它们会影响到别的模板：\n  ${offenders.join('\n  ')}`,
    );
  }
});

test('★ 下拉框的箭头不能被 `background` 简写打散', () => {
  /*
   * 用户报的现象：「**所有下拉框都有 BUG**」—— 截图里每个 `<select>` 内部都是
   * **一排小箭头**，而且压着选项文字。
   *
   * ## 成因（这是"简写重置 longhand"的经典陷阱）
   *
   * `index.css` 的 `.select` 用四条 background-* 属性拼出一个自定义箭头：
   * image、size 12px、position right、no-repeat。而模板里一条
   * `background: var(--aq-field)` 是**简写** —— 它把没写出来的那三条一起
   * 重置成初始值，其中 `background-repeat` 的初始值是 **repeat**。
   * 简写的特异性（0,2,1）又高于 `index.css` 里的单类名（0,1,0），所以
   * "下面再补一条 background-image" 救不回另外三条：一张 12:8 的箭头
   * 变成瓷砖，在整个控件里平铺开。
   *
   * 读源码时它完全合理，只有真实浏览器里量 computed style 才看得出
   * （实测 console：`size: auto / repeat / 0% 0%`；classic：`12px auto /
   * no-repeat / right`）。所以钉成断言。
   */
  const rules = cssRules(stripComments(src('templates/console/theme.css')));

  const shorthand = rules.filter(
    (rule) =>
      rule.selectors.some(hitsSelect) &&
      /(^|[;\s])background\s*:/.test(rule.body),
  );
  assert.deepEqual(
    shorthand.map((rule) => rule.selectors.join(', ')),
    [],
    '这些规则用 `background:` 简写命中了下拉框 —— 它会重置 background-size / position / repeat，' +
      '把自定义箭头平铺成一排。请改用 `background-color`。',
  );

  /*
   * 箭头的位置与大小必须**写在模板这一处**，不靠别处继承：
   * 模板是"这套外观长什么样"的最终说法，而另外三条若来自 `index.css`，
   * 改那边就会悄悄改掉控制台模板的样子（改坏的表现还是一排箭头，像另一个 bug）。
   */
  const arrow = rules.find(
    (rule) => rule.selectors.length === 1 && rule.selectors[0] === 'html.aq-console .select',
  );
  assert.ok(arrow, '找不到 `html.aq-console .select` 这条规则 —— 自定义箭头没有归属。');
  for (const longhand of [
    'background-image',
    'background-repeat',
    'background-position',
    'background-size',
  ]) {
    assert.match(
      arrow!.body,
      new RegExp(`${longhand}\\s*:`),
      `html.aq-console .select 缺少 ${longhand} —— 四条 background-* 必须写在同一个地方，否则箭头会变形或平铺。`,
    );
  }
});

test('★ 下拉框的文字不能被竖向 padding 挤出内容盒', () => {
  /*
   * 用户报的现象：截图里**每一行选项名都只看得到中间半截**，上下被切掉。
   * 同一个弹窗里的 `<input>` 完全正常 —— 所以看起来像"下拉框独有的 bug"。
   *
   * ## 成因（两个来源的数值叠在一起）
   *
   * `index.css` 的 `.input/.select/.textarea` 带着 `py-2`（上下各 8px）。
   * 模板再把高度钉死在 28px（见下面那条 `height`）。于是内容盒只剩
   * `28 − 8 − 8 − 2(边框) = 10px`，而行盒是 `text-md` 的 **21px** ——
   * Chromium 把行盒在内容盒里居中后上下各裁掉 5.5px，选中项就成了半截字。
   *
   * `<input>` 看不出问题纯属巧合：Chromium 对 input 会在内容盒里**重新居中
   * 文字**，对 select 则按行盒排版再交给 overflow 裁 —— 同一个高度下只有
   * 下拉框坏。这也是为什么它值得一条断言：**读源码时两个数值都合理**，
   * 只有量 computed style 才看得出来（实测 `padding: 8px` + `height: 28px`）。
   *
   * 高度既然由 `height` 说了算，竖向 padding 在这里就是来抢内容盒空间的。
   */
  const rules = cssRules(stripComments(src('templates/console/theme.css')));

  /* 先确认前提还在：`index.css` 确实给了竖向 padding，否则这条断言就没意义。 */
  const base = cssRules(stripComments(src('index.css')));
  const fieldRule = base.find(
    (rule) => rule.selectors.includes('.input') && rule.selectors.includes('.select'),
  );
  assert.ok(fieldRule, '找不到 `index.css` 里 `.input, .select, .textarea` 那条规则。');
  assert.match(
    fieldRule!.body,
    /@apply[^;]*\bpy-2\b/,
    '`index.css` 的字段规则不再带 `py-2` —— 如果竖向 padding 已经去掉，' +
      '下面那条"必须归零"的断言就该一起删掉，别让它变成一条永远为真的空话。',
  );

  /*
   * ⚠️ 判的是**命中下拉框的每一条规则**，不是单看 `html.aq-console .select` 那一条。
   *
   * 竖向归零写在共享的 `html.aq-console .input, .select, .textarea` 里（高度
   * 也在那儿），而 `.select` 单列那条只管箭头。第一版断言只查后者，于是它
   * 报了一条**并不存在的 bug** —— 规则确实写了，只是写在另一条里。
   * 这种假阳性会训练人以后忽略这条用例，所以按"命中谁"来查。
   */
  const hits = rules.filter((rule) => rule.selectors.some(hitsSelect));
  assert.ok(hits.length > 0, '模板里没有任何命中 `.select` 的规则。');

  const zeroed = (prop: string): boolean =>
    hits.some((rule) => new RegExp(`${prop}\\s*:\\s*0(?![\\d.])`).test(rule.body));

  for (const prop of ['padding-top', 'padding-bottom']) {
    assert.ok(
      zeroed(prop),
      `控制台模板没有给下拉框写 \`${prop}: 0\` —— 它继承了 index.css 的 ` +
        '`py-2`，而高度是钉死的 28px，竖向 padding 会把行盒挤出内容盒，' +
        '选中项只显示半截字。',
    );
  }

  /* 横向 padding 仍然是刻意的：它是给右侧箭头留位子的，不能一起归零。 */
  const selectRule = rules.find(
    (rule) => rule.selectors.length === 1 && rule.selectors[0] === 'html.aq-console .select',
  );
  assert.ok(selectRule, '找不到 `html.aq-console .select` 这条规则。');
  assert.match(
    selectRule!.body,
    /padding-right\s*:/,
    'html.aq-console .select 不能把 padding-right 也归零 —— 那是箭头的位置。',
  );
});

test('★ registry.ts 保持纯数据：不许 import CSS', () => {
  /*
   * 样式 import 在各自的 Shell 里（理由见 ConsoleShell 那段注释）。这条防的是
   * "挪回注册表"：`registry.ts` 一旦 import `.css`，Node 下任何 import 它的
   * 代码都会 `ERR_UNKNOWN_FILE_EXTENSION` 崩掉 —— 包括这个测试文件本身。
   */
  const registry = src('templates/registry.ts');
  assert.ok(
    !/^import\s+['"][^'"]*\.css['"]/m.test(registry),
    'registry.ts 不能 import CSS —— 它要能在 Node 里被直接 import。',
  );
});

test('★ 模板样式必须由 themes.ts 的 glob 自动发现，且被 main.tsx 引入', () => {
  /*
   * 这一对断言防的是同一个事故：**模板的 CSS 没有进 bundle**。
   *
   * 表现是"控制台模板只剩结构、一点配色都没有"，而这看起来像"样式没写完"，
   * 不像一个构建问题 —— 所以必须由测试来判，不能指望人去看。
   */
  const themes = src('templates/themes.ts');
  assert.match(
    themes,
    /import\.meta\.glob\(\s*['"]\.\/\*\/theme\.css['"]/,
    'themes.ts 必须用 import.meta.glob 扫 ./<目录>/theme.css —— 否则模板配色不会进 bundle。',
  );
  assert.match(
    themes,
    /import\.meta\.glob\(\s*['"]\.\/\*\/\[A-Za-z0-9_\]\*Shell\.tsx['"]/,
    'themes.ts 必须扫 ./<目录>/*Shell.tsx —— 否则第三方模板的外壳不会被注册。',
  );

  const main = src('main.tsx');
  assert.match(
    main,
    /import\s+['"]\.\/templates\/themes['"]/,
    'main.tsx 必须 import ./templates/themes —— 少了它，glob 根本不会被执行。',
  );
});
