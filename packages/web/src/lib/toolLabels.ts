/**
 * **把机器码工具名翻成中文语义**（用户 2026-11-10：「页面上不要出现类似英文，
 * 默认都要显示正常语义中文」）。
 *
 * 背景：决策流里会显示「模型主动取数：screen_symbols → 20 个」——`screen_symbols`
 * 是模型的工具名（机器契约），但对看页面的人是噪音。
 *
 * ## 为什么前端还要做一次映射
 *
 * 服务端从 2026-11-10 起新写的摘要已经是中文（`decisionTools.ts` 的 `summary`），
 * 但**历史决策记录**里存的仍是旧英文摘要（已经落库，不可能为了显示去改库）。
 * 所以渲染时再做一层替换，新老记录都能显示中文。
 */
const TOOL_ZH: Record<string, string> = {
  screen_symbols: '筛选标的',
  get_klines: '读取K线',
  list_candidates: '读取候选池',
  set_params: '修改参数',
  request_deep_analysis: '请求深挖分析',
  get_performance: '读取绩效',
  get_equity_curve: '读取权益曲线',
  get_experiments: '读取历史实验',
  get_lessons: '读取经验教训',
  get_recent_decisions: '读取最近决策',
  get_market_overview: '读取行情概览',
  get_skipped_outcomes: '读取跳过结果',
  get_current_params: '读取当前参数',
  set_cycle_interval: '修改周期',
  finish: '结束',
};

const TOOL_PATTERN = new RegExp(`\\b(${Object.keys(TOOL_ZH).join('|')})\\b`, 'g');

/** 把一段文本里出现的工具名替换成中文（没有工具名时原样返回）。 */
export function humanizeToolNames(text: string): string {
  return text.replace(TOOL_PATTERN, (name) => TOOL_ZH[name] ?? name);
}
