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
import { formatForeignText, looksForeign, translateDiagnostic } from '../../lib/diagnosticText';
import {
  fieldLabel,
  looksLikeActionCode,
  parseDecisionListDetailed,
  parseLooseObjectDetailed,
  valueLabel,
  type ObjectRow,
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

/**
 * **"原文本被截断过"的如实说明**（2026-10-18 · 用户实测那条 4,016/4,750 字）。
 *
 * ## 为什么剥掉留痕之后还要把它说一遍
 *
 * 留痕（`…（已截断，完整 N 字）`）是**后端有意留的**：它在告诉读者"这不是全部"。
 * 展示层解析前必须剥掉它（否则 JSON 永远解析不出来），但**不能连这个事实一起丢掉** ——
 * 用户看到的应当是"这是前 N 个标的，原文还有更多"，而不是一段看起来完整的数据。
 *
 * ## 两种口径（都不许假装完整）
 * ```
 *   shown === null  → 决策数组本身是完整的，被截掉的是数组**之后**的内容
 *   shown !== null  → 数组被截断：只抠出前 N 个完整对象，最后那个不完整的已丢弃
 * ```
 *
 * ⚠️ 颜色按 `DecisionDetailPage` 的口径用**弱化色**而不是 `text-warn`：
 * 截断是"数据不完整"这个**事实**，不是故障；红色会把真正的失败稀释掉。
 */
function TruncationNotice({
  originalLength,
  shown,
}: {
  /** 留痕里记录的原始字符数（`stripTruncationTail` 保证有留痕时非 null）。 */
  originalLength: number;
  /** 结构化后实际显示的标的数；`null` = 数组本身完整，只截掉了后面的内容。 */
  shown: number | null;
}): React.ReactElement {
  return (
    <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
      {`原文本已截断（完整 ${originalLength} 字）`}
      {shown === null ? '。' : `，只显示了前 ${shown} 个完整的标的。`}
    </p>
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
  /*
   * ⚠️ **上游 SDK 的英文诊断先译成人话**（2026-10-18 · 用户截图里那条反复出现的
   * `(The model called a tool this agent doesn't have: "bash"…)`）。
   *
   * `translateDiagnostic` 只认**已知的固定句式**，认不出就返回 null ⇒ 原文照旧。
   * 它**不会**碰模型自己写的推理正文 —— 那个的边界见该文件的说明。
   */
  const translated = translateDiagnostic(text);
  const display = translated ?? text;
  /*
   * **整段外文**（模型用英文思考）→ 加一行中文说明。
   * 不翻译（会失真），但必须标注 —— 否则操作员以为系统坏了。
   */
  const foreign = translated === null && looksForeign(text) ? formatForeignText(text) : null;

  const tooLong = display.length > COLLAPSE_AT;
  const shown = tooLong && !open ? `${display.slice(0, COLLAPSE_AT)}…` : display;

  return (
    <div className="min-w-0">
      {foreign !== null && (
        <p className="mb-0.5 text-[10px] uppercase tracking-wide text-ink-faint">{foreign.label}</p>
      )}
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
 * **一个 JSON 对象** → 键值两列（字段名译成中文，值里的英文枚举也译掉）。
 *
 * 这是用户截图里"英文占位符"的第二半：`note` 里除了决策数组，
 * 也可能写进来**单个对象**（`{"action":"open_short","symbol":"WLDUSDT",…}`）。
 * 那种形态既不是数组、也不该原样显示。
 *
 * ## 2026-10-18：**完整对象与被截断对象共用这一个渲染器**
 *
 * `parseLooseObjectDetailed` 对两种输入给出一致的 `ObjectRow[]`，所以中文化只有这一处：
 * ```
 *   字段名   → `fieldLabel`（`DECISION_FIELD_LABELS`）
 *   枚举值   → `valueLabel`（强/弱/只空或不交易…）+ `actionLabel`（开空/跳过…）
 *   数组值   → `items` → **每个元素一行**（`symbol` 加粗，后面跟 `structure`/`要点`）
 * ```
 */
function ObjectRows({ rows }: { rows: ObjectRow[] }): React.ReactElement {
  return (
    <table className="w-full table-fixed border-collapse text-xs">
      <tbody>
        {rows.map((row) => {
          const label = fieldLabel(row.key);
          /* 未登记的字段名 → 等宽弱色（让人看出这是标识符，不是人话）。 */
          const unmappedField = label === row.key;
          /*
           * 值本身是动作码/英文枚举 → 也译成中文（`open_short` → 开空，`strong` → 强）。
           * 未登记的动作码保留原词 + 等宽弱色（与 `DecisionLine` 同一口径）。
           */
          const isAction = looksLikeActionCode(row.text);
          const translated = valueLabel(isAction ? actionLabel(row.text) : row.text);
          const unmappedValue = isAction && translated === row.text;

          return (
            <tr key={row.key} className="border-b border-base-800 last:border-b-0">
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
                {row.items !== undefined && row.items.length > 0 ? (
                  <ul className="min-w-0 space-y-0.5">
                    {row.items.map((item, index) => (
                      <li key={`${item.symbol ?? ''}-${index}`} className="min-w-0 break-words">
                        {item.symbol !== null && (
                          <span className="num font-semibold text-ink-hi">{plainText(item.symbol)}</span>
                        )}
                        {item.symbol !== null && item.detail.length > 0 && (
                          <span className="text-ink-faint"> · </span>
                        )}
                        <span>{plainText(valueLabel(item.detail))}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  plainText(translated)
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * **"这个对象被截断了、表里只有完整的部分"** 的如实说明（2026-10-18）。
 *
 * 用户截图里那三类对象（①分析产出 ②裁决产出 ③调研产出）都是被后端截断的：
 * 展示层必须让人知道"这不是全部"，**不能把半张表伪装成完整结论**。
 *
 * ⚠️ 颜色仍用弱化色（`text-ink-faint`）而不是警示色 —— 截断是"数据不完整"这个
 * **事实**，不是故障；红色会把真正的失败稀释掉（与 `TruncationNotice` 同一口径）。
 */
function PartialObjectNotice({
  originalLength,
  incomplete,
}: {
  /** 留痕里记录的原始字符数；没有留痕 → `null`（**不知道就不编数字**）。 */
  originalLength: number | null;
  /** 对象本身没闭合（内容在末尾被切断）。 */
  incomplete: boolean;
}): React.ReactElement {
  return (
    <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
      {originalLength === null ? '原文本被截断' : `原文本已截断（完整 ${originalLength} 字）`}
      {incomplete ? '，只显示了完整的部分。' : '。'}
    </p>
  );
}

/**
 * **一条 message 的人话版** —— 所有 step / note 的统一入口。
 *
 * 判据顺序（每一步都要）：
 * ```
 *   ① 是"决策数组"的 JSON？   → 每个标的一行（`parseDecisionListDetailed`）
 *      · 带截断留痕 → 先剥尾巴，再逐个抠完整对象；**如实说明被截断了**
 *   ② 是"对象"的 JSON（完整**或被截断**）？ → 键值两列，字段名/枚举值都译成中文
 *      · 完整对象   → `parseLooseObjectDetailed` 的严格路径（与改动前逐字一致）
 *      · 被截断对象 → 同一函数的容错路径；**如实说明"只显示了完整的部分"**
 *   ③ 否则                   → 纯文本（**仍要过 `plainText`**）+ 超长折叠
 * ```
 * 解析失败（非 JSON、形状不对、一条键值对都提不出来）自然落进 ③ —— **一个字节都不丢**。
 *
 * ## ⚠️ 截断的决策数组（2026-10-18 · 用户实测）
 *
 * 被后端截断的数组**不是合法 JSON**，但前面若干个 `{…}` 是完整的。旧实现整条回落纯文本，
 * 用户屏幕上就是一坨原始 JSON。现在：抠出完整对象 → 按决策数组渲染 → **把留痕那句
 * "原文本已截断（完整 N 字）"照实显示出来**（见 `TruncationNotice`）。
 *
 * ## ⚠️ 截断的**对象**（2026-10-18 · 用户截图里的 ①②③）
 *
 * `{"symbols":[{"symbol":"AGTUSDT",…` / `{"side":"short_or_no_trade",…` /
 * `{"hypothesis":"当前市场整体处于普跌…` —— 这三类 `JSON.parse` 必然失败，
 * 旧实现整条回落纯文本，用户看到的就是原始 JSON。现在走容错提取，
 * **只渲染完整收下的键值对**，并在表下方说明「原文本被截断，只显示了完整的部分」。
 */
export function HumanMessage({
  text,
  level,
}: {
  text: string;
  /** 宽松入参：`roster.ts` 的 `level` 是 `string`，认不出的按 `info`（不染色）。 */
  level?: string | null;
}): React.ReactElement {
  const detail = parseDecisionListDetailed(text);
  const tone = normalizeLevel(level);

  if (detail !== null) {
    /*
     * `true` = 数组真的被截断在中间（只抠出前 N 个完整对象）。
     * 若数组本身完整、截断只发生在它后面的正文里（`arrayClosed`），
     * 条目就是全的 —— 这时的文案**不能**说"只显示了前 N 个"。
     */
    const incomplete = detail.recovered && !detail.arrayClosed;
    return (
      <div className="min-w-0">
        {/*
          先说"有几个标的"—— 用户要能一眼看出这一轮扫了多少个，而不是一行塞满。
          数字用 `num` 等宽，与全仓数字口径一致。

          ⚠️ 数组真的被截断在中间（`incomplete`）时**不能**说"这一轮对 N 个标的
          给了决策" —— N 只是"截断前还完整的那几个"，不是这一轮的全部。
          （若数组本身完整、截断只发生在它后面的正文里，N 就是全部，照常说。）
        */}
        <p className="mb-0.5 text-[11px] text-ink-faint">
          {incomplete ? (
            <>
              截断前能看到 <span className="num text-ink-lo">{detail.items.length}</span> 个完整的标的
            </>
          ) : (
            <>
              这一轮对 <span className="num text-ink-lo">{detail.items.length}</span> 个标的给了决策
            </>
          )}
        </p>
        {detail.truncated && detail.originalLength !== null && (
          <TruncationNotice
            originalLength={detail.originalLength}
            /* 数组被截断 → 说清"只显示了前 N 个"；数组完整 → 只说被截断过。 */
            shown={incomplete ? detail.items.length : null}
          />
        )}
        <ul className="min-w-0 space-y-1">
          {detail.items.map((item, index) => (
            <DecisionLine key={`${item.symbol}-${item.action}-${index}`} item={item} />
          ))}
        </ul>
      </div>
    );
  }

  /*
   * ② 对象 → 键值两列（字段名 + 值里的英文枚举都中文化）。
   *
   * `parseLooseObjectDetailed` 内部有两条路径：
   * ```
   *   · 完整对象   → 与改动前逐字相同的键值行
   *   · 被截断对象 → 只保留完整收下的键值对 / 子对象 / 子数组（① ② ③）
   * ```
   * 被截断时**必须如实说明**（见 `PartialObjectNotice`），不能把半张表伪装成完整结论。
   */
  const objectDetail = parseLooseObjectDetailed(text);
  if (objectDetail !== null) {
    return (
      <div className="min-w-0">
        <ObjectRows rows={objectDetail.rows} />
        {(objectDetail.incomplete || objectDetail.truncated) && (
          <PartialObjectNotice
            originalLength={objectDetail.originalLength}
            incomplete={objectDetail.incomplete}
          />
        )}
      </div>
    );
  }

  return <CollapsibleText text={text} level={tone} />;
}
