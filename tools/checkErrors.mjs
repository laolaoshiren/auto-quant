/**
 * 抓取机器人详情页上显示给操作员的**错误文本**。
 *
 * ## 为什么需要它
 *
 * 用户报「图2 位置有一个红色英文错误，刷新页面也一直存在」。
 * 而 `trader.last_error` 是空的、行情接口返回 200 ——
 * **所以那条错误来自别处，而"是哪一处"只能从页面上读出来。**
 *
 * 这个脚本把所有看起来像错误提示的文本抓下来（含它们的原文），
 * 而不是靠猜是哪个组件。
 */
import { chromium } from 'playwright-core';

const BASE = process.env.AQ_BASE ?? 'http://127.0.0.1:5173';
const USER = process.env.AQ_USER;
const PASS = process.env.AQ_PASS;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.fill('input:not([type="password"])', USER);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);

  await page.goto(`${BASE}/traders/8`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // 等久一点，让所有轮询都跑过至少一轮（错误常常在数据到达后才出现）
  await page.waitForTimeout(12_000);

  const found = await page.evaluate(() => {
    const out = [];
    /*
     * 抓两类：
     *  1) 带错误语义的 class（down / error / danger）里出现的文本
     *  2) 任何含英文单词的短文本（用户看到的是英文，所以这是主要线索）
     */
    const isEnglishy = (t) => /[A-Za-z]{4,}/.test(t) && !/^[A-Z]{2,10}USDT$/.test(t);
    for (const el of document.querySelectorAll('div, p, span')) {
      const cls = el.className ?? '';
      const text = (el.textContent ?? '').trim();
      if (!text || text.length > 400) continue;
      const errorish = typeof cls === 'string' && /(^|\s|\b)(down|error|danger|warn)/i.test(cls);
      if (errorish && (isEnglishy(text) || text.length > 4)) {
        out.push({ where: typeof cls === 'string' ? cls.slice(0, 60) : '', text: text.slice(0, 300) });
      }
    }
    // 去重
    const seen = new Set();
    return out.filter((x) => {
      const k = x.text;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });

  if (found.length === 0) {
    console.log('  ✅ 页面上没有发现错误提示');
  } else {
    console.log(`  发现 ${found.length} 条可疑文本：`);
    for (const f of found.slice(0, 12)) {
      console.log(`    [${f.where}]`);
      console.log(`      ${f.text.replace(/\s+/g, ' ').slice(0, 220)}`);
    }
  }
} catch (err) {
  console.log(`  ❌ 脚本失败: ${err.message}`);
} finally {
  await browser.close();
}
