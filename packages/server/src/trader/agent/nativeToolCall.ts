/**
 * 解析模型的**原生工具调用方言**。
 *
 * ## 为什么需要它（实测出来的，不是设想的）
 *
 * 协议是提示词式的（LLM 客户端只有 complete()，没有 tools 参数），
 * 所以提示词里约定模型每轮输出一个 JSON 对象。
 *
 * **但真实模型不一定照办。** 实测 Command 厂商的 deepseek-v4.1-flash
 * 会用它训练时的**原生工具调用语法**回来 —— 一种类 XML 的块，
 * 分隔符是两个全角竖线（U+FF5C）包着 DSML，内部是 invoke name="…"
 * 与 parameter name="…"。
 *
 * 后果很具体：那一轮审视**解析失败 → 连续两轮坏输出 → 整轮 failed**，
 * 而它已经烧掉 25,621 输入 + 4,725 输出 tokens。**那是纯浪费，
 * 而且看起来像"模型不听话"，实际是"我们没接住它的话"。**
 *
 * ## 与 AGENTS.md §2.4 的关系
 *
 * 那里写着：不要为了让某个"模型经常这么写"的格式通过而**放宽语义校验**；
 * 要加的是**字段别名**。
 *
 * **这就是加别名**：多认一种**格式**，不放宽任何**语义**。
 * 解析出来的工具名与参数仍然走原来那套校验 ——
 * 认不出的工具名照样被拒，参数不合格照样被拒。
 *
 * ## 为什么用 \uFF5C 转义写
 *
 * 直接写那两个全角竖线也能跑，但它们看起来与普通的 | 几乎一样，
 * 改动时极易看错。用码点写出来，**"这是特殊字符"在代码里就看得见**。
 */

/** 分隔符：两个全角竖线夹着 DSML。 */
const MARK = '\uFF5C\uFF5CDSML\uFF5C\uFF5C';

export interface NativeCall {
  tool: string;
  args: Record<string, unknown>;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从回复里抽出原生格式的工具调用。
 *
 * 宽容度与既有的 JSON 解析一致：允许前后有解释文字、允许代码围栏。
 * **但抽不出 invoke name= 就返回空数组** —— 不猜它想调什么。
 *
 * @returns 按出现顺序排列的调用。空数组表示这段文本里没有这种格式。
 */
export function parseNativeToolCalls(text: string): NativeCall[] {
  if (!text.includes(MARK)) return [];

  const calls: NativeCall[] = [];

  /*
   * 逐个 invoke 块处理。
   *
   * 用"找到下一个 invoke 的开头"来切块，而不是靠闭合标签 ——
   * 实测那次回复**没有闭合标签**（模型在生成中被截断，或在格式上偷懒），
   * 靠闭合标签切会一个都抽不出来。
   */
  const invokeRe = new RegExp(escapeRe(MARK) + '\\s*invoke\\s+name="([^"]+)"', 'g');
  const starts: Array<{ name: string; from: number; at: number }> = [];
  for (const m of text.matchAll(invokeRe)) {
    if (m.index === undefined) continue;
    starts.push({ name: m[1] as string, from: m.index + m[0].length, at: m.index });
  }

  for (let i = 0; i < starts.length; i += 1) {
    const cur = starts[i] as { name: string; from: number; at: number };
    // 块的范围：到下一个 invoke 的开头为止（没有下一个就到文本结尾）。
    const next = starts[i + 1];
    const to = next ? next.at : text.length;
    calls.push({ tool: cur.name, args: parseParameters(text.slice(cur.from, to)) });
  }

  return calls;
}

/**
 * 抽一个 invoke 块里的 parameter。
 *
 * 值的形态实测有两种：
 *   · 有内容，后面跟闭合标签
 *   · **没有闭合标签**（同样因为回复被截断，或在格式上偷懒）
 *
 * 所以取值策略是"从 > 之后一直取到下一个 parameter 或块尾"，
 * 再**去掉尾部的闭合标签**。靠闭合标签切会漏掉第二种。
 */
function parseParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const paramRe = new RegExp(escapeRe(MARK) + '\\s*parameter\\s+name="([^"]+)"([^>]*)>', 'g');

  const heads: Array<{ name: string; type: string; from: number }> = [];
  for (const m of body.matchAll(paramRe)) {
    if (m.index === undefined) continue;
    heads.push({
      name: m[1] as string,
      // string="true" 这类声明；没有就是无类型。
      type: /string="true"/.test(m[2] ?? '') ? 'string' : '',
      from: m.index + m[0].length,
    });
  }

  for (let i = 0; i < heads.length; i += 1) {
    const h = heads[i] as { name: string; type: string; from: number };
    const next = heads[i + 1];
    const to = next ? next.from : body.length;
    let value = body.slice(h.from, to);

    /*
     * 取值到**本行末尾**。
     *
     * 没有闭合标签时，"值到哪结束"在格式上就是有歧义的 —— 尾随的解释文字
     * 与值本身长得一样。实测模型是把值内联写的，所以按行切最贴近它的实际行为。
     *
     * 这个取舍的方向是刻意的：**多截一点会失败得响亮，多留一点会静默出错。**
     * 比如 patch 的 JSON 被截断 → JSON.parse 抛错 → 那一轮明确失败；
     * 而把尾随的"以上。"混进 JSON → 同样抛错。两种都不静默。
     * 真正会被截断影响的只有 reason/summary 这类给人看的散文，代价可接受。
     */
    const newline = value.indexOf('\n');
    if (newline >= 0) value = value.slice(0, newline);

    /*
     * 去掉尾部的残留标签。
     *
     * `<` 单独一个也要去掉：切块用的是"下一个 invoke 的分隔符位置"，
     * 所以那个标签的**前导尖括号会留在上一块里** —— 实测得到过 `"24h\\n<"`。
     * 这是实现细节泄漏进值里，不是格式问题。
     */
    value = value.replace(new RegExp('</?' + escapeRe(MARK) + '[^>]*>$'), '');
    value = value.replace(/<$/, '');
    args[h.name] = coerce(value.trim(), h.type);
  }

  return args;
}

/**
 * 把文本值转成 JSON 里该有的类型。
 *
 * **只在能明确判断时才转。** "true"/"false"/"null" 有唯一含义，纯数字也唯一；
 * 其余一律保持字符串 —— 一次自以为是的转换会把 summary 里的 "007" 变成 7。
 * 另外，声明了 string="true" 的参数**永不转换**。
 */
function coerce(raw: string, declaredType: string): unknown {
  if (declaredType === 'string') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}