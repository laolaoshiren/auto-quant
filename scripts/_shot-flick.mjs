/**
 * 临时（用完即删）：刷新页面后立即点「当前委托」，同时**逐帧截图** ——
 * 行数看不出的闪烁，只能在画面上看。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, rmSync } from 'node:fs';

const BASE = process.env.AQ_BASE;
const TOKEN = process.env.AQ_TOKEN ?? '';
const CHROME = process.env.AQ_CHROME;
const OUT = 'packages/web/ui-smoke/flick';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.evaluate((t) => localStorage.setItem('aq.token', t), TOKEN);

/* 刷新后立刻开拍：不等 networkidle，模拟"页面刚出来就点"。 */
await page.goto(`${BASE}/traders/9`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(150);

/*
 * 只截**表格区域**（页面中部那块），帧率高、文件小。
 * 用 `clip` 而非整页：闪烁发生在那块，整页截图会把细节压小。
 */
const CLIP = { x: 20, y: 620, width: 1560, height: 300 };

const shots = [];
const shoot = async (tag) => {
  const name = `${OUT}/${String(shots.length).padStart(2, '0')}-${tag}.png`;
  await page.screenshot({ path: name, clip: CLIP }).catch(() => {});
  const info = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    return tables.map((t) => ({
      rows: t.querySelectorAll('tbody tr').length,
      head: Array.from(t.querySelectorAll('thead th')).slice(0, 2).map((e) => (e.textContent ?? '').trim()).join('/'),
    }));
  });
  const txt = (await page.evaluate(() => document.body.innerText.slice(0, 0))) || '';
  void txt;
  shots.push({ name, info });
};

/* 拍 3 张"点击前"，然后点，再拍 20 张。 */
for (let i = 0; i < 3; i += 1) {
  await shoot('before');
  await page.waitForTimeout(80);
}
await page.getByRole('tab', { name: /当前委托/ }).click({ timeout: 10000 });
for (let i = 0; i < 20; i += 1) {
  await shoot('after');
  await page.waitForTimeout(45);
}
await page.waitForTimeout(800);
await shoot('settled');

console.log('共截图', shots.length, '张 →', OUT);
for (const s of shots) {
  console.log(`  ${s.name.split('/').pop()}  tables=${JSON.stringify(s.info)}`);
}
await browser.close();
process.exit(0);
