#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Jev 判定的样本采集器（在服务器上跑，每 30 分钟一次）
#
# ## 为什么必须单独采集
#
# `runtime_logs` 是**环形缓冲**（`RUNTIME_LOG_CAP=500`），旧的 Jev 日志会被冲掉。
# 而"合没合格"这个判断需要**多轮样本**——单轮 6 vs 13 的对比可能就是巧合。
#
# ## 它做什么
#
# 1. 从 `runtime_logs` 取出**还没采集过**的 Jev 筛除记录
# 2. 去币安拉这些标的**当时**的 24h 涨跌
# 3. 写进 `data/jev-samples.jsonl`（一行一个样本，追加式，不会被日志轮转影响）
#
# ## 为什么记 24h 涨跌而不是"之后的结果"
#
# 因为 Jev 的任务是"挑出**今天有波动**的标的给 LLM 深看"。
# 24h 涨跌幅度是"这标的今天动不动"的直接度量，与它的任务对齐。
# 而"之后的结果"要等平仓才有，且受 LLM/风控影响，不能单独归因给 Jev。
#
# 用法：bash scripts/jev-sample.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

DB="${1:-/opt/autoquant/data/autoquant.sqlite}"
OUT="${2:-/opt/autoquant/data/jev-samples.jsonl}"
SEEN="${OUT}.seen"

touch "$OUT" "$SEEN"

# 取最近 40 条筛除记录（含时间戳与 id），跳过已采集的
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT id || '|' || created_at || '|' || message
    FROM runtime_logs
   WHERE scope='jev' AND level='info' AND message LIKE '%筛除%'
   ORDER BY id DESC LIMIT 40;
" | while IFS='|' read -r id at msg; do
  # 已采集过就跳过
  grep -qxF "$id" "$SEEN" 2>/dev/null && continue

  # 从消息里抠出「标的(分数)」对
  pairs=$(printf '%s' "$msg" | grep -oE '[A-Z]+USDT\([0-9.]+\)' | sed -E 's/\(([0-9.]+)\)/ \1/' | tr '\n' ',' | sed 's/,$//')
  [ -z "$pairs" ] && continue

  # 拉这些标的的 24h 涨跌
  outcomes=""
  IFS=',' read -ra ITEMS <<< "$pairs"
  for item in "${ITEMS[@]}"; do
    sym=$(printf '%s' "$item" | awk '{print $1}')
    score=$(printf '%s' "$item" | awk '{print $2}')
    chg=$(curl -s -m 6 "https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=$sym" 2>/dev/null \
          | python3 -c "import sys,json
try:
  d=json.load(sys.stdin); print(f'{float(d[\"priceChangePercent\"]):.2f}')
except: print('NA')" 2>/dev/null)
    [ "$chg" = "NA" ] && continue
    outcomes="$outcomes{\"symbol\":\"$sym\",\"score\":$score,\"change24h\":$chg},"
  done

  [ -z "$outcomes" ] && continue
  outcomes="${outcomes%,}"

  printf '{"at":"%s","logId":%s,"dropped":[%s]}\n' "$at" "$id" "$outcomes" >> "$OUT"
  echo "$id" >> "$SEEN"
  echo "  采集 #$id ($at)：$(printf '%s' "$pairs" | tr ',' '\n' | wc -l) 个标的"
done

echo
echo "累计样本数：$(wc -l < "$OUT")"
