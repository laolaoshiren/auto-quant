/**
 * **运行期读配置必须走 `effectiveConfig()`，不能直读 `activeConfig`** —— 结构守卫。
 *
 * ## 为什么这个测试存在（同一条 bug 的第四、第五次）
 *
 * `activeConfig` 是**装配期**的原始配置；`effectiveConfig()` 是**本轮真正生效**的
 * 配置（JEV 模式下会覆盖部分字段）。这个仓库为"读了错误的那一个"付过多次代价，
 * 每次症状都一样：**界面/日志说的是 A，实际执行用的是 B，而没有任何报错**。
 *
 * ```
 *   ① 熔断阈值 → 覆盖写在 riskConfig，熔断读 config
 *   ② 熔断横幅 → circuitBreakerReading 读 activeConfig
 *   ③ 保本阈值 → applyBreakevenGuard 读 activeConfig
 *   ④ 回撤守卫 → 就是那一处
 *   ⑤ 2026-11-09 审计又找出 16 处运行期直读（safeModeAfterFailures、
 *      pendingEntryTimeoutMinutes、indicators、fallbackStopLossPercent、
 *      requireStopLoss、priceProtectOnStop …）
 * ```
 *
 * ## 判据
 *
 * 扫描 `autoTrader.ts` 的**代码部分**（剔除注释），每一处 `this.activeConfig`
 * 都必须命中下面显式列出的白名单；否则报错并提示改用 `effectiveConfig()`。
 *
 * ## 白名单里为什么允许这几处读它
 *
 * 装配/写路径：`activeConfig` 是"配置"这个事实本身，把它本身读出来是职责内的事。
 * 用 `effectiveConfig()` 反而会**把 JEV 的瞬态覆盖持久化**（见 `applyAgentPatch`
 * 里的说明）。所以这几处不是"漏改"，而是**必须**读原始配置。
 *
 * ## 边界（诚实说明）
 *
 * · 它抓的是"文本上直读 `this.activeConfig`"这一档；别名/解构绕过它；
 * · 它**不**验证 `effectiveConfig()` 真的覆盖了所有该覆盖的字段（那是另一件事，
 *   由有效配置的单测覆盖）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/** 允许直接出现 `this.activeConfig` 的代码行（去掉行尾空白后逐字比较）。 */
const ALLOWED_LINES: ReadonlyMap<string, string> = new Map([
  ['this.activeConfig = deps.config;', '构造函数：装配期初始化。'],
  ['private activeConfig: StrategyConfig;', '字段声明。'],
  ['if (override) this.activeConfig = override;', '`refreshAgentState()`：装配期刷新。'],
  [
    'if (this.deps.trader.mode !== \'jev\') return this.activeConfig;',
    '`effectiveConfig()` 自身实现：非 JEV 模式直接返回原始配置。',
  ],
  ['...this.activeConfig,', '`effectiveConfig()` 自身实现：展开原始配置。'],
  ['...this.activeConfig.circuitBreaker,', '`effectiveConfig()` 自身实现：展开熔断分区。'],
  [
    'const current = this.activeConfig;',
    '`applyAgentPatch()`：补丁结果会落库，必须基于原始配置（否则瞬态覆盖被持久化）。',
  ],
  ['this.activeConfig = result.config;', '`applyAgentPatch()`：写回刚持久化的配置。'],
]);

/** 去掉一行里的 `//` 与 `/* … *\/` 注释（跳过字符串字面量）。 */
function stripComments(line: string): string {
  let out = '';
  let inString: string | null = null;
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += line[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      i = end === -1 ? line.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 分类：返回 `runtime`（必须改的直读）与 `allowed`（命中白名单的读取）。
 *
 * 整行注释（`*` / `//` / `/*` 开头）先跳过，再剥行内注释 —— 否则注释里提到
 * `this.activeConfig` 的说明文字会被当成代码（本文件有大量这种注释）。
 */
function classify(source: string): { runtime: string[]; allowed: string[] } {
  const runtime: string[] = [];
  const allowed: string[] = [];
  source.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
    const code = stripComments(line);
    if (!code.includes('this.activeConfig')) return;
    const normalized = code.trim();
    if (ALLOWED_LINES.has(normalized)) {
      allowed.push(normalized);
    } else {
      runtime.push(`autoTrader.ts:${index + 1}  ${trimmed}`);
    }
  });
  return { runtime, allowed };
}

const SOURCE_PATH = fileURLToPath(new URL('./autoTrader.ts', import.meta.url));
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

test('★★★ 运行期不得直读 `this.activeConfig` —— 一律走 `effectiveConfig()`', () => {
  const { runtime, allowed } = classify(SOURCE);

  /*
   * 前置断言：必须真的扫到了那些"允许"的读取点。
   * 否则（例如路径写错、文件读成空）下面"运行时直读为零"会**因为什么都没扫到**
   * 而通过 —— 那正是这个仓库反复强调的"看不出异常的空转"。
   */
  assert.ok(
    allowed.length >= 7,
    `★ 只扫到 ${allowed.length} 处白名单读取 —— 源码语料可能没读到，这条守卫会空转`,
  );

  assert.deepEqual(
    runtime,
    [],
    '★★★ 这些代码在**运行期**直读 `this.activeConfig`，而不是 `effectiveConfig()`：\n' +
      runtime.map((line) => `      · ${line}`).join('\n') +
      '\n    JEV 模式下 `activeConfig` 不是本轮生效的那份 —— 这些地方会读到旧值，' +
      '而症状是"界面/日志说 A、实际执行用 B"，不会报错。\n' +
      '    ✅ 运行期读取请改用 `this.effectiveConfig()`；\n' +
      '    ✅ 若确实是装配/写路径（必须读原始配置），把它加进 `ALLOWED_LINES` 并写明理由。',
  );
});

test('★★ 白名单不能变成垃圾桶 —— 名单里的每一行都必须仍然存在于源码', () => {
  /*
   * 反向检查：名单条目对应代码被删掉/改形之后，它就该从名单里移除 ——
   * 否则下一个人会以为那里仍有一处"必须读 activeConfig"的装配代码。
   */
  const present = new Set(
    SOURCE.split('\n')
      .map((line) => stripComments(line).trim())
      .filter((line) => line.length > 0),
  );
  for (const [line, reason] of ALLOWED_LINES) {
    assert.ok(
      present.has(line),
      `★★ 白名单条目在源码里找不到了：\`${line}\`\n    原理由：${reason}\n` +
        '    若该处代码已被删/改写，请把它从 `ALLOWED_LINES` 移除。',
    );
  }
});

test('★★★ 判据必须能真的报出运行期直读 —— 用一个注入的坏例子证明它不是空转', () => {
  /*
   * 探针校准：往一份真实源码后面追加一行**字符串拼接**的坏代码（不是真改仓库），
   * 断言同一套判据会把它报出来。没有这一步，"runtime 为空"也可能是判据失效。
   */
  const badLine = 'const leaked = this.activeConfig.riskControl.requireStopLoss;';
  const { runtime } = classify(`${SOURCE}\n${badLine}`);
  assert.equal(runtime.length, 1, '★ 判据必须报出注入的运行期直读');
  assert.ok(runtime[0]!.includes('leaked'), '★ 报出的行必须是注入的那一行');
});
