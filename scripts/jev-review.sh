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

# ── 2a. ★★★ 主判据：可执行率（2026-10-18 修正，替代"波动比值"） ────────────
#
# ## 为什么换掉了原来的判据
#
# 原来用「保留组 |24h波动| 中位数 / 筛除组 |24h波动| 中位数 ≥ 1.5」。
# 它的隐含假设是**「波动大 = 机会好」** —— 而这个假设是**错的**。
#
# 实测（22 轮 / 144 样本）：
# ```
#   部署"窗口判断"之前：保留组可执行率 20.5%，筛除组 39.8% ⇒ 比值 0.51
#   ⇒ 它在【帮倒忙】：把有机会的筛掉，留下没机会的
#   而旧判据显示"14 倍 POSITIVE"，把这个致命问题完全掩盖了
# ```
# 原因：团队要的是**位移在 0.8%~3.5% 窗口内**的标的，而"波动最大"往往意味着
# "已经走完"（QUSDT +56%、GTC +25%）。旧判据奖励的正是后者。
#
# ## 新判据
#
# ```
#   可执行窗口：|24h 涨跌| 在 0.5% ~ 10% 之间
#   （团队标准 D 0.8~3.5% 的粗略代理——太小无方向，太大已走完）
#   比较：保留组的可执行率 vs 筛除组的可执行率
# ```
#
# 部署"窗口判断"之后的实测：
# ```
#   保留组 44.4%  vs  筛除组 11.1%  ⇒ 4.00 倍 ✅ POSITIVE
# ```
echo
echo "── 2a. ★ 主判据：可执行率（保留组 vs 筛除组）───────────────"
python3 - "$SAMPLES" <<'PY_EXEC'
import json, sys

path = sys.argv[1]
samples = []
with open(path) as f:
    for line in f:
        line = line.strip()
        if line:
            try:
                samples.append(json.loads(line))
            except json.JSONDecodeError:
                pass

def in_window(v: float) -> bool:
    """可执行窗口：|24h| 在 0.5%~10%。太小无方向，太大已走完。"""
    return 0.5 <= abs(v) <= 10.0

# ⚠️ **必须分段统计**（2026-10-18）：
# 全量混算会把"部署窗口判断之前"的坏数据（比值 0.51）与之后的（4.00）平均掉，
# 得到一个既不代表过去也不代表现在的数字。
#
# 分界点：2026-10-18T03:37:00Z（部署"窗口判断"的时刻）
CUTOFF = "2026-10-18T03:37:00"

def evaluate(subset, label):
    kh = kt = dh = dt = 0
    for s in subset:
        for x in s.get("kept", []):
            kt += 1
            if in_window(x["change24h"]):
                kh += 1
        for x in s.get("dropped", []):
            dt += 1
            if in_window(x["change24h"]):
                dh += 1
    if kt == 0 or dt == 0:
        print(f"  {label}：样本不足")
        return None
    kr = kh / kt * 100
    dr = dh / dt * 100
    print(f"  {label}")
    print(f"    保留组可执行率: {kh}/{kt} = {kr:.1f}%")
    print(f"    筛除组可执行率: {dh}/{dt} = {dr:.1f}%")
    if dr <= 0.01:
        print("    ⇒ 筛除组全都不可执行（完美区分）✅ POSITIVE")
        return 99.0
    ratio = kr / dr
    print(f"    ⇒ 比值: {ratio:.2f} 倍")
    if ratio >= 1.5:
        print("    ✅ POSITIVE")
    elif ratio <= 0.67:
        print("    🔴 NEGATIVE")
    else:
        print("    🟡 NEUTRAL")
    return ratio

before = [s for s in samples if s.get("at", "") <= CUTOFF]
after = [s for s in samples if s.get("at", "") > CUTOFF]

print()
before_ratio = evaluate(before, f"【部署窗口判断之前】({len(before)} 轮)")
print()
after_ratio = evaluate(after, f"【部署窗口判断之后】({len(after)} 轮)")

print()
print("  ══ 结论 ══")
if after_ratio is None:
    print("  部署后还没有足够样本 —— 继续观察。")
elif after_ratio >= 1.5:
    print("  以【部署后】为准：✅ POSITIVE —— 窗口判断已把方向修正。保留。")
elif after_ratio <= 0.67:
    print("  以【部署后】为准：🔴 NEGATIVE —— 建议移除。")
    print("  ⇒ 删掉 .env 里的 AQ_JEV_PREFILTER=on 并重启")
else:
    print("  以【部署后】为准：🟡 NEUTRAL —— 继续观察。")
print()
print("  ⚠️ 注意：部署后样本量仍然小（{} 轮）。样本 ≥10 轮再下定论。".format(len(after)))
PY_EXEC

# ── 2b. 追高风险检查（2026-10-18 实测发现） ────────────────────────────────
#
# ## 为什么需要这一节
#
# 实测发现：Jev 的保留名单高度重复（QUSDT 6/12 次，而它 24h 已 +109%）。
# 原因不是 Jev 差，而是我给的问题太粗：**"波动大"同时包含"刚启动"与"已走完"**。
#
# ## 但实测表明风险被下游挡住了
#
#   团队实际决策：ZECUSDT（不是 Q 也不是 AVA）
#   这些标的的成交：GTC +0.1268、AGT -0.0055 —— LLM 深看后正确地放弃了
#
# ⇒ 所以这一节只**告警**，不自动关闭。判据是：
#   「保留组里 24h |涨跌| > 10% 的占比」—— 占比高说明它在挑"已经走完"的。
echo
echo "── 2b. 追高风险（保留组里已走完的占比）─────────────────────"
python3 - "$SAMPLES" <<'PY_CHASE'
import json, sys

path = sys.argv[1]
samples = []
with open(path) as f:
    for line in f:
        line = line.strip()
        if line:
            try:
                samples.append(json.loads(line))
            except json.JSONDecodeError:
                pass

# 只看最近 10 轮（老样本的行情已经过时，不代表现在的风格）
recent = samples[-10:]
if not recent:
    print("  没有样本")
    sys.exit(0)

big = 0
total = 0
for s in recent:
    for k in s.get("kept", []):
        total += 1
        if abs(k["change24h"]) > 10:
            big += 1

if total == 0:
    print("  没有保留样本")
    sys.exit(0)

ratio = big / total
print(f"  最近 {len(recent)} 轮：保留组 {total} 个标的里，{big} 个的 24h |涨跌| > 10%（{ratio*100:.0f}%）")

if ratio > 0.5:
    print("  ⚠️  超过一半的保留标的是'已走完'的行情 —— Jev 在系统性追高。")
    print("     这不构成移除理由（下游 LLM+风控会挡住），但如果发现团队真的跟进，就关掉它。")
elif ratio > 0.3:
    print("  🟡 有一定追高倾向（30%-50%），继续观察。")
else:
    print("  ✅ 追高占比正常（≤30%）。")
PY_CHASE

# ── 2c. 系统性歧视检查（2026-10-18 实测发现） ──────────────────────────────
#
# ## 现象
#
# Jev 对同一个标的给出几乎相同的分数 —— 14 轮里 SOL/WLD/TIA/ETH 是 0% 保留率（14/14 被筛），
# 而 QUSDT/GTCUSDT 是 100%（9/9 保留）。
# **它不是"每天重新判断"，而是"按标的固有属性打固定分"。**
#
# ## 为什么这是个风险
#
# 被 0% 保留的标的，其逐币深度分析**永久缺失**。
# 实测漏掉了两个历史赢家：TIA（+0.5113）、WLD（+0.3252）。
#
# ## 但也有正面
#
#   高保留率组(≥50%) 平均净盈亏 +0.1408
#   低保留率组(<50%) 平均净盈亏 +0.0327 ⇒ 高保留率组更赚 4.3 倍
#
# ⇒ 所以只告警，不自动关。**触发条件**：0% 保留率的标的超过总数一半
#   （说明它的偏好已经覆盖不了市场，那时该重新审视，或换成"随机抽样"做对照）。
echo
echo "── 2c. 系统性歧视（0% 保留率的标的占比）───────────────────"
python3 - "$SAMPLES" <<'PY_BIAS'
import json, sys

path = sys.argv[1]
samples = []
with open(path) as f:
    for line in f:
        line = line.strip()
        if line:
            try:
                samples.append(json.loads(line))
            except json.JSONDecodeError:
                pass

kept_cnt, drop_cnt = {}, {}
for s in samples:
    for k in s.get("kept", []):
        kept_cnt[k["symbol"]] = kept_cnt.get(k["symbol"], 0) + 1
    for d in s.get("dropped", []):
        drop_cnt[d["symbol"]] = drop_cnt.get(d["symbol"], 0) + 1

all_syms = set(kept_cnt) | set(drop_cnt)
if not all_syms:
    print("  没有样本")
    sys.exit(0)

zeros = [s for s in all_syms if kept_cnt.get(s, 0) == 0 and drop_cnt.get(s, 0) >= 3]
zero_ratio = len(zeros) / len(all_syms)

print(f"  共 {len(all_syms)} 个标的，其中 {len(zeros)} 个是 0% 保留率（出现≥3次从未保留）")
if zeros:
    print(f"    被永久筛掉: {' '.join(sorted(zeros)[:10])}" + (" …" if len(zeros) > 10 else ""))

if zero_ratio > 0.5:
    print("  ⚠️  超过一半的标的是 0% 保留率 —— Jev 的偏好可能已经覆盖不了市场。")
    print("     建议：加一组'随机保留'做对照，确认它的筛选是否还有正向价值。")
elif zero_ratio > 0.3:
    print("  🟡 30%-50% 的标的被永久筛掉 —— 有偏好但还留有余地。")
else:
    print("  ✅ 0% 保留率的标的占比正常（≤30%）。")
PY_BIAS

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
