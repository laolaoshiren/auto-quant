/**
 * **角色 id → 界面中文名** —— 团队模式所有"成员行"的唯一登记处。
 *
 * ## 为什么单独一个文件（2026-10-17 · t108）
 *
 * 这张表原来住在 `TeamDecisionRow.tsx` 里。可它有**两个**使用方：
 * ```
 *   TeamDecisionRow.tsx  成员行（决策流里的角色产出）
 *   roster.ts            看板编制表 + **编制表之外的兜底行**
 * ```
 * 而 `TeamDecisionRow` **已经 import 了 `roster`**（要它的 `INK` / `SURFACE` 常量）。
 * 于是让 `roster` 反过来 import `TeamDecisionRow` 就成了**循环依赖** ——
 * 谁都跑得起来，但模块初始化顺序一旦变化就会莫名其妙地拿到 `undefined`
 * （本仓库对这类"看起来能跑"的循环是有戒心的）。
 *
 * ⇒ 把这张**没有任何依赖**的表抽出来放进独立模块，两个使用方都 import 它。
 * 没有循环、没有顺序问题，而且"角色名只有一份"这个事实**在文件层面就成立了**。
 *
 * ## 覆盖范围（**这是本条最容易被漏掉的部分**）
 *
 * 界面能看到的角色 id 有**三个来源**，不是两个：
 * ```
 *   ① FIRM_ROLES          编制表（shared/firm.ts，21 个）
 *   ② ROLE_TIERS          模型路由表（server/routedModel.ts，20 个）
 *   ③ AgentRole 联合       **agent 层真正会产出的角色**（server/agent/roles.ts，17 个）
 * ```
 * ⚠️ 用户实测报的就是**只有 ③ 才有、①②都没有**的那 5 个：
 * `strategist` / `reviewer` / `performance_analyst` / `attribution_analyst` / `trader`。
 * 它们不出现在编制表里（老板没给它们排工位），但**agent 层会以它们的名义产出**，
 * 于是看板走"编制表之外的角色"那条兜底分支 —— 而兜底以前把**原始 id** 当标题。
 *
 * 只守 ①（2026-10-17 的 `roleLabels.test.ts` 当初只遍历 `FIRM_ROLES`）**抓不到这 5 个**，
 * 所以守卫现在也遍历 ③（见同目录的 `roleLabels.test.ts`）。
 *
 * ## 兜底语义不能丢
 *
 * 未登记的 id 返回 `null`，由调用处决定怎么显示 —— **绝不能返回空白**
 *（那会让操作员以为"这一轮没人说话"）。
 */
export const ROLE_LABEL: Record<string, string> = {
  supervisor: '总管',
  judge: '裁决官',
  reporter: '汇报员',
  market_analyst: '市场分析师',
  technical: '技术面分析',
  newscaster: '新闻调查员',
  sentiment: '市场情绪',
  bull: '多头研究员',
  bear: '空头研究员',
  /* ⚠️ 2026-10-17 补：漏登记的正式岗位（见 `TeamDecisionRow` 里那段实测记录）。 */
  symbol_scout: '标的侦查员',
  onchain_analyst: '链上分析',
  community_monitor: '社区监控',
  risk_officer: '风控官',
  red_team: '红队',
  portfolio_manager: '组合经理',
  execution: '交易员（执行层）',
  memory_curator: '复盘员',
  data_sentinel: '数据看门狗',
  ops_watchdog: '运维看门狗',
  clerk: '文员',
  system_engineer: '系统工程师',
  /*
   * ── **agent 层角色**（2026-10-17 · t108 用户实测）────────────────────────
   *
   * 这 5 个来自 `server/agent/roles.ts` 的 `AgentRole` 联合，**不在编制表里**。
   * 用户截图的原话：「AI 工作流里面有部分显示的是：**英文、占位符**，
   * 而不是正确的显示中文名称」—— 指的就是它们。
   *
   * ⚠️ `trader` 与 `execution` 的中文名刻意**不同**：
   * ```
   *   execution  = T0 代码节点，做下单/撤单的机械动作 → 「交易员（执行层）」
   *   trader     = agent 层的 LLM 角色，做下单前的判断   → 「交易员」
   * ```
   * 两者在数据里是两个不同的 id，界面上也必须能分辨 —— 同名会让人以为
   * "同一个岗位出现了两次"。
   */
  strategist: '策略师',
  reviewer: '复核员',
  performance_analyst: '绩效分析',
  attribution_analyst: '归因分析',
  trader: '交易员',
};

/** 给测试用：这张表登记了哪些角色 id（**不导出表本身**，避免被别处改）。 */
export function registeredRoleIds(): string[] {
  return Object.keys(ROLE_LABEL);
}

/** 角色 id → 界面标签（未登记的返回 `null`，由调用处决定怎么显示）。 */
export function roleLabel(role: string): string | null {
  return ROLE_LABEL[role] ?? null;
}
