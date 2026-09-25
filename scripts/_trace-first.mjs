/**
 * 临时（用完即删）：按用户给的复现步骤抓「首次点进当前委托」那一帧。
 *
 * 用户描述：
 *   · 刷新页面后 → 点「当前委托」→ 闪出一些数据（太快看不清）
 *   · 不刷新、在标签之间来回切 → 正常
 *   · 再刷新、或从顶部导航切走再回来 → 复现
 *
 * 所以问题出在**首次挂载**，不是标签切换（上次修的是后者，方向偏了）。
 */
import { chromium } from 'playwright-core';

const BASE = process.env.AQ_BASE;
const TOKEN = process.env.AQ_TOKEN ?? '';
const CHROME = process.env.AQ_CHROME;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.evaluate((t) => localStorage.setItem('aq.token', t), TOKEN);

/* ── 场景 A：刷新页面后，立刻点「当前委托」 ─────────────────────────── */
console.log('=========== 场景 A：刷新后直接点「当前委托」 ===========');
/*
 * ⚠️ 顺序不能反：`goto` 会**重置页面**（新 document），上一版把采样器装在 goto 之前，
 * 于是它连同旧 document 一起被丢掉，采到 0 帧。必须先加载完，再装。
 */
await page.goto(`${BASE}/traders/9`, { waitUntil: 'domcontentloaded' });

/* 页面一加载就装采样器：每一帧记录"表格里的行数 + 首行前 3 格" */
await page.evaluate(() => {
  const w = window;
  w.__s = [];
  w.__clickAt = null;
  document.addEventListener(
    'click',
    (e) => {
      const el = e.target instanceof Element ? e.target.closest('[role="tab"]') : null;
      if ((el?.textContent ?? '').includes('当前委托')) w.__clickAt = Math.round(performance.now());
    },
    true,
  );
  const tick = () => {
    const t = document.querySelector('table');
    let rows = -1;
    let first = '';
    if (t) {
      const trs = t.querySelectorAll('tbody tr');
      rows = trs.length;
      const firstTds = trs[0]?.querySelectorAll('td') ?? [];
      first = Array.from(firstTds).slice(0, 3).map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 12)).join('|');
    }
    w.__s.push({ t: Math.round(performance.now()), rows, first });
    /*
     * 1500 帧 ≈ 25 秒 @60fps。上一版只给 300 帧（≈5 秒），而"等页面稳定 1.2 秒再点"
     * 已经把预算耗掉一大半 —— 结果点击之后一帧都没采到（`after` 为空）。
     */
    if (w.__s.length < 1500) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

/* 只等很短一点就点 —— 模拟"页面刚出来就点进去"（用户就是这么复现的） */
await page.waitForTimeout(300);
await page.getByRole('tab', { name: /当前委托/ }).click({ timeout: 10000 });
await page.waitForTimeout(3000);

const { s, clickAt } = await page.evaluate(() => ({ s: window.__s, clickAt: window.__clickAt }));
console.log('  点击时刻:', clickAt);
const after = clickAt === null ? s : s.filter((x) => x.t >= clickAt);
console.log('  点击后帧数:', after.length);
console.log('  点击后出现过的行数:', JSON.stringify([...new Set(after.map((x) => x.rows))]));
console.log('\n=== 点击后行数发生变化的时刻 ===');
let prev = null;
for (const x of after) {
  if (x.rows !== prev) {
    console.log(`    ${String(x.t).padStart(5)}ms  行=${String(x.rows).padStart(3)}  首行="${x.first}"`);
    prev = x.rows;
  }
}

/* ── 场景 B：不刷新，标签来回切 ─────────────────────────────────────── */
console.log('\n=========== 场景 B：不刷新，来回切换标签 ===========');
await page.evaluate(() => {
  window.__s = [];
  window.__clickAt = null;
});
await page.getByRole('tab', { name: /订单记录/ }).click({ timeout: 8000 });
await page.waitForTimeout(1500);
/* 在「订单记录」状态下重置采样，然后点回「当前委托」。 */
await page.evaluate(() => {
  window.__s = [];
  window.__clickAt = Math.round(performance.now());
});
await page.getByRole('tab', { name: /当前委托/ }).click({ timeout: 8000 });
await page.waitForTimeout(2000);
const { s: s2, clickAt: c2 } = await page.evaluate(() => ({ s: window.__s, clickAt: window.__clickAt }));
console.log('  点击时刻:', c2, ' 帧数:', s2.length);
console.log('  来回切换时出现过的行数:', JSON.stringify([...new Set(s2.map((x) => x.rows))]));
console.log('\n  === 切回「当前委托」后的轨迹 ===');
let p2 = null;
for (const x of s2) {
  if (x.rows !== p2) {
    console.log(`    ${String(x.t).padStart(5)}ms  行=${String(x.rows).padStart(3)}  首行="${x.first}"`);
    p2 = x.rows;
  }
}

/* ── 场景 C：看首次加载时数据到底什么时候到 ─────────────────────────── */
console.log('\n=========== 场景 C：刷新后 ordersQuery 何时拿到数据 ===========');
const reqs = [];
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('/orders') || u.includes('/positions')) {
    reqs.push({ at: Date.now(), url: u.replace(BASE, '').slice(0, 60), status: r.status() });
  }
});
await page.goto(`${BASE}/traders/9`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const t0 = reqs[0]?.at ?? Date.now();
for (const r of reqs.slice(0, 10)) console.log(`    +${String(r.at - t0).padStart(5)}ms  ${r.status}  ${r.url}`);

await browser.close();
process.exit(0);
