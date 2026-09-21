/**
 * 界面一致性自检：找**屏幕上互相矛盾的数字**。
 *
 * ## 为什么要有这个（而不是再加测试）
 *
 * 某一天操作员连着报了四个问题，**每一个都是他看界面发现的，而我一个都没主动找出来**：
 *
 *   1. 每刷新一次页面，右下角就弹一轮**过时的**成交通知；
 *   2. 界面说「赚了 0.20」，而交易所钱包相对起始只多了 0.008；
 *   3. 每个决策都显示「置信度 0%」，而模型其实**根本没给这个字段**；
 *   4. 一行里同时写着「触发止损」和 **+$0.17**（那是一次**被上移到成本之上的**止损）。
 *
 * **共同点是：数据层全对，界面把它们拼错了。** 而 `ui-check.mjs` 查的是"版面坏没坏"
 * （溢出、控制台报错、空白页），`npm test` 查的是"计算对不对" —— 两边都不看
 * "屏幕上这两个数字放一起说不说得通"。那正好是唯一有人会看的地方。
 *
 * 所以这个脚本不问"算得对吗"，只问**"同一屏上的数字彼此矛盾吗"**。
 * 规则全部从上面四个真实问题反向提炼，一条对应一个。
 *
 * ## 与 `ui-check.mjs` 的分工
 *
 *   · `ui:check`       —— 版面客观异常（溢出、报错、空白），10 个页面都过一遍；
 *   · `ui:consistent`  —— **跨字段语义矛盾**（本文件），只打开有数字的页面。
 *
 * 两者都需要登录态，所以都**不能进 CI**（CI 里没有真实部署与凭据）。
 * 它们是"改完之后自己过一遍"的工具，而这一轮之后应当成为**每次 UI 改动的固定动作**。
 *
 * ## 用法
 *
 *   AQ_BASE=https://... AQ_TOKEN=<jwt> AQ_CHROME=<chrome 路径> npm run ui:consistent
 */
import { chromium } from 'playwright-core';

const BASE = process.env.AQ_BASE;
const TOKEN = process.env.AQ_TOKEN ?? '';
const CHROME = process.env.AQ_CHROME;
if (!BASE || !CHROME) {
  console.error('需要 AQ_BASE 与 AQ_CHROME 环境变量（见本文件顶部用法）。');
  process.exit(2);
}

/** 要进去看的机器人。用第一个在跑的；找不到就用 1。 */
const TRADER_ID = process.env.AQ_TRADER_ID ?? '9';

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.evaluate((t) => localStorage.setItem('aq.token', t), TOKEN);

const fails = [];
const warns = [];
const fail = (rule, msg) => fails.push(`[${rule}] ${msg}`);
const warn = (rule, msg) => warns.push(`[${rule}] ${msg}`);

/** 页面上右下角那类浮动通知的数量（与 `store.ts` 的 pushToast 对应）。 */
const toastCount = () =>
  page.evaluate(() => {
    return [...document.querySelectorAll('div')].filter((d) => {
      const s = getComputedStyle(d);
      if (s.position !== 'fixed') return false;
      const r = d.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.5) return false;
      return /机器人 #\d+ →|已平仓|委托|跳过本轮/.test(d.textContent ?? '');
    }).length;
  });

const openTrader = async () => {
  await page.goto(`${BASE}/traders/${TRADER_ID}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);
};

console.log(`\n界面一致性自检  ${BASE}  机器人 #${TRADER_ID}\n`);

/* ────────────────────────────────────────────────────────────────────────────
 * 规则 1：刷新页面**不该**产生通知
 *
 * 真实问题：服务端在 WebSocket 连上时重放最近 30 条事件，而客户端把它们当
 * "刚发生"，于是每刷新一次弹一轮「已平仓 ETHUSDT」「机器人 #9 → 启动中」。
 *
 * 判据：第二次打开的通知数**不得多于**第一次。理想都是 0（重放的都该被跳过，
 * 只有首屏那几秒真发生的事件才该弹 —— 而测试环境里通常没有）。
 * ──────────────────────────────────────────────────────────────────────────── */
await openTrader();
const firstToasts = await toastCount();
await openTrader();
const secondToasts = await toastCount();
await openTrader();
const thirdToasts = await toastCount();

if (secondToasts > firstToasts || thirdToasts > firstToasts) {
  fail(
    '刷新弹通知',
    `第 1 次 ${firstToasts} 个 → 第 2 次 ${secondToasts} → 第 3 次 ${thirdToasts}；` +
      '后续打开比第一次还多，说明**重放的历史事件仍在触发通知**',
  );
} else {
  console.log(`  规则 1 刷新不弹通知         ✅ 通知数 ${firstToasts} → ${secondToasts} → ${thirdToasts}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 规则 2：账户的两个权益口径**不能差太多**
 *
 * 真实问题：界面显示归属权益 20.9842、而交易所钱包是 20.79 —— 差 0.19，
 * 因为同一笔成交被记了两次（0.17 是重复的）。
 *
 * 口径本来不同（归属权益 = 机器人自己的账；账户权益 = 交易所的钱包），
 * 所以允许一个带宽：浮盈 + 手续费 + 资金费的量级。**但它不该是 0.2/20 = 1%**。
 * ──────────────────────────────────────────────────────────────────────────── */
const equity = await page.evaluate(() => {
  const txt = document.body.innerText.replace(/\s+/g, ' ');
  const grab = (re) => {
    const m = txt.match(re);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  return {
    attributed: grab(/归属权益(?:USDT)?\s*([\d,]+\.?\d*)/),
    account: grab(/账户权益\s*([\d,]+\.?\d*)/),
    wallet: grab(/钱包余额\s*([\d,]+\.?\d*)/),
  };
});

if (equity.attributed !== null && equity.account !== null && equity.account > 0) {
  const diff = Math.abs(equity.attributed - equity.account);
  const pct = (diff / equity.account) * 100;
  if (pct > 1) {
    fail(
      '权益口径不一致',
      `归属权益 ${equity.attributed} vs 账户权益 ${equity.account}，差 ${diff.toFixed(4)}（${pct.toFixed(2)}%）—— ` +
        '超过 1%，通常意味着账目有重复或漏记',
    );
  } else {
    console.log(
      `  规则 2 权益口径一致         ✅ 归属 ${equity.attributed} / 账户 ${equity.account}，差 ${diff.toFixed(4)}（${pct.toFixed(2)}%）`,
    );
  }
} else {
  warn('权益口径不一致', `页面上读不到两个权益口径（归属=${equity.attributed} 账户=${equity.account}），规则被跳过`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 规则 3：同一行里「触发止损」与**正数盈亏**不能并存
 *
 * 真实问题：操作员看到两笔显示盈利、而平仓原因写着「触发止损」，判断这是 bug。
 * 数据两边都对（那是一次被上移到成本之上的止损），问题只在措辞 ——
 * 而**这一条规则的价值就是：那种措辞不该再出现**。
 *
 * 判据：找到含「触发止损」的行，若同一行还含 `+$`（正数）就报错。
 * **"移动止损（保本离场）" 不触发这一条** —— 它本来就是为这个场景造的词。
 * ──────────────────────────────────────────────────────────────────────────── */
const stopLossRows = await page.evaluate(() => {
  const out = [];
  for (const table of document.querySelectorAll('table')) {
    for (const tr of table.querySelectorAll('tbody tr')) {
      const text = (tr.textContent ?? '').replace(/\s+/g, ' ');
      if (text.includes('触发止损')) out.push(text.slice(0, 120));
    }
  }
  return out;
});

const contradictory = stopLossRows.filter((t) => /\+\s*\$?\s*[\d.]+/.test(t) && !/\+\s*\$?0(\.0+)?\b/.test(t));
if (contradictory.length > 0) {
  fail(
    '止损却说盈利',
    `${contradictory.length} 行同时写着「触发止损」和正数盈亏 —— ` +
      `应当说「移动止损（保本离场）」。例：${contradictory[0]}`,
  );
} else {
  console.log(`  规则 3 止损与盈亏一致       ✅ 含「触发止损」的 ${stopLossRows.length} 行都没有正数盈亏`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 规则 4：「置信度: 0%」是可疑信号
 *
 * 真实问题：模型压根没给 `confidence` 字段，而解析器填了 0 —— 屏幕上每个决策
 * 都显示「置信度: 0%」，看起来像"模型对每个判断都毫无把握"。
 *
 * **现在正确的显示是「未给出」。** 所以屏幕上再出现 `置信度 0%` 就值得看一眼：
 * 要么模型真的给了 0（罕见），要么某个字段又没解析出来被填成了默认值。
 *
 * 只报**可疑**，不算失败 —— 因为"模型真的给了 0"是合法情形。
 * ──────────────────────────────────────────────────────────────────────────── */
const zeroConfidence = await page.evaluate(() => {
  const txt = document.body.innerText;
  return (txt.match(/置信度[:：]?\s*0%?/g) ?? []).length;
});
if (zeroConfidence > 0) {
  warn(
    '置信度显示成 0',
    `页面上出现 ${zeroConfidence} 处「置信度 0」—— 若模型没给这个字段，界面应当显示「未给出」而不是 0`,
  );
} else {
  console.log('  规则 4 置信度不伪装成 0    ✅ 没有「置信度 0」');
}

/* ────────────────────────────────────────────────────────────────────────────
 * 规则 5：「读不到」不能显示成「0 / 空」
 *
 * 真实问题：实时查询接口在机器人没在运行时返回空数组，而持仓卡片把它渲染成
 * 「持仓 0」—— 而数据库里躺着两个仓位。「查不到」与「没有」是两件事。
 *
 * 判据：页面上若出现"暂不可读 / 未给出 / —"这类诚实的占位符，说明这条路径
 * 是对的；这一条**不做失败判定**，只把当前形态打出来供人核对（因为"没有持仓"
 * 时显示 0 也是正确的，脚本区分不了）。
 * ──────────────────────────────────────────────────────────────────────────── */
const honest = await page.evaluate(() => {
  const txt = document.body.innerText;
  const hits = [];
  for (const word of ['暂不可读', '未给出', '尚无', '暂无平仓', '等待统计']) {
    if (txt.includes(word)) hits.push(word);
  }
  return hits;
});
console.log(`  规则 5 诚实占位符           ${honest.length > 0 ? '✅' : '·'} 页面上有：${honest.join(' / ') || '（无）'}`);

/* ──────────────────────────────────────────────────────────────────────────── */
console.log('');
if (fails.length > 0) {
  for (const f of fails) console.log(`  ❌ ${f}`);
}
for (const w of warns) console.log(`  ⚠️  ${w}`);
if (fails.length === 0 && warns.length === 0) console.log('  ✅ 五条一致性规则全部通过');

await browser.close();
process.exit(fails.length === 0 ? 0 : 1);
