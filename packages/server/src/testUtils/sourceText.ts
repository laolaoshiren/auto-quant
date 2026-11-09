/**
 * **测试用的源码工具**。
 *
 * ## 为什么需要 `codeOnly()`（这是四次假失败换来的）
 *
 * 本项目里有一类断言是"**某段旧代码不该存在**"：
 * ```
 *   断言：!src.includes('const riskPerTradePercent = 2;')
 *   断言：!src.includes('AQ_HUNTER_CONCURRENCY ?? \'\') || 2')
 *   …
 * ```
 * 而**我在修复的注释里引用了那段旧代码**（用来解释"为什么改"）→ 断言命中注释 → 假失败。
 *
 * 四次记录：
 * ```
 *   ① riskBudget.test.ts           `const riskPerTradePercent = 2;`
 *   ② marginLimit.test.ts          `这一条门槛就已经把可行集压到接近空了`
 *   ③ hunterConcurrency.test.ts    `AQ_HUNTER_CONCURRENCY ?? '' || 2`
 *   ④ researchPersistence.test.ts  `researchCache.get(`
 * ```
 *
 * **"在注释里引用旧代码"是有价值的** —— 它让后来的人知道为什么改。
 * 所以该修的是**断言**，不是注释。
 *
 * ⚠️ 而"每处手写一遍过滤"必然会漏 —— 所以抽成这一个共用实现。
 */

/**
 * 去掉整行注释后的源码。
 *
 * 判据是"**这一行以注释记号开头**"：
 * ```
 *   * …        → 块注释的续行（JSDoc）
 *   // …       → 行注释
 *   /* …       → 块注释开头
 * ```
 * ⚠️ **不处理行尾注释**（`const x = 1; // 旧值是 2`）——
 * 那需要真正的解析器，而本工具的用途是"排除大段说明性注释"，
 * 行尾注释里的旧代码引用是罕见情形，且**保留它更安全**
 *（宁可多排除一点，也不要漏掉真的代码）。
 */
export function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');
}

