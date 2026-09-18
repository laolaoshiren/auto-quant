/**
 * 验证「平仓」按钮打开的是**真的平仓确认框**，而不是旧的"不可用"说明。
 *
 * ## 为什么需要它
 *
 * 用户报「全部平仓和单独平仓按钮不可用」。而"按钮能点开一个弹窗"与
 * "那个弹窗能真的平仓"是两件事 —— 原来那个弹窗的标题就写着「平仓不可用」。
 *
 * 这个脚本**只看弹窗内容、不点确认** —— 它不该动真钱。
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
  await page.waitForTimeout(6000);

  const report = (label, ok, detail) => console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`);

  // 1. 单独平仓按钮
  const single = page.locator('table button:has-text("平仓")').first();
  const singleCount = await single.count();
  report('持仓表里有「平仓」按钮', singleCount > 0, singleCount ? '' : '（可能当前没有持仓）');

  if (singleCount > 0) {
    await single.click();
    await page.waitForTimeout(1200);
    // Radix 的 Dialog 渲染成 [role="dialog"] —— 不要回落到 body，那会抓到整页。
    const text = (await page.locator('[role="dialog"]').first().innerText()).slice(0, 600);
    const isReal = text.includes('确认平仓') && text.includes('市价');
    const isOld = text.includes('不可用') || text.includes('不会下任何订单');
    report('弹窗是「真的平仓确认框」', isReal && !isOld, isReal ? '' : (isOld ? '打开的还是旧说明框' : '内容不符'));
    console.log(`     弹窗文本前 120 字: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
    // 只关闭，不确认 —— 不动真钱
    await page.locator('button:has-text("取消")').first().click().catch(() => undefined);
    await page.waitForTimeout(800);
  }

  // 2. 全部平仓按钮
  const all = page.locator('button:has-text("全部平仓")').first();
  const disabled = await all.isDisabled().catch(() => true);
  report('「全部平仓」按钮可用（有持仓时不该禁用）', !disabled, disabled ? '仍是禁用状态' : '');

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
