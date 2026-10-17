/**
 * **给人看的文本渲染层** —— 团队模式里所有 step / note / message 都必须过这里。
 *
 * ## 用户的原话（2026-10-17）
 *
 * > 「团队模式，页面上给人看得东西不要出现：**英文占位符、json、代码块、无意义的内容**，
 * >  展示给人看的东西要**处理干净**，**格式排版、颜色高亮各方面都要优化做到位**」
 *
 * ## 它解决的四件事（每一件都对应一次用户截图）
 *
 * | 屏幕上原来长什么样 | 现在 |
 * |---|---|
 * | `[{"symbol":"WLDUSDT","action":"open_short","leverage":5,…}]` | **每个标的一行**：`开空 WLDUSDT · 5x · $11 · 止损 0.5380 · 止盈 0.5115 · 置信 60` |
 * | `**支撑**：162.4` | `支撑：162.4`（走 `lib/plainText.ts`） |
 * | 整段正文染红/染黄 | **左侧细竖条染色，正文保持中性**（整段染色可读性差） |
 * | 一条 1000 字的 note 铺满整屏 | 截断 + 「展开」 |
 *
 * ## 三条纪律（都有前例）
 *
 * ```
 *   ① 解析失败 → 回落纯文本，**绝不白屏**（`lib/structuredMessage.ts` 的 `parseJsonLoose`）
 *   ② 认不出的形状 → 不猜，原样显示
 *   ③ markdown 剥除与 JSON 格式化是**两件事**，都要做（`plainText` 只管前者）
 * ```
 *
 * ## ⚠️ 为什么"英文 id 保留原词"而不是硬翻
 *
 * `open_short` → 开空 是**有映射的**（`DecisionAudit` 的 `ACTION_LABELS`，全仓唯一一份）。
 * 但映射不到的词（新动作、模型自己编的字段名）**保留原词** —— 编一个中文名比显示
 * 英文更危险：操作员会以为那是系统认得的动作。保留时用**等宽 + 弱化色**，
 * 让人一眼看出"这是标识符，不是人话"（`AGENTS.md` §5.2 同一条）。
 */
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

import { actionLabel } from '../DecisionAudit';
import { plainText } from '../../lib/plainText';
import {
  fieldLabel,
  looksLikeActionCode,
  parseDecisionList,
  parseLooseObject,
  type ParsedDecisionItem,
} from '../../lib/structuredMessage';

/**
 * 超过这个长度就折叠。
 *
 * 取 220：历史详情那一列在 1600px 视口下约 480px 宽、`text-xs` 一行约 60 字，
 * 220 字 ≈ 3.7 行 —— 足够看清"它说了什么"，又不至于把上下条目挤出屏幕。
 */
const COLLAPSE_AT = 220;

/** 一个数值的人话（`null` 显示 `—`，**不是 0** —— 与全仓口径一致）。 */
function num(value: number | null, digits = 2): string {
  if (value === null) return '—';
  return value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 置信度：服务端给的是 0–100 的整数。`null` → 「未给出」（不是 0%）。 */
function confidence(value: number | null): string {
  return value === null ? '置信未给出' : `置信 ${Math.round(value)}`;
}

/**
 * **一条决策** —— 压成一行可扫读的摘要。
 *
 * 用户看这一列想知道的是"它这一轮对哪个标的做了什么、多大仓、止损在哪"，
 * 而不是"JSON 里有哪些键"。所以只挑这几个量，其余字段**不显示**（不是丢了 ——
 * 原始 JSON 仍在 `raw_response` / 日志里，这一格只负责"扫一眼"）。
 */
function DecisionLine({ item }: { item: ParsedDecisionItem }): React.ReactElement {
  const label = actionLabel(item.action);
  /* 映射不到的动作 → 等宽弱色（让人看出这是标识符，不是人话）。 */
  const unmapped = label === item.action;

  /* 仓位/风险只在"真的会开仓"的动作上有意义；skip/wait 显示这些只会是噪音。 */
  const showsSize = item.action.startsWith('open_') || item.action === 'add_to_position';

  return (
    <li className="min-w-0 py-0.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          className={
            unmapped
              ? 'num shrink-0 rounded bg-base-800 px-1 font-mono text-[11px] text-ink-faint'
              : 'shrink-0 rounded bg-base-800 px-1 text-[11px] font-medium text-ink-hi'
          }
          title={unmapped ? `这个动作码界面还没登记中文名：${item.action}` : undefined}
        >
          {label}
        </span>
        <span className="num shrink-0 text-xs font-semibold text-ink-hi">{item.symbol}</span>
        {showsSize && item.leverage !== null && (
          <span className="num shrink-0 text-[11px] text-ink-lo">{item.leverage}x</span>
        )}
        {showsSize && item.positionSizeUsd !== null && (
          <span className="num shrink-0 text-[11px] text-ink-lo">${num(item.positionSizeUsd, 0)}</span>
        )}
        {item.stopLoss !== null && (
          <span className="shrink-0 text-[11px] text-ink-faint">
            止损 <span className="num text-ink-lo">{num(item.stopLoss, 4)}</span>
          </span>
        )}
        {item.takeProfit !== null && (
          <span className="shrink-0 text-[11px] text-ink-faint">
            止盈 <span className="num text-ink-lo">{num(item.takeProfit, 4)}</span>
          </span>
        )}
        <span className="shrink-0 text-[11px] text-ink-faint">{confidence(item.confidence)}</span>
      </div>
      {item.reasoning !== null && (
        <p className="mt-0.5 break-words pl-1 text-[11px] leading-relaxed text-ink-lo">
          {plainText(item.reasoning)}
        </p>
      )}
    </li>
  );
}

/** 三级日志级别。**入参故意收 `string`**：`roster.ts` 里 `level` 就是 `string`（跨版本数据）。 */
export type HumanLevel = 'info' | 'warn' | 'error';

/**
 * 把宽松的 `string` 收成三级。
 *
 * ⚠️ **认不出的级别当 `info`**（不染色）而不是 `error`：把一条未知级别染成红色，
 * 会让"真正的失败"被稀释 —— 与本仓库"宁可少标也不要错标"同一条纪律。
 */
function normalizeLevel(level: string | null | undefined): HumanLevel {
  return level === 'error' || level === 'warn' ? level : 'info';
}

/**
 * **可折叠的长文本**。
 *
 * 折叠判据是**字符数**而不是行数：模型输出常常是一整段没有换行的长句，
 * 按行数判会把 1000 字当成"一行"从而不折叠。
 */
function CollapsibleText({ text, level }: { text: string; level: HumanLevel }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const tooLong = text.length > COLLAPSE_AT;
  const shown = tooLong && !open ? `${text.slice(0, COLLAPSE_AT)}…` : text;

  return (
    <div className="min-w-0">
      {/*
        ⚠️ **颜色只上左侧竖条，正文保持中性**（用户要求"正文不要整段染色"）。
        整段染红会让 8 条历史里只要有一条 error，整块看起来都像故障。
      */}
      <div
        className={
          level === 'error'
            ? 'border-l-2 border-down pl-2'
            : level === 'warn'
              ? 'border-l-2 border-warn pl-2'
              : 'border-l-2 border-transparent pl-2'
        }
      >
        <p className="min-w-0 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">
          {plainText(shown)}
        </p>
      </div>
      {tooLong && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-0.5 inline-flex items-center gap-0.5 rounded px-1 text-[11px] text-ink-lo transition hover:bg-base-800 hover:text-ink-hi"
        >
          <ChevronRight aria-hidden className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
          {open ? '收起' : `展开全文（${text.length} 字）`}
        </button>
      )}
    </div>
  );
}

/**
 * **一个 JSON 对象** → 键值两列（字段名译成中文，动作码值也译掉）。
 *
 * 这是用户截图里"英文占位符"的第二半：`note` 里除了决策数组，
 * 也可能写进来**单个对象**（`{"action":"open_short","symbol":"WLDUSDT",…}`）。
 * 那种形态既不是数组、也不该原样显示。
 */
function ObjectRows({ rows }: { rows: Array<[string, string]> }): React.ReactElement {
  return (
    <table className="w-full table-fixed border-collapse text-xs">
      <tbody>
        {rows.map(([key, value]) => {
          const label = fieldLabel(key);
          /* 未登记的字段名 → 等宽弱色（让人看出这是标识符，不是人话）。 */
          const unmappedField = label === key;
          /*
           * 值本身是动作码 → 也译成中文（`open_short` → 开空）。
           * 未登记的动作码保留原词 + 等宽弱色（与 `DecisionLine` 同一口径）。
           */
          const translated = looksLikeActionCode(value) ? actionLabel(value) : value;
          const unmappedValue = looksLikeActionCode(value) && translated === value;

          return (
            <tr key={key} className="border-b border-base-800 last:border-b-0">
              <th
                scope="row"
                className={`w-[7rem] whitespace-nowrap py-1 pr-2 text-left align-top font-normal ${
                  unmappedField ? 'font-mono text-[11px] text-ink-faint' : 'text-ink-faint'
                }`}
              >
                {plainText(label)}
              </th>
              <td
                className={`break-words py-1 align-top ${
                  unmappedValue ? 'font-mono text-[11px] text-ink-faint' : 'text-ink-mid'
                }`}
              >
                {plainText(translated)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * **一条 message 的人话版** —— 所有 step / note 的统一入口。
 *
 * 判据顺序（每一步都要）：
 * ```
 *   ① 是"决策数组"的 JSON？   → 每个标的一行（`parseDecisionList`）
 *   ② 是"单个对象"的 JSON？   → 键值两列，字段名与动作码都译成中文（`parseLooseObject`）
 *   ③ 否则                   → 纯文本（**仍要过 `plainText`**）+ 超长折叠
 * ```
 * 解析失败（截断、非 JSON、形状不对）自然落进 ③ —— **一个字节都不丢**。
 */
export function HumanMessage({
  text,
  level,
}: {
  text: string;
  /** 宽松入参：`roster.ts` 的 `level` 是 `string`，认不出的按 `info`（不染色）。 */
  level?: string | null;
}): React.ReactElement {
  const items = parseDecisionList(text);
  const tone = normalizeLevel(level);

  if (items !== null) {
    return (
      <div className="min-w-0">
        {/*
          先说"有几个标的"—— 用户要能一眼看出这一轮扫了多少个，而不是一行塞满。
          数字用 `num` 等宽，与全仓数字口径一致。
        */}
        <p className="mb-0.5 text-[11px] text-ink-faint">
          这一轮对 <span className="num text-ink-lo">{items.length}</span> 个标的给了决策
        </p>
        <ul className="min-w-0 space-y-1">
          {items.map((item, index) => (
            <DecisionLine key={`${item.symbol}-${item.action}-${index}`} item={item} />
          ))}
        </ul>
      </div>
    );
  }

  /* ② 单个对象 → 键值两列（字段名 + 动作码值都中文化）。 */
  const rows = parseLooseObject(text);
  if (rows !== null) {
    return (
      <div className="min-w-0">
        <ObjectRows rows={rows} />
      </div>
    );
  }

  return <CollapsibleText text={text} level={tone} />;
}
