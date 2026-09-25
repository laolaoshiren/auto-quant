import { chromium } from 'playwright-core';
const BASE=process.env.AQ_BASE, TOKEN=process.env.AQ_TOKEN, CHROME=process.env.AQ_CHROME;
const b=await chromium.launch({executablePath:CHROME,headless:true});
const c=await b.newContext({viewport:{width:1600,height:1000}});
const p=await c.newPage();
await p.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'});
await p.evaluate(t=>localStorage.setItem('aq.token',t),TOKEN);
await p.goto(`${BASE}/traders/9`,{waitUntil:'networkidle'});
await p.waitForTimeout(3000);

/* 采样函数：当前表格里有多少行、第一行是什么、表头第一列是什么 */
const sample = () => p.evaluate(() => {
  const t = document.querySelector('table');
  if (!t) return { rows: -1, head: [], first: [] };
  const rows = t.querySelectorAll('tbody tr').length;
  const head = Array.from(t.querySelectorAll('thead th')).slice(0,3).map(e=>(e.textContent||'').replace(/\s+/g,' ').trim());
  const first = Array.from(t.querySelectorAll('tbody tr')).slice(0,3).map(tr =>
    Array.from(tr.querySelectorAll('td')).slice(0,4).map(td=>(td.textContent||'').replace(/\s+/g,' ').trim().slice(0,10)).join('|'));
  return { rows, head, first };
});

console.log('=== 1. 先切到「订单记录」（加载全部订单）===');
await p.getByRole('tab',{name:/订单记录/}).click({timeout:8000});
await p.waitForTimeout(2500);
console.log('  订单记录:', JSON.stringify(await sample()));

console.log('\n=== 2. 点「当前委托」，并高频采样（每 30ms 一次，共 25 次）===');
const samples = [];
const clicker = p.getByRole('tab',{name:/当前委托/}).click({timeout:8000});
for (let i=0;i<25;i++){
  const s = await sample();
  samples.push({ i, ms: i*30, rows: s.rows, head: s.head[0] ?? '', first: s.first[0] ?? '' });
  await p.waitForTimeout(30);
}
await clicker;
await p.waitForTimeout(1200);
const final = await sample();
console.log('  最终:', JSON.stringify(final));

console.log('\n=== 3. 采样序列（只看行数变化）===');
for (const s of samples) console.log(`  ${String(s.ms).padStart(4)}ms  行=${String(s.rows).padStart(3)}  表头="${s.head}"  首行="${s.first}"`);
await b.close(); process.exit(0);
