/**
 * 策略工坊：预设起点 + 已保存策略。
 *
 * 这一页的两个决定：
 * 1. **预设卡片说清"它改了什么"**。预设只覆盖提示词与少量数值旋钮，直接给出
 *    杠杆/持仓/币种池的来源，比一句营销式的简介有用得多。
 * 2. **表格行整行可点**。编辑是最常用的动作（见 DESIGN.md §6），只让一个小按钮
 *    可点会让人反复瞄准；行内操作按钮 `stopPropagation` 以免误触发跳转。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Pencil, Plus, Search, X } from 'lucide-react';
import type { StrategyRecord } from '@aq/shared';
import { STRATEGY_PRESETS } from '@aq/shared';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { applyPreset, cloneConfig } from '../lib/strategy';
import { Badge, Button, Empty, ErrorNote, Modal, Panel, Spinner3, TextInput } from '../components/ui';
import { SectionHeading } from '../components/Badges';
import { StrategyCheckButton, StrategyCheckModal } from '../components/StrategyCheckModal';
import { fmtDateTime } from '../lib/format';

/** 首屏渲染多少行策略；再多就分批展开，避免一次挂出上百行。 */
const ROW_PAGE = 25;

/** 预设的"证据行"：把 patch 里的关键数值摊开，而不是复述简介。 */
function presetFacts(patch: (typeof STRATEGY_PRESETS)[number]['patch']): string[] {
  return [
    `最多 ${patch.riskControl?.maxPositions ?? 3} 个持仓`,
    `${patch.riskControl?.defaultLeverage ?? 3}× 默认杠杆`,
    `盈亏比 ≥ 1:${patch.riskControl?.minRiskRewardRatio ?? 3}`,
    `${patch.coinSource?.sourceType ?? 'static'} 币种池`,
  ];
}

export function StrategyListPage() {
  useDocumentTitle('策略工坊');
  const navigate = useNavigate();
  const catalog = useApp((s) => s.catalog);
  const traders = useApp((s) => s.traders);
  const query = usePolled((signal) => api.strategies(signal), { intervalMs: 30_000 });
  const [busy, setBusy] = useState<{ kind: 'create' | 'row'; id: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  const [checkTarget, setCheckTarget] = useState<{ id: number; name: string } | null>(null);
  const [filter, setFilter] = useState('');
  const [rowLimit, setRowLimit] = useState(ROW_PAGE);

  const strategies = query.data ?? [];

  /** 策略 → 引用它的机器人数量。删之前要知道会波及谁。 */
  const usageByStrategy = useMemo(() => {
    const counts = new Map<number, { total: number; running: number }>();
    for (const trader of traders) {
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
        const preset = STRATEGY_PRESETS.find((item) => item.id === presetId);
        const base = catalog?.defaultStrategy ?? null;
        const config = preset && base ? applyPreset(cloneConfig(base), preset) : base;
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

  const remove = async (record: StrategyRecord) => {
    const usage = usageByStrategy.get(record.id);
    const consequence = usage?.total
      ? `有 ${usage.total} 个机器人正在引用它${usage.running > 0 ? `（其中 ${usage.running} 个在运行）` : ''}，删除后这些机器人将无法启动。`
      : '当前没有机器人引用它。';
    if (!window.confirm(`删除策略“${record.name}”？\n\n${consequence}此操作不可撤销。`)) return;

    setBusy({ kind: 'row', id: record.id });
    setError(null);
    try {
      await api.deleteStrategy(record.id);
      query.reload();
    } catch (err) {
      setError((err as Error).message);
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
    <div className="space-y-3">
      <SectionHeading
        title="策略工坊"
        sub="策略是一整套交易法则：币种池、指标、硬性风控限制以及提示词本身。"
        right={
          <Button variant="primary" onClick={() => setPresetOpen(true)}>
            <Plus aria-hidden className="h-3.5 w-3.5" />
            新建策略
          </Button>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {/* 轮询失败必须显式说出来，否则空列表会被误读成"一个策略都没有" */}
      {query.error && <ErrorNote>读取策略列表失败：{query.error}（正在自动重试）</ErrorNote>}

      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-3">
        {STRATEGY_PRESETS.map((preset) => (
          <Panel
            key={preset.id}
            title={
              <span className="flex items-center gap-2">
                {preset.label}
                <Badge tone="accent">{preset.tradingMode}</Badge>
              </span>
            }
            bodyClassName="p-3"
            padded={false}
          >
            <p className="text-base leading-relaxed text-ink-lo">{preset.summary}</p>
            <ul className="mt-2 flex flex-wrap gap-1">
              {presetFacts(preset.patch).map((fact) => (
                <li key={fact} className="num rounded border border-base-700 bg-base-850 px-1.5 text-xs text-ink-mid">
                  {fact}
                </li>
              ))}
            </ul>
            <Button
              className="mt-2.5"
              block
              variant="ghost"
              busy={busy?.kind === 'create'}
              onClick={() => void createFrom(preset.id)}
            >
              从此预设开始
            </Button>
          </Panel>
        ))}
      </div>

      <Panel
        title="已保存策略"
        actions={
          <span className="flex items-center gap-2">
            <span className="num text-xs text-ink-faint">
              共 {strategies.length} 个
              {filter && ` · 匹配 ${filtered.length}`}
            </span>
          </span>
        }
        padded={false}
      >
        {query.loading && strategies.length === 0 ? (
          <Spinner3 label="正在加载策略" />
        ) : strategies.length === 0 ? (
          <Empty
            message="暂无已保存策略。"
            hint="从上方任一预设开始，或从一张空白配置开始 —— 一个策略就是一组可以被机器人复用的交易法则。"
            action={
              <Button variant="primary" onClick={() => setPresetOpen(true)}>
                <Plus aria-hidden className="h-3.5 w-3.5" />
                新建策略
              </Button>
            }
          />
        ) : (
          <>
            {strategies.length > 8 && (
              <div className="flex items-center gap-2 border-b border-base-800 px-3 py-2">
                <div className="relative min-w-[12rem] flex-1">
                  <Search
                    aria-hidden
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
                  />
                  <TextInput
                    className="pl-8"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="搜索名称、描述或交易模式…"
                    aria-label="搜索已保存策略"
                  />
                </div>
              </div>
            )}

            {filtered.length === 0 ? (
              <Empty message={`没有匹配「${filter}」的策略。`} action={<Button onClick={() => setFilter('')}>清空搜索</Button>} />
            ) : (
              <>
                <div className="scroll-x">
                  <table className="w-full border-collapse">
                    <thead className="border-b border-base-800 bg-base-850/60">
                      <tr>
                        <th className="th">名称</th>
                        <th className="th">模式</th>
                        <th className="th">币种池</th>
                        <th className="th text-right">最大持仓</th>
                        <th className="th text-right">杠杆</th>
                        <th className="th text-right">最小置信度</th>
                        <th className="th">被引用</th>
                        <th className="th">更新时间</th>
                        <th className="th text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((record) => {
                        const usage = usageByStrategy.get(record.id);
                        return (
                          <tr
                            key={record.id}
                            className="row-hover cursor-pointer"
                            onClick={() => navigate(`/strategy/${record.id}`)}
                            title="打开编辑器"
                          >
                            <td className="td">
                              {/* 名称是真正的链接：整行可点，但键盘与"新标签页打开"仍然可用 */}
                              <Link
                                to={`/strategy/${record.id}`}
                                onClick={(event) => event.stopPropagation()}
                                className="text-base font-semibold text-ink-hi hover:text-accent"
                              >
                                {record.name}
                              </Link>
                              {record.description && (
                                <div className="max-w-[340px] truncate text-xs text-ink-faint" title={record.description}>
                                  {record.description}
                                </div>
                              )}
                            </td>
                            <td className="td">
                              <Badge tone="accent">{record.config.tradingMode}</Badge>
                            </td>
                            <td className="td text-ink-lo">
                              {record.config.coinSource.sourceType}
                              <span className="num text-ink-faint">
                                {' '}
                                · {record.config.coinSource.staticCoins.length} 个静态
                              </span>
                            </td>
                            <td className="td num text-right">{record.config.riskControl.maxPositions}</td>
                            <td className="td num text-right">{record.config.riskControl.defaultLeverage}×</td>
                            <td className="td num text-right">{record.config.riskControl.minConfidence}</td>
                            <td className="td">
                              {usage?.total ? (
                                <Badge tone={usage.running > 0 ? 'up' : 'muted'}>
                                  {usage.total} 个机器人{usage.running > 0 ? ` · ${usage.running} 运行中` : ''}
                                </Badge>
                              ) : (
                                <span className="text-ink-faint">未使用</span>
                              )}
                            </td>
                            <td className="td num text-ink-faint">{fmtDateTime(record.updatedAt)}</td>
                            <td className="td text-right">
                              <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
                                <StrategyCheckButton small onClick={() => setCheckTarget({ id: record.id, name: record.name })} />
                                <Button
                                  small
                                  busy={busy?.kind === 'row' && busy.id === record.id}
                                  onClick={() => navigate(`/strategy/${record.id}`)}
                                  title="打开编辑器"
                                >
                                  <Pencil aria-hidden className="h-3.5 w-3.5" />
                                  编辑
                                </Button>
                                <Button small busy={busy?.kind === 'row' && busy.id === record.id} onClick={() => void duplicate(record)}>
                                  克隆
                                </Button>
                                <Button
                                  small
                                  variant="danger"
                                  busy={busy?.kind === 'row' && busy.id === record.id}
                                  aria-label={`删除策略 ${record.name}`}
                                  title="删除策略"
                                  onClick={() => void remove(record)}
                                >
                                  <X aria-hidden className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {remaining > 0 && (
                  <div className="flex items-center justify-between gap-2 border-t border-base-800 px-3 py-2">
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

      <Modal
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        title="新建策略"
        description="预设只填充提示词段落与少量数值旋钮 — 之后一切都可编辑。"
        footer={<Button onClick={() => setPresetOpen(false)}>取消</Button>}
      >
        <div className="space-y-1.5">
          {STRATEGY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                setPresetOpen(false);
                void createFrom(preset.id);
              }}
              className="w-full rounded-md border border-base-700 bg-base-850 px-3 py-2.5 text-left transition hover:border-accent/60 hover:bg-base-800"
            >
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-ink-hi">{preset.label}</span>
                <Badge tone="accent">{preset.tradingMode}</Badge>
              </div>
              <div className="mt-0.5 text-xs text-ink-lo">{preset.summary}</div>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setPresetOpen(false);
              void createFrom(null, '未命名策略');
            }}
            className="w-full rounded-md border border-base-700 bg-base-850 px-3 py-2.5 text-left transition hover:border-accent/60 hover:bg-base-800"
          >
            <div className="text-base font-semibold text-ink-hi">空白（服务端默认值）</div>
            <div className="mt-0.5 text-xs text-ink-lo">每个字段都取 Zod 默认值 — 一个中性的起点。</div>
          </button>
        </div>
      </Modal>

      <StrategyCheckModal open={checkTarget !== null} onClose={() => setCheckTarget(null)} target={checkTarget} />
    </div>
  );
}
