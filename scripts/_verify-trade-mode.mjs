import { chromium } from 'playwright-core';
const BASE=process.env.AQ_BASE, TOKEN=process.env.AQ_TOKEN, CHROME=process.env.AQ_CHROME;
const b=await chromium.launch({executablePath:CHROME, headless:true});
const c=await b.newContext({viewport:{width:1600,height:1000}});
const p=await c.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message.slice(0,120)));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,120));});
await p.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'});
await p.evaluate(t=>localStorage.setItem('aq.token',t),TOKEN);
await p.goto(`${BASE}/traders/9`,{waitUntil:'networkidle'});
await p.waitForTimeout(2500);
await p.getByRole('tab',{name:/历史成交/}).click({timeout:10000});
await p.waitForTimeout(2500);
const heads=await p.locator('table thead th').allTextContents();
console.log('历史成交表头('+heads.length+'列):', JSON.stringify(heads.map(h=>h.replace(/\s+/g,' ').trim())));
const idx=heads.findIndex(h=>/保证金模式/.test(h));
console.log('「保证金模式」列位置:', idx>=0?('第 '+(idx+1)+' 列 ✅'):'❌ 没找到');
const rows=await p.locator('table tbody tr').count();
console.log('行数:', rows);
for(let i=0;i<Math.min(5,rows);i++){
  const tds=await p.locator('table tbody tr').nth(i).locator('td').allTextContents();
  const cells=tds.map(x=>x.replace(/\s+/g,' ').trim());
  console.log(`  行${i+1}: 币种=${cells[0]?.slice(0,10)} 保证金=${cells[3]} 模式=${cells[4]}`);
}
/* 统计有多少行有值、多少行是 — */
let withVal=0, dash=0;
for(let i=0;i<rows;i++){
  const tds=await p.locator('table tbody tr').nth(i).locator('td').allTextContents();
  const m=(tds[idx]||'').trim();
  if(m==='—') dash++; else if(m) withVal++;
}
console.log(`\n有值 ${withVal} 行 / 显示 — ${dash} 行（共 ${rows} 行）`);
const ov=await p.evaluate(()=>{const el=document.querySelector('.scroll-x');return el?{s:el.scrollWidth,c:el.clientWidth}:null;});
console.log('表格横向:', JSON.stringify(ov), ov && ov.s<=ov.c+2 ? '✅ 不溢出' : '⚠️ 需横向滚动');
console.log('控制台错误:', errs.length?('❌ '+errs.slice(0,3).join(' | ')):'✅ 无');
await b.close(); process.exit(0);
