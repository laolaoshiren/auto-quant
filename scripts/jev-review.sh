#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Jev 实验复核脚本（一条命令重算"保留还是移除"）
#
# ## 什么时候用它
#
# · 想复核"这个实验功能还值得留吗"
# · 行情风格变了（例如从高波动转为低波动），怀疑 Jev 判据失效
# · 改了 Jev 的提问措辞之后，验证是否仍有区分度
#
# ## 它做什么
#
#   1. 采集（或复用）配对样本：每轮的「保留名单」+「筛除名单」+ 各自当期 24h 涨跌
#   2. 用**中位数**算两组的 |24h 涨跌| 中位数比值
#   3. 给出 positive / negative / neutral
#
# ## ⚠️ 必须用中位数，不能用平均值
#
# 实测过的坑（2026-10-18）：一个 +92.66% 的标的把保留组平均值从 10.94% 拉到 24.56%，
# 于是判据从"应该移除"变成"应该保留"。
#
#   ```
#     平均值（含极值）：1.94 倍 ⇒ positive   ← 错
#     剔除极值        ：0.86 倍 ⇒ negative   ← 又一个答案
#     中位数          ：1.06 倍 ⇒ neutral    ← 真相
#   ```
#
# 加密市场里单日翻倍很常见 ⇒ **平均值在这个场景下不可用**。
#
# 用法：bash scripts/jev-review.sh [traderId]
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

TRADER="${1:-11}"
DB="${DB:-/opt/autoquant/data/autoquant.sqlite}"
SAMPLES="${SAMPLES:-/opt/autoquant/data/jev-samples.jsonl}"

echo "══════════════════════════════════════════════════════════════"
echo " Jev 实验复核  (trader=$TRADER)"
echo "══════════════════════════════════════════════════════════════"

# ── 1. 采集（复用 jev-sample2.sh；不存在就现场从日志算） ────────────────────
if [ -x /tmp/jev-sample2.sh ]; then
  echo
  echo "── 1. 采集新样本 ───────────────────────────────────────────"
  bash /tmp/jev-sample2.sh "$DB" "$SAMPLES" 2>&1 | sed 's/^/  /'
fi

if [ ! -s "$SAMPLES" ]; then
  echo
  echo "  ⚠️  没有样本文件（$SAMPLES）—— 先跑一次采集："
  echo "     bash scripts/jev-sample2.sh"
  echo "     或等下一轮决策后再试"
  exit 0
fi

# ── 2. 判据（中位数） ───────────────────────────────────────────────────────
echo
echo "── 2. 判据（中位数口径） ───────────────────────────────────"
python3 - "$SAMPLES" <<'PY'
import json, statistics, sys

path = sys.argv[1]
samples = []
with open(path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            samples.append(json.loads(line))
        except json.JSONDecodeError:
            continue

if not samples:
    print("  没有可用样本")
    sys.exit(0)

kept_all, dropped_all, ratios = [], [], []
for s in samples:
    k = [abs(x["change24h"]) for x in s.get("kept", [])]
    d = [abs(x["change24h"]) for x in s.get("dropped", [])]
    if len(k) < 3 or len(d) < 3:
        continue
    kept_all.extend(k)
    dropped_all.extend(d)
    km, dm = statistics.median(k), statistics.median(d)
    if dm > 0.01:
        ratios.append(km / dm)

print(f"  完整样本轮数: {len(samples)}")
print(f"  可比轮数:     {len(ratios)}")
print()

if not kept_all or not dropped_all:
    print("  样本不足以计算（需要至少 3 个保留 + 3 个筛除）")
    sys.exit(0)

km = statistics.median(kept_all)
dm = statistics.median(dropped_all)
ratio = km / dm if dm > 0.01 else float("inf")

print(f"  保留组 |24h| 中位数: {km:6.2f}%   ({len(kept_all)} 个样本)")
print(f"  筛除组 |24h| 中位数: {dm:6.2f}%   ({len(dropped_all)} 个样本)")
print(f"  ⇒ 比值:              {ratio:6.2f} 倍")
print()

if ratios:
    print(f"  逐轮比值: {', '.join(f'{r:.2f}' for r in ratios)}")
    positive_rounds = sum(1 for r in ratios if r > 1)
    print(f"  比值 > 1 的轮次: {positive_rounds} / {len(ratios)}")
    print()

print("══════════════════════════════════════════════════════════════")
if ratio >= 1.5 and len(ratios) >= 3:
    print("  ✅ POSITIVE —— Jev 在挑更有机会的标的。保留。")
elif ratio <= 0.67 and len(ratios) >= 3:
    print("  🔴 NEGATIVE —— Jev 在丢掉更有机会的标的。")
    print("     ⇒ 移除：删掉 .env 里的 AQ_JEV_PREFILTER=on 并重启")
elif len(ratios) < 3:
    print(f"  🟡 样本不足（可比 {len(ratios)} 轮 < 3）—— 继续观察。")
else:
    print("  🟡 NEUTRAL —— Jev 没有提供有效区分信息。")
    print("     可以保留（它至少省时间），但不要指望它提升质量。")
print("══════════════════════════════════════════════════════════════")
PY

# ── 3. 同时报一下运行健康 ───────────────────────────────────────────────────
echo
echo "── 3. 运行健康 ─────────────────────────────────────────────"
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT '  Jev 成功轮次: ' || COUNT(*) FROM runtime_logs
   WHERE scope='jev' AND level='info' AND message LIKE '%保留%';
"
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT '  Jev 失败降级: ' || COUNT(*) FROM runtime_logs
   WHERE scope='jev' AND level='warn';
"
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT '  最近 5 轮决策耗时: ' || GROUP_CONCAT(ROUND(ai_latency_ms/1000.0) || 's', ' ')
    FROM (SELECT ai_latency_ms FROM decision_records
           WHERE trader_id=$TRADER AND ai_latency_ms > 0
           ORDER BY id DESC LIMIT 5);
"
sqlite3 -readonly "file:$DB?mode=ro" "
  SELECT '  最近契约自检: ' || SUBSTR(message, 1, 90) FROM runtime_logs
   WHERE scope='gateway_contract' ORDER BY id DESC LIMIT 1;
"
