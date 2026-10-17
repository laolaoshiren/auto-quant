/**
 * `ui-check` / `ui-audit` / `ui-consistency` 共用的两件事：**凭据闸门**与 **markdown 判据**。
 *
 * 它存在的原因与那两条修复一样：三个脚本各写一遍同样的"登录 + 判据"，
 * 迟早会漂 —— 本仓库对"同一件事写两遍"的结论一向是"改一处等于没改"。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ① 凭据闸门：为什么**必须**显式失败
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 三个脚本原来都会在**没有登录凭据**时照常跑完并报绿。它会这么"绿"：
 *
 *   1. `page.goto(BASE)` → 应用把未登录的访问重定向到 `/login`；
 *   2. 脚本量的就是**登录页**（实测正文长度**固定 496 字**）
 *      —— 而 `ui-check` 的判据是 `text > 300`，于是**每一页都通过**；
 *   3. 2026-10-17 实测：无 token 时 `ui-check` 报「10 页全部 ✅」、
 *      `ui-audit` 报「437 字 ✅ 通过」；带上真 token 重跑，同一批页面正文是
 *      **616–18,995 字**。
 *
 * 也就是说：那种绿灯证明的是"**登录页渲染正常**"，而不是"被检查的页面正常"。
 * 在一个跑真实资金的仓库里，"验证通过"这四个字**不能**有这种含义 ——
 * 所以缺凭据时这里**直接非零退出**，而不是继续跑。
 *
 * ⚠️ **只有"凭据存在"是不够的**：令牌过期时服务端会把人踢回 `/login`，
 * 于是又变成"检查登录页"。所以 `login()` 之后还要**断言没停在登录页**
 * （`assertLoggedIn`）—— 这把"过期 token"这条同样的假绿路径一起堵掉。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ② markdown 判据：三条计数，回答三个不同的问题
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `ui-audit` 原来只有一个 `mdHits`，按**叶子元素**数 `**`。那条判据有两个盲区：
 *
 * | 盲区 | 机制（实测） | 后果 |
 * | --- | --- | --- |
 * | 跨元素边界 | 逐叶子扫描会 `continue` 掉**有子元素的容器**。`/appearance` 那句 `**是禁用的**` 落在 `<p>` 的**文本节点**里，而那个 `<p>` 因为含 `<strong>` 而被跳过 → 逐叶子 **0 命中**，而 `body.innerText` **1 命中** | 真实的 markdown 残留被漏报 |
 * | `title` 属性 | `title` 是属性、不在 `innerText` 里，此前**任何检查都没扫它**。实测漏掉 **28 处**（总览 11 / 机器人列表 14 / 详情 2 / 团队 1）—— 而它是用户**悬浮就能看见**的文案 | 同上 |
 *
 * 所以 `probeMarkdown()` 同时给出三个计数：
 *   · `leafMatches`      —— 旧判据（保留：让"盲区"在工具自己的输出里可见，而不是只写在注释里）
 *   · `innerTextMatches` —— 整页 innerText（跨越元素边界）
 *   · `titleHits`        —— 含 markdown 的 `title` 属性个数
 *
 * ## 判据为什么只认 `**`，不认 `#` / `- ` / `|` / 反引号
 *
 * 这些符号在本仓库里**大量合法出现**，而它们是**原文**该有的样子：
 *   · 决策详情页的「系统提示词 / 用户提示词」面板**逐字**显示模型看到的提示词
 *     （审计要求：可复现），里面有 `## 市场快照`、`- 最新价：…`；
 *   · `/data` 的运行时日志里有 `|`、`-` 与反引号包住的模块名。
 * 把它们判成"界面漏了 markdown"会制造**一批假红**，而假红会让整条检查被忽略。
 * `**` 不一样：它是**强调符**，在纯文本界面里没有任何合法用途 —— 露出来就是错。
 * ⚠️ 这条取舍有代价：**水平分隔线与表格符仍然抓不到**（见各脚本报告里的"本判据抓不到什么"）。
 *
 * ## 为什么正则不会误伤 glob
 *
 * `**` 在 glob 里合法（`packages/web/src/ ** /*.ts`）。判据要求成对
 * （`\*\*[^*\n]{1,120}\*\*`），而 `[^*\n]` **不允许中间再出现 `*`** ——
 * 于是 glob 形状（星号对紧跟一个斜杠，例如 `packages/web/src/` 后面那种）天然不匹配。
 * 这是一条刻意的设计，不是巧合。
 */

/** 用法/前置条件错误的退出码（三个脚本共用；与 `ui-check` 原有约定一致）。 */
export const EXIT_USAGE = 2;

/* -------------------------------------------------------------------------- */
/*  凭据                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 从环境变量里解析凭据。返回 `null` = **一个都没有**。
 *
 * 两套都认，与 `ui-smoke.mjs` 一致：
 *   · `AQ_TOKEN`                              —— 一枚现成的 JWT（自动巡检里手边通常只有这个）
 *   · `UI_SMOKE_USER` + `UI_SMOKE_PASS`       —— 表单登录（人现场操作时拿得到）
 */
export function readCredentials(env = process.env) {
  const token = (env.AQ_TOKEN ?? '').trim();
  if (token) return { kind: 'token', token };
  const username = (env.UI_SMOKE_USER ?? '').trim();
  const password = (env.UI_SMOKE_PASS ?? '').trim();
  if (username && password) return { kind: 'password', username, password };
  return null;
}

/**
 * 缺凭据 → 打印**为什么会假绿**，然后非零退出。
 *
 * 这段文字刻意解释机制而不只是报错：下一个人看到它时要知道"原来那样报绿是假的"，
 * 否则他会以为是这次改动把工具弄红脾气了。
 */
export function requireCredentials(tool, env = process.env) {
  const creds = readCredentials(env);
  if (creds) return creds;

  console.error(
    [
      '',
      `✗ ${tool}：**没有登录凭据** —— 这次自检不能给出任何结论。`,
      '',
      '  为什么不继续跑：未登录时应用会把访问**重定向到 /login**，于是脚本量的是',
      '  **登录页** —— 它的正文长度固定在一个很小的值（2026-10-17 实测：',
      '  `ui-check` 496 字、`ui-audit` 437 字），而 `ui-check` 的判据是「> 300 字」，',
      '  于是每一页都"通过"，而那份绿灯证明的只是"登录页渲染正常"。',
      '',
      '  请提供下面**二者之一**（与 `npm run ui:smoke` 同一套变量）：',
      '    · AQ_TOKEN=<jwt>',
      '    · UI_SMOKE_USER=<用户名> UI_SMOKE_PASS=<密码>',
      '',
      '  另外还需要：AQ_BASE（三个脚本都认；`ui-audit` 另认 --url / UI_SMOKE_URL），',
      '  以及 AQ_CHROME（或 CHROME_PATH）指向 Chrome/Edge 可执行文件。',
      '',
    ].join('\n'),
  );
  process.exit(EXIT_USAGE);
}

/* -------------------------------------------------------------------------- */
/*  登录                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 建立登录态，并且**断言它真的建立了**。
 *
 * 顺序与 `ui-smoke.mjs` 一致：先进同源页面 → 再写 `localStorage` → 之后导航才带登录态。
 */
export async function login(page, base, creds) {
  const authPath = `${base}/login`;
  if (creds.kind === 'token') {
    await page.goto(authPath, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => localStorage.setItem('aq.token', t), creds.token);
    return;
  }
  await page.goto(authPath, { waitUntil: 'domcontentloaded' });
  await page.fill('input[autocomplete="username"], input[name="username"]', creds.username);
  await page.fill('input[type="password"]', creds.password);
  await page.keyboard.press('Enter');
  await page
    .waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 })
    .catch(() => {
      /* 超时不在这里报错：交给 assertLoggedIn 给出更准确的诊断。 */
    });
}

/**
 * 断言当前**不在**登录页。
 *
 * 放在第一次导航到目标页之后调用。它同时挡住两件事：
 *   · 令牌过期/无效（服务端拒绝 → 踢回 `/login`，并把失效的 token 清掉）；
 *   · 应用鉴权行为变化（例如未登录也能渲染一个空壳）。
 *
 * 没有这一步，`AQ_TOKEN` 填一个过期串也能拿到一整套绿灯 —— 那与"没有凭据"同害。
 *
 * `creds` 用来把**原因**说到点上：token 路径下"localStorage 里没有 token"是
 * **结果**（服务端清掉了它），不是"表单登录没成功"。
 */
export async function assertLoggedIn(page, tool, creds) {
  const path = new URL(page.url()).pathname;
  if (!path.startsWith('/login')) return;

  const stored = await page
    .evaluate(() => localStorage.getItem('aq.token') ?? '')
    .catch(() => '');
  const reason =
    creds?.kind === 'token'
      ? stored
        ? '你提供的是 AQ_TOKEN，但服务端不接受它 —— 已过期、或被另一个实例签发。'
        : '你提供的是 AQ_TOKEN，而服务端已经把它清掉了（过期或无效）。'
      : stored
        ? '表单登录提交后仍被送回 /login —— 用户名或密码不对。'
        : 'localStorage 里没有 token —— 表单登录没有成功。';
  console.error(
    [
      '',
      `✗ ${tool}：**登录态没有建立** —— 页面停在 /login。`,
      '',
      `  ${reason}`,
      '',
      '  不继续自检：那会把"检查登录页"当成"检查目标页"，正是这次要修掉的假绿。',
      '',
    ].join('\n'),
  );
  process.exit(EXIT_USAGE);
}

/* -------------------------------------------------------------------------- */
/*  markdown 判据                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 注入到页面里执行的扫描。**必须是自包含的纯函数**（`page.evaluate` 不共享闭包）。
 *
 * 返回值里三个计数各自独立，且都带样本 —— 只报一个数字，下一个人定位不到是哪一处。
 */
export function probeMarkdown() {
  /**
   * 元素是否**渲染出来**了。`checkVisibility` 是 Chrome 105+ 的标准 API
   *（默认只查 `display:none`，带上两个开关才一并查 `visibility` / `opacity`）；
   * 老环境回落到"有没有盒子"。
   */
  function isVisible(el) {
    if (!el) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    return el.getClientRects().length > 0;
  }

  /**
   * 页面上的**可见文本**，按文本节点重建。
   *
   * ⚠️ **刻意不用 `document.body.innerText`。** 这个脚本的第一版就是用它，
   * 结果报了一个**不存在的命中**：`innerText` 会把**内联 `<script>` 的源码**
   * 也算进来 —— 而任何 `<script>` 里出现星号对（glob 就是这种形状）都会变成假红。
   * 都会变成假红。假红会让整条检查被忽略，所以这里宁可多写十行。
   *
   * 可见性语义与 `innerText` 对齐（跳过 `display:none` / `visibility:hidden` /
   * `opacity:0`），差别只有两点，都是**刻意的**：
   *   · 显式排除 `SCRIPT` / `STYLE` / `TEMPLATE` / `NOSCRIPT`；
   *   · **逐文本节点**访问 —— 容器有没有子元素都不影响这里（这正是 ① 的盲区）。
   */
  function visibleText() {
    const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
    let out = '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || SKIP.has(parent.tagName)) continue;
      if (!isVisible(parent)) continue;
      out += `${node.nodeValue ?? ''}\n`;
    }
    return out;
  }

  const countIn = (text) => (text.match(/\*\*[^*\n]{1,120}\*\*/g) ?? []).length;

  /* ① 旧判据：逐**叶子元素**。刻意保留 —— 它让"盲区"在输出里可见，而不是只写在注释里。
   * ⚠️ 顺便补了一处旧判据自己的假阳性：它用 `el.innerText`，而规范规定
   * **未渲染的元素 `innerText` 返回 `textContent`** —— 于是 `display:none` 里的文案
   * 也会被数进来。这里加了 `isVisible`，让它与页面级判据同一把尺子。 */
  let leafMatches = 0;
  const leafSamples = [];
  for (const el of document.querySelectorAll('*')) {
    /* ⚠️ 这一行就是盲区的来源：含子元素的容器被跳过，而它的**文本节点**从不被访问。
     * `/appearance` 那句 `**是禁用的**` 正落在这样一个 `<p>` 的文本节点里。 */
    if (el.children.length > 0) continue;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    if (!isVisible(el)) continue;
    const t = el.innerText ?? '';
    const n = countIn(t);
    if (n === 0) continue;
    leafMatches += n;
    if (leafSamples.length < 6) {
      leafSamples.push({
        text: t.trim().slice(0, 56),
        cls: String(el.className ?? '').slice(0, 44),
        parent: String(el.parentElement?.className ?? '').slice(0, 44),
      });
    }
  }

  /* ② 页面级：跨越元素边界（补齐 ① 的盲区）。 */
  const pageText = visibleText();
  const innerTextMatches = countIn(pageText);
  const innerTextSamples = [];
  if (innerTextMatches > 0) {
    for (const m of pageText.matchAll(/\*\*[^*\n]{1,120}\*\*/g)) {
      if (innerTextSamples.length >= 6) break;
      const i = Math.max(0, (m.index ?? 0) - 30);
      innerTextSamples.push(pageText.slice(i, i + 90).replace(/\s+/g, ' '));
    }
  }

  /* ③ title 属性：悬浮可见，此前完全不在任何检查范围。 */
  let titleHits = 0;
  let titleMatches = 0;
  const titleSamples = [];
  for (const el of document.querySelectorAll('[title]')) {
    /* 不可渲染的元素（`display:none` 子树）悬浮不到，不算用户可见。 */
    if (!isVisible(el)) continue;
    const t = el.getAttribute('title') ?? '';
    const found = t.match(/\*\*[^*\n]{1,120}\*\*/g) ?? [];
    if (found.length === 0) continue;
    titleHits += 1;
    titleMatches += found.length;
    if (titleSamples.length < 6) {
      titleSamples.push({
        hit: found[0].slice(0, 40),
        tag: el.tagName,
        cls: String(el.className ?? '').slice(0, 44),
      });
    }
  }

  return {
    leafMatches,
    leafSamples,
    innerTextMatches,
    innerTextSamples,
    titleHits,
    titleMatches,
    titleSamples,
    textLen: pageText.replace(/\s/g, '').length,
  };
}

/** 三个计数里任意一个 > 0 就算命中（供各脚本统一判命中）。 */
export function hasMarkdown(scan) {
  return scan.innerTextMatches > 0 || scan.titleHits > 0;
}

/**
 * markdown 维度**是否参与退出码**。
 *
 * ## 默认**不参与** —— 这是一个有代价的刻意决定，理由要写清楚
 *
 * 2026-10-17 这次改动落地时，这套判据在真机上抓到 **28 处 `title` + 1 处正文**
 * （总览 11 / 机器人列表 14 / 详情 2 / 团队看板 1 / 外观 1）。它们**全部是真阳性**，
 * 但**全部是已跟踪、待修**的展示层缺陷（B4 批次）。
 *
 * 如果默认就让它们失败，代价是具体的：
 *
 *   · `ui-check` 是"每次 UI 改动的固定动作"，它会在这 28 处被修掉之前**一直红**；
 *   · 而本仓库对"一直红且与自己无关"的工具的结论是明确的 ——
 *     `ui-check.mjs` 自己的注释里写着：「一个会误报的检查工具比没有检查更糟：
 *     **它训练人忽略它的红叉**」。同一个机制对"长期已知项"同样成立。
 *
 * 所以默认的行为是：**报出来，但不改判决**。这不是"不说"：
 *   · 有残留的页面在逐页清单里显示 **`⚠️` 而不是 `✅`**（永远不会假绿）；
 *   · 摘要里**单列一行**给出页数与处数；
 *   · 想让它一并失败：`--markdown-gate` 或 `AQ_UI_MARKDOWN_GATE=1`。
 *
 * ⚠️ **它是可翻转的，而不是被删掉的**：等那 28 处清完，把这个开关的默认值改成 true
 * 即可（或让调用方带上参数）。一条能证明自己会红的判据，比一条被删掉的判据有用。
 */
export function markdownGateEnabled(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--markdown-gate')) return true;
  const v = (env.AQ_UI_MARKDOWN_GATE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * 把一次扫描打成给人看的一段。`indent` 是每行前缀。
 *
 * 输出里**刻意同时打三条计数**：当页面级命中而逐叶子为 0 时，那一行本身就是
 * "盲区真的存在"的证据（而不是一句写在注释里的断言）——
 * 2026-10-17 在 `/appearance` 上实测正是 `正文 1 · 逐叶子 0`。
 */
export function formatMarkdownReport(scan, indent = '      ') {
  const lines = [];
  lines.push(
    `${indent}markdown 残留: 正文 ${scan.innerTextMatches} 处 · title ${scan.titleHits} 个属性（${scan.titleMatches} 处）· 逐叶子 ${scan.leafMatches} 处（旧判据，作对照）`,
  );
  for (const s of scan.innerTextSamples) lines.push(`${indent}  正文命中: ${s}`);
  for (const s of scan.titleSamples) {
    lines.push(`${indent}  title 命中: <${s.tag} class="${s.cls}"> → ${s.hit}`);
  }
  if (scan.innerTextMatches > scan.leafMatches) {
    lines.push(
      `${indent}  ⚠️ 逐叶子只看到 ${scan.leafMatches} 处、页面级看到 ${scan.innerTextMatches} 处 —— 差额来自「含子元素的容器」里的文本节点`,
    );
  }
  return lines;
}

/**
 * 本判据**抓不到什么** —— 每个调用方都要把它打出来。
 *
 * 写在这里而不是散在三个脚本里：这是同一份取舍，不该有三种说法。
 */
export const MARKDOWN_BLIND_SPOTS = [
  '水平分隔线（`---`）与表格符（`|`）：它们在 `/data` 日志、提示词原文、执行日志里**合法**出现，判红就是假红',
  '`**` 被切成两个文本节点的那种（`**粗<strong>体</strong>**`）：逐文本节点拼接后不构成一对，不报',
  '伪元素（`::after { content }`）里的文案：`innerText` 与文本节点遍历都看不到',
  'canvas / SVG `<text>` 里画出来的字',
];
