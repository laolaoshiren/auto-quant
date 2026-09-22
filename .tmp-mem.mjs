import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('/opt/autoquant/data/autoquant.sqlite');
const q = (sql) => d.prepare(sql).all();

console.log('== agent_memory 列 ==');
console.log(q('pragma table_info(agent_memory)').map(r => r.name).join(', '));

console.log('\n== 最近 12 条记忆 ==');
for (const r of q(`select * from agent_memory order by id desc limit 12`)) {
  const keep = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'lesson' || k === 'tagsJson' || k === 'tradeId' || k === 'symbol' || k === 'createdAt')
      keep[k] = String(v ?? '').slice(0, 700);
  }
  console.log(JSON.stringify(keep, null, 1));
  console.log('');
}

console.log('== SOLUSDT 的持仓（找「浮盈回吐」那条的原始数字）==');
for (const r of q(`select id, symbol, side, entry_price, leverage, peak_pnl_percent,
                          stop_loss, take_profit, opened_at, status
                   from positions where symbol='SOLUSDT' order by id desc limit 6`)) {
  console.log(JSON.stringify(r));
}
