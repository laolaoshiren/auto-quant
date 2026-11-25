import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { summarizeClose } from '../../lib/closeSummary';
import { Button, ErrorNote, Modal } from '../ui';

/**
 * 确认并执行手工平仓（单个或全部）。
 *
 * `__all__` 是内部哨兵，只用于分支判断，绝不直接展示在界面文案中。
 * `failed` 必须原样透传给 `summarizeClose`，确保「全部平仓」部分失败时显著告警。
 */
export function ClosePositionModal({
  traderId,
  target,
  symbols,
  onClose,
  onDone,
}: {
  traderId: number;
  /** `null` = 关闭；`'__all__'` = 全部；其他 = 该币种。只在内部用，不显示。 */
  target: string | null;
  /** 当前持仓的币种列表 —— 用来把"全部"说成"全部 N 个持仓"。 */
  symbols: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    closed: string[];
    cancelledPending?: number;
    failed?: Array<{ symbol: string; error: string }>;
    stillRunning: boolean;
  } | null>(null);

  useEffect(() => {
    if (target !== null) {
      setError(null);
      setResult(null);
    }
  }, [target]);

  if (target === null) return null;

  const isAll = target === '__all__';
  const label = isAll ? `全部 ${symbols.length} 个持仓` : target;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isAll) {
        const response = await api.closeAllPositions(traderId);
        setResult({
          closed: response.closed,
          cancelledPending: response.cancelledPending,
          failed: response.failed,
          stillRunning: response.stillRunning,
        });
      } else {
        const response = await api.closePosition(traderId, target);
        setResult({ closed: [target], stillRunning: response.stillRunning });
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isAll ? '全部平仓' : '手工平仓'}
      width="max-w-md"
      footer={
        result ? (
          <Button onClick={onClose}>关闭</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button variant="danger" onClick={submit} disabled={busy}>
              {busy ? '正在平仓…' : '确认平仓'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3">
        {result ? (
          <>
            {(() => {
              const summary = summarizeClose(result);
              const toneClass =
                summary.tone === 'danger'
                  ? 'border-down/50 bg-down/10 text-down'
                  : summary.tone === 'success'
                    ? 'border-up/50 bg-up/10 text-up'
                    : 'border-base-700 bg-base-850/60 text-ink-mid';
              return (
                <>
                  <div
                    className={`rounded-md border px-3 py-2 text-base font-semibold ${toneClass}`}
                  >
                    {summary.headline}
                  </div>
                  {summary.failed.length > 0 && (
                    <ul className="space-y-1 rounded-md border border-down/40 bg-down/5 px-3 py-2">
                      {summary.failed.map((f) => (
                        <li key={f.symbol} className="text-xs leading-relaxed text-down">
                          <span className="font-semibold">{f.symbol}</span>
                          <span className="text-ink-mid">：{f.error}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              );
            })()}
            {result.stillRunning && (
              <p className="text-base leading-relaxed text-warn">
                机器人<strong>仍在运行</strong>，它可能在下一个决策周期重新开出仓位。
                如果不想让它再开，请先「停止」机器人。
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-base leading-relaxed text-ink-hi">
              以<strong>市价</strong>平掉 <span className="font-semibold">{label}</span>
              的全部仓位，并撤掉对应的止损与止盈单。
            </p>
            {isAll && symbols.length > 0 && (
              <p className="text-xs leading-relaxed text-ink-mid">
                将依次平掉：{symbols.join('、')}
              </p>
            )}
            <p className="text-xs leading-relaxed text-ink-faint">
              成交价以交易所实际回报为准，这里无法预知滑点。
            </p>
            {error && <ErrorNote>{error}</ErrorNote>}
          </>
        )}
      </div>
    </Modal>
  );
}
