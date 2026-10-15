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
 * | `mdHits` | 可见文字里 `**` 的出现次数 | 界面是纯文本，不该出现 markdown 强调符 |
 * | `overflowX` | `documentElement.scrollWidth - clientWidth` | 横向滚动（`ui-smoke` 也查，这里复查一次） |
 * | `consoleErrors` | 控制台 error 条数 | 与 `ui-smoke` 同源 |
 * | `roleRows` | 团队看板每个岗位的行高与"本轮产出"格宽度 | 用来验证"宽度真的让给了产出" |
 *
 * ## ⚠️ 已知的判据边界（不要把它当全知）
 *
 * · `**` 的统计基于 `innerText`，所以 **`title` 属性里的 `**` 不计入** ——
 *   而悬浮说明同样会露给用户。要查那一侧得看 SSR 断言
 *（`boardRender.test.ts` 有一条专门判"整行 HTML 不含 `**`"）。
 * · `clipped` 会把"**有 `title` 兜底**的截断"也算进来。本仓库的规约是
 *  `ui-check.mjs` 那句：「有 `ellipsis` 但没有 `title` → 截掉的部分永远看不到，
 *  是信息丢失」。所以看到 `clipped` 里有条目时，**先确认它有没有 `title`**。
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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const BASE_URL = arg('url', process.env.UI_SMOKE_URL ?? 'http://127.0.0.1:27137').replace(/\/$/, '');
const TOKEN = process.env.AQ_TOKEN ?? '';
const TRADER = arg('trader', '11');
const ZOOM = Number(arg('zoom', '1'));
const OUT_DIR = path.resolve(REPO_ROOT, arg('out', 'packages/web/ui-audit'));

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

await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
await page.evaluate((t) => localStorage.setItem('aq.token', t), TOKEN);
await page.goto(`${BASE_URL}/traders/${TRADER}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const result = await page.evaluate(() => {
  const R = (el) => {
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  };
  const bodyText = document.body.innerText ?? '';

  /*
   * ⚠️ 只统计**可见元素**的 `**`：`innerText` 会把内联 `<script>` 的文本也算进来
   *（第一版就因此报了一个不存在的命中），所以按叶子元素逐个看。
   */
  const mdSamples = [];
  let mdHits = 0;
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length > 0) continue;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    const t = el.innerText ?? '';
    const n = (t.match(/\*\*/g) ?? []).length;
    if (n > 0) {
      mdHits += n;
      if (mdSamples.length < 5) mdSamples.push(t.trim().slice(0, 60));
    }
  }

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
    textLen: bodyText.replace(/\s/g, '').length,
    mdHits,
    mdSamples,
    clipped,
    roleRows,
    overflowX: root.scrollWidth - root.clientWidth,
  };
});

mkdirSync(OUT_DIR, { recursive: true });
await page.screenshot({ path: path.join(OUT_DIR, `trader-${TRADER}@${ZOOM * 100}.png`), fullPage: false });

const problems = [];
/* 没有 `title` 兜底的截断才是信息丢失 —— 有 `title` 的是设计允许的。 */
const lostInfo = result.clipped.filter((c) => !c.hasTitle);
if (result.mdHits > 0) problems.push(`可见文字里有 ${result.mdHits} 处 markdown 强调符（界面是纯文本，不是渲染器）`);
if (lostInfo.length > 0) problems.push(`${lostInfo.length} 处文字被截断且没有 title 兜底（截掉的部分永远看不到）`);
if (result.overflowX > 2) problems.push(`出现横向滚动（${result.overflowX}px）`);
if (consoleErrors.length > 0) problems.push(`控制台报错 ${consoleErrors.length} 条：${consoleErrors[0].slice(0, 100)}`);

console.log(`  可见文字 ${result.textLen} 字 · markdown 残留 ${result.mdHits} 处 · 无兜底截断 ${lostInfo.length} 处 · 有兜底截断 ${result.clipped.length - lostInfo.length} 处 · 横向滚动 ${result.overflowX}px · 控制台错误 ${consoleErrors.length} 条`);
if (result.mdSamples.length > 0) {
  for (const s of result.mdSamples) console.log(`    markdown 样本: ${s}`);
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

if (problems.length === 0) {
  console.log('✅ 未发现问题：没有 markdown 残留，没有被静默吃掉的信息。\n');
  await browser.close();
  process.exit(0);
}
console.log(`❌ 发现 ${problems.length} 个问题：\n`);
for (const p of problems) console.log(`  · ${p}`);
console.log('');
await browser.close();
process.exit(1);
