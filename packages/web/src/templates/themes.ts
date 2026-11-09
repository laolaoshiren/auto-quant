/**
 * 模板样式的**浏览器侧入口**。
 *
 * ## 这个文件为什么必须存在
 *
 * 注册表（`registry.ts`）是**纯数据**：它只导出 `TemplateDefinition[]`，
 * 不 import 组件、不 import 样式。理由很实在 —— 它要能在 Node 里被直接
 * import（契约测试、构建脚本、以后可能的 SSR 探针）。而 Node 的 ESM 加载器
 * 不认识 `.css`，一旦注册表碰了样式，`import './registry'` 就
 * `ERR_UNKNOWN_FILE_EXTENSION` 直接崩。
 *
 * 那就意味着"模板样式从哪来"需要另一个地方回答。这里就是那个地方。
 *
 * ## 靠 `import.meta.glob` 自动发现，不靠手写清单
 *
 * 手写清单的代价是：每加一套模板都要回来改这个文件。而"贡献一套 UI"这件事
 * 一旦需要改共享文件，贡献者之间就会开始互相冲突。
 *
 * 这里的 glob 有两条（写法见下面的 `import.meta.glob`，这里只说要旨）：
 *
 *   · **主题样式**：子目录下的 `theme.css`。它是按目录找的，所以**一条模式
 *     就能发现一套模板**，不需要先知道目录里叫什么名字；
 *   · **外壳组件**：子目录下以 `Shell.tsx` 结尾的文件。
 *
 * 分开写而不是合成一条，是因为两者可以**只有其一**：`classic` 有外壳、
 * 没有 theme.css（它用的就是 `index.css` 的默认色板）。
 *
 * ⚠️ 目录名就是模板 id，会写进用户的 localStorage —— **发布后不要改名**。
 *
 * ## 加载顺序与"首帧不闪"
 *
 * 这个文件由 `main.tsx` 在**渲染之前** `await`，所以：
 *
 *   1. 样式先就位（现在就在 bundle 里了，不会再有一次网络往返）；
 *   2. 外壳组件先注册；
 *   3. 然后才 `createRoot().render()`。
 *
 * 反过来（渲染完再注册）的表现是：用户上次选的那套模板找不到，应用先画出
 * 默认模板，几百毫秒后整页重排 —— 切回来的人会看到界面"抖一下"。
 *
 * ## 坏模板不能拖垮整个应用
 *
 * 每一项都裹在 try / catch 里：第三方模板里一个语法错误，最坏的结果应该是
 * "那一套模板没出现"，而不是**整个界面白屏**（那时用户连设置页都进不去，
 * 也就没法切回原版）。这里 warn 一声、跳过，其余模板照常。
 */
import { listTemplates, registerTemplate } from './registry';
import type { TemplateDefinition } from './types';

/*
 * `eager: true` —— 这两条都是**同步**的，所以样式在 `main.tsx` 渲染之前
 * 就已经在 bundle 里了（`import` 本身完成这件事）。
 *
 * 不用惰性 import 的原因：模板是"用户可能随时切换"的东西，惰性加载的结果是
 * 切换的那一瞬间才去拉样式，于是能看到一帧无配色的骨架。整个模板 CSS 加起来
 * 几十 KB、压缩后十几 KB，不值得为它换一次闪烁。
 */
const themes = import.meta.glob('./*/theme.css', { eager: true }) as Record<string, unknown>;
const shells = import.meta.glob('./*/[A-Za-z0-9_]*Shell.tsx', { eager: true }) as Record<
  string,
  Record<string, unknown>
>;

/** `./quill/QuillShell.tsx` → `quill`。 */
function dirOf(globKey: string): string {
  return globKey.split('/')[1] ?? '';
}

/**
 * 从模块里取出一份 `TemplateDefinition`。
 *
 * 支持两种写法：
 *
 *   1. `export default { id, label, hint, rootClass, Shell }` —— 元数据写全；
 *   2. `export default function MyShell() {}` —— **最省事的那种**，
 *      label / hint 从目录名推。
 *
 * 缺到 `Shell` 就返回 null（这套模板跳过）—— 一个没有组件的模板注册进去
 * 只会在切换时渲染空白，比不注册更糟。
 */
function pick(mod: Record<string, unknown>, id: string, hasTheme: boolean): TemplateDefinition | null {
  const exported = mod.default;
  if (!exported) return null;

  /* 写法 2：默认导出直接就是一个组件函数。 */
  if (typeof exported === 'function') {
    return {
      id,
      label: id,
      hint: '',
      rootClass: `aq-${id}`,
      Shell: exported as TemplateDefinition['Shell'],
      ownsPalette: hasTheme,
    };
  }

  /* 写法 1：默认导出一个定义对象。 */
  const raw = exported as Partial<TemplateDefinition>;
  if (typeof raw.Shell !== 'function') return null;
  return {
    id: raw.id ?? id,
    label: raw.label ?? id,
    hint: raw.hint ?? '',
    rootClass: raw.rootClass ?? `aq-${id}`,
    Shell: raw.Shell,
    ownsPalette: raw.ownsPalette ?? hasTheme,
  };
}

const known = new Set(listTemplates().map((t) => t.id));

/*
 * 目录集合来自**两条 glob 的并集**，不是只来自外壳那条。
 *
 * 只扫外壳的话，"目录里只有 theme.css"的模板会被整个忽略；而目录集合是
 * 判定的起点 —— 先知道有哪些目录，再问"它有没有外壳"（没有就跳过，
 * 因为一个没有外壳的模板没法渲染）。
 */
const dirs = new Set([...Object.keys(shells), ...Object.keys(themes)].map(dirOf));

for (const id of dirs) {
  if (!id) continue;

  /*
   * 内置的两套已经静态注册过了。
   *
   * ⚠️ **这里跳过，是为了 `import './quill/theme.css'` 那条不重复**。
   * 样式是 eager glob 自动带进来的，不需要在这里再引一次；而组件用目录名
   * 重名替换内置定义，会把内置的人写 label / hint 换成目录名。
   */
  if (known.has(id)) continue;

  const shellKey = Object.keys(shells).find((key) => dirOf(key) === id);
  if (!shellKey) continue;

  try {
    const definition = pick(shells[shellKey]!, id, `./${id}/theme.css` in themes);
    if (!definition) {
      console.warn(
        `[templates] ${shellKey} 里没找到外壳组件。需要「默认导出一个组件」或者` +
          '「默认导出一个 TemplateDefinition」—— 这套模板被跳过了（其它模板不受影响）。',
      );
      continue;
    }
    registerTemplate(definition);
  } catch (error) {
    /*
     * 单个模板出错不能连累别的模板，更不能连累应用启动 ——
     * 用户得先能进设置页，才谈得上"换回原版"。
     */
    console.warn(`[templates] 加载模板「${id}」失败，已跳过：`, error);
  }
}
