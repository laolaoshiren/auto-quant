/**
 * 界面冒烟检查 —— 用真实浏览器打开每一个页面。
 *
 * ## 为什么需要它
 *
 * `typecheck` 和 `build` 通过**不代表页面能用**。它们看不见这些东西：
 *
 *   · 运行时的控制台报错（未捕获的 Promise、key 警告、Radix 的 aria 抱怨）
 *   · 某个路由渲染成空白（懒加载路径写错、组件抛错被 ErrorBoundary 吞掉）
 *   · 浏览器缩放后出现横向滚动条（交易界面最常见的布局事故）
 *   · 点击后没有任何反应（状态没接上，但编译完全通过）
 *
 * 这个项目里已经有过实例：`animate-pulseSoft` 这个类名在
 * `tailwind.config.js` 里根本不存在，Tailwind 对不存在的类**不报错**，
 * 只是不生成样式 —— 于是那些状态徽章**从来没有闪过**，
 * 而 typecheck 与 build 全绿。
 *
 * ## 用法
 *
 *     先启动服务（前端产物要在 packages/web/dist）
 *         npm run ui:smoke
 *         npm run ui:smoke -- --url http://127.0.0.1:27137 --user admin_xxx --pass yyy
 *
 * 需要本机已安装 Chrome 或 Edge（用 `playwright-core` 驱动，不下载浏览器）。
 * 找不到浏览器时会明确告诉你，而不是抛一个看不懂的错误。
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */
/*  参数                                                                       */
/* -------------------------------------------------------------------------- */

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const BASE_URL = arg('url', process.env.UI_SMOKE_URL ?? 'http://127.0.0.1:27137').replace(/\/$/, '');
const USERNAME = arg('user', process.env.UI_SMOKE_USER ?? '');
const PASSWORD = arg('pass', process.env.UI_SMOKE_PASS ?? '');
const OUT_DIR = path.resolve(REPO_ROOT, arg('out', 'packages/web/ui-smoke'));

/** 要检查的路由。带 `:id` 的会在运行时用第一条真实数据替换。 */
const ROUTES = [
  ['/', '总览'],
  ['/traders', '机器人'],
  ['/strategy', '策略'],
  ['/market', '行情'],
  ['/models', '模型'],
  ['/exchanges', '交易所'],
  ['/account', '账户'],
  ['/data', '数据'],
  ['/faq', 'FAQ'],
];

/** 缩放级别。150% 是用户实际会遇到的上限，也是最容易挤坏布局的。 */
const ZOOMS = [1, 1.25, 1.5];

/* -------------------------------------------------------------------------- */
/*  浏览器查找                                                                 */
/* -------------------------------------------------------------------------- */

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findBrowser() {
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  console.error('找不到浏览器。请安装 Chrome / Edge，或用 CHROME_PATH 指定可执行文件路径。');
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*  报告                                                                       */
/* -------------------------------------------------------------------------- */

const problems = [];
function problem(where, detail) {
  problems.push({ where, detail });
  console.log(`  ✗ ${where} — ${detail}`);
}
function ok(text) {
  console.log(`  ✓ ${text}`);
}

/* -------------------------------------------------------------------------- */
/*  主流程                                                                     */
/* -------------------------------------------------------------------------- */

const browserPath = findBrowser();
console.log(`\n界面冒烟检查`);
console.log(`  浏览器: ${browserPath}`);
console.log(`  目标:   ${BASE_URL}\n`);

const { chromium } = await import('playwright-core');

const browser = await chromium.launch({ executablePath: browserPath, headless: true });
mkdirSync(OUT_DIR, { recursive: true });

let context = await browser.newContext({ viewport: { width: 1600, height: 900 } });

/** 当前页面收集到的运行时错误。每次导航前清空。 */
let consoleErrors = [];
let pageErrors = [];

function attach(page) {
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
}

/* --- 1. 服务可达 --- */
{
  const page = await context.newPage();
  attach(page);
  try {
    const response = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    if (!response || !response.ok()) {
      problem('服务可达性', `HTTP ${response?.status() ?? '无响应'} —— 服务起来了吗？`);
      await browser.close();
      process.exit(1);
    }
    ok(`服务可达（HTTP ${response.status()}）`);
  } catch (error) {
    problem('服务可达性', error.message.split('\n')[0]);
    await browser.close();
    process.exit(1);
  }
  await page.close();
}

/* --- 2. 登录 --- */
const loginPage = await context.newPage();
attach(loginPage);
await loginPage.goto(BASE_URL, { waitUntil: 'networkidle' });

if (USERNAME && PASSWORD) {
  try {
    await loginPage.fill('input[autocomplete="username"], input[name="username"]', USERNAME);
    await loginPage.fill('input[type="password"]', PASSWORD);
    await loginPage.keyboard.press('Enter');
    await loginPage.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });
    ok('登录成功');
  } catch (error) {
    problem('登录', error.message.split('\n')[0]);
  }
} else {
  console.log('  · 未提供凭据，只检查登录页');
}
await loginPage.close();

/* --- 3. 逐路由检查 --- */
const discovered = [];

for (const [route, label] of ROUTES) {
  const page = await context.newPage();
  consoleErrors = [];
  pageErrors = [];
  attach(page);

  const target = `${BASE_URL}${route}`;
  try {
    await page.goto(target, { waitUntil: 'networkidle', timeout: 20_000 });
    await page.waitForTimeout(400); // 让懒加载块与首批请求落地

    // 页面不该是空白的：主区域要有可见文本
    const text = (await page.locator('main, body').first().innerText().catch(() => '')) || '';
    const visible = text.replace(/\s/g, '').length;

    if (visible < 30) {
      problem(`${label} ${route}`, `页面几乎是空的（可见文本 ${visible} 字）—— 可能渲染失败`);
    } else if (pageErrors.length > 0) {
      problem(`${label} ${route}`, `未捕获异常: ${pageErrors[0].slice(0, 120)}`);
    } else if (consoleErrors.length > 0) {
      problem(`${label} ${route}`, `控制台报错: ${consoleErrors[0].slice(0, 120)}`);
    } else if (/^(http:\/\/[^/]+)?\/(login|404|not-?found)/.test(new URL(page.url()).pathname)) {
      problem(`${label} ${route}`, `被重定向到 ${page.url()} —— 路由没匹配上或未登录`);
    } else {
      ok(`${label} ${route}（可见 ${visible} 字）`);
    }

    /* --- 缩放与横向滚动 --- */
    const client = await page.context().newCDPSession(page);
    for (const zoom of ZOOMS) {
      // 用 CDP 设置页面缩放，等同于浏览器菜单里的缩放
      await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: zoom }).catch(() => {});
      // 同时缩窄视口来模拟"放大后可用宽度变小"，这是真正会挤坏布局的情形
      await page.setViewportSize({ width: Math.round(1600 / zoom), height: Math.round(900 / zoom) });
      await page.waitForTimeout(250);

      const overflow = await page.evaluate(() => {
        const el = document.documentElement;
        return { scroll: el.scrollWidth, client: el.clientWidth };
      });

      // 允许 2px 的取整误差
      if (overflow.scroll - overflow.client > 2) {
        problem(`${label} ${route} @${Math.round(zoom * 100)}%`, `出现横向滚动（内容 ${overflow.scroll}px > 视口 ${overflow.client}px）`);
      }
    }

    // 恢复视口与**页面缩放**。
    //
    // 缩放必须显式复位：`setPageScaleFactor` 是粘性的，只恢复视口尺寸的话
    // 截图会带着放大状态拍下来，看起来就像"右侧内容被裁掉了" ——
    // 那是测试脚本制造的假象，不是界面的问题。这个坑踩过一次。
    await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }).catch(() => {});
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForTimeout(300);

    await page.screenshot({
      path: path.join(OUT_DIR, `${route.replace(/\W+/g, '_') || 'root'}.png`),
      fullPage: false,
    });

    /* --- 收集带 id 的真实路由 --- */
    if (route === '/traders') {
      const link = await page.locator('a[href^="/traders/"]').first().getAttribute('href').catch(() => null);
      if (link) discovered.push([link, '机器人详情']);
    }
    if (route === '/strategy') {
      const link = await page.locator('a[href^="/strategy/"]').first().getAttribute('href').catch(() => null);
      if (link) discovered.push([link, '策略编辑']);
    }
  } catch (error) {
    problem(`${label} ${route}`, error.message.split('\n')[0]);
  }
  await page.close();
}

/* --- 4. 详情页（用真实数据） --- */
for (const [route, label] of discovered) {
  const page = await context.newPage();
  consoleErrors = [];
  pageErrors = [];
  attach(page);
  try {
    await page.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle', timeout: 20_000 });
    await page.waitForTimeout(600);
    const text = ((await page.locator('main, body').first().innerText().catch(() => '')) || '').replace(/\s/g, '');
    if (text.length < 30) problem(`${label} ${route}`, `页面几乎是空的（${text.length} 字）`);
    else if (pageErrors.length > 0) problem(`${label} ${route}`, `未捕获异常: ${pageErrors[0].slice(0, 120)}`);
    else ok(`${label} ${route}（可见 ${text.length} 字）`);

    await page.screenshot({ path: path.join(OUT_DIR, `${label}-detail.png`), fullPage: false });
  } catch (error) {
    problem(`${label} ${route}`, error.message.split('\n')[0]);
  }
  await page.close();
}

/* --- 5. 命令面板（⌘K） --- */
{
  const page = await context.newPage();
  consoleErrors = [];
  pageErrors = [];
  attach(page);
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    const dialogVisible = await page.locator('[cmdk-root], [role="dialog"]').first().isVisible().catch(() => false);
    if (!dialogVisible) {
      problem('命令面板', 'Ctrl+K 没有打开任何面板');
    } else {
      ok('命令面板可以用 Ctrl+K 打开');
      await page.keyboard.type('策略');
      await page.waitForTimeout(300);
      const items = await page.locator('[cmdk-item]').count().catch(() => 0);
      if (items === 0) problem('命令面板', '输入关键词后没有匹配到任何条目');
      else ok(`命令面板搜索返回 ${items} 条`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      const stillOpen = await page.locator('[cmdk-root]').first().isVisible().catch(() => false);
      if (stillOpen) problem('命令面板', 'Esc 没有关闭面板');
    }
    await page.screenshot({ path: path.join(OUT_DIR, 'command-palette.png') });
  } catch (error) {
    problem('命令面板', error.message.split('\n')[0]);
  }
  await page.close();
}

/* --- 6. 侧栏折叠 --- */
{
  const page = await context.newPage();
  consoleErrors = [];
  pageErrors = [];
  attach(page);
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    const before = await page.locator('aside, nav').first().boundingBox();
    const toggle = page.locator('button[aria-label*="折叠"], button[aria-label*="展开"], button[aria-label*="侧栏"]').first();
    if ((await toggle.count()) > 0) {
      await toggle.click();
      await page.waitForTimeout(500);
      const after = await page.locator('aside, nav').first().boundingBox();
      if (before && after && Math.abs(before.width - after.width) < 4) {
        problem('侧栏折叠', '点击后宽度没有变化');
      } else {
        ok(`侧栏折叠可用（${Math.round(before?.width ?? 0)}px → ${Math.round(after?.width ?? 0)}px）`);
      }
    } else {
      console.log('  · 没找到侧栏折叠按钮，跳过');
    }
  } catch (error) {
    problem('侧栏折叠', error.message.split('\n')[0]);
  }
  await page.close();
}

/* -------------------------------------------------------------------------- */
/*  结论                                                                       */
/* -------------------------------------------------------------------------- */

await browser.close();

console.log(`\n截图目录：${OUT_DIR}`);
console.log(`  共 ${ROUTES.length} 个路由 × ${ZOOMS.length} 档缩放已检查\n`);

if (problems.length === 0) {
  console.log('✅ 未发现问题：所有页面都能渲染，控制台干净，150% 缩放下无横向滚动。\n');
  process.exit(0);
}

console.log(`❌ 发现 ${problems.length} 个问题：\n`);
for (const item of problems) console.log(`  · ${item.where}\n      ${item.detail}`);
console.log('');
process.exit(1);
