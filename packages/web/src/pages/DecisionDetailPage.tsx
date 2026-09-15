import { Link, useParams } from 'react-router-dom';
import type { DecisionRecord } from '@aq/shared';
import { api } from '../lib/api';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { Badge, ErrorNote, Panel, Spinner3, Stat } from '../components/ui';
import { ActionBadge, ExecutionList, PromptBlocks, RejectedBanner } from '../components/DecisionAudit';
import { fmtDateTime, fmtInt, fmtLatency, fmtPrice, fmtUsd } from '../lib/format';

export function DecisionDetailPage() {
  const params = useParams();
  const traderId = Number(params.id);
  const recordId = Number(params.recordId);

  const query = usePolled((signal) => api.traderDecision(traderId, recordId, signal), {
    enabled: Number.isFinite(traderId) && Number.isFinite(recordId),
    deps: [traderId, recordId],
  });

  useDocumentTitle(`决策 #${params.recordId}`);

  if (query.loading && !query.data) return <Spinner3 label="正在加载决策记录" />;
  if (query.error) return <ErrorNote>{query.error}</ErrorNote>;
  if (!query.data) return <ErrorNote>未找到决策记录。</ErrorNote>;

  return <DecisionAuditView record={query.data} traderId={traderId} />;
}

export function DecisionAuditView({ record, traderId }: { record: DecisionRecord; traderId: number }) {
  const rejected = record.executionLog.filter((entry) => entry.status === 'rejected');
  const failed = record.executionLog.filter((entry) => entry.status === 'failed');
  const executed = record.executionLog.filter((entry) => entry.status === 'ok');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link to={`/traders/${traderId}`} className="text-xs text-ink-lo transition hover:text-accent">
          ← 机器人面板
        </Link>
        <h1 className="text-base font-semibold tracking-wide text-ink-hi">周期 #{record.cycleNumber}</h1>
        <Badge tone={record.success ? 'up' : 'down'}>{record.success ? '周期成功' : '周期失败'}</Badge>
        <span className="num text-2xs text-ink-faint">{fmtDateTime(record.timestamp)}</span>
        <span className="num ml-auto text-2xs text-ink-faint">记录 #{record.id} · 机器人 #{traderId}</span>
      </div>

      {/* Rejected proposals are the clearest signal that the bot looked and
          declined — surface them above the fold rather than burying them. */}
      <RejectedBanner log={record.executionLog} />

      {failed.length > 0 && (
        <div className="rounded border border-down/60 bg-down/10 px-3 py-2">
          <div className="text-xs font-bold uppercase tracking-wide text-down">
            {failed.length} 个操作在交易所失败
          </div>
          <ul className="mt-1 space-y-1">
            {failed.map((entry, index) => (
              <li key={index} className="text-2xs leading-relaxed text-down/90">
                <span className="num font-semibold">
                  {entry.action} {entry.symbol}
                </span>{' '}
                — {entry.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="模型延迟" value={fmtLatency(record.aiLatencyMs)} />
        <Stat label="决策数" value={fmtInt(record.decisions.length)} sub={`${record.executionLog.length} 条执行记录`} />
        <Stat label="提示词 Token" value={fmtInt(record.promptTokens ?? 0)} />
        <Stat label="补全 Token" value={fmtInt(record.completionTokens ?? 0)} />
        <Stat label="候选交易对" value={fmtInt(record.candidateSymbols.length)} sub="提供给模型的交易对" />
        <Stat
          label="已执行 / 已拒绝"
          value={
            <>
              <span className="text-up">{executed.length}</span>
              <span className="text-ink-faint"> / </span>
              <span className={rejected.length > 0 ? 'text-warn' : 'text-ink-mid'}>{rejected.length}</span>
            </>
          }
          sub="风控结果"
        />
      </div>

      {record.error && (
        <div className="rounded border border-down/60 bg-down/10 px-3 py-2 text-xs text-down">
          <span className="font-semibold">周期错误：</span> <span className="num">{record.error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {/* Chain of thought ------------------------------------------------ */}
        <Panel
          title="思维链"
          actions={<span className="num text-2xs text-ink-faint">{fmtInt(record.cotTrace.length)} 字符</span>}
          bodyClassName="p-0"
          padded={false}
        >
          {record.cotTrace ? (
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed text-ink-mid">
              {record.cotTrace}
            </pre>
          ) : (
            <p className="px-3 py-4 text-xs text-ink-faint">
              本周期模型未返回 {'<reasoning>'} 块。
            </p>
          )}
        </Panel>

        <div className="space-y-3">
          {/* Parsed decisions ---------------------------------------------- */}
          <Panel
            title="解析后的决策"
            actions={<span className="num text-2xs text-ink-faint">风控复核后</span>}
            bodyClassName="p-0"
            padded={false}
          >
            {record.decisions.length === 0 ? (
              <p className="px-3 py-4 text-xs text-ink-faint">
                没有可执行的决策 — 本周期模型选择观望或持仓。
              </p>
            ) : (
              <div className="divide-y divide-base-850">
                {record.decisions.map((decision, index) => (
                  <div key={`${decision.symbol}-${index}`} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-ink-hi">{decision.symbol}</span>
                      <ActionBadge action={decision.action} />
                      <Badge tone="muted">{decision.leverage}×</Badge>
                      <span className="num text-2xs text-ink-lo">{fmtUsd(decision.positionSizeUsd, 2)}</span>
                      <span className="num ml-auto text-2xs text-ink-lo">置信度 {decision.confidence}</span>
                    </div>

                    <div className="mt-1.5 grid grid-cols-2 gap-x-4 md:grid-cols-4">
                      <Readout label="止损" value={decision.stopLoss ? fmtPrice(decision.stopLoss) : '无'} />
                      <Readout label="止盈" value={decision.takeProfit ? fmtPrice(decision.takeProfit) : '无'} />
                      <Readout label="风险预算" value={fmtUsd(decision.riskUsd, 2)} />
                      <Readout label="名义价值" value={fmtUsd(decision.positionSizeUsd, 2)} />
                    </div>

                    {decision.reasoning && (
                      <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-mid">
                        {decision.reasoning}
                      </p>
                    )}

                    {decision.adjustments.length > 0 && (
                      <div className="mt-1.5 rounded border border-warn/40 bg-warn/10 px-2 py-1">
                        <div className="text-2xs font-semibold uppercase tracking-wide text-warn">风控引擎调整</div>
                        <ul className="mt-0.5 space-y-0.5">
                          {decision.adjustments.map((note, noteIndex) => (
                            <li key={noteIndex} className="text-2xs text-warn/90">
                              • {note}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* Execution log -------------------------------------------------- */}
          <Panel
            title="执行日志"
            actions={
              <span className="flex items-center gap-1.5">
                {executed.length > 0 && <Badge tone="up">{executed.length} 成功</Badge>}
                {rejected.length > 0 && <Badge tone="warn">{rejected.length} 拒绝</Badge>}
                {failed.length > 0 && <Badge tone="down">{failed.length} 失败</Badge>}
              </span>
            }
            bodyClassName="p-2"
            padded={false}
          >
            <ExecutionList log={record.executionLog} />
          </Panel>
        </div>
      </div>

      {/* Candidates -------------------------------------------------------- */}
      <Panel
        title="候选交易对"
        actions={<span className="num text-2xs text-ink-faint">{record.candidateSymbols.length} 个交易对</span>}
        padded={false}
        bodyClassName="p-2"
      >
        {record.candidateSymbols.length === 0 ? (
          <p className="text-xs text-ink-faint">本周期没有筛选出候选交易对。</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {record.candidateSymbols.map((symbol) => (
              <span key={symbol} className="chip border-base-700 bg-base-850 text-ink-mid">
                {symbol}
              </span>
            ))}
          </div>
        )}
      </Panel>

      <PromptBlocks record={record} />
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-base-850 py-1 last:border-0">
      <span className="text-2xs uppercase tracking-wide text-ink-lo">{label}</span>
      <span className="num text-xs text-ink-hi">{value}</span>
    </div>
  );
}

/** Small back-reference used from the trader dashboard's decision list. */
export function DecisionLinkButton({ traderId, recordId }: { traderId: number; recordId: number }) {
  return (
    <Link to={`/traders/${traderId}/decisions/${recordId}`} className="btn btn-primary btn-xs">
      审计
    </Link>
  );
}
