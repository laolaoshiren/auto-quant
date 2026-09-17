/**
 * 量一下机器人详情页各区块占了多少高度。
 *
 * ## 为什么需要它
 *
 * 用户报过一个布局问题：「下面这块占用页面大量面积，挡住页面大部分」。
 * 我改了 CSS，但**"我改了所以应该好了"不是验证** —— 布局只能用实际像素说话。
 *
 * 这个脚本在真实浏览器里量每一块的高度，并算出占视口的比例。
 */
import { chromium } from 'playwright-core';

const BASE = process.env.AQ_BASE ?? 'http://127.0.0.1:5173';
const USER = process.env.AQ_USER;
const PASS = process.env.AQ_PASS;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
// 用一个常见的笔记本视口 —— 紧凑屏才是布局最容易出问题的地方。
const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.fill('input:not([type="password"])', USER);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);

  await page.goto(`${BASE}/traders/8`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(6000);
  // 切到有数据的那张表，让表格区取到它真实的"最高"形态
  const tab = page.locator('button:has-text("订单记录")').first();
  if ((await tab.count()) > 0) {
    await tab.click().catch(() => undefined);
    await page.waitForTimeout(3000);
  }

  const measured = await page.evaluate(() => {
    const vh = window.innerHeight;
    const out = [];
    const push = (name, el) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      out.push({ name, h: Math.round(r.height), pct: Math.round((r.height / vh) * 100) });
    };
    // 表格区：找那个含 tablist 的 Panel 的祖先容器
    const tablist = document.querySelector('[role="tablist"]');
    push('表格区', tablist ? tablist.closest('.max-h-\\[46vh\\]') ?? tablist.closest('div.space-y-4') : null);
    // 指标卡行
    const cards = document.querySelectorAll('[class*="grid"] > *');
    void cards;
    push('页头', document.querySelector('header'));
    // 整页
    const root = document.querySelector('main') ?? document.body;
    push('整页内容', root);
    return { vh, out };
  });

  console.log(`  视口高度: ${measured.vh}px`);
  for (const m of measured.out) {
    console.log(`  ${m.name.padEnd(10)} ${String(m.h).padStart(5)}px  ${String(m.pct).padStart(3)}%`);
  }
  const tables = measured.out.find((m) => m.name === '表格区');
  if (tables) {
    if (tables.pct <= 50) console.log(`  ✅ 表格区占 ${tables.pct}%，不超一半`);
    else console.log(`  ❌ 表格区占 ${tables.pct}%，仍然过大`);
  } else {
    console.log('  ⚠️ 没有量到表格区（选择器没匹配上）');
  }
  if (errors.length > 0) {
    console.log(`  ❌ 捕获到 ${errors.length} 条错误：`);
    for (const e of errors.slice(0, 3)) console.log(`     ${e.slice(0, 200)}`);
    process.exitCode = 1;
  } else {
    console.log('  ✅ 无控制台错误');
  }
} catch (err) {
  console.log(`  ❌ 脚本失败: ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
