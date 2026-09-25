/**
 * 控制台版面自检：逐页在**真实浏览器**里找客观异常。
 *
 * ## 为什么需要它
 *
 * 重做界面这十几轮里，我每一轮都在手工写一遍同样的脚本：打开页面、量正文长度、
 * 找横向溢出、收集控制台错误。那是重复劳动，而且**每次写法略有不同** ——
 * 于是"这轮查了没有"和"上轮查了没有"其实不可比。
 *
 * ## 它判什么、不判什么
 *
 * 判的是**客观异常**，不是"好不好看"：横向溢出、控制台报错、4xx/5xx、空白页。
 * 版面美观仍然要人看截图 —— 这个脚本只负责挡住"明显坏了"的那一类。
 *
 * ## ⚠️ 横向溢出必须排除 `text-overflow: ellipsis`
 *
 * 第一版把 `scrollWidth > clientWidth` 一律算成溢出，于是 `/strategy` 报了两处
 * **假阳性**：那两个格子带着 `truncate`（省略号截断），而"内容比容器宽"正是
 * 截断的**预期状态**。真正要抓的是**另一种**情况：
 *
 *   · 没有 `ellipsis` 却溢出 → **内容真的跑出去了**（会撑出横向滚动条）
 *   · 有 `ellipsis` 但**没有 `title`** → 截掉的部分**永远看不到**，是信息丢失
 *
 * 后者比前者更隐蔽：版面看起来完全正常，只是那半句话谁也读不到。
 *
 * ## 用法
 *
 *   AQ_BASE=https://... AQ_TOKEN=<jwt> AQ_CHROME=<chrome 路径> npm run ui:check
 *
 * 需要登录态，所以**不能进 CI**（CI 里没有真实部署与凭据）。它是本地/服务器上
 * 手动核对的工具，用于在每次 UI 改动之后快速过一遍全部页面。
 */
import { chromium } from 'playwright-core';

const BASE = process.env.AQ_BASE;
const TOKEN = process.env.AQ_TOKEN ?? '';
const CHROME = process.env.AQ_CHROME;
if (!BASE || !CHROME) {
  console.error('需要 AQ_BASE 与 AQ_CHROME 环境变量（见本文件顶部用法）。');
  process.exit(2);
}

const ROUTES = [
  ['/', '总览'],
  ['/traders', '机器人'],
  ['/strategy', '策略工作室'],
  ['/market', '行情'],
  ['/data', '数据与日志'],
  ['/models', 'AI 模型'],
  ['/exchanges', '交易所'],
  ['/account', '操作员账户'],
  ['/faq', '帮助'],
];

/*
 * 机器人详情页的 id **必须动态取**，不能写死。
 *
 * 这里原来是 `['/traders/8', '机器人详情']` —— 而机器人是会被删掉的：实测线上
 * 只剩 `#9`，`#8` 早已删除，于是这一页每次都报「控制台错误 2 条 + 4xx 2 条」，
 * **看起来像改版把页面改坏了**，实际只是脚本拿了一个不存在的 id 去撞。
 *
 * 一个会误报的检查工具比没有检查更糟：它训练人忽略它的红叉。
 */
let traderRoute = null;
try {
  const res = await fetch(`${BASE}/api/traders`, {
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
  });
  const rows = await res.json();
  if (Array.isArray(rows) && rows[0]?.id) traderRoute = [`/traders/${rows[0].id}`, '机器人详情'];
} catch {
  /* 取不到就**不检查这一页** —— 拿一个猜的 id 去撞只会制造假故障。 */
  console.error('⚠️ 读不到机器人列表，跳过「机器人详情」这一页');
}
if (traderRoute) ROUTES.splice(2, 0, traderRoute);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message.slice(0, 140)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 140)); });
const badResponses = [];
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url().slice(-50)}`); });

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.evaluate((t) => localStorage.setItem('aq.token', t), TOKEN);

let problems = 0;

for (const [route, label] of ROUTES) {
  const errBefore = consoleErrors.length;
  const badBefore = badResponses.length;
  await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const m = await page.evaluate(() => {
    const realOverflow = [];
    const clippedWithoutTitle = [];
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el);
      if (s.overflowX === 'auto' || s.overflowX === 'scroll') continue;
      const over = el.scrollWidth - el.clientWidth;
      if (over <= 2 || el.clientWidth <= 100) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (s.textOverflow === 'ellipsis') {
        /* 截断是预期行为，但截掉的部分必须能从 title 看到。 */
        if (!el.getAttribute('title') && text.length > 0) {
          clippedWithoutTitle.push({ cls: (el.className || '').toString().slice(0, 60), text: text.slice(0, 40) });
        }
      } else {
        realOverflow.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 60), over });
      }
    }
    const scroller = document.getElementById('main-scroll') ?? document.querySelector('main');
    return {
      text: (document.body.innerText || '').length,
      realOverflow: realOverflow.slice(0, 5),
      clippedWithoutTitle: clippedWithoutTitle.slice(0, 5),
      scrollable: scroller ? scroller.scrollHeight - scroller.clientHeight : null,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  const errs = consoleErrors.length - errBefore;
  const bad = badResponses.length - badBefore;
  const ok =
    m.text > 300 && m.realOverflow.length === 0 && m.docOverflow <= 0 && errs === 0 && bad === 0;
  if (!ok || m.clippedWithoutTitle.length > 0) problems++;

  console.log(
    `  ${route.padEnd(13)} ${label.padEnd(7)} 正文 ${String(m.text).padStart(6)} 字  可滚 ${String(m.scrollable).padStart(5)}px  ${ok ? '✅' : '❌'}`,
  );
  for (const o of m.realOverflow) console.log(`      ⚠️ <${o.tag}> 溢出 ${o.over}px  ${o.cls}`);
  for (const c of m.clippedWithoutTitle) {
    console.log(`      ⚠️ 被截断且没有 title（内容读不到）: ${c.cls} — "${c.text}"`);
  }
  if (errs > 0) console.log(`      ❌ 控制台错误 ${errs} 条`);
  if (bad > 0) console.log(`      ❌ 4xx/5xx ${bad} 条`);
}

console.log(
  problems === 0
    ? `\n✅ ${ROUTES.length} 个页面没有客观异常`
    : `\n❌ ${problems} 个页面有问题（见上）`,
);
await browser.close();
process.exit(problems === 0 ? 0 : 1);
