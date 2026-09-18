/**
 * 用真实浏览器打开机器人详情页，捕获控制台错误。
 *
 * ## 为什么写这个
 *
 * 我连续两次让用户帮我看"页面是不是白的" —— 那是把我的活推给了别人。
 *
 * 仓库的 devDependencies 里一直有 `playwright-core`，而系统里装了 Chrome。
 * **能自己看的东西，不该让别人看。**
 */
import { chromium } from 'playwright-core';

const BASE = process.env.AQ_BASE ?? 'http://127.0.0.1:5173';
const USER = process.env.AQ_USER;
const PASS = process.env.AQ_PASS;
const PATH_TO_TRADER = process.env.AQ_PATH ?? '/traders/8';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
});
const page = await browser.newPage();

const errors = [];
const logs = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  else logs.push(`[${msg.type()}] ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`));
/*
 * `ERR_ABORTED` **不是失败，是客户端主动取消。**
 *
 * 应用用 `AbortController` 在依赖变化或组件卸载时中断在途请求
 * （见 `usePolled`），那是正确行为 —— 不中断的话，一个过期的响应
 * 会写进已经变了的状态里。
 *
 * 第一版把每一条 `requestfailed` 都当错误报出来，于是这个工具
 * 每次运行有约 40% 的概率喊一条假警报。
 * **一个会误报的检查比没有检查更糟**：它会把人训练成忽略它 ——
 * 而这正是本仓库在别处反复写过的那件事（「狼来了」的面板会被学会忽略）。
 *
 * 真正要报的是**服务器拒绝**、**连接失败**、**超时**那些。
 */
const IGNORED_FAILURES = ['net::ERR_ABORTED'];
page.on('requestfailed', (req) => {
  const reason = req.failure()?.errorText ?? '';
  if (IGNORED_FAILURES.some((x) => reason.includes(x))) return;
  errors.push(`[requestfailed] ${req.url()} ${reason}`);
});

try {
  // 1. 登录
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 30_000 });
  // 用户名那个 <input> 没有显式的 type 属性，所以 [type="text"] 匹配不到。
  await page.fill('input:not([type="password"])', USER);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  console.log(`  登录后 URL: ${page.url()}`);

  // 2. 打开详情页
  errors.length = 0;
  await page.goto(`${BASE}${PATH_TO_TRADER}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(6000); // 让轮询跑起来 —— 崩溃常常发生在数据到达之后

  // 3. 看页面还剩多少内容
  const text = (await page.locator('body').innerText().catch(() => '')) || '';
  const html = await page.locator('#root').innerHTML().catch(() => '');

  console.log('');
  console.log(`  URL: ${page.url()}`);
  console.log(`  #root 内容长度: ${html.length}`);
  console.log(`  可见文本长度: ${text.trim().length}`);
  console.log(`  可见文本前 200 字: ${text.trim().slice(0, 200).replace(/\s+/g, ' ')}`);
  console.log('');
  if (errors.length === 0) {
    console.log('  ✅ 没有捕获到任何错误');
  } else {
    console.log(`  ❌ 捕获到 ${errors.length} 条错误：`);
    for (const e of errors.slice(0, 10)) console.log(`     ${e.slice(0, 600)}`);
  }
} catch (err) {
  console.log(`  ❌ 脚本自身失败: ${err.message}`);
  for (const e of errors.slice(0, 5)) console.log(`     ${e.slice(0, 400)}`);
} finally {
  await browser.close();
}
