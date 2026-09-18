/**
 * 检查「当前委托」标签里显示的单，与数据库里真正未终态的单是否一致。
 *
 * ## 为什么需要它
 *
 * 用户报「当前委托里有 10 张挂单，但只有 1 个持仓」——而数据库里只有 2 张 NEW。
 * **这类"界面显示的数与实际的数不一致"只能靠对比两边来定案**，
 * 光看代码或光看数据库都得不出结论。
 */
import { chromium } from 'playwright-core';

const BASE = process.env.AQ_BASE ?? 'http://127.0.0.1:5173';
const USER = process.env.AQ_USER;
const PASS = process.env.AQ_PASS;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.fill('input:not([type="password"])', USER);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);

  await page.goto(`${BASE}/traders/8`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(5000);

  // 标签上那个数字
  const tabText = await page.locator('button:has-text("当前委托")').first().innerText().catch(() => '');
  console.log(`  标签文本: ${tabText.replace(/\s+/g, ' ').trim()}`);

  // 切到该标签，数表体里的行
  await page.locator('button:has-text("当前委托")').first().click().catch(() => undefined);
  await page.waitForTimeout(3000);

  const rows = await page.evaluate(() => {
    const out = [];
    for (const tr of document.querySelectorAll('table tbody tr')) {
      const tds = [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim());
      if (tds.length >= 2) out.push({ symbol: tds[0], cols: tds });
    }
    return out;
  });

  console.log(`  表体行数: ${rows.length}`);
  for (const r of rows.slice(0, 12)) {
    // 打印"交易对 + 用途 + 状态"（状态在最后几列）
    const joined = r.cols.filter(Boolean).slice(0, 3).join(' | ');
    const tail = r.cols.filter(Boolean).slice(-3).join(' | ');
    console.log(`    ${joined}   ……  ${tail}`);
  }

  if (errors.length > 0) {
    console.log(`  ❌ 页面错误 ${errors.length} 条`);
    for (const e of errors.slice(0, 3)) console.log(`     ${e.slice(0, 200)}`);
  } else {
    console.log('  ✅ 无页面错误');
  }
} catch (err) {
  console.log(`  ❌ 脚本失败: ${err.message}`);
} finally {
  await browser.close();
}
