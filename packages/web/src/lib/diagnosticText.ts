/**
 * **把模型/上游 SDK 抛出来的英文诊断信息译成人话**。
 *
 * ## 用户的原话（2026-10-18）
 *
 * > 「这 UI 设计我都不说符不符合审美了，这东倒西歪，到处错位，大片空白的，是给人看的吗？」
 *
 * 截图里最刺眼的一条：
 * ```
 * (The model called a tool this agent doesn't have: "bash". The call was left out.)
 * ```
 * 它**每隔几分钟就出现一次**，占据了历史列表的一大片。而它说的其实是同一件事：
 * 「模型想调用一个不存在的工具，那次调用被跳过了」—— 这件事对操作员的意义是
 * **"这一轮那个角色白跑了一次"**，而不是这串英文。
 *
 * ## 边界（重要）
 *
 * 只译**已知的诊断句式**，**绝不碰模型自己的正文**。
 *
 * ```
 *   ✅ (The model called a tool this agent doesn't have: "bash"…)  ← 上游 SDK 的固定句式
 *   ❌ Let me analyze each candidate systematically using the entry standards…  ← 模型写的推理
 * ```
 *
 * 后者是模型**当时的思考**，翻译它会失真；对它的正确处理是**标注这是模型的原始输出**
 * （见 `formatForeignText`），而不是假装我们懂它在说什么。
 */

/** 一条英文诊断 → 中文。匹配不上就返回 `null`（调用方保持原文）。 */
export function translateDiagnostic(text: string): string | null {
  const t = text.trim();

  /*
   * 上游 SDK：模型调用了这个角色没有的工具。
   *
   * 原文（Anthropic/OpenAI 兼容层常见）：
   *   `(The model called a tool this agent doesn't have: "bash". The call was left out.)`
   *   `(The model called a tool this agent doesn't have: "web_search". The call was left out.)`
   *
   * 译成人话时要**带上工具名** —— 那是唯一有诊断价值的部分：
   * 如果模型反复想调 `bash`，说明提示词里给了它"可以执行命令"的错觉，那是要修的东西。
   */
  const noTool = /^\(?The model called a tool this agent doesn't have:?\s*"([^"]+)"\.?\s*The call was left out\.?\)?$/i.exec(t);
  if (noTool !== null) {
    return `模型试图调用工具「${noTool[1]}」，但这个角色没有该工具 —— 那次调用已跳过。`;
  }

  /* 同一句式的紧凑版（有的上游省掉后半句）。 */
  const noToolShort = /^\(?The model called a tool this agent doesn't have:?\s*"([^"]+)"\.?\)?$/i.exec(t);
  if (noToolShort !== null) {
    return `模型试图调用工具「${noToolShort[1]}」，但这个角色没有该工具。`;
  }

  return null;
}

/**
 * 这段文本**是不是整段外文**（没有一个中日韩字符）。
 *
 * 判据：长度超过阈值、且不含任何 CJK 字符。
 * 阈值 40 是为了不误伤 `BTCUSDT 5x`、`RSI14 58.2` 这类本来就该是英文/数字的短串。
 */
export function looksForeign(text: string): boolean {
  const t = text.trim();
  if (t.length < 40) return false;
  /* CJK 统一表意文字 + 中日文标点。有一个就算"中文内容"。 */
  return !/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(t);
}

/**
 * **模型自己写的整段外文** → 加一行说明，让人知道这是原始输出、不是系统故障。
 *
 * ## 为什么不是"翻译"
 *
 * 那是模型**当时的推理**（`Let me analyze each candidate systematically…`）。
 * 翻译它会引入我们的理解偏差，而且下一句可能就是它真正的结论 ——
 * 该保留原文，只是**告诉操作员这是什么**。
 *
 * ## 为什么必须标注
 *
 * 一屏里突然出现一整段英文，操作员的第一反应是"系统出 bug 了"。
 * 加一行中文说明，它就变成"模型用英文在想事情"—— 那是正常现象、也不是我能改的
 * （模型的输出语言由它的提示词和习惯决定，不该由前端擦掉）。
 */
export function formatForeignText(text: string): { label: string; body: string } {
  return {
    label: '模型输出（英文原文）',
    body: text,
  };
}
