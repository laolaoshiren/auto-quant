/**
 * 临时（用完即删）：自己复现"表格闪烁/重叠"。
 *
 * 用户说得对 —— 截图只能抓一帧，看不到"重叠"。所以这里用两件更精确的工具：
 *
 *   ① **MutationObserver**：记录表格区域里**每一次** DOM 变化（时间、类型、目标），
 *      以及变化前后**行数/列数/首行内容**。如果表格在高频重建，这里会看到密集的记录。
 *   ② **Playwright 录视频**：把整个交互录下来，事后抽帧 —— 抓"重叠"这种视觉残留。
 *
 * 关键判据不是"行数对不对"，而是**渲染次数**：React 每重建一次表体，
 * 浏览器就可能画出一次中间态；频率足够高时人眼看到的就是"多个残影重叠"。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, rmSync } from 'node:fs';

const BASE = process.env.AQ_BASE;
const TOKEN = process.env.AQ_TOKEN ?? '';
const CHROME = process.env.AQ_CHROME;
const VID = 'packages/web/ui-smoke/video';
rmSync(VID, { recursive: true, force: true });
mkdirSync(VID, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  recordVideo: { dir: VID, size: { width: 1600, height: 1000 } },
});
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.evaluate((t) => localStorage.setItem('aq.token', t), TOKEN);

await page.goto(`${BASE}/traders/9`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(200);

/* 装监视器：记录每一次表格相关的 DOM 变化。 */
await page.evaluate(() => {
  const w = window;
  w.__mut = [];
  w.__t0 = performance.now();

  const snapshot = () => {
    const t = document.querySelector('table');
    const txt = document.body.innerText;
    /* 表格不存在时，页面上到底是什么？这是定位"消失"的关键。 */
    const what = t
      ? 'table'
      : /正在加载/.test(txt)
        ? 'spinner'
        : /暂无当前委托/.test(txt)
          ? 'empty-orders'
          : /暂无持仓/.test(txt)
            ? 'empty-positions'
            : /暂无订单记录/.test(txt)
              ? 'empty-history'
              : /暂无成交/.test(txt)
                ? 'empty-trades'
                : 'other';
    if (!t) return { rows: -1, cols: -1, head: '', first: what };
    const head = Array.from(t.querySelectorAll('thead th'))
      .map((e) => (e.textContent ?? '').trim())
      .join('|');
    const trs = t.querySelectorAll('tbody tr');
    const first = trs[0]
      ? Array.from(trs[0].querySelectorAll('td'))
          .slice(0, 3)
          .map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 8))
          .join('|')
      : what;
    return { rows: trs.length, cols: head.split('|').length, head: head.slice(0, 40), first };
  };

  /* 监视整个 body 的子节点变化 —— 表格被换掉/重建都在这里现形。 */
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target instanceof Element ? r.target : null;
      /* 只关心表格/表体附近的变化，避免噪音。 */
      const nearTable = el && (el.closest('table') || el.tagName === 'TBODY' || el.tagName === 'TABLE');
      if (!nearTable && r.type !== 'childList') continue;
      w.__mut.push({
        t: Math.round(performance.now() - w.__t0),
        type: r.type,
        added: r.addedNodes.length,
        removed: r.removedNodes.length,
        target: r.target.nodeName,
        ...snapshot(),
      });
    }
  });
  obs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  w.__obs = obs;
});

await page.getByRole('tab', { name: /当前委托/ }).click({ timeout: 10000 });
await page.waitForTimeout(6000);

const mut = await page.evaluate(() => window.__mut);
console.log('=== 表格区域的 DOM 变化次数:', mut.length, '===');
if (mut.length) {
  console.log('  第一次:', JSON.stringify(mut[0]));
  console.log('  最后一次:', JSON.stringify(mut.at(-1)));
  const span = mut.at(-1).t - mut[0].t;
  console.log(`  时间跨度 ${span}ms → 平均每 ${(span / Math.max(1, mut.length)).toFixed(1)}ms 一次变化`);
  /* 按"行数+首行"归组，看有没有来回跳。 */
  const seq = mut.map((m) => `${m.rows}/${m.first}`.slice(0, 20));
  const uniq = [...new Set(seq)];
  console.log('  出现过的状态数:', uniq.length);
  if (uniq.length > 1) {
    console.log('  状态序列（前 40 次）:');
    for (const s of seq.slice(0, 40)) console.log('    ' + s);
  }
}

/* 结束后把页面快照也存一份，便于对账。 */
await page.screenshot({ path: `${VID}/final.png`, fullPage: false });
await ctx.close(); // 关闭时才落盘视频
const vids = (await import('node:fs')).readdirSync(VID).filter((f) => f.endsWith('.webm'));
console.log('\n录屏:', vids.length ? VID + '/' + vids[0] : '（没生成）');
await browser.close();
process.exit(0);
