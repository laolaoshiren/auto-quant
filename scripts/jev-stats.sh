#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Jev 实验的效果统计（在服务器上跑）
#
# 用途：回答那个唯一重要的问题 ——
#   **Jev 保留的标的 vs 它筛掉的标的，哪个更值得交易？**
#
# 判据（事先定好，避免事后找理由，见 docs/JEV-EXPERIMENT.md 第五节）：
#   · Jev 保留的标的，被实际开仓的次数 / 盈亏 应当【不劣于】被筛掉的
#   · 如果筛掉的那批明显更好（≥2 倍），说明 Jev 在帮倒忙 ⇒ 移除
#
# 用法：bash scripts/jev-stats.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

DB="${1:-/opt/autoquant/data/autoquant.sqlite}"
TRADER="${2:-11}"

echo "══════════════════════════════════════════════════════════════"
echo " Jev 实验效果统计  (trader=$TRADER)"
echo "══════════════════════════════════════════════════════════════"

echo
echo "── 1. Jev 运行情况 ─────────────────────────────────────────"
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT '  成功轮次: ' || COUNT(*) FROM runtime_logs
   WHERE scope='jev' AND level='info' AND message LIKE '%保留%';
"
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT '  失败降级: ' || COUNT(*) FROM runtime_logs
   WHERE scope='jev' AND level='warn';
"
echo "  最近 5 轮："
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT '    ' || SUBSTR(message, 1, 70) FROM runtime_logs
   WHERE scope='jev' AND level='info' AND message LIKE '%保留%'
   ORDER BY id DESC LIMIT 5;
"

echo
echo "── 2. 逐币并行成功率（应按币数，不该有失败） ────────────────"
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT '    ' || SUBSTR(message, 1, 60) FROM runtime_logs
   WHERE message LIKE '%按币并行完成%' ORDER BY id DESC LIMIT 5;
"

echo
echo "── 3. ★ 关键判据：保留 vs 筛除，谁更值得交易 ───────────────"
echo "   （统计最近 20 轮 Jev 的判定，与之后的实际成交对照）"
echo
echo "  最近一轮 Jev 的保留/筛除名单："
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT '    ' || SUBSTR(message, 1, 160) FROM runtime_logs
   WHERE scope='jev' AND level='info' ORDER BY id DESC LIMIT 2;
"

echo
echo "   各标的的实际成交笔数与净盈亏（历史累计，供对照）："
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT '    ' || symbol || '  ' || COUNT(*) || ' 笔  ' ||
         printf('%+.4f', COALESCE(SUM(net_pnl), 0)) || ' USDT'
    FROM trades WHERE trader_id=$TRADER
   GROUP BY symbol ORDER BY COUNT(*) DESC LIMIT 15;
"

echo
echo "── 4. 决策轮次耗时（基线 308s，Jev 应让它下降） ────────────"
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT '    cyc=' || cycle_number || '  ' || ROUND(ai_latency_ms/1000.0, 0) || 's'
    FROM decision_records
   WHERE trader_id=$TRADER AND ai_latency_ms > 0
   ORDER BY id DESC LIMIT 8;
"
echo "    最近 10 轮平均："
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT '    ' || ROUND(AVG(ai_latency_ms)/1000.0, 0) || 's'
    FROM (SELECT ai_latency_ms FROM decision_records
           WHERE trader_id=$TRADER AND ai_latency_ms > 0
           ORDER BY id DESC LIMIT 10);
"

echo
echo "── 5. magpie 版本与契约自检 ────────────────────────────────"
echo -n "    当前版本: "
cat "$HOME/.config/magpie/last-version" 2>/dev/null || echo "(读不到)"
echo "    契约自检最近记录："
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT '    ' || level || ' ' || SUBSTR(message, 1, 100) FROM runtime_logs
   WHERE scope='gateway_contract' ORDER BY id DESC LIMIT 5;
"

echo
echo "══════════════════════════════════════════════════════════════"
echo " 判据提醒（docs/JEV-EXPERIMENT.md §5）："
echo "   保留 ≥2 倍于筛除 ⇒ 正向，保留"
echo "   筛除 ≥2 倍于保留 ⇒ 负向，关闭 AQ_JEV_PREFILTER"
echo "   数据不足       ⇒ 继续观察"
echo "══════════════════════════════════════════════════════════════"
