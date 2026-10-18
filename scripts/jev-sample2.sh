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
     -- ⚠️ 这里用 保留：/筛除： 作条件，不要加 [Jev] 前缀（2026-10-18 修）
     -- 因为格式演进后前缀变了：
     --   旧格式 A: [Jev] 保留：A B C            <- 有 [Jev] 前缀
     --   旧格式 B: [Jev] 保留：A B C | 筛除：X  <- 有 [Jev] 前缀
     --   新格式 C: [Jev] 20->6 个 · ... · 保留：A B C | 筛除：X  <- 没有 [Jev] 保留：这个连续串
     -- 用带前缀的条件会把新格式全部漏掉 —— 实测：7 条日志里只匹配到 3 条，
     -- 而漏掉的正是部署后的新格式，于是样本卡在 8 轮不动。
     AND (message LIKE '%保留：%' OR message LIKE '%筛除：%')
   ORDER BY id ASC LIMIT 60;
" > "$tmp"

# ── 归一成"每轮一行" ────────────────────────────────────────────────────────
#
# ## 两种日志格式都要支持（2026-10-18）
#
# **旧格式（三行）**：
# ```
#   132633  [Jev] 20 个标的 → 保留 6 个 · 最高 0.61 · 耗时 1482ms
#   132634  [Jev] 保留：QUSDT AGTUSDT …
#   132635  [Jev] 筛除：EPICUSDT(0.50) …
# ```
# **新格式（两行，保留与筛除合并成一行）**：
# ```
#   132636  [Jev] 保留：QUSDT … | 筛除：EPICUSDT(0.50) …
#   132637  [Jev] 20 个标的 → 保留 6 个 · 最高 0.61 · 耗时 1482ms
# ```
#
# 为什么改成新格式：旧的靠"保留行 + 下一行筛除行"配对，而 `runtime_logs`
# 是环形缓冲（500 条 ≈ 100 分钟）—— 中间被别的日志挤掉一行，那一轮就**永久采不到**
# （实测：seen 记了 132634，132635 成了孤儿）。
#
# ⇒ 这里统一归一成"保留 + 筛除"两行喂给下面的 Python（新旧都能处理）。
# ── 三种日志格式都要支持（2026-10-18 演进过程） ─────────────────────────────
#
# **格式 A（最早，三行）**：
#   [Jev] 20 个标的 → 保留 6 个 · …
#   [Jev] 保留：QUSDT …
#   [Jev] 筛除：EPICUSDT(0.50) …
#
# **格式 B（第二版，两行）**：
#   [Jev] 保留：QUSDT … | 筛除：EPICUSDT(0.50) …
#   [Jev] 20 个标的 → 保留 6 个 · …
#
# **格式 C（当前，一行）**：
#   [Jev] 20→6 个 · 最高 0.44 最低 0.17 · 1360ms · 保留：QUSDT … | 筛除：EPICUSDT(0.50) …
#
# 为什么一路合并到现在：`runtime_logs` 是**环形缓冲（500 条）**，而 `#10` 每分钟
# 产出大量 `llm` 日志 —— 实测 scope 分布 `llm 202 / store 138 / team 114 / jev 10`，
# Jev 的时间跨度只剩 40 分钟，而 cron 每 30 分钟才采一次 ⇒ 大量轮次被冲掉。
#
# ⇒ 采集脚本统一归一成「保留行 + 筛除行」两行喂给下面的 Python。
awk -F'~' '
  # 格式 C / B：同一行里既有「保留：」又有「| 筛除：」
  /保留：.*\| 筛除：/ {
    head = $0
    sub(/\| 筛除：.*$/, "", head)
    drop = $0
    sub(/^.*\| 筛除：/, "[Jev] 筛除：", drop)
    print head "\n" drop "\n---"
    keptLine = ""
    next
  }
  # 格式 A：独立的两行
  /\[Jev\] 保留：/ { keptLine = $0; next }
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
