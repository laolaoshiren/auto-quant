import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { StrategyRecord } from '@aq/shared';
import { STRATEGY_PRESETS } from '@aq/shared';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { applyPreset, cloneConfig } from '../lib/strategy';
import { Badge, Button, Empty, ErrorNote, Modal, Panel, Spinner3 } from '../components/ui';
import { SectionHeading } from '../components/Badges';
import { StrategyCheckButton, StrategyCheckModal } from '../components/StrategyCheckModal';
import { fmtDateTime } from '../lib/format';

export function StrategyListPage() {
  useDocumentTitle('策略工坊');
  const navigate = useNavigate();
  const catalog = useApp((s) => s.catalog);
  const query = usePolled((signal) => api.strategies(signal), { intervalMs: 30_000 });
  const [busy, setBusy] = useState<number | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  const [checkTarget, setCheckTarget] = useState<{ id: number; name: string } | null>(null);

  const strategies = query.data ?? [];

  const createFrom = async (presetId: string | null, name?: string) => {
    setBusy('new');
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
  };

  const remove = async (record: StrategyRecord) => {
    if (!window.confirm(`删除“${record.name}”？此操作不可撤销。`)) return;
    setBusy(record.id);
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
    setBusy(record.id);
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
            + 新建策略
          </Button>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
        {STRATEGY_PRESETS.map((preset) => (
          <Panel key={preset.id} title={preset.label} bodyClassName="p-3" padded={false}>
            <p className="text-xs leading-relaxed text-ink-lo">{preset.summary}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <Badge tone="accent">{preset.tradingMode}</Badge>
              <Badge tone="muted">最多 {preset.patch.riskControl?.maxPositions ?? 3} 个持仓</Badge>
              <Badge tone="muted">{preset.patch.riskControl?.defaultLeverage ?? 3}× 默认</Badge>
              <Badge tone="muted">
                {preset.patch.coinSource?.sourceType ?? 'static'} 币种池
              </Badge>
            </div>
            <Button className="mt-2" block variant="ghost" busy={busy === 'new'} onClick={() => void createFrom(preset.id)}>
              从此预设开始
            </Button>
          </Panel>
        ))}
      </div>

      <Panel
        title="已保存策略"
        actions={<span className="num text-2xs text-ink-faint">共 {strategies.length} 个</span>}
        padded={false}
      >
        {query.loading && strategies.length === 0 ? (
          <Spinner3 label="正在加载策略" />
        ) : strategies.length === 0 ? (
          <Empty message="暂无已保存策略。" hint="从上方任一预设开始。" />
        ) : (
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
                  <th className="th">来源预设</th>
                  <th className="th">更新时间</th>
                  <th className="th text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {strategies.map((record) => (
                  <tr key={record.id} className="row-hover">
                    <td className="td">
                      <Link to={`/strategy/${record.id}`} className="text-xs font-semibold text-ink-hi hover:text-accent">
                        {record.name}
                      </Link>
                      {record.description && (
                        <div className="max-w-[380px] truncate text-2xs text-ink-faint">{record.description}</div>
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
                    <td className="td text-ink-lo">{record.presetId ?? '—'}</td>
                    <td className="td num text-ink-faint">{fmtDateTime(record.updatedAt)}</td>
                    <td className="td text-right">
                      <div className="flex items-center justify-end gap-1">
                        <StrategyCheckButton small onClick={() => setCheckTarget({ id: record.id, name: record.name })} />
                        <Button small onClick={() => navigate(`/strategy/${record.id}`)}>
                          编辑
                        </Button>
                        <Button small busy={busy === record.id} onClick={() => void duplicate(record)}>
                          克隆
                        </Button>
                        <Button small variant="danger" busy={busy === record.id} onClick={() => void remove(record)}>
                          ✕
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Modal
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        title="新建策略"
        footer={<Button onClick={() => setPresetOpen(false)}>取消</Button>}
      >
        <p className="mb-2 text-xs text-ink-lo">
          预设只填充提示词段落与少量数值旋钮 — 之后一切都可编辑。
        </p>
        <div className="space-y-1.5">
          {STRATEGY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                setPresetOpen(false);
                void createFrom(preset.id);
              }}
              className="w-full rounded border border-base-700 bg-base-850 px-3 py-2 text-left transition hover:border-accent/60"
            >
              <div className="text-xs font-semibold text-ink-hi">{preset.label}</div>
              <div className="text-2xs text-ink-faint">{preset.summary}</div>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setPresetOpen(false);
              void createFrom(null, '未命名策略');
            }}
            className="w-full rounded border border-base-700 bg-base-850 px-3 py-2 text-left transition hover:border-accent/60"
          >
            <div className="text-xs font-semibold text-ink-hi">空白（服务端默认值）</div>
            <div className="text-2xs text-ink-faint">每个字段都取 Zod 默认值 — 一个中性的起点。</div>
          </button>
        </div>
      </Modal>

      <StrategyCheckModal
        open={checkTarget !== null}
        onClose={() => setCheckTarget(null)}
        target={checkTarget}
      />
    </div>
  );
}
