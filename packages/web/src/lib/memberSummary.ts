/**
 * **把一个角色的产出压成一段可读的摘要**（2026-10-14）。
 *
 * ## 为什么需要它（两次用户反馈之间的那个平衡点）
 *
 * ```
 *   第一版：message = member.text（产出全文）
 *     → 用户看到裸 JSON：```json [ {"symbol":"BTWUSDT","action":"ski…
 *
 *   第二版：message = '完成'
 *     → 用户：「全是完成，展开看到也是完成何意味？」
 *
 *   现在：从产出里【提取】一段摘要 —— 既不裸奔，也不丢弃
 * ```
 *
 * ## 提取规则（按顺序执行）
 *
 * ```
 *   ① 剥掉机器标签：<reasoning> / <thinking> / <answer>（它们是包装，不是内容）
 *   ② 剥掉 markdown 装饰：**粗体**、## 标题、`代码`、- 列表符
 *   ③ 剥掉代码围栏标记（```json）—— **但保留它后面的内容**
 *   ③b 若产出是 JSON，**抽 `"reasoning"` 字段** —— 那正是"它为什么这么判"
 *   ④ 按句切开，跳过【开场白】（"让我…"、"第一步："、"首先"）——
 *      它们说的是"我要做什么"，不是"我得出了什么"
 *   ⑤ 取第一句有实质内容的话，截到 72 字
 *   ⑥ 全都不行 → 退回"完成"（显示空比显示"完成"更糟）
 * ```
 *
 * ⚠️ **必须跳过开场白**：直接 `slice(0, 72)` 会切出
 * `让我按决策流程走一遍。第一步：扫描触发。` —— 那是"截断"而不是"摘要"。
 *
 * ⚠️ **必须抽 JSON 的 `reasoning`**：裁决官的整段产出就是一个 JSON 数组，
 * 不抽它那一行只能显示"完成"（实测踩到）。
 *
 * ⚠️ 产出全文仍在「展开详情 → 各角色产出」里（有「展开全文」按钮）。
 *
 * ## 为什么单独一个模块
 *
 * 组件（`DecisionFeed`）与测试都要用它 —— 而"同一个算术写两遍"在本项目
 * 已经反复造成漂移（见 `docs/MAINTENANCE.md` §3.4）。所以**只有这一份实现**。
 */

const MAX = 72;

/** 产出为空、或全部被剥光时的兜底文案。 */
export const EMPTY_SUMMARY = '完成';

export function summarizeMemberOutput(text: string): string {
  /* ① 机器标签。 */
  let s = text.replace(/<\/?(?:reasoning|thinking|answer)>/gi, ' ');
  /*
   * ③ 代码围栏。
   *
   * ⚠️ **只剥围栏标记，不剥它后面的内容** —— 我第一版把整行都剥了，
   * 于是裁决官（产出就是 JSON）被剥成空 → 退回"完成" → 信息全丢。
   * 而那个 JSON 里的 `"reasoning"` 字段**恰恰是最该显示的东西**。
   */
  s = s.replace(/```[a-z]*/gi, ' ');
  /* ② markdown 装饰。 */
  s = s
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/`/g, '')
    .replace(/^\s*[-*]\s+/gm, '');

  /*
   * ③b 从 JSON 里抽 `reasoning`。
   *
   * ⚠️ 用**非贪婪 + 长度下限 4**：太短的（例如 `"reasoning":""`）没有信息，
   * 交给后面的句子提取去处理。
   */
  const reasoningHits = [...s.matchAll(/"reasoning"\s*:\s*"([^"]{4,300})"/g)].map((m) => m[1]!);
  if (reasoningHits.length > 0) {
    const first = reasoningHits[0]!.trim();
    const more = reasoningHits.length > 1 ? `（共 ${reasoningHits.length} 条判定）` : '';
    const out = first.length > MAX ? `${first.slice(0, MAX)}…` : first;
    return `${out}${more}`;
  }

  /* 换行 → 空格，让"句子"能跨行拼接。 */
  s = s.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (s.length === 0) return EMPTY_SUMMARY;

  /*
   * ⚠️ **剩下的是裸 JSON 时不给它**（2026-10-14 实测抓到的边界）。
   *
   * 上面已经抽过 `reasoning` —— 走到这里说明**没有 reasoning 字段**，
   * 而产出仍可能是 JSON（例如 `[ {"symbol":"BTWUSDT","action":"skip"} ]`）。
   * 把它当摘要显示就是第一次反馈里的那个事故（用户看到 `{"symbol":…`）。
   *
   * 判据：**以 `[` 或 `{` 开头、且含 `":`** —— 那是 JSON 的形态。
   * 这种产出没有可读的结论，退回"完成"比显示一段 JSON 诚实。
   */
  if (/^[[{]/.test(s) && /"\s*:/.test(s)) return EMPTY_SUMMARY;

  /*
   * ④ 按句切。⚠️ 中英文句号都要认 —— 模型的产出混用两种。
   * 句号后面必须跟空格或结尾，否则 `2.6046` 这种小数会被切开。
   */
  const sentences = s.split(/(?<=[。！？；])\s*|(?<=[.!?])\s+/).filter((x) => x.trim().length > 0);
  /*
   * ⚠️ **开场白要认得更宽**：实测 `market_analyst` 的第一句是
   * `第一步：扫描触发。` —— 它**不是**"让我…"开头，但同样是**结构性开场**，
   * 读起来毫无信息。所以除了人称开场白，还要跳过"第 N 步"这类步骤标题。
   */
  const opener =
    /^(让我|我先|先让|首先让|以下是|我将|我需要先|让我先|好的|好，|OK|第[一二三四五六七八九十\d]+步|首先|接下来|现在)/i;
  const pick =
    sentences.find((x) => x.trim().length >= 8 && !opener.test(x.trim())) ??
    sentences.find((x) => x.trim().length >= 8) ??
    s;
  const clean = pick.trim();
  return clean.length > MAX ? `${clean.slice(0, MAX)}…` : clean;
}
