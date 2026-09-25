/** 临时（用完即删）：验证"刷新后首次点进当前委托"不再闪加载转圈。 */
import { chromium } from 'playwright-core';

const BASE = process.env.AQ_BASE;
const TOKEN = process.env.AQ_TOKEN ?? '';
const CHROME = process.env.AQ_CHROME;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.evaluate((t) => localStorage.setItem('aq.token', t), TOKEN);

await page.goto(`${BASE}/traders/9`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(150);

/* 逐帧记录：画面上有没有「正在加载」、有没有表格、几行。 */
await page.evaluate(() => {
  const w = window;
  w.__s = [];
  const tick = () => {
    const txt = document.body.innerText;
    const t = document.querySelector('table');
    w.__s.push({
      t: Math.round(performance.now()),
      spinner: /正在加载/.test(txt),
      rows: t ? t.querySelectorAll('tbody tr').length : -1,
    });
    if (w.__s.length < 900) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

await page.getByRole('tab', { name: /当前委托/ }).click({ timeout: 10000 });
await page.waitForTimeout(4000);

const s = await page.evaluate(() => window.__s);
const spans = s.filter((x) => x.spinner);
console.log('采样帧数:', s.length);
console.log('出现「正在加载」的帧数:', spans.length, spans.length ? `（持续约 ${spans.at(-1).t - spans[0].t}ms）` : '');
console.log(spans.length === 0 ? '✅ 加载转圈不再出现 —— 闪烁已消除' : '⚠️ 仍有转圈');
console.log('\n行数变化轨迹:');
let prev = null;
for (const x of s) {
  if (x.rows !== prev) {
    console.log(`  ${String(x.t).padStart(5)}ms  行=${String(x.rows).padStart(3)}  spinner=${x.spinner}`);
    prev = x.rows;
  }
}
await browser.close();
process.exit(0);
