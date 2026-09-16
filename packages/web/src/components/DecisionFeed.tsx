/**
 * 最近决策 — 决策流。
 *
 * 交易页的右栏（`LAYOUT.md` §2），也是操作者一直盯着的那个面板。
 *
 * ## 形态：照抄参考产品，`DECISION-FEED.md` 是契约
 *
 * 一轮周期 = **一行纯文字元数据 + 一个带边框的盒子 + 两个纯文字按钮**：
 *
 * ```
 * 3 分钟前 │ 周期 #5404 │ in 34,411 · out 4,980      ← 一行纯文字，无边框无底色无徽章
 * ┌──────────────────────────────────────────────┐
 * │ ⬤ ZECUSDT                              观望  │   ← 币种图标 + 符号 …… 右对齐动作
 * │   置信度: 78%                                │   ← 强调色小字
 * │   📄 AI500=776 达标，价格站上 15m EMA20…     │   ← 文档图标 + 理由，允许折行
 * │                                              │
 * │ Ⓑ BRUSDT                               等待  │
 * │   置信度: 30%                                │
 * │   📄 AI500 仅 66.3 未达 75 红线…             │
 * └──────────────────────────────────────────────┘
 * ✨ 思考过程 ✓   │   🔒 提示词                        ← 两个纯文字按钮
 * ```
 *
 * ## 这一版删掉的东西，以及为什么不能再加回来
 *
 * - **每条决策外面那层带边框的卡片**：一轮本来就只该有**一个**盒子。给每条决策再套
 *   一层，屏幕上就会出现三层边框（盒子 / 决策卡 / 数字表），一屏只能看下两三条。
 * - **决策卡内的 6 格数字表**（数量 / 开仓价 / 止损 / 止盈 / 风险回报 / 杠杆）：
 *   它是三轮溢出 bug 的根源。表格格子有最小宽度，右栏只有 40% 宽，格子一挤，
 *   文字就飘到相邻列里去（见 git 历史里那张 `率.47%` 的截图）。
 *   现在这些数字变成**理由下面的一行小字**——一行文本可以折行，**不可能溢出**。
 * - **周期头左侧的 3px 结果色条、`成功` 徽章、`N 个候选`**：参考里没有。
 *   结果信息改用一行小字表达（`⚠ 2 条被风控拒绝`），见 `CycleBlock`。
 *
 * ## 高度：填满所在的那一栏，而不是自己算一个视口高度
 *
 * 这里曾经有一个 `height` 参数，交易页传的是 `max(380px, calc(100vh - 18rem))`。
 * 那个写法在"左指标栏 + 主内容"的旧骨架里是唯一可行的做法 —— 决策流是主内容区里
 * 的**第一块**，它上面的页头有多高只有页面自己知道，于是只能靠手算一个 `18rem`
 * 去凑。骨架改成两栏之后这个数就没法对了：右栏的顶边等于内容区顶边，要减多少
 * 完全由外壳（顶栏高度 + 页面内边距）决定，页面再算一次必然算错。
 *
 * 现在分成两件事：
 *
 * - **`xl` 及以上**：`PageShell` 的右栏在 `h-full` 的高度链上拿到了"可视区 − 顶栏"
 *   这份确定高度，所以面板 `h-full`、表头 `shrink-0`、卡片区 `flex-1 min-h-0
 *   overflow-y-auto` —— 决策流自己撑满整栏，滚动条只有一条（在卡片区），
 *   「最近决策」这一行钉在顶上不跟着滚走。
 * - **`xl` 以下**：两栏塌成一列，右栏落到主内容下面，父级高度是 `auto`，
 *   `h-full` 会解析成 `auto`。这时 `max-h-[calc(100dvh-16rem)]` 兜底 ——
 *   没有它，50 个周期会把整页撑成一条长条，正是 §2 要避免的。
 *   `xl:max-h-none` 把上限交还给上面那条 flex 高度链。
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Check, FileText, Lock, RotateCw, Sparkles, TriangleAlert } from 'lucide-react';
import type { DecisionRecord, Decision, ExecutionLogEntry } from '@aq/shared';
import { api, type MarketSymbol } from '../lib/api';
import { useEvents } from '../lib/store';
import { usePolled } from '../lib/hooks';
import { Empty, Panel, Spinner3, cn } from './ui';
import { ActionBadge, actionLabel, isOpenAction } from './DecisionAudit';
import { fmtInt, fmtLatency, fmtPriceUsd, fmtUsd, timeAgo } from '../lib/format';

/**
 * How many cycles are rendered.
 *
 * The endpoint answers with 50 and the socket can append more; either way the
 * list is capped so a long-running bot cannot turn this panel into a thousand
 * DOM nodes. `全部记录` in the header is the way to see the rest.
 */
const FEED_LIMIT = 50;

/**
 * 币种图标的底色。
 *
 * 参考产品给每个币一个彩色圆点，而**这里不引入图标库**（`package.json` 里没有
 * 币种图标依赖，为几个圆点加一个依赖不划算）。用币种符号哈希出一个色相：
 * 同一个币**永远**是同一个颜色，刷新、跨周期、跨机器人都不变 ——
 * 颜色是给眼睛当锚点用的，随机变一次就废了。
 *
 * 固定 `42% 40%` 的饱和度与明度，只让**色相**变：深色界面上一排圆点如果明度
 * 也各不相同，最亮的那几个会抢走数字的注意力（`DESIGN.md` §1：装饰不能挤压数据）。
 */
function coinColor(symbol: string): string {
  let hash = 0;
  for (let index = 0; index < symbol.length; index += 1) {
    hash = (hash * 31 + symbol.charCodeAt(index)) % 100_000;
  }
  // 乘 47 再取模：让相邻的符号（`BTCUSDT` / `BTUSDT`）落到**相隔很远**的色相上，
  // 而不是相邻的、肉眼分不出来的两档。
  return `hsl(${(hash * 47) % 360} 42% 40%)`;
}

function coinInitial(symbol: string): string {
  return symbol.slice(0, 1).toUpperCase() || '?';
}

export function DecisionFeed({ traderId }: { traderId: number }) {
  const live = useEvents((s) => s.byTrader[traderId]?.decisions);
  const query = usePolled((signal) => api.traderDecisions(traderId, FEED_LIMIT, signal), {
    intervalMs: 20_000,
    deps: [traderId],
  });

  // 行情列表提供**当前价**，用来把"止损 74434.8"变成"离现价多远"，
  // 也是开仓那一行里 `开仓 <价>` 与风险回报比的来源。
  const symbolsQuery = usePolled((signal) => api.marketSymbols(signal), { intervalMs: 20_000 });

  // Live records win, but a REST page can be newer after a reload.
  const records = useMemo(() => {
    const merged = new Map<number, DecisionRecord>();
    for (const record of query.data ?? []) merged.set(record.id, record);
    for (const record of live ?? []) merged.set(record.id, record);
    return [...merged.values()].sort((a, b) => b.cycleNumber - a.cycleNumber);
  }, [query.data, live]);

  if (query.loading && records.length === 0) {
    return (
      // 加载态也占满整栏：否则数据一到位，这一栏会突然从一小条跳成整屏高。
      <Panel
        title="最近决策"
        padded={false}
        className="flex h-full min-h-0 flex-col"
        bodyClassName="flex min-h-0 flex-1 flex-col p-0"
      >
        <Spinner3 label="正在加载决策" />
      </Panel>
    );
  }

  const shown = records.slice(0, FEED_LIMIT);

  return (
    <Panel
      padded={false}
      /* 填满右栏：面板 `h-full` + 一个 `min-h-0` 的纵向 flex，卡片区才能拿到
         "剩下的高度"并自己滚动（见组件顶部注释）。 */
      className="flex h-full min-h-0 flex-col"
      bodyClassName="flex min-h-0 flex-1 flex-col p-0"
      title="最近决策"
      actions={
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => query.reload()}
            title="重新拉取决策记录"
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-ink-lo transition hover:text-ink-hi disabled:opacity-50"
            disabled={query.loading}
          >
            <RotateCw aria-hidden className={cn('h-3.5 w-3.5', query.loading && 'animate-spin')} />
            刷新
          </button>
          <Link to="/data" className="text-xs text-ink-lo transition hover:text-accent">
            全部记录
          </Link>
        </span>
      }
    >
      {records.length === 0 ? (
        <Empty
          message="暂无决策记录。"
          hint="每个周期都会连同完整提示词与原始响应一起持久化 — 运行一次后这里就会填满。"
        />
      ) : (
        // One scroll container. 每轮 = 元数据行 + 盒子 + 两个文字按钮。
        //
        // `flex-1 min-h-0`：高度来自右栏（`h-full` 的确定高度），不是 `max-height`。
        // `min-h-0` 不能省 —— flex 子项默认 `min-height: auto`，那一项会让滚动区
        // 永远不肯比内容矮，于是滚动条跑到整栏外面去。
        //
        // `max-h-[calc(100dvh-16rem)]` 只在 `xl` 以下生效：那时右栏塌到主内容下面，
        // 高度是内容高度，没有这个上限就会把整页撑长。
        //
        // `space-y-2.5` 而不是相邻的 `border-b`：40 个周期用一条接一条的分隔线排下来，
        // 会连成一整片、分不清哪里是上一个周期的结尾。
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-2.5 max-h-[calc(100dvh-16rem)] xl:max-h-none">
          {shown.map((record) => (
            <CycleBlock
              key={record.id}
              record={record}
              symbols={symbolsQuery.data ?? []}
            />
          ))}
          {records.length > shown.length && (
            <p className="pt-1 text-xs text-ink-faint">
              只显示最近 {shown.length} 个周期，共 {records.length} 个。完整历史在
              <Link to="/data" className="ml-1 text-accent hover:underline">
                决策记录
              </Link>
              。
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/*  One cycle module                                                           */
/* -------------------------------------------------------------------------- */

function priceOf(symbols: MarketSymbol[], symbol: string): number | null {
  const row = symbols.find((item) => item.symbol === symbol);
  return row ? row.price : null;
}

/**
 * 一轮周期：**一行纯文字元数据 + 一个盒子 + 两个纯文字按钮**。
 *
 * 盒子里按顺序排这一轮的每一条决策（扁平行，不再给每条决策套卡片），
 * 然后是执行失败的条目和被风控拒绝的小字说明 —— 后者是操作者判断
 * "风控到底有没有在跑"的唯一依据，必须留在原位、不能被折叠掉
 * （`DECISION-FEED.md` §7）。
 */
function CycleBlock({ record, symbols }: { record: DecisionRecord; symbols: MarketSymbol[] }) {
  const rejected = record.executionLog.filter((entry) => entry.status === 'rejected');
  const failed = record.executionLog.filter((entry) => entry.status === 'failed');

  return (
    <article className="min-w-0">
      <CycleMeta record={record} />

      {/*
        决策盒子：**一轮只有这一个**边框。每条决策只是里面的一段，没有自己的边框。

        ⚠️ 底色必须是 `bg-base-850` 而不是 `bg-base-900`。
        面板（Panel）本身就是 `bg-base-900` —— 盒子用同色等于**没有边界**，
        几十轮决策连成一片，分不清哪一条属于哪一轮（操作者原话：
        "肉眼看不出来每一期决策"）。

        `base-850` 比面板抬升一层，盒子就浮出来了；配合边框，
        一眼能看出"这一轮到这里结束"。
      */}
      <div className="min-w-0 rounded-lg border border-base-700 bg-base-850 px-3 py-2.5">
        {record.error && (
          <p className="mb-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-down">
            <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">周期错误：{record.error}</span>
          </p>
        )}

        {record.decisions.length === 0 && rejected.length === 0 && failed.length === 0 && (
          <p className="text-xs text-ink-faint">本周期模型没有给出任何决策。</p>
        )}

        {record.decisions.length > 0 && (
          // 决策之间只用**间距**分隔（§3），不加分隔线：一条细线在深色底上会
          // 变成第二层边框，而这个盒子里只该有一层。
          <div className="space-y-2.5">
            {record.decisions.map((decision, index) => (
              <DecisionRow
                key={`${decision.symbol}-${index}`}
                decision={decision}
                price={priceOf(symbols, decision.symbol)}
              />
            ))}
          </div>
        )}

        {/* 执行失败 / 被风控拒绝：用一行小字说出来，不做成徽章行、不折叠。 */}
        {failed.length + rejected.length > 0 && (
          <ul className="mt-2 space-y-1 border-t border-base-850 pt-2">
            {failed.map((entry, index) => (
              <LogLine key={`fail-${index}`} entry={entry} />
            ))}
            {rejected.map((entry, index) => (
              <LogLine key={`rej-${index}`} entry={entry} />
            ))}
          </ul>
        )}
      </div>

      <CycleDetails record={record} rejected={rejected.length} failed={failed.length} />
    </article>
  );
}

/**
 * 周期头：一行纯文字。
 *
 * 内容与顺序照参考：`相对时间 │ 周期 #N │ in N · out N`。
 * **没有**边框、底色、`成功` 徽章、`N 个候选`、`N 条决策` —— 那些都要读第二眼
 * 才明白在说什么，而这一行的作用是让操作者扫过去就知道"这是第几轮、多久以前"。
 *
 * 完整时间戳放在 `title` 里：相对时间适合扫读，但对账时需要精确时刻。
 */
function CycleMeta({ record }: { record: DecisionRecord }) {
  const tokens =
    record.promptTokens === null && record.completionTokens === null
      ? // 没有 token 计数时（老记录 / 端点未回传用量）说延迟，不写 `in 0 / out 0`：
        // 那会让人以为模型一个 token 都没花。
        fmtLatency(record.aiLatencyMs)
      : `in ${fmtInt(record.promptTokens ?? 0)} · out ${fmtInt(record.completionTokens ?? 0)}`;

  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-0.5 text-xs text-ink-lo">
      <span>{timeAgo(record.timestamp)}</span>
      <span aria-hidden className="text-ink-faint">
        │
      </span>
      <span className="num">周期 #{record.cycleNumber}</span>
      <span aria-hidden className="text-ink-faint">
        │
      </span>
      <span className="num">{tokens}</span>
    </div>
  );
}

/**
 * 一条决策 = 三行，左对齐在同一条缩进线上。
 *
 * 图标固定 `h-5 w-5`（20px），第二、三行用 `pl-5` 对齐到符号下方 —— 缩进宽度就是
 * 图标宽度，两处改动必须一起改，否则三行会错开。
 *
 * 行 1 用 `flex` 而不是 grid：符号与右侧动作徽章分别 `shrink-0`，中间没有需要
 * 分配的空间，`ml-auto` 就够了。徽章必须 `shrink-0` —— `chip` 自带 `whitespace`
 * 无关的 `font-mono`，一旦被压窄，`开多` 两个字会折成两行、把行高顶起来。
 */
function DecisionRow({ decision, price }: { decision: Decision; price: number | null }) {
  const figures = figureParts(decision, price);

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <CoinIcon symbol={decision.symbol} />
        <span className="min-w-0 truncate text-base font-semibold text-ink-hi">{decision.symbol}</span>
        <ActionBadge action={decision.action} className="ml-auto shrink-0" />
      </div>

      {/* 置信度：缩进对齐到符号下方，强调色小字。 */}
      <div className="mt-0.5 pl-5 text-xs text-accent">
        置信度: <span className="num">{decision.confidence}%</span>
      </div>

      {decision.reasoning && (
        <div className="mt-0.5 flex min-w-0 items-start gap-1.5 pl-5">
          {/* `shrink-0` + `mt-[3px]`：图标不能被文字挤扁，也要和第一行文字的视觉中线对齐。 */}
          <FileText aria-hidden className="mt-[3px] h-3.5 w-3.5 shrink-0 text-ink-lo" />
          <p className="min-w-0 break-words text-xs leading-relaxed text-ink-mid">{decision.reasoning}</p>
        </div>
      )}

      {/*
        实际开仓的关键数字：**一行小字**，不是表格。
        见 `figureParts` 的说明 —— 这是三轮溢出 bug 的修复方式。
      */}
      {figures.length > 0 && (
        <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 pl-5 text-xs leading-relaxed text-ink-lo">
          {figures.map((part, index) => (
            <span key={`${part.label}-${part.value}-${index}`} className="flex items-baseline gap-1">
              {index > 0 && (
                <span aria-hidden className="text-ink-faint">
                  ·
                </span>
              )}
              {part.label && <span className="text-ink-faint">{part.label}</span>}
              {/*
                折行由**外层** `flex-wrap` 负责（在片段之间断），这是正常路径 ——
                不要给这个数字加 `whitespace-nowrap`：`0.171900` 一旦被折成两行，
                看起来就是两个数。

                但也不能指望"片段足够窄"：所以保留 `break-all` 作为**最后一道防线**。
                决策流在 `xl` 以下是整页宽（≥600px），在 `xl` 以上是右栏的 40%
                （≥500px），而这一行最长的片段（`止损 0.174000`）约 90px，
                正常永远用不到它；万一真的窄到放不下，`break-all` 保证数字在
                **自己的盒子内**折行，而不是撑破容器跑出去
                （`DECISION-FEED.md` 里那三轮溢出 bug 就是这么来的）。
              */}
              <span className="num break-all" title={FIGURE_TITLE[part.key]}>
                {part.value}
              </span>
            </span>
          ))}
        </p>
      )}

      {/* 风控对这条决策做过的每一次干预。带数字，不是"参数已调整"这种空话。 */}
      {decision.adjustments.length > 0 && (
        <ul className="mt-1 space-y-0.5 pl-5">
          {decision.adjustments.map((note, index) => (
            <li key={index} className="break-words text-xs leading-relaxed text-warn/90">
              • {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type FigureKey = 'size' | 'entry' | 'stop' | 'target' | 'reward' | 'leverage';

/** 关键数字里的一个片段：`{ label: '止损', value: '0.174000' }`。 */
interface Figure {
  key: FigureKey;
  /** 短标签；数量、风险回报比、杠杆没有标签，靠悬停说明解释。 */
  label: string;
  value: string;
}

/**
 * 开仓关键数字里每一项的悬停说明。
 *
 * 这一行的标签很短（`$30.00 · 开仓 0.171900 · … · 1:8.62 · 5x`），
 * 悬停时给出**带单位的全称** —— `DESIGN.md` §7：单位要写出来，
 * 不能让人猜 `1:8.62` 和 `5x` 各是什么。
 */
const FIGURE_TITLE: Record<FigureKey, string> = {
  size: '名义价值（USDT）',
  entry: '当前价格，即开仓参考价',
  stop: '止损价',
  target: '止盈价',
  reward: '风险回报比 = 到止盈的距离 ÷ 到止损的距离',
  leverage: '杠杆倍数',
};

/**
 * 开仓的关键数字，拆成**若干可以整体折行的片段**。
 *
 * ## 为什么不是表格（这是这个文件里最重要的一条注释）
 *
 * 这里原来是 6 个格子的 grid（数量 / 开仓价 / 止损 / 止盈 / 风险回报 / 杠杆），
 * 还用了容器查询按卡片宽度切 2/3 列。它连续三轮出溢出 bug：grid 的列有最小内容
 * 宽度，而决策流在右栏里只有约 40% 宽、卡片还得再分两三列，于是一个
 * `0.176800` 加一个 `+26.67%` 就撑破格子，文字挤进相邻列（截图里那个飘出去的
 * `率.47%` 就是这么来的）。
 *
 * 现在返回**结构化片段**而不是一整条字符串：调用处把每一项的标签与数字分开渲染，
 * 由外层的 `flex-wrap` 在片段之间折行（正常路径），数字上再加 `break-all` 兜底。
 * 两条加起来的结果是：**横向不可能撑破容器**，这正是三轮 bug 的根因所在。
 *
 * 顺序照 `DECISION-FEED.md` §6 的示例：
 * `$30.00 · 开仓 0.171900 · 止损 0.174000 · 止盈 0.190000 · 1:8.62 · 5x`。
 * 最后一个 `5x` 是杠杆，`1:8.62` 是风险回报比 —— 两者都在悬停说明里写清楚。
 *
 * 只在实际开仓（`open_*`）时出现。观望 / 等待没有仓位可谈；平仓的数字属于成交
 * 记录，硬凑在理由下面只会让这一行变长而不增加信息。
 */
function figureParts(decision: Decision, price: number | null): Figure[] {
  if (!isOpenAction(decision.action)) return [];

  const parts: Figure[] = [{ key: 'size', label: '', value: fmtUsd(decision.positionSizeUsd, 2) }];
  if (price !== null) parts.push({ key: 'entry', label: '开仓', value: fmtPriceUsd(price) });
  if (decision.stopLoss !== null) parts.push({ key: 'stop', label: '止损', value: fmtPriceUsd(decision.stopLoss) });
  if (decision.takeProfit !== null)
    parts.push({ key: 'target', label: '止盈', value: fmtPriceUsd(decision.takeProfit) });
  if (price !== null && decision.stopLoss !== null && decision.takeProfit !== null) {
    // `Math.abs` 两侧：做空时价格在止损之上、止盈之下，直接相减会得到一个**负数**
    // 的风险回报比 —— 那是一个不存在的比例，看起来像算错了。
    const risk = Math.abs(price - decision.stopLoss);
    const reward = Math.abs(decision.takeProfit - price);
    if (risk > 0) parts.push({ key: 'reward', label: '', value: `1:${(reward / risk).toFixed(2)}` });
  }
  parts.push({ key: 'leverage', label: '', value: `${decision.leverage}x` });

  return parts;
}

/**
 * 币种图标：一个彩色圆点，里面是符号首字母。
 *
 * 不引图标库（见 `coinColor`）。`aria-hidden` + 文本缩进对齐：这一列纯粹是视觉锚点，
 * 屏幕阅读器读出来是噪音 —— 旁边的符号本身才是内容。
 */
function CoinIcon({ symbol }: { symbol: string }) {
  const style: CSSProperties = { backgroundColor: coinColor(symbol) };
  return (
    <span
      aria-hidden
      style={style}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none text-white/90"
    >
      {coinInitial(symbol)}
    </span>
  );
}

/**
 * 一条执行记录（失败 / 被风控拒绝），一行小字。
 *
 * 保留在盒子里、不折叠：`DECISION-FEED.md` §7 明确要求这些条目仍然可见 ——
 * 它们是操作者判断"风控到底有没有在跑"的证据。一条都不显示，界面会变成
 * "模型很保守"，而事实是"风控拦截了 3 次"。
 */
function LogLine({ entry }: { entry: ExecutionLogEntry }) {
  const mark = entry.status === 'rejected' ? '⚠ 被风控拒绝' : `✕ ${entry.status === 'skipped' ? '已跳过' : '执行失败'}`;
  const tone = entry.status === 'rejected' ? 'text-warn' : 'text-down';

  return (
    <li className="flex min-w-0 items-start gap-1.5 text-xs leading-relaxed">
      <span className={cn('shrink-0', tone)}>{mark}</span>
      <span className="min-w-0 break-words text-ink-lo">
        <span className="num text-ink-mid">
          {actionLabel(entry.action)} {entry.symbol}
        </span>
        {entry.detail ? ` — ${entry.detail}` : ''}
      </span>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  底部：两个纯文字按钮 + 展开内容                                             */
/* -------------------------------------------------------------------------- */

type DetailTab = 'cot' | 'prompt';

/**
 * 一轮的底部：`✨ 思考过程 │ 🔒 提示词` 两个**纯文字按钮**。
 *
 * 它们是文字 + 图标，不是带边框的按钮、也不是标签页控件（§4）。展开状态用
 * **勾选标记 + 强调色**表示 —— 参考里展开的那一项是绿的带 ✓。用颜色 + 符号双重
 * 表达而不是只用颜色：`DESIGN.md` §2 要求不能只靠颜色传递状态。
 *
 * 这两个按钮**只管推理内容**，上面的决策永远可见 —— 折叠了决策，面板就会在
 * 没人点的时候什么都不显示，而"它到底决定了什么"才是操作者一直要看的东西。
 */
function CycleDetails({
  record,
  rejected,
  failed,
}: {
  record: DecisionRecord;
  rejected: number;
  failed: number;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DetailTab>('cot');

  /**
   * 点一个按钮既切换内容也展开（§4）。
   *
   * 再点**同一个**按钮才收起 —— 两个按钮各管自己那一份内容，所以它们是"看什么"
   * 的切换，而不是一个全局的开/关。第一次点击必须能打开：只切不展，用户会以为
   * 按钮没反应。
   */
  const toggle = (next: DetailTab): void => {
    const collapse = open && tab === next;
    setTab(next);
    setOpen(!collapse);
  };

  const notes: string[] = [];
  if (failed > 0) notes.push(`${failed} 条执行失败`);
  if (rejected > 0) notes.push(`${rejected} 条被风控拒绝`);

  const tabClass = (active: boolean): string =>
    cn(
      'inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs transition',
      active ? 'font-semibold text-up' : 'text-ink-lo hover:text-ink-hi',
    );

  return (
    <div className="min-w-0">
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
        <button
          type="button"
          onClick={() => toggle('cot')}
          aria-expanded={open && tab === 'cot'}
          title={open && tab === 'cot' ? '收起思考过程' : '展开思考过程'}
          className={tabClass(open && tab === 'cot')}
        >
          <Sparkles aria-hidden className="h-3.5 w-3.5 shrink-0" />
          思考过程
          {open && tab === 'cot' && <Check aria-hidden className="h-3.5 w-3.5 shrink-0" />}
        </button>

        <span aria-hidden className="text-ink-faint">
          │
        </span>

        <button
          type="button"
          onClick={() => toggle('prompt')}
          aria-expanded={open && tab === 'prompt'}
          title={open && tab === 'prompt' ? '收起提示词' : '展开提示词'}
          className={tabClass(open && tab === 'prompt')}
        >
          <Lock aria-hidden className="h-3.5 w-3.5 shrink-0" />
          提示词
          {open && tab === 'prompt' && <Check aria-hidden className="h-3.5 w-3.5 shrink-0" />}
        </button>

        {/*
          被拒 / 失败在底部也要有一行小字（§2）：按钮这一行是操作者扫视时的落点，
          而"这一轮被风控拦了 2 条"是必须看见的信息 —— 光看上面的决策列表，
          被拒的条目没有任何视觉标记。
        */}
        {notes.length > 0 && (
          <span className="flex items-center gap-1 text-xs text-warn">
            <TriangleAlert aria-hidden className="h-3.5 w-3.5 shrink-0" />
            {notes.join(' · ')}
          </span>
        )}
      </div>

      {/* 展开的内容留在同一个盒子的语义范围内、按钮下方，并且**可滚动**（§5）。 */}
      {open && (
        <div className="mt-2 min-w-0">
          {tab === 'cot' ? (
            <ScrollArea
              body={record.cotTrace}
              empty="本周期模型未返回 <reasoning> 块。"
            />
          ) : (
            <div className="space-y-2">
              <PromptSection title="系统提示词" body={record.systemPrompt} />
              <PromptSection title="用户提示词" body={record.userPrompt} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PromptSection({ title, body }: { title: string; body: string }) {
  return (
    <section className="min-w-0">
      <h4 className="mb-1 text-xs font-semibold text-ink-lo">{title}</h4>
      <ScrollArea body={body} empty="（空）" />
    </section>
  );
}

/**
 * 可滚动的等宽文本块。
 *
 * `max-h` 而不是固定 `height`：短内容不该留一大片空白。
 * `break-words` + `whitespace-pre-wrap`：提示词里有超长 JSON 行，不折行就会
 * 把这一栏顶出横向滚动条。
 */
function ScrollArea({ body, empty }: { body: string; empty: string }) {
  if (!body.trim()) return <p className="px-1 py-2 text-xs text-ink-faint">{empty}</p>;
  return (
    <pre className="max-h-80 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-base-800 bg-base-950 px-2.5 py-2 font-mono text-xs leading-relaxed text-ink-mid">
      {body}
    </pre>
  );
}
