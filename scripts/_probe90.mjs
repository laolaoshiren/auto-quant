/**
 * 临时（用完即删）：**彻查**表格闪烁。
 *
 * 前几轮的教训：只观察 6 秒，而轮询是 15 秒一次 —— 真正的跳变可能在后面。
 * 这个版本：
 *   ① 观察 90 秒（覆盖 ~6 轮轮询）
 *   ② 走遍所有四个标签（持仓 / 委托 / 历史成交 / 订单记录）
 *   ③ 每次 DOM 变化都记录"表格是否存在 / 是什么内容 / 行数 / 列数 / 是否 spinner / 是否空状态"
 *   ④ 输出**去重后的连续状态序列** —— 那是"人眼看到的重叠"的直接来源
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
await page.goto(`${BASE}/traders/9`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(200);

await page.evaluate(() => {
  const w = window;
  w.__log = [];
  w.__t0 = performance.now();
  let lastKey = null;

  const classify = () => {
    const t = document.querySelector('table');
    const txt = document.body.innerText;
    if (t) {
      const head = Array.from(t.querySelectorAll('thead th')).map((e) => (e.textContent ?? '').trim());
      const trs = t.querySelectorAll('tbody tr');
      /* 用表头第 3 列区分是哪张表：用途=订单/委托，平仓原因/净盈亏=成交，方向/杠杆=持仓 */
      const kind = head.includes('用途')
        ? 'orders'
        : head.includes('平仓原因') || head.some((h) => h.includes('净盈亏'))
          ? 'trades'
          : head.some((h) => h.includes('强平价'))
            ? 'positions'
            : 'other';
      return { key: `table:${kind}:${trs.length}`, label: `${kind} 表 ${trs.length} 行` };
    }
    if (/正在加载/.test(txt)) return { key: 'spinner', label: '转圈' };
    if (/暂无/.test(txt)) return { key: 'empty', label: '空状态（暂无…）' };
    return { key: 'blank', label: '空白占位' };
  };

  const record = (why) => {
    const c = classify();
    const t = Math.round(performance.now() - w.__t0);
    if (c.key === lastKey) return;
    lastKey = c.key;
    w.__log.push({ t, key: c.key, label: c.label, why });
  };

  const obs = new MutationObserver(() => record('dom'));
  obs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

  /* 也按固定节拍采样一次 —— DOM 不变但内容换了（比如整表替换）也能被节拍抓到。 */
  const beat = setInterval(() => record('beat'), 50);
  w.__stop = () => {
    obs.disconnect();
    clearInterval(beat);
  };
});

/* 走遍所有标签 */
const tabs = ['当前持仓', '当前委托', '历史成交', '订单记录'];
for (const name of tabs) {
  await page.getByRole('tab', { name: new RegExp(name) }).click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(12000); // 覆盖接近一轮轮询
}
await page.waitForTimeout(30000); // 再静置观察两轮轮询

const log = await page.evaluate(() => {
  window.__stop();
  return window.__log;
});

console.log('=== 状态变化共', log.length, '次（去重后的连续片段）===');
for (const e of log) console.log(`  ${String(e.t).padStart(6)}ms  ${e.label.padEnd(18)} (${e.why})`);

/* 判据：出现「空状态」或「表格类型跳变」都算可疑。 */
const empties = log.filter((e) => e.key === 'empty');
const kinds = log.filter((e) => e.key.startsWith('table:')).map((e) => e.key.split(':')[1]);
let flips = 0;
for (let i = 1; i < kinds.length; i += 1) if (kinds[i] !== kinds[i - 1]) flips += 1;
console.log('\n=== 判定 ===');
console.log('  空状态出现次数:', empties.length, empties.length ? '❌' : '✅');
console.log('  表格类型切换次数:', flips, flips > 4 ? '❌（四个标签最多切 3 次）' : '✅');
await browser.close();
process.exit(0);
