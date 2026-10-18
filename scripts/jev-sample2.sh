#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Jev 判定的样本采集器 v2（在服务器上跑）
#
# ## v1 的缺口（已修）
#
# v1 只采集了「筛除」那一半的名单。于是判据只能拿一个**近似值**当"保留组"——
# 我实测时手工补了 QUSDT 76.66%，结果把结论从 `neutral` 拉成了 `positive`。
# **用近似值算出来的结论不能用来决定一个实盘功能的去留。**
#
# v2 现在同时采集：
#   · `保留：A B C D E F`（2026-10-18 新增的日志行）
#   · `筛除：X(0.46) Y(0.42) …`
# 并给**两边的每个标的**都配上当期 24h 涨跌。
#
# ## 为什么用 24h 涨跌幅度而不是净收益
#
# Jev 的任务是"挑出**今天有波动**的标的给 LLM 深看"——方向由 LLM 判断。
# 所以 |涨跌幅| 是它的任务口径；净收益要等平仓，且混入了 LLM 与风控的作用。
#
# 用法：bash scripts/jev-sample.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

DB="${1:-/opt/autoquant/data/autoquant.sqlite}"
OUT="${2:-/opt/autoquant/data/jev-samples.jsonl}"
SEEN="${OUT}.seen"

touch "$OUT" "$SEEN"

# 拉最近 60 条 Jev info 日志（保留 + 筛除 混在一起，按 id 配对）
tmp=$(mktemp)
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT id || '~' || created_at || '~' || message
    FROM runtime_logs
   WHERE scope='jev' AND level='info'
     AND (message LIKE '%[Jev] 保留：%' OR message LIKE '%[Jev] 筛除：%')
   ORDER BY id ASC LIMIT 60;
" > "$tmp"

# 用 awk 把「保留」与它后面紧跟的「筛除」配成一对（同一轮的两行）
awk -F'~' '
  /\[Jev\] 保留：/ { kept=$0; keptLine=$0; next }
  /\[Jev\] 筛除：/ {
    if (keptLine != "") { print keptLine "\n" $0 "\n---" }
    keptLine = ""
  }
' "$tmp" > "${tmp}.pairs"

python3 - "$OUT" "$SEEN" "${tmp}.pairs" <<'PY'
import json, re, subprocess, sys, urllib.request

out_path, seen_path, pairs_path = sys.argv[1], sys.argv[2], sys.argv[3]

seen = set()
try:
    with open(seen_path) as f:
        seen = {ln.strip() for ln in f if ln.strip()}
except FileNotFoundError:
    pass

def change_24h(sym: str):
    """拉币安 24h 涨跌幅；拿不到返回 None（**不编造 0**）。"""
    try:
        url = f"https://fapi.binance.com/fapi/v1/ticker/24hr?symbol={sym}"
        with urllib.request.urlopen(url, timeout=6) as r:
            return round(float(json.load(r)["priceChangePercent"]), 2)
    except Exception:
        return None

blocks = [b for b in open(pairs_path).read().split("---") if b.strip()]
processed = 0
for block in blocks:
    lines = [ln for ln in block.strip().split("\n") if ln.strip()]
    if len(lines) < 2:
        continue
    kept_line, drop_line = lines[0], lines[1]

    m_id = re.match(r"^(\d+)~([^~]+)~", kept_line)
    if not m_id:
        continue
    log_id, at = m_id.group(1), m_id.group(2)
    if log_id in seen:
        continue

    kept = re.findall(r"[A-Z]+USDT", kept_line.split("保留：", 1)[1])
    dropped = [(s, float(v)) for s, v in re.findall(r"([A-Z]+USDT)\(([0-9.]+)\)", drop_line)]
    if not kept or not dropped:
        continue

    rec = {"at": at, "logId": int(log_id), "kept": [], "dropped": []}
    for sym in kept:
        c = change_24h(sym)
        if c is not None:
            rec["kept"].append({"symbol": sym, "change24h": c})
    for sym, score in dropped:
        c = change_24h(sym)
        if c is not None:
            rec["dropped"].append({"symbol": sym, "score": score, "change24h": c})

    if len(rec["kept"]) < 3 or len(rec["dropped"]) < 3:
        continue

    with open(out_path, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    with open(seen_path, "a") as f:
        f.write(log_id + "\n")
    processed += 1
    print(f"  采集 #{log_id} ({at[11:19]})：保留 {len(rec['kept'])} / 筛除 {len(rec['dropped'])}")

print(f"\n  本次新增 {processed} 条")
PY

total=$(wc -l < "$OUT" 2>/dev/null || echo 0)
echo "  累计样本数：$total"
rm -f "$tmp" "${tmp}.pairs"
