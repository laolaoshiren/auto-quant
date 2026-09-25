import { chromium } from 'playwright-core';
const BASE=process.env.AQ_BASE, TOKEN=process.env.AQ_TOKEN, CHROME=process.env.AQ_CHROME;
/* headed：真实窗口 + GPU 合成，最接近用户的浏览器 */
const b=await chromium.launch({executablePath:CHROME, headless:false, args:['--window-size=1600,1000']});
const c=await b.newContext({viewport:{width:1600,height:1000}});
const p=await c.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message.slice(0,120)));
p.on('console',m=>{ if(m.type()==='error') errs.push(m.text().slice(0,120)); });
await p.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'});
await p.evaluate(t=>localStorage.setItem('aq.token',t),TOKEN);
await p.goto(`${BASE}/traders/9`,{waitUntil:'domcontentloaded'});
await p.waitForTimeout(200);
await p.evaluate(()=>{
  const w=window; w.__log=[]; w.__t0=performance.now(); let last=null;
  const cls=()=>{
    const t=document.querySelector('table'); const txt=document.body.innerText;
    if(t){
      const head=Array.from(t.querySelectorAll('thead th')).map(e=>(e.textContent||'').trim());
      const n=t.querySelectorAll('tbody tr').length;
      const kind=head.includes('用途')?'orders':(head.some(h=>h.includes('净盈亏'))?'trades':(head.some(h=>h.includes('强平价'))?'positions':'other'));
      return {k:`table:${kind}:${n}`,l:`${kind} ${n}行`};
    }
    if(/正在加载/.test(txt)) return {k:'spinner',l:'转圈'};
    if(/暂无/.test(txt)) return {k:'empty',l:'空状态'};
    return {k:'blank',l:'空白'};
  };
  const rec=(why)=>{const c2=cls(); if(c2.k===last)return; last=c2.k; w.__log.push({t:Math.round(performance.now()-w.__t0),l:c2.l,why});};
  new MutationObserver(()=>rec('dom')).observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});
  const beat=setInterval(()=>rec('beat'),40);
  w.__stop=()=>clearInterval(beat);
});
for(const name of ['当前持仓','当前委托','历史成交','订单记录']){
  await p.getByRole('tab',{name:new RegExp(name)}).click({timeout:10000}).catch(()=>{});
  await p.waitForTimeout(10000);
}
await p.waitForTimeout(20000);
const log=await p.evaluate(()=>{window.__stop();return window.__log;});
console.log('=== headed 模式：状态变化',log.length,'次 ===');
for(const e of log) console.log(`  ${String(e.t).padStart(6)}ms  ${e.l.padEnd(16)} (${e.why})`);
const empt=log.filter(e=>e.l.includes('空状态')).length;
console.log('\n空状态:',empt,empt?'❌':'✅');
console.log('控制台错误:',errs.length?('❌ '+errs.slice(0,3).join(' | ')):'✅ 无');
await b.close(); process.exit(0);
