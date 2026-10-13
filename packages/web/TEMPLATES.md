# 模板开发指南

**本文档是外壳模板的公开接口。** 想给这套终端做一套自己的界面，只需要读这一份，
不必读任何业务页面。布局与配色的具体规范见 [`LAYOUT.md`](LAYOUT.md) 与
[`DESIGN.md`](DESIGN.md)；本文档讲的是**怎么接上去**。

---

## 0. 这套东西是什么

界面被拆成了互不依赖的两半：

```
   ┌──────────────────────────┐         ┌───────────────────────────┐
   │  业务页面                │         │  外壳（模板）              │
   │  src/pages/*             │  ←──→   │  src/templates/<名字>/*    │
   │                          │  契约   │                           │
   │  「这一页有什么」         │         │  「它在屏幕上放哪」        │
   │  表格、表单、图表、动作   │         │  导航、工具栏、配色        │
   └──────────────────────────┘         └───────────────────────────┘
```

- **页面**不知道导航在哪，也不知道自己被套在什么壳里；
- **模板**不含任何业务逻辑：它不请求数据、不算数字、不知道"机器人"是什么。

两者之间只有一份接口，就是下面的 §2 与 §3。**你的模板里不该出现 `fetch`、
不该 import `lib/store`、不该自己连 WebSocket。**

---

## 1. 五分钟做一套能跑起来的模板

```
src/templates/mytheme/
  MyThemeShell.tsx     ← 必须。默认导出外壳组件
  theme.css            ← 可选。自带配色
```

**目录名就是模板 id**（这里是 `mytheme`）。它会出现在外观设置页里，
也会被写进用户的 `localStorage`。

最小可用的外壳：

```tsx
// src/templates/mytheme/MyThemeShell.tsx
import { Outlet } from 'react-router-dom';
import { MAIN_SCROLL_ID, useShell } from '../types';
import { CommandPalette } from '../../components/CommandPalette';

export default function MyThemeShell() {
  const shell = useShell();

  return (
    <div className="flex h-screen flex-col bg-base-950">
      <header className="flex h-14 items-center gap-3 border-b border-base-800 px-4">
        <span className="font-semibold text-ink-hi">AutoQuant</span>
        <nav className="flex items-center gap-1">
          {shell.navItems.map((item) => (
            <NavLink key={item.to} to={item.to} className="px-2 text-ink-lo hover:text-ink-hi">
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      {/* ⚠️ id 必须是这个常量，且它要是**真正的滚动容器** */}
      <main id={MAIN_SCROLL_ID} className="page-pad min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>

      {/* 命令面板**不在这里** —— 它由 ShellRuntime 统一渲染（见 §4③） */}
    </div>
  );
}
```

**保存即生效。** 不需要注册、不需要改任何现有文件 —— `templates/themes.ts`
用 `import.meta.glob` 自动发现目录（见 §5）。刷新页面，外观设置页里就会出现
「mytheme」这张卡。

---

## 2. 外壳拿得到什么：`useShell()`

只在 `<ShellRuntime>` 内部可用（模板天然在它里面）。返回 `ShellState`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user` | `User \| null` | 当前操作员。用于显示用户名与角色 |
| `system` | `SystemStatus \| null` | 环境、是否模拟盘、交易所标签、推送权重 |
| `traders` | `Trader[]` | 机器人列表（外壳只用来数数、算运行中数量） |
| `socketStatus` | `'idle' \| 'connecting' \| 'live' \| 'error'` | 推送状态 |
| `runningCount` | `number` | 正在运行的机器人数 |
| `clockWarn` | `boolean` | 本地时钟偏差超过 2 秒 |
| `weightPercent` | `number` | 当前分钟已消耗的 API 权重百分比 |
| `weightWarn` | `boolean` | 权重是否已达警戒线（≥70%） |
| `navItems` | `NavItem[]` | 扁平导航表（命令面板、抽屉用） |
| `navGroups` | `NavGroup[]` | 分组导航表（侧栏、菜单栏用） |
| `signOut` | `() => void` | 退出登录并跳回登录页 |
| `paletteOpen` / `setPaletteOpen` | `boolean` / `(open: boolean) => void` | 命令面板开关 |

`NavItem` 的形状：`{ to, label, icon, jump, group? }` —— `to` 是路由路径
（配 `<NavLink to={item.to}>`），`icon` 是 `lucide-react` 组件，`jump` 是
`g` 前缀快捷键的第二段。

`navGroups` 是 `Array<{ label: string; items: NavItem[] }>`。

---

## 3. 页面动作：`<PageActions>`

页面里的「刷新」「新建」这类按钮，位置由模板决定。页面只声明**有什么**：

```tsx
<PageActions
  start={<Button onClick={reload}>刷新</Button>}
  end={<Button variant="primary" onClick={create}>新建</Button>}
/>
```

要让自己的模板接管它们，就在外壳里渲染两个**挂载点**：

```tsx
import { TOOLBAR_END_ID, TOOLBAR_START_ID } from '../types';

<div className="toolbar">
  <div id={TOOLBAR_START_ID} className="contents" />
  <span className="min-w-2 flex-1" />
  <div id={TOOLBAR_END_ID} className="contents" />
</div>
```

`start` 是普通动作（刷新 / 筛选 / 导出），`end` 是主操作与危险动作 ——
它**永远靠右**，这件事不该由每个页面自己记得。

### 不渲染它们也能用，但你会想要它们

`PageActions` 找不到挂载点时会**就地渲染**同一批按钮（页面把它写在哪儿，
它就出现在哪儿）。所以不渲染挂载点不会丢功能 —— 但你也失去了对动作位置的
控制。这正是"换模板不影响功能"的保证方式（`classic` 模板就走这条路）。

### 两个槽必须带 `className="contents"`

它们只用来定位（`createPortal` 找 DOM 节点），**不该参与布局**。少了
`display: contents`，两个空 div 会成为工具栏的 flex 子项，`flex-1` 弹簧被夹在
中间、左右两组动作不再贴边 —— 而"按钮位置有点怪"没人会当成 bug 报。

---

## 4. 必须遵守的四条约束

### ① 内容区要有 `id={MAIN_SCROLL_ID}`，且它要是真的滚动容器

页面里有些功能靠这个 id 找滚动容器（帮助页的目录跟随高亮）。**找不到时它们
静默失效**，页面看起来毫无异常。用 `templates/ids.ts` 里的常量，不要手写字符串。

### ② 不要自己渲染 `<Toaster />`，也不要调用 `connect()`

它们由 `ShellRuntime`（`templates/lib/context.tsx`）统一调度，而那个组件包在
模板**外面**。模板里重复做会导致 toast 出两次、或者连上两条 WebSocket。
`ShellRuntime` 必须在模板外面还有第二个理由：它在里面时，每次切模板都会重新
挂载 —— 表现是"切个皮肤，推送断两秒"。

### ③ 命令面板**不要**自己渲染 —— 给一个入口就行

> ⚠️ **这一条以前写的是反的。** 本文档与 `templates/types.ts` 的示例一度都说
> "命令面板每套外壳自己渲染一次"，而实际代码里 `ShellRuntime`
> （`lib/context.tsx`）已经统一渲染了 `<CommandPalette>` 与 `<Toaster>`，
> 两套内置外壳都没有渲染它。照那份文档写的第三方模板会**叠出两个面板**。
>
> 教训是：文档里的"必须"要跟着代码走，而这两处没有一起改。

模板只需要一个**打开它的入口**（一个按钮调 `shell.setPaletteOpen(true)`）。
命令面板与 toast 都由 `ShellRuntime` 渲染 —— 理由与 ② 相同：它们是"应用级"
的浮层，位置固定在屏幕角上/中央，和外壳的形状无关。

### ④ 自带样式必须挂在**根类名**下面

见下一节。

---

## 5. 配色：两套选择

### 方式 A：只覆盖 CSS 变量（推荐，最省事）

放一个 `theme.css`，把默认色板覆盖掉。**每一条选择器都要带
`html.aq-<你的目录名>` 前缀：**

```css
/* src/templates/mytheme/theme.css */
html.aq-mytheme {
  color-scheme: dark;

  /* 每个令牌写两份：十六进制 + 空格分隔的 R G B 三元组 */
  --aq-base-950: #07090f;
  --aq-base-950-rgb: 7 9 15;
  --aq-base-900: #0d1117;
  --aq-base-900-rgb: 13 17 23;
  /* … 见 index.css 的 :root，那里是全部令牌的默认值 */
}

/* 模板自己的结构类也挂在前缀下 */
html.aq-mytheme .my-sidebar {
  width: 180px;
}
```

**为什么必须写两份**：Tailwind 把透明度修饰符编译进 `rgb(... / <alpha>)`。
`bg-accent/10` → `rgb(var(--aq-accent-rgb) / 0.1)`。只给十六进制的话产出的是
`rgb(#7060f5 / 0.1)` —— **非法 CSS，整条声明被丢弃，而且不报错**。界面不会
"坏"，只会变得寡淡。详见 `index.css` 顶部那段论证。

**为什么必须带 `html.aq-<名字>` 前缀**（两条理由，都重要）：

1. **不污染别的模板。** 一条裸选择器会开始影响原版 —— 而且是在你看不见的
   时候（你在自己的模板下看，一切正常）。
2. **压得过 `index.css`。** `html.aq-mytheme .foo` 特异性是 0,2,1，高于
   `index.css` 里的单类名（0,1,0）。这样两段 CSS 的加载顺序就不重要了 ——
   而顺序由模块图决定，开发与构建产物还不一样。

页面里原有的 Tailwind 工具类（`px-3 py-2` 之类）在你的模板下会被你的规则
覆盖，在原版下原样生效。这就是"只加类名、不动页面结构"能做出两套外观的原因。

### 方式 B：导出完整的 `TemplateDefinition`

需要改 label / hint，或者不想让 label 等于目录名时：

```tsx
import type { TemplateDefinition } from '../types';

function Shell() {
  /* … */
}

export default {
  id: 'mytheme',
  label: '我的模板',
  hint: '一句话说明它适合什么场景，显示在外观设置页的卡片上。',
  rootClass: 'aq-mytheme',
  Shell,
  ownsPalette: true, // 有 theme.css 就写 true
} satisfies TemplateDefinition;
```

默认导出是**组件函数**时，`label` 与 `hint` 从目录名推（label = 目录名，
hint 为空）。所以推荐上面这种写法。

### 自动发现是怎么工作的

`src/templates/themes.ts` 用两条 `import.meta.glob`：

```
templates/<目录>/theme.css        → 模板自带的配色
templates/<目录>/<名字>Shell.tsx  → 外壳组件
```

**目录名就是模板 id。** 加一套模板 = 加一个目录，不需要改任何现有文件。

⚠️ 内置的 `classic` 与 `console` 已经在 `registry.ts` 里静态注册过，
自动发现会**跳过**它们 —— 那是刻意的：自动推出来的 label 会盖掉人写的。

---

## 6. 主题与密度（正交的两件事）

**模板**决定骨架，**主题**（深 / 浅）与**密度**（行高）是另外两个维度。
一套模板可以同时支持两套主题（`console` 就是这样），也可以只有一套
（`classic` 是固定的深色，它用的就是 `index.css` 的默认色板）。

要不要支持由你决定。支持的话，在 `theme.css` 里按属性选择器分写：

```css
html.aq-mytheme[data-skin='light'] {
  color-scheme: light;
  --aq-base-950: #eef1f5;
  --aq-base-950-rgb: 238 241 245;
  /* … */
}
```

密度走 `--aq-row-h`（表格行高），取值 `24px` / `26px` / `32px`：

```css
html.aq-mytheme[data-density='compact'] { --aq-row-h: 24px; }
html.aq-mytheme[data-density='cozy']    { --aq-row-h: 32px; }
```

当前值读 `document.documentElement.dataset.skin` / `.density`。

### 图表配色要额外做一件事

canvas 与写进 `stroke` / `fill` 的 SVG **吃不了 CSS 变量**（写 `var(--aq-accent)`
不会报错，只是什么都不画）。所以图表用 `useChartInk()` 从 CSS 变量里读出
**当时的字面量**。

如果你的模板改了语义色（`--aq-up` / `--aq-down` / `--aq-accent` …），图表会
自动跟上 —— **不需要你做任何事**，但前提是这些变量都在 `theme.css` 里覆盖了。
漏掉一个的表现是"别的都变了，只有那个颜色没变"，而没有报错。

---

## 7. 改完自己验一遍

```bash
npm run typecheck --workspace @aq/web
npm run lint
npm run test --workspace @aq/web     # 含模板契约测试
npm run build --workspace @aq/web
npm run ui:smoke -- --url http://127.0.0.1:5173 --user <用户名> --pass <密码>
```

`ui:smoke` 与 `ui:check`（需要 `AQ_BASE` / `AQ_TOKEN` / `AQ_CHROME`）会**真的**
开浏览器跑每一个页面，查横向溢出、控制台报错、空白页、截断且读不到的内容。
它们是唯一能发现"样式没生效"的工具 —— `typecheck` 与 `build` 对 CSS 类名是否
存在**一无所知**。

### 契约测试查什么

`src/templates/registry.test.ts` 把几条静默失败钉成了断言：

- 内置第一套必须是 `classic`（未知 id 的回落目标，也是新用户的默认）；
- 未知模板 id 必须回落，**绝不抛异常**（抛异常 = 整个应用白屏）；
- 每套外壳的内容区都要写成 `id={MAIN_SCROLL_ID}`（不许手写字符串）；
- 每套模板的 `rootClass` 必须唯一（撞车 = 两套样式同时生效）；
- 模板的每条 CSS 选择器都要带 `html.aq-<rootClass>` 前缀；
- `theme.css` 与 Shell 必须被 `themes.ts` 的 glob 扫到、且被 `main.tsx` 引入；
- `registry.ts` 不许 import CSS（它要能在 Node 里被直接 import）。

---

## 8. 常见坑

| 现象 | 原因 |
| --- | --- |
| 模板卡片出现了，但界面一点没变 | 默认导出的不是组件 —— 检查它是不是一个对象、且 `Shell` 是组件 |
| 颜色只变了一半 | `theme.css` 里漏了几个 `-rgb` 三元组（每个令牌要两份） |
| 气泡提示位置不对 | 给 Radix 的 `asChild` 传了没有 `forwardRef` 的组件（用 `Button` / `Badge`） |
| 按钮从页面里"跳"进工具栏 | 挂载点用 `useEffect` 而不是 `useLayoutEffect` 去找（`PageActions` 已经处理了） |
| 帮助页目录不跟随高亮 | 内容区少了 `MAIN_SCROLL_ID` |
| ⌘K 没反应 | 忘了渲染 `<CommandPalette>` |
| toast 弹两次 / 推送连两条 | 模板里自己渲染了 `<Toaster />` 或调了 `connect()` |
| 切模板时推送断了一下 | `<ShellRuntime>` 被放进了模板内部（它必须在外面） |
| 刷新时先闪一下别的配色 | 模板没在 `index.html` 的内联脚本里登记（第三方模板的已知取舍，见下） |

最后一条值得说明：`index.html` 里那段同步内联脚本是**纯 JS 字符串**，它没法
import TS，所以只认内置的 `aq-classic` / `aq-console`。第三方模板的首帧会先按
默认模板画一帧，随后由 `main.tsx` 纠正。要消掉这一帧，就在那段脚本里加一个
分支 —— 但那是改共享文件，也就意味着以后会和上游冲突，取舍由你定。

---

## 9. 三套内置模板的分工

读它们比读本文档更快 —— 这也就是它们存在的意义：

| | `classic` | `console` | `quill` |
| --- | --- | --- | --- |
| 骨架 | 顶部导航 + 单列内容 | 五层窗口：标题栏 / 菜单栏 / 工具栏 / 侧栏 / 状态栏 | 左侧分组侧栏 + 分段控件（两层导航） |
| 导航 | 横排，低频项收进「设置」下拉 | 左侧分组侧栏 + 顶部菜单栏 | 侧栏给分组、分段控件给组内页面 |
| 页面动作 | **不渲染挂载点** → 就地渲染（原版行为） | 收进工具栏，左右分组 | 收进工具栏，左右分组 |
| 配色 | 用 `index.css` 的默认色板 | 自带 `theme.css`，深 / 浅两套（冷蓝） | 自带 `theme.css`，深 / 浅两套（中性冷紫） |
| 主题 / 密度 | 不支持（固定深色） | 都支持 | 都支持 |
| 选中态 | 主色下划线 | 主色底 + 左侧色条 | **浮起的中性块**（不用主色） |
| 定位 | **原版逐字保留** —— 它是回落目标，不许改 | 桌面窗口隐喻 | 安静的桌面工具 |

`classic` 的每一条取舍都指向同一件事：**它必须和改造前逐字一致**。所以它没有
工具栏、不读 `data-skin`、`PageActions` 在那里走就地渲染分支。改动它之前先想
清楚：那是"改原版"，不是"改模板"。

### `quill` 的设计语言（借鉴自 [magpie](https://github.com/yetone/magpie)）

它不是"另一套配色"，而是另一套**视觉语法**。三条规则解释了它全部的观感：

1. **层次靠两级线 + 两级底，不靠阴影。** 静态卡片一律 `1px 边框 + 底色差`；
   `--aq-base-700` 画卡片外轮廓、`--aq-base-750` 画卡片**内部**的行分隔 ——
   内部线永远比轮廓淡一档，这是"一整块卡片"读起来不散的原因。阴影只给真正
   浮起的弹层与拖拽中的元素。
2. **主色只标记"可操作的焦点"，不标记"当前在哪"。** 侧栏选中、分段控件选中、
   开关打开态全部走**中性浮起块**（`--aq-seg-thumb` + `--aq-seg-edge`）或墨色，
   不是蓝色背景。主色留给焦点环、主按钮、数据条。这一条最影响"不土"。
3. **中性灰阶统一在一个冷紫轴上**（`R == G`，`B` 高出 4–9），而且越弱/越浅的
   颜色蓝偏移越大 —— 于是弱化的文字视觉上真的会"退远"，而强调色出现时不会
   和灰阶打架（两者同色相家族）。

另外三条实现上的取舍，都是踩过之后改的（详见 `theme.css` 里各自的注释）：

- **`.td` 的行高不能靠 `height` 钉死** —— 表格单元格的 `height` 是最小高度语义，
  而本项目大量单元格是两行内容（主行 + 副行），`height: 30px` 实测渲染成 41px。
  改用 `height` 作下限 + 竖向 padding 让文字居中。
- **`--aq-up` / `--aq-down` 的色相锁在币安那一套上**（`DESIGN.md` §2：红绿不许为
  好看改色相）。第一版照搬了 magpie 的薄荷绿与粉红，真浏览器里看 K 线图才发现
  "这一根是涨还是跌"要靠重新辨认颜色才能回答。
- **语义色的柔底是"深色去饱和"而不是半透明** —— 半透明的底会和它下面的东西
  糊在一起，而那正是徽章最不该有的样子。

---

## 10. 提交一套模板

1. 目录放在 `src/templates/<名字>/`，名字用小写英文与连字符（它会成为 id）；
2. `theme.css`（如有）的每条选择器都带 `html.aq-<名字>` 前缀；
3. 跑一遍 §7 的命令，全绿；
4. 附一张截图（深色 + 浅色，如果都支持）。

**不需要**动任何业务代码，**不需要**改 `registry.ts`、`Layout.tsx`、`nav.ts` 或
任何页面。你的改动全部落在一个新目录里 —— 这正是它被设计成这样的原因：
上游一直在更新，而你的模板永远能合上去。
