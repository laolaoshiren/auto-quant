/**
 * **界面"信息可见度"审计** —— 量那些 `ui-smoke` 量不到的东西。
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
 * ## 它量什么
 *
 * | 指标 | 判据 | 为什么这个判据 |
 * |---|---|---|
 * | `clipped` | 元素 `scrollWidth > clientWidth + 2` 且有 `overflow` 裁剪 | 这就是"文字被静默吃掉"的机器判据 |
 * | `innerTextMatches` | **页面可见文本**里的 `**` 处数（跨越元素边界） | 界面是纯文本，不该出现 markdown 强调符 |
 * | `titleHits` | **`title` 属性**里带 `**` 的个数（悬浮可见） | 实测漏掉 28 处 —— 见下 |
 * | `overflowX` | `documentElement.scrollWidth - clientWidth` | 横向滚动（`ui-smoke` 也查，这里复查一次） |
 * | `consoleErrors` | 控制台 error 条数 | 与 `ui-smoke` 同源 |
 * | `roleRows` | 团队看板每个岗位的行高与"本轮产出"格宽度 | 用来验证"宽度真的让给了产出" |
 *
 * ## ⚠️ markdown 有**两条**判据，少一条就漏（2026-10-17 补齐）
 *
 * 原来只有一条 `mdHits`，按**叶子元素**数 `**`。它有**两个**盲区，都实测过：
 *
 *   1. **跨元素边界** —— 逐叶子扫描会跳过**含子元素的容器**，而它的**文本节点**
 *      从不被访问。`/appearance` 那句 `**是禁用的**` 正落在这样一个 `<p>` 的文本节点里
 *      （那个 `<p>` 含 `<strong>`）→ 逐叶子 **0 命中**，页面级 **1 命中**。
 *   2. **`title` 属性** —— `title` 不在 `innerText` 里，所以它此前**根本没有任何检查**。
 *      实测有 **28 处** title 带 `**`（总览 11 / 机器人列表 14 / 详情 2 / 团队看板 1），
 *      而它是用户**悬浮就能看见**的文案。
 *
 * 所以现在是页面级 + `title` 两条判据，`leaf` 计数保留作对照 —— 让"盲区"在**输出里**
 * 可见，而不是只写在注释里。判据为什么只认 `**`（不认 `##` / `- ` / `|`），
 * 见 `ui-probe-lib.mjs`；**抓不到什么**也在那里列成了一张表，脚本会原样打出来。
 *
 * ## ⚠️ 缺凭据时**直接非零退出**（2026-10-17）
 *
 * 原来没有凭据也照跑：应用把访问重定向到 `/login`，脚本量的就是**登录页**
 * （实测正文固定 **437 字**）→ 报「✅ 未发现问题」。那种绿灯证明的是
 * "登录页渲染正常"，而不是被检查的页面正常。现在缺凭据（或 token 已过期）
 * 会**非零退出并说明原因**，见 `ui-probe-lib.mjs`。
 *
 * ## ⚠️ 已知的判据边界（不要把它当全知）
 *
 * · `clipped` 会把"**有 `title` 兜底**的截断"也算进来。本仓库的规约是
 *  `ui-check.mjs` 那句：「有 `ellipsis` 但没有 `title` → 截掉的部分永远看不到，
 *  是信息丢失」。所以看到 `clipped` 里有条目时，**先确认它有没有 `title`**。
 * · `clipped` 仍然是**逐叶子**的 —— 同一个盲区在它身上还在（未在这次改动里扩）。
 * · 它只量一个机器人（默认 `#11`）—— 团队看板只在 `ai_team` 模式下渲染。
 *
 * ## 用法
 *
 * ```powershell
 * # 先建隧道：本地端口 → 线上服务（服务只听 172.17.0.1:3200）
 * ssh -N -L 27201:172.17.0.1:3200 <ssh-alias>
 * $env:AQ_TOKEN = <一枚 owner token>
 * node scripts/ui-audit.mjs --url http://127.0.0.1:27201
 * node scripts/ui-audit.mjs --url http://127.0.0.1:27201 --zoom 1.5   # 复量 150% 缩放
 * ```
 *
 * 需要本机已装 Chrome 或 Edge（用 `playwright-core` 驱动，不下载浏览器）。
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKDOWN_BLIND_SPOTS,
  assertLoggedIn,
  formatMarkdownReport,
  hasMarkdown,
  login,
  markdownGateEnabled,
  probeMarkdown,
  requireCredentials,
} from './ui-probe-lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/*
 * `--url` → `UI_SMOKE_URL` → `AQ_BASE` → 本地默认。
 *
 * ⚠️ **`AQ_BASE` 是 2026-10-17 补的，而这一补不是可有可无的**：`ui-check` 与
 * `ui-consistency` 只认 `AQ_BASE`，而 `ui-audit` 只认 `UI_SMOKE_URL`
 * （它们的 `credentialHint` 里都写着 AQ_BASE，于是**按提示配好变量的人会打到
 *  另一个地址上而毫无察觉**）。我自己在验证这次改动时就踩了一次：
 * `AQ_BASE` 指向本地沙箱，而它照旧去打了默认端口。
 * 三个脚本读同一套变量，是"同一件事只写一遍"在这一层的落点。
 */
const BASE_URL = (
  arg('url', process.env.UI_SMOKE_URL ?? process.env.AQ_BASE ?? 'http://127.0.0.1:27137')
).replace(/\/$/, '');
const TRADER = arg('trader', '11');
const ZOOM = Number(arg('zoom', '1'));
const OUT_DIR = path.resolve(REPO_ROOT, arg('out', 'packages/web/ui-audit'));

/*
 * 凭据是**前置条件**，不是可选项：没有它就会去量登录页，然后报一整套假绿。
 * 放在建浏览器之前 —— 一个连不上目标的检查不该先花几秒启动 Chrome。
 */
const credentials = requireCredentials('ui-audit');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const { existsSync } = await import('node:fs');
const browserPath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!browserPath) {
  console.error('找不到 Chrome / Edge —— 设 `CHROME_PATH` 指向可执行文件。');
  process.exit(1);
}

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const context = await browser.newContext({
  viewport: { width: Math.round(1600 / ZOOM), height: Math.round(900 / ZOOM) },
});
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(e.message));

console.log(`\n界面可见度审计`);
console.log(`  浏览器: ${browserPath}`);
console.log(`  目标:   ${BASE_URL}/traders/${TRADER}   缩放: ${ZOOM * 100}%\n`);

await login(page, BASE_URL, credentials);
await page.goto(`${BASE_URL}/traders/${TRADER}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
/* token 过期也会被踢回 /login —— 那与"没有凭据"是同一个假绿，所以一并断言。 */
await assertLoggedIn(page, 'ui-audit', credentials);

const result = await page.evaluate(() => {
  const R = (el) => {
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  };

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
 * markdown 扫描**单独一次 `page.evaluate`**，直接复用 `ui-probe-lib.mjs` 的那份实现 ——
 * 三个脚本共用一份判据，就不会出现"两个工具对同一处一处报一处不报"。
 */
const markdown = await page.evaluate(probeMarkdown);

mkdirSync(OUT_DIR, { recursive: true });
await page.screenshot({ path: path.join(OUT_DIR, `trader-${TRADER}@${ZOOM * 100}.png`), fullPage: false });

const problems = [];
/* 没有 `title` 兜底的截断才是信息丢失 —— 有 `title` 的是设计允许的。 */
const lostInfo = result.clipped.filter((c) => !c.hasTitle);
const mdHit = hasMarkdown(markdown);
/*
 * ⚠️ markdown 命中**默认只报、不改判决** —— 理由（含代价与翻转方式）写在
 * `ui-probe-lib.mjs` 的 `markdownGateEnabled` 上。要点：这 28 处是真阳性，
 * 但它们是**已跟踪的待修项**，让"每次 UI 改动的固定动作"在那之前一直红，
 * 只会训练人忽略红叉。`--markdown-gate` / `AQ_UI_MARKDOWN_GATE=1` 可让它失败。
 */
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
console.log(`\n  截图：${path.join(OUT_DIR, `trader-${TRADER}@${ZOOM * 100}.png`)}`);
/* 判据抓不到什么，每次都说一遍 —— 读一个绿灯的人必须同时知道它没证明什么。 */
console.log('\n  本判据仍**抓不到**：');
for (const s of MARKDOWN_BLIND_SPOTS) console.log(`    · ${s}`);

if (problems.length === 0) {
  console.log(
    mdHit
      ? `\n⚠️ 客观异常 0 个（退出码 0），但有 markdown 残留 ${markdown.innerTextMatches + markdown.titleHits} 处 —— 它默认不参与退出码，见上。\n`
      : '\n✅ 未发现问题：没有 markdown 残留，没有被静默吃掉的信息。\n',
  );
  await browser.close();
  process.exit(0);
}
console.log(`❌ 发现 ${problems.length} 个问题：\n`);
for (const p of problems) console.log(`  · ${p}`);
console.log('');
await browser.close();
process.exit(1);
