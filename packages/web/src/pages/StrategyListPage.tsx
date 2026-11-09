/**
 * 策略工坊：一张整宽的表，加一个"新建策略"入口。
 *
 * 这一页的三个决定：
 *
 * 1. **列表页就是一张表**（LAYOUT.md §1）。预设曾经以三张大卡片铺在表格上方，
 *    占掉近半屏高，而且它们的内容与「新建策略」对话框里的列表**完全重复** ——
 *    于是预设只剩下对话框里那一份，页面腾出来给表格。行整行可点（DESIGN.md §6），
 *    所以不再需要一个只做同样事情的「编辑」按钮。
 * 2. **表格只留挣得到宽度的列**（§2）。`最大持仓` 与 `杠杆` 合成一格「风控」，
 *    `最小置信度` 从列表里去掉（它是编辑器里的字段，不是筛选依据）。
 * 3. **机器码一律走 `@aq/shared` 的标签**。`tradingMode` 用 `TRADING_MODE_LABELS`，
 *    `coinSource.sourceType` 用 `coinSourceTypeLabel` —— 界面上不出现
 *    `conservative` / `mixed` 这种存储值。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Copy, MoreHorizontal, Pencil, Plus, Search, ShieldCheck, Trash2 } from 'lucide-react';
import type { StrategyRecord, TradingMode } from '@aq/shared';
import { STRATEGY_PRESETS, TRADING_MODE_LABELS, coinSourceTypeLabel, resolvePreset } from '@aq/shared';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { cloneConfig } from '../lib/strategy';
import { PAGE_LABEL } from '../lib/glossary';
import { Badge, Button, ErrorNote, Modal, Panel, Spinner3, TextInput, cn } from '../components/ui';
import { SectionHeading } from '../components/Badges';
import { PageShell, SectionLabel } from '../components/shell';
import { StrategyCheckModal } from '../components/StrategyCheckModal';
import { fmtDateTime } from '../lib/format';

/** 首屏渲染多少行策略；再多就分批展开，避免一次挂出上百行。 */
const ROW_PAGE = 25;

/**
 * 交易模式 → 徽章色调。
 *
 * 用户 2026-11-10：「标签加颜色」。三种模式原来全用 `accent`（一片同色蓝），
 * 在列表里等于没有区分。改成语义分色：稳健=绿、短线=蓝、进取=琥珀
 * （风险最高的一档用 warn 色 —— 它本来就是"更激进"的那个选择）。
 * 认不出的模式回落 `muted`，绝不猜测。
 */
function tradingModeTone(mode: string): 'up' | 'accent' | 'warn' | 'muted' {
  if (mode === 'conservative') return 'up';
  if (mode === 'scalping') return 'accent';
  if (mode === 'aggressive') return 'warn';
  return 'muted';
}

/**
 * 交易模式的机器码 → 中文。缺映射时退回原码，绝不显示空白。
 *
 * 入参是 `string` 而不是 `TradingMode`：策略是从数据库读出来的，
 * 可能带着这张表之后新增、或迁移前留下的值。**收窄的是表的键，
 * 不是调用方的入参** —— 前者由编译器保证不漏，后者必须容忍未知。
 */
function tradingModeLabel(mode: string): string {
  return TRADING_MODE_LABELS[mode as TradingMode] ?? mode;
}

export function StrategyListPage() {
  useDocumentTitle(PAGE_LABEL.strategy);
  const navigate = useNavigate();
  const catalog = useApp((s) => s.catalog);
  const traders = useApp((s) => s.traders);
  /*
   * ⚠️ **必须等会话就绪再拉取**（2026-10-27 实测）。
   *
   * 没有 `enabled` 守卫时，首屏会在 `bootstrap()` 拿到 token **之前**就发出
   * `/api/strategies` —— 那次请求必然 401，浏览器控制台留下一行红色错误：
   *
   *     Failed to load resource: 401 (Unauthorized) @ /api/strategies
   *
   * 页面本身随后会渲染正常（token 到了、30 秒轮询也会补上），所以**肉眼看不出问题** ——
   * 但它是 `npm run ui:check` 判红这一页的唯一原因，而且会让操作员以为
   * "登录/权限出了问题"。
   *
   * 同目录下其它页面（TraderPage / DecisionDetailPage / MarketPage …）都带
   * `enabled` 守卫，只有这一页漏了。这不是"加载策略"的特例，
   * 而是**所有需要认证的数据拉取都必须等会话就绪**。
   */
  const sessionStatus = useApp((s) => s.status);
  const query = usePolled((signal) => api.strategies(signal), {
    intervalMs: 30_000,
    enabled: sessionStatus === 'authenticated',
  });
  const [busy, setBusy] = useState<{ kind: 'create' | 'row'; id: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  const [checkTarget, setCheckTarget] = useState<{ id: number; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StrategyRecord | null>(null);
  const [filter, setFilter] = useState('');
  const [rowLimit, setRowLimit] = useState(ROW_PAGE);

  /*
   * ⚠️ **不能写 `query.data ?? []`** —— 那个字面量每轮渲染都会新建一个数组，
   * 于是所有以 `strategies` 为依赖的 `useMemo` / `useCallback` **每轮都重算**，
   * 而它们看起来是在做缓存。`exhaustive-deps` 的报警措辞像风格建议，
   * 说的却是这件事。包一层 `useMemo` 让引用稳定。
   */
  const strategies = useMemo(() => query.data ?? [], [query.data]);

  /**
   * 策略 → **真的在用这份参数**的机器人数量。删之前要知道会波及谁。
   *
   * ## ⚠️ AI 托管的机器人**不算引用**
   *
   * 它们的 `strategy_id` 也指向一个策略，但那是**外键占位** ——
   * `db/schema.ts` 的 `M7_TRADER_MODE` 写得很清楚：`strategy_id` 保留 NOT NULL
   * （策略模式下用得上，**AI 模式下被忽略**），不动外键只是为了不牵动既有数据的
   * 完整性约束。AI 托管的参数整份存在 `traders.agent_config_json` 里，
   * `readAgentConfig()` 只要能解析就完全用它，**基线不参与**。
   *
   * 把它算进「N 个机器人引用」，等于告诉操作员"这台机器人在跑稳健策略" ——
   * 而事实完全相反。实测（用户的原话）：「我这个机器人运行的是智能托管模式
   * （有且只有一个机器人），为什么默认策略 — 稳健提示：1 个机器人 · 1 运行中？」
   *
   * 所以分开计数：`total` / `running` 只数固定策略模式的，
   * `aiBaseline` 单独记一笔 —— 它**不影响参数**，但**仍然会让删除撞上外键**
   * （`ON DELETE RESTRICT`），所以不能直接把它藏掉。
   */
  const usageByStrategy = useMemo(() => {
    const counts = new Map<number, { total: number; running: number }>();
    for (const trader of traders) {
      /*
       * ⚠️ **AI 托管的机器人不引用任何策略**（`strategyId === null`）。
       *
       * 这里原来还有一档 `aiBaseline` —— 那是"AI 托管拿某个策略当基线"时期的
       * 说法。现在它在设计上已经不存在了：AI 托管的参数整份在它自己的
       * `agent_config_json` 里，建号时就写入了（数据库迁移 M12 + 创建端点），
       * 与策略（乃至"没有任何策略"）再无关系。
       */
      if (trader.strategyId === null) continue;
      const entry = counts.get(trader.strategyId) ?? { total: 0, running: 0 };
      entry.total += 1;
      if (trader.isRunning) entry.running += 1;
      counts.set(trader.strategyId, entry);
    }
    return counts;
  }, [traders]);

  const filtered = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return strategies;
    return strategies.filter((record) =>
      [record.name, record.description, record.config.tradingMode, record.presetId ?? ''].some((field) =>
        field.toLowerCase().includes(term),
      ),
    );
  }, [strategies, filter]);

  const shown = filtered.slice(0, rowLimit);
  const remaining = filtered.length - shown.length;

  // 换了搜索词就把分页收回首屏，否则"已显示 50/3"这种数字会让人莫名其妙。
  useEffect(() => setRowLimit(ROW_PAGE), [filter]);

  const createFrom = useCallback(
    async (presetId: string | null, name?: string) => {
      setBusy({ kind: 'create', id: 0 });
      setError(null);
      try {
        /*
         * ⚠️ **这是"套预设"的第二条入口，必须与编辑器给出同一份配置。**
         *
         * 这里原来走 `applyPreset(cloneConfig(base), preset)` —— 那条路以**当前默认
         * 策略**为底再叠 patch，而编辑器的那条以 schema 默认值为底。同一份"稳健"
         * 从两个入口点进去会得到两份不同参数（未在 `patch` 里声明的字段一个继承
         * 默认策略、一个继承 schema 默认），而它们在列表里长得一模一样。
         *
         * 现在两条入口都调共享包的 `resolvePreset()`：**声明即生效、其余回到
         * schema 默认值**。`catalog.defaultStrategy` 因此不再参与（它只是"新策略"
         * 从空白开始时的底稿，不是套模板的底稿）。
         */
        const preset = STRATEGY_PRESETS.find((item) => item.id === presetId);
        const config = preset ? resolvePreset(preset) : (catalog?.defaultStrategy ?? null);
        if (!config) throw new Error('默认策略尚未加载完成 — 请稍后重试。');

        const record = await api.createStrategy({
          name: name ?? preset?.label ?? '新策略',
          description: preset?.summary ?? '',
          presetId: preset?.id ?? null,
          config: { ...config, name: name ?? preset?.label ?? '新策略', description: preset?.summary ?? '' },
        });
        navigate(`/strategy/${record.id}`);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [catalog, navigate],
  );

  /**
   * 删除之前要说清的后果 —— 「有几个机器人真的在用这份参数」。
   *
   * ## ⚠️ AI 托管的机器人**不算引用**
   *
   * 它们的 `strategy_id` 也指向一个策略，但那是**外键占位** ——
   * `db/schema.ts` 的 `M7_TRADER_MODE` 写得很清楚：`strategy_id` 保留 NOT NULL
   * （策略模式下用得上，**AI 模式下被忽略**），不动外键只是为了不牵动既有数据的
   * 完整性约束。AI 托管的参数整份存在 `traders.agent_config_json` 里，
   * `readAgentConfig()` 只要能解析就完全用它，**基线不参与**。
   *
   * 把它算进「N 个机器人引用」，等于告诉操作员"这台机器人在跑稳健策略" ——
   * 而事实完全相反。实测（用户的原话）：「我这个机器人运行的是智能托管模式
   * （有且只有一个机器人），为什么默认策略 — 稳健提示：1 个机器人 · 1 运行中？」
   *
   * 所以分开计数：`total` / `running` 只数固定策略模式的，
   * `aiBaseline` 单独记一笔 —— 它**不影响参数**，但**仍然会让删除撞上外键**
   * （`ON DELETE RESTRICT`），所以不能直接把它藏掉。
   */
  const deleteConsequence = (record: StrategyRecord): string => {
    const usage = usageByStrategy.get(record.id);
    return usage && usage.total > 0
      ? `有 ${usage.total} 个机器人正在引用它${usage.running > 0 ? `（其中 ${usage.running} 个在运行）` : ''}，删除后这些机器人将无法启动。`
      : '当前没有机器人引用它。';
  };

  /**
   * 真正的删除。
   *
   * ⚠️ **确认交给 `Modal`，不再用 `window.confirm`**：原生弹窗不能把"引用数"
   * 渲染成有层次的内容，观感也与全站其它删除确认（机器人列表）不一致 ——
   * 用户说的"拼凑感"里就包含这一类。
   */
  const remove = async (record: StrategyRecord) => {
    setBusy({ kind: 'row', id: record.id });
    setError(null);
    try {
      await api.deleteStrategy(record.id);
      query.reload();
      setDeleteTarget(null);
    } catch (err) {
      setError((err as Error).message);
      setDeleteTarget(null);
    } finally {
      setBusy(null);
    }
  };

  const duplicate = async (record: StrategyRecord) => {
    setBusy({ kind: 'row', id: record.id });
    setError(null);
    try {
      const created = await api.createStrategy({
        name: `${record.name}（副本）`,
        description: record.description,
        presetId: record.presetId,
        config: { ...cloneConfig(record.config), name: `${record.name}（副本）` },
      });
      navigate(`/strategy/${created.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <PageShell>
      <SectionHeading
        title={PAGE_LABEL.strategy}
        sub="策略是一整套交易法则：币种池、指标、硬性风控限制以及提示词本身。整行可点即可编辑。"
        right={
          /* 动作紧跟标题（用户 2026-11-10：不要孤零零挂在页面最右端）。 */
          <Button variant="primary" onClick={() => setPresetOpen(true)}>
            <Plus aria-hidden className="h-3.5 w-3.5" />
            新建策略
          </Button>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {/* 轮询失败必须显式说出来，否则空列表会被误读成"一个策略都没有" */}
      {query.error && <ErrorNote>读取策略列表失败：{query.error}（正在自动重试）</ErrorNote>}

      <section>
        <SectionLabel
          title="已保存策略"
          count={filter ? `${filtered.length} / ${strategies.length}` : `${strategies.length}`}
        />

        <Panel padded={false}>
          {query.loading && strategies.length === 0 ? (
            <Spinner3 label="正在加载策略" />
          ) : strategies.length === 0 ? (
            /* 空状态：一行说明 + 主操作，不画大盒子（ui-spec §1）。 */
            <div className="px-3 py-3">
              <p className="text-base text-ink-lo">
                暂无已保存策略。一个策略就是一组可以被机器人复用的交易法则 —— 从预设或空白配置开始。
              </p>
              <Button variant="primary" className="mt-2" onClick={() => setPresetOpen(true)}>
                <Plus aria-hidden className="h-3.5 w-3.5" />
                新建策略
              </Button>
            </div>
          ) : (
            <>
              {strategies.length > 8 && (
                <div className="flex items-center gap-2 border-b border-base-800 px-2 py-2">
                  <div className="relative min-w-[12rem] flex-1">
                    <Search
                      aria-hidden
                      className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
                    />
                    <TextInput
                      className="!pl-8"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      placeholder="搜索名称、描述或交易模式…"
                      aria-label="搜索已保存策略"
                    />
                  </div>
                </div>
              )}

              {filtered.length === 0 ? (
                <div className="flex flex-wrap items-center gap-2 px-3 py-3">
                  <p className="text-base text-ink-lo">没有匹配「{filter}」的策略。</p>
                  <Button small onClick={() => setFilter('')}>
                    清空搜索
                  </Button>
                </div>
              ) : (
                <>
                  <div>
                    <table className="w-full table-fixed border-collapse">
                      <thead className="border-b border-base-800 bg-base-850/60">
                        <tr>
                          <th className="th w-[25%] px-2 py-2">名称</th>
                          <th className="th w-[11%] px-2 py-2">模式</th>
                          <th className="th hidden w-[15%] px-2 py-2 lg:table-cell">币种池</th>
                          <th className="th w-[14%] px-2 py-2 text-right">风控</th>
                          <th className="th hidden w-[12%] px-2 py-2 xl:table-cell">被引用</th>
                          <th className="th hidden w-[12%] px-2 py-2 lg:table-cell">更新时间</th>
                          <th className="th w-[11%] px-2 py-2 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((record) => {
                          const usage = usageByStrategy.get(record.id);
                          const risk = record.config.riskControl;
                          const source = record.config.coinSource;
                          const staticCount = source.staticCoins.length;
                          return (
                            <tr
                              key={record.id}
                              className="row-hover cursor-pointer"
                              onClick={() => navigate(`/strategy/${record.id}`)}
                              title="打开编辑器"
                            >
                              <td className="td px-2 py-2">
                                {/* 名称是真正的链接：整行可点，但键盘与"新标签页打开"仍然可用 */}
                                <Link
                                  to={`/strategy/${record.id}`}
                                  onClick={(event) => event.stopPropagation()}
                                  className="block truncate text-base font-semibold text-ink-hi hover:text-accent"
                                >
                                  {record.name}
                                </Link>
                                {record.description && (
                                  <div className="max-w-[320px] truncate text-xs text-ink-faint" title={record.description}>
                                    {record.description}
                                  </div>
                                )}
                              </td>
                              <td className="td px-2 py-2">
                                {/* 模式按语义分色（稳健=绿 / 短线=蓝 / 进取=琥珀）—— 原来三档全是同一种蓝 */}
                                <Badge tone={tradingModeTone(record.config.tradingMode)}>
                                  {tradingModeLabel(record.config.tradingMode)}
                                </Badge>
                              </td>
                              <td className="td hidden px-2 py-2 text-ink-lo lg:table-cell">
                                {coinSourceTypeLabel(source.sourceType)}
                                {staticCount > 0 && (
                                  <span className="num text-ink-faint"> · {staticCount} 个标的</span>
                                )}
                              </td>
                              {/* 两格并一格：持仓上限与杠杆是同一个决定的两半 */}
                              <td
                                className="td num px-2 py-2 text-right"
                                title={`最大同时持仓 ${risk.maxPositions} 个 · 默认杠杆 ${risk.defaultLeverage}× · 最小置信度 ${risk.minConfidence}`}
                              >
                                {risk.maxPositions} 持仓 · {risk.defaultLeverage}×
                              </td>
                              <td className="td hidden px-2 py-2 xl:table-cell">
                                {/*
                                  ⚠️ **只有"真的在用这份参数"的机器人会被数进来。**
                                  AI 托管的机器人 `strategyId === null`，压根不在这张表里
                                  （见 `usageByStrategy`）—— 所以这里回到了最简形式，
                                  不再有"AI 托管基线 ×N"那一档。那一档是"AI 托管仍然
                                  需要一个策略占位"时期的说法，而那条依赖已经拆掉了。

                                  ⚠️ 文案要短：这一列只有 12% 宽，原来那句
                                  「1 个机器人 · 1 运行中」会把 1024/1440 下的
                                  「更新时间」挤掉（实测文字叠在一起）。
                                */}
                                {usage && usage.total > 0 ? (
                                  <Badge
                                    tone={usage.running > 0 ? 'up' : 'muted'}
                                    title={`${usage.total} 个机器人引用它${usage.running > 0 ? `，其中 ${usage.running} 个在运行` : ''}`}
                                  >
                                    {usage.total} 个{usage.running > 0 ? ` · ${usage.running} 运行` : ''}
                                  </Badge>
                                ) : (
                                  <span className="text-ink-faint">未使用</span>
                                )}
                              </td>
                              <td className="td num hidden px-2 py-2 text-xs text-ink-faint lg:table-cell">
                                {fmtDateTime(record.updatedAt)}
                              </td>
                              <td className="td px-2 py-2 text-right">
                                <div
                                  className="flex items-center justify-end gap-1"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  {/*
                                    §4「操作列只放主操作（行内）」：行内只留**体检**
                                    （它是唯一一个不进编辑器就能做的动作），
                                    低频的克隆 / 删除收进溢出菜单 —— 原来三个按钮
                                    并排，在 1024/768 下会盖住「风控」列（实测重叠）。

                                    ⚠️ **体检用 ghost，不用 `StrategyCheckButton` 的
                                    primary 实心**：那一版每行一颗饱和主色按钮 →
                                    整页 4 颗"主操作"，与 ui-spec §1「每页最多 1 个
                                    主操作」冲突。行为完全一样（同一个 Modal）。
                                  */}
                                  <span className="hidden xl:inline-flex">
                                    <Button
                                      small
                                      title="用真实模型跑一遍完整决策链路，验证策略是否能正常工作（不会下单）"
                                      onClick={() => setCheckTarget({ id: record.id, name: record.name })}
                                    >
                                      <ShieldCheck aria-hidden className="h-3.5 w-3.5" />
                                      策略体检
                                    </Button>
                                  </span>
                                  <StrategyRowMenu
                                    busy={busy?.kind === 'row' && busy.id === record.id}
                                    onCheck={() => setCheckTarget({ id: record.id, name: record.name })}
                                    onDuplicate={() => void duplicate(record)}
                                    onDelete={() => setDeleteTarget(record)}
                                  />
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {remaining > 0 && (
                    <div className="flex items-center justify-between gap-2 border-t border-base-800 px-2 py-2">
                      <span className="num text-xs text-ink-faint">
                        已显示 {shown.length} / {filtered.length} 个
                      </span>
                      <Button small onClick={() => setRowLimit((current) => current + ROW_PAGE)}>
                        显示更多（+{Math.min(ROW_PAGE, remaining)}）
                      </Button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </Panel>

        <p className="mt-2 flex items-center gap-2 text-xs text-ink-faint">
          <Pencil aria-hidden className="h-3.5 w-3.5 shrink-0" />
          点击任意一行即可编辑；「策略体检」用真实模型跑一遍完整决策链路，不会下单。
        </p>
      </section>

      <Modal
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        title="新建策略"
        description="预设只填充提示词段落与少量数值旋钮 — 之后一切都可编辑。"
        footer={<Button onClick={() => setPresetOpen(false)}>取消</Button>}
      >
        <div className="space-y-2">
          {STRATEGY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                setPresetOpen(false);
                void createFrom(preset.id);
              }}
              className="w-full rounded-lg border border-base-700 bg-base-850 px-3 py-2 text-left transition hover:border-accent/60 hover:bg-base-800"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-ink-hi">{preset.label}</span>
                <Badge tone={tradingModeTone(preset.tradingMode)}>{tradingModeLabel(preset.tradingMode)}</Badge>
                {/* 数值旋钮直接摊开：比复述简介有用，也是"这个预设改了什么"的答案 */}
                <span className="num ml-auto text-xs text-ink-faint">
                  最多 {preset.patch.riskControl?.maxPositions ?? 3} 持仓 ·{' '}
                  {preset.patch.riskControl?.defaultLeverage ?? 3}× 杠杆
                </span>
              </div>
              <div className="mt-1 text-xs text-ink-lo">{preset.summary}</div>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setPresetOpen(false);
              void createFrom(null, '未命名策略');
            }}
            className="w-full rounded-lg border border-base-700 bg-base-850 px-3 py-2 text-left transition hover:border-accent/60 hover:bg-base-800"
          >
            <div className="text-base font-semibold text-ink-hi">空白（服务端默认值）</div>
            <div className="mt-1 text-xs text-ink-lo">每个字段都取 Zod 默认值 — 一个中性的起点。</div>
          </button>
        </div>
      </Modal>

      {/*
        删除确认 —— 与机器人列表同一个 `Modal`（不再用 `window.confirm`：
        原生弹窗不能把「有几个机器人引用它」渲染成可读的结构，观感也与全站
        其它危险操作不一致）。
      */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => (busy === null ? setDeleteTarget(null) : undefined)}
        title={`删除“${deleteTarget?.name ?? ''}”`}
        width="max-w-lg"
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)} disabled={busy !== null}>
              取消
            </Button>
            <Button
              variant="danger"
              busy={busy !== null}
              autoFocus
              onClick={() => deleteTarget && void remove(deleteTarget)}
            >
              确认删除
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <div className="rounded-md border border-down/50 bg-down/10 px-3 py-2 text-base font-semibold text-down">
            该操作不可撤销。
          </div>
          <p className="text-base leading-relaxed text-ink-mid">
            {deleteTarget ? deleteConsequence(deleteTarget) : ''}
          </p>
          <p className="text-base leading-relaxed text-ink-mid">
            只删除这份参数，不会影响已产生的成交、委托与决策记录。
          </p>
        </div>
      </Modal>

      <StrategyCheckModal open={checkTarget !== null} onClose={() => setCheckTarget(null)} target={checkTarget} />
    </PageShell>
  );
}

/* -------------------------------------------------------------------------- */
/*  行的溢出菜单                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 每行一个"更多操作"（打开 / 克隆 / 删除）。
 *
 * 这三个都是低频动作，而原来它们和「策略体检」平铺在操作列里 —— 三个按钮
 * 约 200px，而这一列只有 8%，实测在 1024/768 下会**盖住「风控」列**（文字叠字）。
 * 现在行内只留体检这一个主操作，其余收进菜单（与机器人列表同一套交互）。
 *
 * 用 Radix Popover 而不是手写绝对定位：Esc 关闭、点外部关闭、焦点管理都已正确。
 */
function StrategyRowMenu({
  onCheck,
  onDuplicate,
  onDelete,
  busy,
}: {
  onCheck: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);

  /** 每个动作做完就收起菜单，否则它会盖住下一行的反馈。 */
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <Button size="icon" variant="ghost" title="更多操作" aria-label="更多操作" disabled={busy}>
          <MoreHorizontal aria-hidden className="h-3.5 w-3.5" />
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={4}
          role="menu"
          aria-label="策略操作"
          className="z-50 w-40"
        >
          <RowMenuItem icon={<ShieldCheck aria-hidden className="h-3.5 w-3.5" />} label="策略体检" onClick={run(onCheck)} />
          <RowMenuItem icon={<Copy aria-hidden className="h-3.5 w-3.5" />} label="克隆" onClick={run(onDuplicate)} />
          <RowMenuItem
            icon={<Trash2 aria-hidden className="h-3.5 w-3.5" />}
            label="删除策略"
            danger
            title="删除策略 — 需要确认"
            onClick={run(onDelete)}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function RowMenuItem({
  icon,
  label,
  onClick,
  title,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  title?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      title={title}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-2 text-left text-base transition',
        danger ? 'text-down hover:bg-down/10' : 'text-ink-mid hover:bg-base-850 hover:text-ink-hi',
      )}
    >
      {icon}
      {label}
    </button>
  );
}