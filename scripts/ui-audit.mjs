/**
 * **界面"信息可见度"审计**（外加三个 UI 自检脚本共用的库）—— 量那些 `ui-smoke` 量不到的东西。
 *
 * ## 为什么需要它（与 `scripts/ui-smoke.mjs` 的分工）
 *
 * `ui-smoke` 回答的是"**页面能不能用**"：路由是否渲染、控制台有没有报错、
 * 150% 缩放下有没有横向滚动。它**不回答**下面这两个问题：
 * ```
 *   ① 信息有没有被 CSS 截掉？（`truncate` / `line-clamp` 静默吃掉的文字）
 *   ② 界面上有没有把 markdown 标记当纯文本显示出来？（`**粗体**` 直接露给用户）
 * ```
 * 而这两个正是 2026-10-15 用户报「功能布局要合理，方便用户使用，**用户体验至上**」
 * 时的真实症状：
 * ```
 *   团队看板每行三个 `flex-1` 平分宽度 → 职责 142px/需 272px、本轮产出 142px/需 387px
 *   → 产出（"它这一轮在做什么"）被砍 63%，用户只看得到开头几个字
 *   而 `firm.ts` / `parser.ts` 的文案里带 `**` → 界面上原样显示
 * ```
 * 这两种问题**都不会让测试变红**：typecheck 绿、单测绿、`ui-smoke` 也绿
 *（页面确实渲染了、也没有横向滚动）—— 只有人盯着看才会发现。
 *
 * ## ⚠️ 本文件同时是 `ui-check` / `ui-consistency` 的**共用库**（2026-10-17）
 *
 * 三个脚本都要做同样的两件事：**凭据闸门**与 **markdown 判据**。让它们各写一遍
 * 迟早会漂 —— 本仓库对"同一件事写两遍"的结论一向是"改一处等于没改"。
 * 所以这两块实现放在本文件里（下面的「共用库」一节），另外两个脚本从这里 import。
 *
 * 因此**本文件的脚本主体包在 `main()` 里**，末尾有一道"是不是被直接运行"的判断：
 * 被 import 时**只导出函数、不启动浏览器**。
 *
 * ## 它量什么
 *
 * | 指标 | 判据 | 为什么这个判据 |
 * |---|---|---|
 * | `clipped` | 元素 `scrollWidth > clientWidth + 2` 且有 `overflow` 裁剪 | 这就是"文字被静默吃掉"的机器判据 |
 * | `innerTextMatches` | **页面可见文本**里的 `**` 处数（跨越元素边界） | 界面是纯文本，不该出现 markdown 强调符 |
 * | `titleHits` | **`title` 属性**里带 `**` 的个数（悬浮可见） | 实测漏掉 28 处 —— 见「共用库」一节 |
 * | `overflowX` | `documentElement.scrollWidth - clientWidth` | 横向滚动（`ui-smoke` 也查，这里复查一次） |
 * | `consoleErrors` | 控制台 error 条数 | 与 `ui-smoke` 同源 |
 * | `roleRows` | 团队看板每个岗位的行高与"本轮产出"格宽度 | 用来验证"宽度真的让给了产出" |
 *
 * ## ⚠️ 已知的判据边界（不要把它当全知）
 *
 * · `clipped` 会把"**有 `title` 兜底**的截断"也算进来。本仓库的规约是
 *  `ui-check.mjs` 那句：「有 `ellipsis` 但没有 `title` → 截掉的部分永远看不到，
 *  是信息丢失」。所以看到 `clipped` 里有条目时，**先确认它有没有 `title`**。
 * · `clipped` 仍然是**逐叶子**的 —— 同一个盲区在它身上还在（本次改动没有扩它）。
 * · 它只量一个机器人（默认 `#11`）—— 团队看板只在 `ai_team` 模式下渲染。
 * · markdown 判据**抓不到什么**：见 `MARKDOWN_BLIND_SPOTS`（每次运行都会原样打印）。
 *
 * ## 用法
 *
 * ```powershell
 * # 人造校准：不需要凭据、不需要起服务（判据的防恒真/恒假门禁）
 * node scripts/ui-audit.mjs --selftest
 *
 * # 真机审计：先建隧道：本地端口 → 线上服务（服务只听回环之外的网关地址）
 * ssh -N -L 27201:172.17.0.1:3200 <ssh-alias>
 * $env:AQ_TOKEN = <一枚 owner token>
 * node scripts/ui-audit.mjs --url http://127.0.0.1:27201
 * node scripts/ui-audit.mjs --url http://127.0.0.1:27201 --zoom 1.5   # 复量 150% 缩放
 * ```
 *
 * 需要本机已装 Chrome 或 Edge（用 `playwright-core` 驱动，不下载浏览器）。
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

/* ══════════════════════════════════════════════════════════════════════════ */
/*  共用库（`ui-check.mjs` / `ui-consistency.mjs` 从这里 import）              */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * ## ① 凭据闸门：为什么**必须**显式失败
 *
 * 三个脚本原来都会在**没有登录凭据**时照常跑完并报绿。它会这么"绿"：
 *
 *   1. `page.goto(BASE)` → 应用把未登录的访问重定向到 `/login`；
 *   2. 脚本量的就是**登录页**（实测正文长度**固定 496 字**）
 *      —— 而 `ui-check` 的判据是 `text > 300`，于是**每一页都通过**；
 *   3. 2026-10-17 实测：无 token 时 `ui-check` 报「10 页全部 ✅」、
 *      `ui-audit` 报「437 字 ✅ 通过」；带上真 token 重跑，同一批页面正文是
 *      **616–23,000 字**。
 *
 * 也就是说：那种绿灯证明的是"**登录页渲染正常**"，而不是"被检查的页面正常"。
 * 在一个跑真实资金的仓库里，"验证通过"这四个字**不能**有这种含义 ——
 * 所以缺凭据时这里**直接非零退出**，而不是继续跑。
 *
 * ⚠️ **只有"凭据存在"是不够的**：令牌过期时服务端会把人踢回 `/login`，
 * 于是又变成"检查登录页"。所以 `login()` 之后还要**断言没停在登录页**
 * （`assertLoggedIn`）—— 这把"过期 token"这条同样的假绿路径一起堵掉。
 *
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ## ② markdown 判据：三条计数，回答三个不同的问题
 *
 * 原来只有一个 `mdHits`，按**叶子元素**数 `**`。那条判据有两个盲区：
 *
 * | 盲区 | 机制（实测） | 后果 |
 * | --- | --- | --- |
 * | 跨元素边界 | 逐叶子扫描会 `continue` 掉**有子元素的容器**，它的**文本节点**从不被访问。`/appearance` 那句 `**是禁用的**` 正落在含 `<strong>` 的 `<p>` 的文本节点里 → 逐叶子 **0 命中**，页面级 **1 命中** | 真实的 markdown 残留被漏报 |
 * | `title` 属性 | `title` 是属性、不在 `innerText` 里，此前**任何检查都没扫它**。实测漏掉 **28 处**（总览 11 / 机器人列表 14 / 详情 2 / 团队 1）—— 而它是用户**悬浮就能看见**的文案 | 同上 |
 *
 * 所以 `probeMarkdown()` 同时给出三个计数：
 *   · `leafMatches`      —— 旧判据（保留：让"盲区"在工具自己的输出里可见，而不是只写在注释里）
 *   · `innerTextMatches` —— 页面可见文本（跨越元素边界）
 *   · `titleHits`        —— 含 markdown 的 `title` 属性个数
 *
 * ### 判据为什么只认 `**`，不认 `#` / `- ` / `|` / 反引号
 *
 * 这些符号在本仓库里**大量合法出现**，而它们是**原文**该有的样子：
 *   · 决策详情页的「系统提示词 / 用户提示词」面板**逐字**显示模型看到的提示词
 *     （审计要求：可复现），里面有 `## 市场快照`、`- 最新价：…`；
 *   · `/data` 的运行时日志里有 `|`、`-` 与反引号包住的模块名。
 * 把它们判成"界面漏了 markdown"会制造**一批假红**，而假红会让整条检查被忽略。
 * `**` 不一样：它是**强调符**，在纯文本界面里没有任何合法用途 —— 露出来就是错。
 * ⚠️ 这条取舍有代价：**水平分隔线与表格符仍然抓不到**（见 `MARKDOWN_BLIND_SPOTS`）。
 *
 * ### 为什么正则不会误伤 glob
 *
 * 星号对在 glob 里合法。判据要求成对（`\*\*[^*\n]{1,120}\*\*`），而 `[^*\n]`
 * **不允许中间再出现 `*`** —— 于是 glob 形状（星号对紧跟一个斜杠那种）天然不匹配。
 * 这是一条刻意的设计，不是巧合。
 */

/** 用法/前置条件错误的退出码（三个脚本共用；与 `ui-check` 原有约定一致）。 */
export const EXIT_USAGE = 2;

/**
 * 从环境变量里解析凭据。返回 `null` = **一个都没有**。
 *
 * 两套都认，与 `ui-smoke.mjs` 一致：
 *   · `AQ_TOKEN`                          —— 一枚现成的 JWT（自动巡检里手边通常只有这个）
 *   · `UI_SMOKE_USER` + `UI_SMOKE_PASS`   —— 表单登录（人现场操作时拿得到）
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

/**
 * 建立登录态。
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
  const pathname = new URL(page.url()).pathname;
  if (!pathname.startsWith('/login')) return;

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
   * 假红会让整条检查被忽略，所以这里宁可多写十行。
   *
   * 可见性语义与 `innerText` 对齐（跳过 `display:none` / `visibility:hidden` /
   * `opacity:0`），差别只有两点，都是**刻意的**：
   *   · 显式排除 `SCRIPT` / `STYLE` / `TEMPLATE` / `NOSCRIPT`；
   *   · **逐文本节点**访问 —— 容器有没有子元素都不影响这里（这正是旧判据的盲区）。
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

  /*
   * ① 旧判据：逐**叶子元素**。刻意保留 —— 它让"盲区"在输出里可见，而不是只写在注释里。
   * ⚠️ 顺便补了一处旧判据自己的假阳性：它用 `el.innerText`，而规范规定
   * **未渲染的元素 `innerText` 返回 `textContent`** —— 于是 `display:none` 里的文案
   * 也会被数进来。这里加了 `isVisible`，让它与页面级判据同一把尺子。
   */
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

/** 两个真实判据里任意一个 > 0 就算命中（`leafMatches` 只是对照，不参与判决）。 */
export function hasMarkdown(scan) {
  return scan.innerTextMatches > 0 || scan.titleHits > 0;
}

/**
 * markdown 维度**是否参与退出码**。
 *
 * ## 默认**不参与** —— 这是一个有代价的刻意决定，理由要写清楚
 *
 * 2026-10-17 这套判据落地时，它在真机上抓到 **28 处 `title` + 1 处正文**
 * （总览 11 / 机器人列表 14 / 详情 2 / 团队看板 1 / 外观 1）。它们**全部是真阳性**，
 * 但**全部是已跟踪、待修**的展示层缺陷。
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

/* ══════════════════════════════════════════════════════════════════════════ */
/*  人造校准（`--selftest`）—— 判据的防恒真/恒假门禁                          */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * ## 为什么需要它（而不是"跑一遍真机看看"）
 *
 * 判据最危险的失效方式不是"报错"，而是**恒真/恒假**：一个永远返回 0 的计数器
 * 会让所有页面都绿，而"绿"看起来和"真干净"一模一样。本仓库已经吃过一次同类的
 * 亏 —— 有一条守卫断言写成 `xxx || true`，于是它**永远通过**。
 *
 * 所以每个用例都同时断言**阳性**（该报的要报出来）与**阴性**（不该报的一个都不许报）：
 * 恒真的实现会在阴性上失败，恒假的会在阳性上失败。
 *
 * 它不需要凭据、不需要服务、不碰任何真实数据，所以随时可以跑。
 * 真机上的那两类残留由 `ui-check` / `ui-audit` 负责发现。
 */
const SELF_TEST_CASES = [
  {
    name: '阴性 · 干净页面（普通 title、`<strong>` 加粗、单星号、孤立星号对）',
    html: `<p>前面 <strong>粗体</strong> 后面 *单星号* 与孤立的 ** 两个星号</p>
   <div title="这是普通的悬浮说明，没有任何强调符">卡片</div>
   <span title="glob 形状但不该算：packages/web/src/**/*.ts">路径</span>`,
    expect: { innerTextMatches: 0, titleHits: 0, leafMatches: 0 },
  },
  {
    name: '阴性 · `<script>` 源码里的星号不算（历史假红）',
    html: `<p>正文很干净</p>
   <script>var re = /\\*\\*\\/*\\.ts/; /* **bold** 在脚本里 */</script>
   <style>/* **styling** */</style>`,
    expect: { innerTextMatches: 0, titleHits: 0, leafMatches: 0 },
  },
  {
    name: '阴性 · 隐藏元素里的 `**` 与隐藏的 title 都不算',
    html: `<div style="display:none"><span>**藏起来的强调**</span><span title="**藏起来的 title**">x</span></div>
   <p>可见文案</p>`,
    expect: { innerTextMatches: 0, titleHits: 0, leafMatches: 0 },
  },
  {
    name: '阳性 · 叶子元素里的 `**`（旧判据本来就抓得到，确认没被改坏）',
    html: '<span>**叶子里的强调**</span>',
    expect: { innerTextMatches: 1, leafMatches: 1, titleHits: 0 },
  },
  {
    name: '阳性 · 容器里的 `**`（/appearance 的真实形状：容器含 `<strong>`，逐叶子必漏）',
    html: `<p>⚠️ <strong>经典模板只有深色</strong>：它的配色就是原版配色，所以那一项在当前模板下**是禁用的**（不再是一个点了没反应的开关）。</p>`,
    expect: { innerTextMatches: 1, leafMatches: 0, titleHits: 0 },
  },
  {
    name: '阳性 · `title` 属性里的 `**`（旧检查完全没有这一条）',
    html: `<div title="总盈亏 = 已平仓的净盈亏 + 当前持仓的浮动盈亏，**与下面曲线的「本段变化」同一个口径**。">数值</div>`,
    expect: { innerTextMatches: 0, titleHits: 1, titleMatches: 1, leafMatches: 0 },
  },
  {
    name: '阳性 · 正文与 title 各自命中一次（两条判据互不遮蔽）',
    html: '<p>正文里**这一处**要报</p><div title="悬浮里**那一处**也要报">数值</div>',
    expect: { innerTextMatches: 1, titleHits: 1, titleMatches: 1 },
  },
  {
    name: '阳性 · 同一个 title 里两处强调符（按"属性"与"处数"分别计数）',
    html: '<div title="**第一处** 说明 **第二处**">数值</div>',
    expect: { titleHits: 1, titleMatches: 2, innerTextMatches: 0 },
  },
];

/** 找一台可用的 Chrome / Edge。**不下载浏览器**（与 `ui-smoke.mjs` 同一份候选）。 */
function findBrowserPath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.AQ_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * 跑人造校准。返回进程退出码（0 = 全部通过）。
 *
 * 每个用例都同时打印三条计数 —— 一个用例失败时，看数字就知道是"该报没报"还是"不该报却报了"。
 */
async function runSelfTest() {
  const browserPath = findBrowserPath();
  if (!browserPath) {
    console.error('找不到 Chrome / Edge —— 用 CHROME_PATH 或 AQ_CHROME 指定可执行文件。');
    return EXIT_USAGE;
  }

  console.log('\nui-audit 人造校准（判据的防恒真/恒假门禁）');
  console.log(`  浏览器: ${browserPath}\n`);

  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage();
  let failed = 0;

  for (const testCase of SELF_TEST_CASES) {
    await page.setContent(`<!doctype html><html lang="zh-CN"><body>${testCase.html}</body></html>`, {
      waitUntil: 'domcontentloaded',
    });
    const scan = await page.evaluate(probeMarkdown);
    const bad = [];
    for (const [key, want] of Object.entries(testCase.expect)) {
      if (scan[key] !== want) bad.push(`${key}: 期望 ${want}，实际 ${scan[key]}`);
    }
    console.log(`${bad.length === 0 ? '✅' : '❌'} ${testCase.name}`);
    console.log(`     正文 ${scan.innerTextMatches} · title ${scan.titleHits} · 逐叶子 ${scan.leafMatches}`);
    if (bad.length > 0) {
      failed += 1;
      for (const b of bad) console.log(`     ✗ ${b}`);
      if (scan.innerTextSamples.length > 0) console.log(`     正文样本: ${scan.innerTextSamples[0]}`);
      if (scan.titleSamples.length > 0) {
        console.log(`     title 样本: <${scan.titleSamples[0].tag}> → ${scan.titleSamples[0].hit}`);
      }
    }
  }

  await browser.close();
  console.log('');
  if (failed === 0) {
    console.log(`✅ ${SELF_TEST_CASES.length} 个用例全部通过：判据既不恒真也不恒假。\n`);
    return 0;
  }
  console.log(`❌ ${failed} 个用例不通过（见上）。\n`);
  return 1;
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  主流程                                                                     */
/* ══════════════════════════════════════════════════════════════════════════ */

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  if (process.argv.includes('--selftest')) {
    process.exitCode = await runSelfTest();
    return;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  /*
   * `--url` → `UI_SMOKE_URL` → `AQ_BASE` → 本地默认。
   *
   * ⚠️ **`AQ_BASE` 是 2026-10-17 补的，而这一补不是可有可无的**：`ui-check` 与
   * `ui-consistency` 只认 `AQ_BASE`，而 `ui-audit` 原来只认 `UI_SMOKE_URL`
   * （三个脚本的提示里都写着 AQ_BASE，于是**按提示配好变量的人会打到另一个地址上
   *  而毫无察觉**）。我自己在验证这次改动时就踩了一次：`AQ_BASE` 指向本地沙箱，
   * 而它照旧去打了默认端口。三个脚本读同一套变量，是"同一件事只写一遍"的落点。
   */
  const baseUrl = (
    arg('url', process.env.UI_SMOKE_URL ?? process.env.AQ_BASE ?? 'http://127.0.0.1:27137')
  ).replace(/\/$/, '');
  const trader = arg('trader', '11');
  const zoom = Number(arg('zoom', '1'));
  const outDir = path.resolve(repoRoot, arg('out', 'packages/web/ui-audit'));

  /*
   * 凭据是**前置条件**，不是可选项：没有它就会去量登录页，然后报一整套假绿。
   * 放在建浏览器之前 —— 一个连不上目标的检查不该先花几秒启动 Chrome。
   */
  const credentials = requireCredentials('ui-audit');

  const browserPath = findBrowserPath();
  if (!browserPath) {
    console.error('找不到 Chrome / Edge —— 设 `CHROME_PATH` 指向可执行文件。');
    process.exit(1);
  }

  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const context = await browser.newContext({
    viewport: { width: Math.round(1600 / zoom), height: Math.round(900 / zoom) },
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  console.log(`\n界面可见度审计`);
  console.log(`  浏览器: ${browserPath}`);
  console.log(`  目标:   ${baseUrl}/traders/${trader}   缩放: ${zoom * 100}%\n`);

  await login(page, baseUrl, credentials);
  await page.goto(`${baseUrl}/traders/${trader}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  /* token 过期也会被踢回 /login —— 那与"没有凭据"是同一个假绿，所以一并断言。 */
  await assertLoggedIn(page, 'ui-audit', credentials);

  const result = await page.evaluate(() => {
    const clipped = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const s = getComputedStyle(el);
      const t = (el.innerText ?? '').trim();
      if (t.length > 4 && el.scrollWidth > el.clientWidth + 2 && s.overflow !== 'visible' && s.textOverflow !== 'clip') {
        /*
         * `hasTitle` 很关键：有 `title` 的截断是**允许的设计**（悬浮可见），
         * 没有的才是"信息永远看不到"。见文件头的判据边界。
         */
        clipped.push({
          text: t.slice(0, 44),
          need: el.scrollWidth,
          have: el.clientWidth,
          hasTitle: el.getAttribute('title') !== null,
        });
      }
    }

    const roleRows = [];
    for (const li of document.querySelectorAll('li[data-role]')) {
      const prod = [...li.querySelectorAll('*')].find((e) => String(e.className ?? '').includes('line-clamp-2'));
      roleRows.push({
        id: li.getAttribute('data-role'),
        h: Math.round(li.getBoundingClientRect().height),
        prodW: prod ? Math.round(prod.getBoundingClientRect().width) : null,
        prodNeed: prod ? prod.scrollWidth : null,
        prodClipped: prod ? prod.scrollWidth > prod.clientWidth + 2 : null,
      });
    }

    const root = document.documentElement;
    return {
      clipped,
      roleRows,
      overflowX: root.scrollWidth - root.clientWidth,
    };
  });

  /*
   * markdown 扫描**单独一次 `page.evaluate`**，直接复用上面那份实现 ——
   * 三个脚本共用一份判据，就不会出现"两个工具对同一处一处报一处不报"。
   */
  const markdown = await page.evaluate(probeMarkdown);

  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, `trader-${trader}@${zoom * 100}.png`), fullPage: false });

  const problems = [];
  /* 没有 `title` 兜底的截断才是信息丢失 —— 有 `title` 的是设计允许的。 */
  const lostInfo = result.clipped.filter((c) => !c.hasTitle);
  const mdHit = hasMarkdown(markdown);
  const mdGate = markdownGateEnabled();
  if (mdHit && mdGate) {
    problems.push(
      `markdown 强调符露在界面上：正文 ${markdown.innerTextMatches} 处、title ${markdown.titleHits} 个属性（界面是纯文本，不是渲染器）`,
    );
  }
  if (lostInfo.length > 0) problems.push(`${lostInfo.length} 处文字被截断且没有 title 兜底（截掉的部分永远看不到）`);
  if (result.overflowX > 2) problems.push(`出现横向滚动（${result.overflowX}px）`);
  if (consoleErrors.length > 0) problems.push(`控制台报错 ${consoleErrors.length} 条：${consoleErrors[0].slice(0, 100)}`);

  console.log(
    `  可见文字 ${markdown.textLen} 字 · 无兜底截断 ${lostInfo.length} 处 · 有兜底截断 ${result.clipped.length - lostInfo.length} 处 · 横向滚动 ${result.overflowX}px · 控制台错误 ${consoleErrors.length} 条`,
  );
  if (mdHit) {
    for (const line of formatMarkdownReport(markdown, '    ')) console.log(line);
    if (!mdGate) {
      console.log(
        '    ⚠️ 这一维度**默认不参与退出码**（判据本身有效，见 --markdown-gate）—— 加 --markdown-gate 或 AQ_UI_MARKDOWN_GATE=1 可让它一并失败',
      );
    }
  } else {
    console.log(`    markdown 残留: 0 处（正文与 title 都干净；逐叶子对照 ${markdown.leafMatches} 处）`);
  }
  for (const c of result.clipped) {
    console.log(`    截断${c.hasTitle ? '（有 title 兜底）' : '（无兜底）'}: ${c.text} — 需 ${c.need}px / 有 ${c.have}px`);
  }
  if (result.roleRows.length > 0) {
    console.log(`  团队看板 ${result.roleRows.length} 个岗位行：`);
    for (const r of result.roleRows) {
      console.log(`    ${r.id.padEnd(18)} 行高 ${r.h}px · 产出格 ${r.prodW}px（需 ${r.prodNeed}）${r.prodClipped ? ' ← 仍被截' : ''}`);
    }
  }
  console.log(`\n  截图：${path.join(outDir, `trader-${trader}@${zoom * 100}.png`)}`);
  /* 判据抓不到什么，每次都说一遍 —— 读一个绿灯的人必须同时知道它没证明什么。 */
  console.log('\n  本判据仍**抓不到**：');
  for (const s of MARKDOWN_BLIND_SPOTS) console.log(`    · ${s}`);

  await browser.close();

  if (problems.length === 0) {
    console.log(
      mdHit
        ? `\n⚠️ 客观异常 0 个（退出码 0），但有 markdown 残留 ${markdown.innerTextMatches + markdown.titleHits} 处 —— 它默认不参与退出码，见上。\n`
        : '\n✅ 未发现问题：没有 markdown 残留，没有被静默吃掉的信息。\n',
    );
    process.exit(0);
  }
  console.log(`❌ 发现 ${problems.length} 个问题：\n`);
  for (const p of problems) console.log(`  · ${p}`);
  console.log('');
  process.exit(1);
}

/*
 * ⚠️ **只有"被直接运行"时才跑主流程**：`ui-check` / `ui-consistency` 会 import 本文件
 * 取共用库，那时**不能**顺带启动浏览器、更不能 exit。
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
