/**
 * **智能体审计面板的三列机器码必须有中文标签**（用户实测，2026-10-17 · t53）。
 *
 * ## 用户报的是什么
 *
 * > 「**智能体审计里面出现英文字符（整个前端UI都应该是中文表述）**」
 *
 * 截图里可见 `strategy`、`idle`、`timeout`、`new result`、`ok`、`failed`。
 *
 * ## 判据（t52 清单 §1，一句话）
 *
 * > **码的「存储与传输」保持英文；码的「显示」必须经过一次"码 → 中文标签"的映射。**
 * > 判据查的是**渲染层**，不是存储层。
 *
 * 所以本文件**不**断言"库里不该出现英文"（那反而是合规的），
 * 它钉的是另外三件事：
 *
 *   ① 三张标签表覆盖了各自的**全部**取值（`agent_runs.kind/trigger/outcome`）；
 *   ② **认不出的码回落原码**，绝不渲染成 `undefined` / 空白；
 *   ③ **跨包一致性**：服务端新增一个 `WakeTrigger` / `outcome` / 环境取值，
 *      而 shared 的名单没跟上 → **这里当场变红**。
 *
 * ## 为什么 ③ 必须存在（这是本任务的核心价值）
 *
 * 服务端的端口签名把 `kind` / `trigger` 放宽成了 `string`（`orchestrator.ts`
 * 的 `recordRun`），所以**类型层拦不住"服务端加了一个新码"**：
 * 有人在写入点加一档 `kind: 'incident'` → `tsc` 不报错 → 落库 →
 * 界面回落到 `?? 原值` → 屏幕上出现 `incident`，
 * 而"每个 `AgentRunKind` 都有标签"那条穷尽断言**仍然是绿的**
 * （因为 shared 的联合里根本没有它）。
 *
 * 所以 ③ 是**从服务端权威定义反向核对**，而不是自己跟自己比。
 * 三条守卫各自读一个服务端文件，把成员抽出来逐字比对 ——
 * 服务端动、shared 没动，就红。
 *
 * ## ⚠️ 判据不能恒真（本仓库的纪律）
 *
 * 每一条断言都做了**探针校准**：`__probe__` 那种不存在的码必须被**报出来**。
 * 一条"怎么改都不红"的断言比没有断言更糟（它会让人以为这里被守住了）。
 * 校准见每组末尾的 `★ 探针`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AGENT_RUN_KINDS,
  AGENT_RUN_KIND_LABELS,
  AGENT_RUN_OUTCOMES,
  AGENT_RUN_OUTCOME_LABELS,
  WAKE_TRIGGER_LABELS,
  WAKE_TRIGGERS,
  agentRunKindLabel,
  agentRunOutcomeLabel,
  wakeTriggerLabel,
} from '@aq/shared';
import { CodeLabel } from '../components/AgentAuditPanel.js';
import { TRADING_ENVIRONMENT_LABELS, tradingEnvironmentLabel } from './format.js';

/* -------------------------------------------------------------------------- */
/*  服务端权威定义（跨包一致性的"另一侧"）                                       */
/* -------------------------------------------------------------------------- */

/**
 * 读服务端源码。
 *
 * `import.meta.url` 基准是 `packages/web/src/lib/`，所以往上三层到 `packages/`，
 * 再进 `server/src/`。**与 `equityMetric.test.ts` 读 `repositories.ts` 同一个做法**
 * （那里就是 `new URL('../../../server/src/store/repositories.ts', import.meta.url)`）。
 */
const SERVER_SRC = new URL('../../../server/src/', import.meta.url);

/** 去掉块注释与行注释，免得"注释里提到的旧取值"把守卫变成假失败。 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * 从 `export type X = 'a' | 'b'` 里抽出成员。
 *
 * ⚠️ **允许换行与前置 `|`** —— 服务端那两个定义都是竖排的：
 * ```
 *   export type WakeTrigger =
 *     | 'new_result'
 *     | 'losing_streak'
 * ```
 * 第一版按单行写正则，抽出来的是空集合，而**空集合能让"子集"断言恒真** ——
 * 那正是本仓库反复记录的那类静默失效。所以下面每个守卫都有"抽到的成员数必须达标"
 * 的前置断言。
 */
function unionMembers(src: string, typeName: string): string[] {
  const start = src.indexOf(`export type ${typeName}`);
  assert.notEqual(start, -1, `★ 找不到服务端的 \`export type ${typeName}\` —— 判据失效了`);
  const eq = src.indexOf('=', start);
  const end = src.indexOf(';', eq);
  const body = src.slice(eq + 1, end);
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/* -------------------------------------------------------------------------- */
/*  ① 穷尽性：三张表 + 环境表                                                    */
/* -------------------------------------------------------------------------- */

test('★★★ agent_runs.kind 的每一个取值都有中文标签，且标签真的翻译过', () => {
  /*
   * `Record<AgentRunKind, string>` 让**漏一个取值编译不过**，但类型层管不到
   * "标签值等于原码"（`strategy: 'strategy'` 是合法的 string）——
   * 而那种标签上屏之后与原样渲染机器码**没有区别**。
   */
  for (const kind of AGENT_RUN_KINDS) {
    const label = AGENT_RUN_KIND_LABELS[kind];
    assert.ok(
      typeof label === 'string' && label.length > 0,
      `★★★ agent_runs.kind='${kind}' 没有中文标签 —— 面板会渲染裸机器码`,
    );
    assert.notEqual(label, kind, `★★★ '${kind}' 的标签与机器码相同 —— 那等于没翻译`);
    assert.equal(agentRunKindLabel(kind), label, `agentRunKindLabel('${kind}') 必须返回它的标签`);
    /* 标签本身不该含 ASCII 字母：那是"没翻译"的形状（原码另处单独显示）。 */
    assert.ok(
      !/[A-Za-z]/.test(label),
      `★★★ '${kind}' 的标签「${label}」里还有英文字母 —— 用户报的就是这个`,
    );
  }
  /* ★ 探针：表里没有的码必须原样返回，而不是 undefined / 空串。 */
  assert.equal(agentRunKindLabel('__probe__'), '__probe__', '★ 探针：未知码必须回落原码');
});

test('★★★ agent_runs.trigger 的每一个取值都有中文标签', () => {
  for (const trigger of WAKE_TRIGGERS) {
    const label = WAKE_TRIGGER_LABELS[trigger];
    assert.ok(
      typeof label === 'string' && label.length > 0,
      `★★★ agent_runs.trigger='${trigger}' 没有中文标签 —— 面板会渲染裸机器码`,
    );
    assert.notEqual(label, trigger, `★★★ '${trigger}' 的标签与机器码相同 —— 那等于没翻译`);
    assert.equal(wakeTriggerLabel(trigger), label, `wakeTriggerLabel('${trigger}') 必须返回它的标签`);
    assert.ok(
      !/[A-Za-z]/.test(label),
      `★★★ '${trigger}' 的标签「${label}」里还有英文字母 —— 用户截图里的 idle/timeout 就是它`,
    );
  }
  assert.equal(wakeTriggerLabel('__probe__'), '__probe__', '★ 探针：未知码必须回落原码');
});

test('★★★ agent_runs.outcome 的每一个取值都有中文标签，且 degraded 不等于"失败"', () => {
  for (const outcome of AGENT_RUN_OUTCOMES) {
    const label = AGENT_RUN_OUTCOME_LABELS[outcome];
    assert.ok(
      typeof label === 'string' && label.length > 0,
      `★★★ agent_runs.outcome='${outcome}' 没有中文标签 —— 面板会渲染裸机器码`,
    );
    assert.notEqual(label, outcome, `★★★ '${outcome}' 的标签与机器码相同 —— 那等于没翻译`);
    assert.equal(agentRunOutcomeLabel(outcome), label);
    assert.ok(!/[A-Za-z]/.test(label), `★★★ '${outcome}' 的标签「${label}」里还有英文字母`);
  }
  /*
   * ⚠️ **`degraded` 不得译成「失败」**（队长裁定 2）。
   *
   * `loop.ts` 区分得很清楚：`ok`=模型自己调了 finish（有结论）/ `degraded`=
   * 撞上步数上限、**没有结论** / `failed`=输出坏掉且无法恢复。
   * 把 degraded 说成"失败"，操作员会去查一个"坏掉的轮次"，
   * 而真实处置是"放宽步数预算或精简必读清单" —— 两种方向完全不同。
   *
   * 判据写成"两者标签必须不同"，而不是断言某一个具体措辞：
   * **它防的是混淆，不是锁死文案**（改措辞不该让测试红）。
   */
  assert.notEqual(
    AGENT_RUN_OUTCOME_LABELS.degraded,
    AGENT_RUN_OUTCOME_LABELS.failed,
    '★★★ degraded 与 failed 被译成了同一个词 —— 两者的处置方向完全相反',
  );
  assert.equal(agentRunOutcomeLabel('__probe__'), '__probe__', '★ 探针：未知码必须回落原码');
});

test('★★★ 交易环境的每一个取值都有中文标签，且 legacy-testnet 不再露码', () => {
  /*
   * 服务端权威集合：`binance/endpoints.ts` 的 `BinanceEnvironment`。
   * t52 的 A5 实测：这个函数原来只认 production/demo，
   * 第三种环境会**直接回落到原码**（卡片上显示 `legacy-testnet`）。
   */
  const environments = unionMembers(
    codeOnly(readFileSync(new URL('binance/endpoints.ts', SERVER_SRC), 'utf8')),
    'BinanceEnvironment',
  );
  assert.ok(
    environments.length >= 3,
    `★ 只抽到 ${environments.length} 个环境取值（${environments.join('/')}）—— 抽取逻辑失效，断言会恒真`,
  );

  for (const environment of environments) {
    const label = TRADING_ENVIRONMENT_LABELS[environment];
    assert.ok(
      typeof label === 'string' && label.length > 0,
      `★★★ 环境 '${environment}' 没有中文标签 —— 界面会渲染裸机器码`,
    );
    assert.notEqual(label, environment, `★★★ '${environment}' 的标签与机器码相同`);
    assert.equal(tradingEnvironmentLabel(environment), label);
  }
  assert.equal(tradingEnvironmentLabel('__probe__'), '__probe__', '★ 探针：未知环境必须回落原码');
  assert.equal(tradingEnvironmentLabel(null), '—', '空值仍然是破折号，不是原码也不是 undefined');
});

/* -------------------------------------------------------------------------- */
/*  ② 跨包一致性：服务端加一个取值，这里必须红                                    */
/* -------------------------------------------------------------------------- */

test('★★★ WakeTrigger 必须与 shared 的名单逐字一致 —— 服务端加一档而这里没跟上就红', () => {
  const src = codeOnly(readFileSync(new URL('trader/agent/wake.ts', SERVER_SRC), 'utf8'));
  const members = unionMembers(src, 'WakeTrigger');
  assert.ok(
    members.length >= 8,
    `★ 只抽到 ${members.length} 个 WakeTrigger 取值 —— 抽取逻辑失效，下面的比对会恒真`,
  );
  assert.deepEqual(
    [...WAKE_TRIGGERS].sort(),
    [...members].sort(),
    '★★★ shared 的 WAKE_TRIGGERS 与服务端 wake.ts 的 WakeTrigger 分叉了 —— ' +
      '新增的触发原因必须同时在这里登记中文标签，否则界面上会出现一个新的英文词',
  );
});

test('★★★ LoopResult.outcome 必须与 shared 的名单逐字一致', () => {
  const src = codeOnly(readFileSync(new URL('trader/agent/loop.ts', SERVER_SRC), 'utf8'));
  /*
   * `outcome` 不是 `export type`，而是接口里的一个联合成员：
   *   `outcome: 'ok' | 'degraded' | 'failed';`
   * 所以单独抽一次（不能复用 `unionMembers`）。
   */
  const match = /outcome:\s*((?:'[^']+'\s*\|\s*)*'[^']+')\s*;/.exec(src);
  assert.ok(match, '★ 找不到 loop.ts 里的 `outcome: …` 联合 —— 判据失效了');
  const members = [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  assert.ok(
    members.length >= 3,
    `★ 只抽到 ${members.length} 个 outcome 取值（${members.join('/')}）—— 抽取逻辑失效`,
  );
  assert.deepEqual(
    [...AGENT_RUN_OUTCOMES].sort(),
    [...members].sort(),
    '★★★ shared 的 AGENT_RUN_OUTCOMES 与服务端 loop.ts 分叉了 —— 新增的结果分类必须同时补中文标签',
  );
});

test('★★ 服务端写入的 kind 字面量必须都在 shared 的名单里', () => {
  /*
   * `recordRun` 只有一个生产调用点模块（`orchestrator.ts`），它写的是
   * `kind: 'strategy'`。这里把该文件里**所有** `kind: '…'` 字面量抽出来，
   * 断言它们都被登记过。
   *
   * ⚠️ 这条**抓不住**"端口收 string、写入点传变量"那种形态
   * （那半边要收口在服务端，见 t61）；它抓的是"有人直接写了一个新字面量"。
   * 判据边界写在注释里，不含糊。
   */
  const src = codeOnly(readFileSync(new URL('trader/agent/orchestrator.ts', SERVER_SRC), 'utf8'));
  const literals = [...src.matchAll(/kind:\s*'([^']+)'/g)].map((m) => m[1]!);
  assert.ok(
    literals.length >= 1,
    '★ 一个 `kind: \'…\'` 字面量都没抽到 —— 抽取逻辑失效，断言会恒真',
  );
  const unknown = [...new Set(literals)].filter(
    (k) => !(AGENT_RUN_KINDS as readonly string[]).includes(k),
  );
  assert.deepEqual(
    unknown,
    [],
    `★★★ 服务端写了未登记的 agent_runs.kind：${unknown.join('、')} —— ` +
      '面板会回落成裸机器码（用户报的就是这个形状）',
  );
});

/* -------------------------------------------------------------------------- */
/*  ③ 面板与另外两个界面：不许再直出码（渲染层，不是源码层）                       */
/* -------------------------------------------------------------------------- */

test('★★★ 面板的四处渲染都必须过标签函数（源码接通性）', () => {
  /*
   * 这一条是**源码层**的接通性检查（上一条是渲染层，两者互补）：
   * 它防的是"有人把这四处改回直出写法"。用户截图里的那四处正是
   * `AgentAuditPanel.tsx` 的 `r.kind` / `r.trigger` / `r.outcome` / `e.trigger`。
   */
  const panel = codeOnly(
    readFileSync(new URL('../components/AgentAuditPanel.tsx', import.meta.url), 'utf8'),
  );
  for (const [field, fn] of [
    ['r.kind', 'agentRunKindLabel'],
    ['r.trigger', 'wakeTriggerLabel'],
    ['r.outcome', 'agentRunOutcomeLabel'],
    ['e.trigger', 'wakeTriggerLabel'],
  ] as const) {
    assert.ok(
      panel.includes(`${fn}(${field})`),
      `★★★ 面板里的 ${field} 没有过 ${fn}() —— 它会直出机器码（用户截图的正是这四处）`,
    );
  }
  /*
   * ★ 探针：同一个判据跑在"直出写法"的样本上必须报出来。
   * 缺了它，上面那四条在"整段被删掉"这类改动下仍可能因为字符串恰好还在而变绿。
   */
  const naive = 'const x = () => <td>{r.kind}</td>;';
  assert.ok(
    !naive.includes('agentRunKindLabel(r.kind)'),
    '★ 探针：直出写法必须被判为未接通（否则上面的断言恒真）',
  );
});

test('★★★ 面板渲染出来的 HTML 里，机器码只能出现在小字里、中文必须是主体', () => {
  /*
   * ## 这一条为什么必须**真的渲染**
   *
   * 上一组断言只证明"源码里调了标签函数"。而表漏一个取值时，那个调用会经
   * `?? 原码` **回落成英文**，源码看起来完全正确、上一条也是绿的 ——
   * 屏幕却仍然是用户截图里的样子。
   *
   * 所以这里把面板那一格真的渲染成 HTML，直接断言：
   *   ① 屏幕上**含有中文标签**（这是"看得懂"的证据）；
   *   ② 机器码**不作为可见文本的主体**出现（它只在小字里、且有 `存储值` 的语义标注）。
   *
   * ## 判据的边界（诚实说明）
   *
   * 原码**仍然在 HTML 里**（这是刻意的：排查时要能抄它，见 `CodeLabel` 的注释），
   * 所以判据**不能**写成"HTML 里不许出现 strategy"—— 那会与"保留原始码"直接冲突，
   * 也会逼出一个恒真或恒假的断言。判据写成**结构性的**：
   * 中文标签必须在，且原码必须带 `title="存储值 …"` 的说明。
   */
  const rendered = renderToStaticMarkup(
    createElement(CodeLabel, { label: agentRunKindLabel('strategy'), code: 'strategy' }),
  );
  assert.ok(
    rendered.includes('策略轮'),
    `★★★ 渲染结果里没有中文标签 —— 用户看到的就是这一格：${rendered}`,
  );
  assert.ok(
    rendered.includes('title="存储值 strategy"'),
    `★★★ 原码必须以"存储值"的身份出现（不是可见主体）：${rendered}`,
  );
  /*
   * ⚠️ **原码外面要有可读的边界**（实测抓到的：第一版渲染出来是
   * `策略轮strategy`，中文与英文连成一串，读起来像坏掉的文案）。
   * 断言"可见文本里中文之后紧跟的是 `（`" —— 这是"有边界"的证据，
   * 而**不是**断言某一种具体措辞（改样式不该让测试红）。
   */
  const visibleText = rendered.replace(/<[^>]*>/g, '');
  assert.ok(
    visibleText.startsWith('策略轮（'),
    `★★★ 原码与标签之间没有可见边界（第一版是「策略轮strategy」）：${visibleText}`,
  );

  /*
   * ★ 探针：**回落形态**（表里没有那个码）必须能被这套判据认出来 ——
   * 否则上面两条对"表漏了取值"这种失败是瞎的。
   */
  const fallback = renderToStaticMarkup(
    createElement(CodeLabel, { label: agentRunKindLabel('__probe__'), code: '__probe__' }),
  );
  assert.ok(
    !fallback.includes('策略轮'),
    '★ 探针：未知码不该拿到任何已知标签',
  );
  assert.ok(
    fallback.includes('__probe__'),
    '★ 探针：未知码必须原样出现（回落原码是契约，不许变成 undefined）',
  );
  /*
   * ⚠️ 回落时 `label === code`，**不该显示成「incident（incident）」** ——
   * 那比显示一次更糟（看起来像系统把同一个词弄混了）。
   */
  const fallbackText = fallback.replace(/<[^>]*>/g, '');
  assert.equal(
    fallbackText,
    '__probe__',
    `★★★ 未知码只该出现一次（不许「incident（incident）」）：${fallbackText}`,
  );
});

test('★★ 登录页与账户页不许再渲染环境机器码', () => {
  const login = codeOnly(readFileSync(new URL('../pages/LoginPage.tsx', import.meta.url), 'utf8'));
  assert.ok(
    !/health\.environment\.toUpperCase\(\)/.test(login),
    '★★ 登录页又把环境码大写直出了（`DEMO` / `PRODUCTION`）—— 改用 tradingEnvironmentLabel',
  );
  assert.ok(
    login.includes('tradingEnvironmentLabel(health.environment)'),
    '★★ 登录页必须走 tradingEnvironmentLabel',
  );

  const account = codeOnly(
    readFileSync(new URL('../components/settings/AccountSection.tsx', import.meta.url), 'utf8'),
  );
  assert.ok(
    account.includes('tradingEnvironmentLabel(system.environment)'),
    '★★ 账户页的运行环境兜底支必须过 tradingEnvironmentLabel（否则落回原码）',
  );

  /* ★ 探针：直出形态必须被判违规。 */
  assert.ok(
    /health\.environment\.toUpperCase\(\)/.test('{health.environment.toUpperCase()}'),
    '★ 探针：正则必须能匹配直出形态（否则上面第一条恒真）',
  );
});
