/**
 * `ui-probe-lib.mjs` 的**人造校准测试**。
 *
 * ## 为什么必须有它（而不是"跑一遍真机看看"）
 *
 * 判据最危险的失效方式不是"报错"，而是**恒真/恒假**：一个永远返回 0 的计数器
 * 会让所有页面都绿，而"绿"看起来和"真干净"一模一样。本仓库已经吃过一次
 * 同类的亏 —— 有一条守卫断言写成 `xxx || true`，于是它**永远通过**。
 *
 * 所以这里用 `page.setContent()` 造**七个合成页面**，每一个都同时断言
 * **阳性**（该报的要报出来）与**阴性**（不该报的一个都不许报）。
 * 一个恒真的实现会在阴性用例上失败，一个恒假的实现在阳性用例上失败。
 *
 * ## 它测的是"判据"，不是"应用"
 *
 * 这里不需要登录、不需要服务、不碰任何真实数据 —— 所以它可以随时跑，
 * 也可以进 CI（只要机器上有 Chrome）。真机上的那两类残留由
 * `ui-check` / `ui-audit` 负责发现。
 *
 * ## 用法
 *
 *   CHROME_PATH=<chrome 可执行文件> node scripts/ui-probe-lib.test.mjs
 *   或 node scripts/ui-probe-lib.test.mjs --chrome "C:\\...\\chrome.exe"
 *
 * 退出码：0 = 全部通过；1 = 有用例不通过；2 = 环境不满足（找不到浏览器）。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { probeMarkdown } from './ui-probe-lib.mjs';

/* -------------------------------------------------------------------------- */
/*  浏览器                                                                     */
/* -------------------------------------------------------------------------- */

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const CANDIDATES = [
  arg('chrome'),
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

const browserPath = CANDIDATES.find((p) => existsSync(p));
if (!browserPath) {
  console.error('找不到 Chrome / Edge —— 用 CHROME_PATH 或 --chrome 指定可执行文件。');
  process.exit(2);
}

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const page = await browser.newPage();

/* -------------------------------------------------------------------------- */
/*  断言                                                                       */
/* -------------------------------------------------------------------------- */

let failed = 0;

/**
 * 跑一个合成页面，逐项对比。
 *
 * `expect` 里只列**要断言的字段**，其余不检查 —— 免得一个字段的改动把无关用例全部弄红。
 */
async function check(title, html, expect) {
  await page.setContent(`<!doctype html><html lang="zh-CN"><body>${html}</body></html>`, {
    waitUntil: 'domcontentloaded',
  });
  const scan = await page.evaluate(probeMarkdown);
  const bad = [];
  for (const [key, want] of Object.entries(expect)) {
    const got = scan[key];
    if (got !== want) bad.push(`${key}: 期望 ${want}，实际 ${got}`);
  }
  const mark = bad.length === 0 ? '✅' : '❌';
  console.log(`${mark} ${title}`);
  console.log(
    `     正文 ${scan.innerTextMatches} · title ${scan.titleHits} · 逐叶子 ${scan.leafMatches}`,
  );
  if (bad.length > 0) {
    failed += 1;
    for (const b of bad) console.log(`     ✗ ${b}`);
    if (scan.innerTextSamples.length) console.log(`     正文样本: ${scan.innerTextSamples[0]}`);
    if (scan.titleSamples.length) {
      console.log(`     title 样本: <${scan.titleSamples[0].tag}> → ${scan.titleSamples[0].hit}`);
    }
  }
}

console.log(`\nui-probe-lib 人造校准\n  浏览器: ${browserPath}\n`);

/* --- 阴性用例：干净页面必须**一个都不报** ---------------------------------- */

await check(
  '阴性 · 干净页面（普通 title、`<strong>` 加粗、单星号、孤立星号对）',
  `<p>前面 <strong>粗体</strong> 后面 *单星号* 与孤立的 ** 两个星号</p>
   <div title="这是普通的悬浮说明，没有任何强调符">卡片</div>
   <span title="glob 形状但不该算：packages/web/src/**/*.ts">路径</span>`,
  { innerTextMatches: 0, titleHits: 0, leafMatches: 0 },
);

await check(
  '阴性 · `<script>` 源码里的 `**` 不算（历史假红）',
  `<p>正文很干净</p>
   <script>var re = /\\*\\*\\/*\\.ts/; /* **bold** 在脚本里 */</script>
   <style>/* **styling** */</style>`,
  { innerTextMatches: 0, titleHits: 0, leafMatches: 0 },
);

await check(
  '阴性 · 隐藏元素里的 `**` 与隐藏的 title 都不算',
  `<div style="display:none"><span>**藏起来的强调**</span><span title="**藏起来的 title**">x</span></div>
   <p>可见文案</p>`,
  { innerTextMatches: 0, titleHits: 0, leafMatches: 0 },
);

/* --- 阳性用例：每一类都必须被抓到 ------------------------------------------ */

await check(
  '阳性 · 叶子元素里的 `**`（旧判据本来就抓得到，确认没被改坏）',
  `<span>**叶子里的强调**</span>`,
  { innerTextMatches: 1, leafMatches: 1, titleHits: 0 },
);

await check(
  '阳性 · 容器里的 `**`（/appearance 的真实形状：容器含 `<strong>`，逐叶子必漏）',
  `<p>⚠️ <strong>经典模板只有深色</strong>：它的配色就是原版配色，所以那一项在当前模板下**是禁用的**（不再是一个点了没反应的开关）。</p>`,
  { innerTextMatches: 1, leafMatches: 0, titleHits: 0 },
);

await check(
  '阳性 · `title` 属性里的 `**`（旧检查完全没有这一条）',
  `<div title="总盈亏 = 已平仓的净盈亏 + 当前持仓的浮动盈亏，**与下面曲线的「本段变化」同一个口径**。">数值</div>`,
  { innerTextMatches: 0, titleHits: 1, titleMatches: 1, leafMatches: 0 },
);

await check(
  '阳性 · 正文与 title 各自命中一次（两条判据互不遮蔽）',
  `<p>正文里**这一处**要报</p><div title="悬浮里**那一处**也要报">数值</div>`,
  { innerTextMatches: 1, titleHits: 1, titleMatches: 1 },
);

await check(
  '阳性 · 同一个 title 里两处强调符（按"属性"与"处数"分别计数）',
  `<div title="**第一处** 说明 **第二处**">数值</div>`,
  { titleHits: 1, titleMatches: 2, innerTextMatches: 0 },
);

/* -------------------------------------------------------------------------- */
console.log('');
await browser.close();

if (failed === 0) {
  console.log('✅ 8 个用例全部通过：判据既不恒真也不恒假。\n');
  process.exit(0);
}
console.log(`❌ ${failed} 个用例不通过（见上）。\n`);
process.exit(1);
