import { Link, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import type { DecisionRecord } from '@aq/shared';
import { api } from '../lib/api';
import { useDocumentTitle, usePolled } from '../lib/hooks';
import { Badge, ErrorNote, Panel, Spinner3 } from '../components/ui';
import { PageShell, Metric, MetricGroup, SectionLabel } from '../components/shell';
import {
  ActionBadge,
  ExecutionList,
  PromptBlocks,
  RejectedBanner,
  actionLabel,
} from '../components/DecisionAudit';
import { fmtDateTime, fmtInt, fmtLatency, fmtPrice, fmtUsd } from '../lib/format';

/**
 * Candidate symbols are rendered as chips. The count comes from the strategy's
 * own symbol filter, which can be a few hundred on a permissive config — past
 * 48 chips the panel is a wall of text and stops being scannable, so the rest
 * collapse behind a count.
 */
const MAX_CANDIDATE_CHIPS = 48;

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

/**
 * 单条周期的完整审计视图。
 *
 * 版式按 `LAYOUT.md` §1 重排：**决策是主内容，诊断值进左栏**。
 *
 * 改版前这里有六张 `text-2xl` 的指标卡（延迟 / 决策数 / 提示词 token / 补全
 * token / 候选数 / 执行数）横在决策上面 —— 它们全是**诊断值**（§3），却占据了
 * 首屏最显眼的位置，把"这一轮到底决定了什么"挤到了下面。现在 token 与延迟
 * 收进左栏的「上下文（诊断）」分组：做审计时一眼能找到，日常看的时候不碍事。
 */
export function DecisionAuditView({ record, traderId }: { record: DecisionRecord; traderId: number }) {
  const rejected = record.executionLog.filter((entry) => entry.status === 'rejected');
  const failed = record.executionLog.filter((entry) => entry.status === 'failed');
  const executed = record.executionLog.filter((entry) => entry.status === 'ok');
  const candidates = record.candidateSymbols;

  /*
   * 左栏：这一轮的诊断读数。
   *
   * `LAYOUT.md` §3 说诊断值默认不该出现在状态区，但**专门的审计页可以显示，
   * 前提是放在专门的区块里**。这就是那个区块：它回答的是"这一轮跑了多久、
   * 花了多少 token、给了模型多少候选"，而不是"现在该不该慌"。
   */
  const rail = (
    /* 窄屏 2 列而非 3 列 —— 理由见 TraderPage 同名处：3 列会把值截断。 */
    <div className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2 xl:grid-cols-1">
      <MetricGroup title="周期结果">
        <Metric
          label="决策数"
          value={fmtInt(record.decisions.length)}
          size="lg"
          sub={`${fmtInt(record.executionLog.length)} 条执行记录`}
          title="模型给出的决策条数，以及风控复核后落下的执行记录条数。"
        />
        <Metric
          label="已执行 / 已拒绝"
          value={
            <>
              <span className="text-up">{fmtInt(executed.length)}</span>
              <span className="text-ink-faint"> / </span>
              <span className={rejected.length > 0 ? 'text-warn' : 'text-ink-mid'}>{fmtInt(rejected.length)}</span>
            </>
          }
          sub={failed.length > 0 ? `另有 ${fmtInt(failed.length)} 条在交易所失败` : '风控复核结果'}
        />
      </MetricGroup>

      <MetricGroup title="上下文（诊断）">
        <Metric label="模型延迟" value={fmtLatency(record.aiLatencyMs)} sub="单次推理耗时" />
        <Metric label="提示词 Token" value={fmtInt(record.promptTokens ?? 0)} />
        <Metric label="补全 Token" value={fmtInt(record.completionTokens ?? 0)} />
        <Metric
          label="候选交易对"
          value={fmtInt(candidates.length)}
          sub="本周期提供给模型的交易对"
        />
      </MetricGroup>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-[110rem] space-y-3">
      {/* Header ------------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link
          to={`/traders/${traderId}`}
          className="inline-flex items-center gap-1 text-base text-ink-lo transition hover:text-accent"
        >
          <ChevronLeft aria-hidden className="h-4 w-4" />
          机器人面板
        </Link>
        <span className="h-4 w-px bg-base-700" aria-hidden />
        <h1 className="text-xl font-semibold tracking-wide text-ink-hi">周期 #{record.cycleNumber}</h1>
        <Badge tone={record.success ? 'up' : 'down'}>{record.success ? '周期成功' : '周期失败'}</Badge>
        <span className="num text-xs text-ink-faint">{fmtDateTime(record.timestamp)}</span>
        <span className="num ml-auto text-xs text-ink-faint">
          记录 #{record.id} · 机器人 #{traderId}
        </span>
      </div>

      {/* Rejected proposals are the clearest signal that the bot looked and
          declined — surface them above the fold rather than burying them. */}
      <RejectedBanner log={record.executionLog} />

      {failed.length > 0 && (
        <div className="rounded-lg border border-down/60 bg-down/10 px-4 py-3">
          <div className="text-base font-bold uppercase tracking-wide text-down">
            {failed.length} 个操作在交易所失败
          </div>
          <ul className="mt-1.5 space-y-1">
            {failed.map((entry, index) => (
              <li key={index} className="text-xs leading-relaxed text-down/90">
                <span className="num font-semibold" title={entry.action}>
                  {actionLabel(entry.action)} {entry.symbol}
                </span>{' '}
                — {entry.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      <PageShell rail={rail}>
        {/* Decisions ------------------------------------------------------- */}
        {/*
          The parsed decisions get the full width, first. They are what the page
          exists to answer; the chain of thought, the execution log and the
          prompts sit below.
        */}
        <section>
          <SectionLabel
            title="解析后的决策"
            count={record.decisions.length}
            actions={
              <>
                <span className="text-xs text-ink-faint">风控复核后</span>
                {executed.length > 0 && <Badge tone="up">{executed.length} 已执行</Badge>}
              </>
            }
          />
          <Panel bodyClassName="p-0" padded={false}>
            {record.decisions.length === 0 ? (
              <p className="px-4 py-3 text-base text-ink-faint">
                没有可执行的决策 — 本周期模型选择观望或持仓。
              </p>
            ) : (
              /*
                1px gaps over a border-coloured background, rather than per-item
                borders. The 2px horizontal padding cancels the 1px the gaps leave
                at the right edge and the bottom, so the rules stop at the panel
                border instead of bleeding to its corner.
              */
              <div className="grid grid-cols-1 gap-px bg-base-850 pb-px pr-px">
                {record.decisions.map((decision, index) => (
                  <div key={`${decision.symbol}-${index}`} className="min-w-0 bg-base-900 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-semibold text-ink-hi">{decision.symbol}</span>
                      <ActionBadge action={decision.action} />
                      <Badge tone="muted" title="该决策建议的杠杆倍数。">
                        {decision.leverage}x
                      </Badge>
                      <span className="num text-xs text-ink-lo" title="名义价值（USDT）">
                        {fmtUsd(decision.positionSizeUsd, 2)}
                      </span>
                      <span className="num ml-auto text-xs text-ink-lo" title="模型对该决策的自评置信度。">
                        置信度 {decision.confidence}%
                      </span>
                    </div>

                    {/* Units stay in the labels — "风险预算" alone does not say in what. */}
                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 md:grid-cols-4">
                      <Readout label="止损" value={decision.stopLoss ? fmtPrice(decision.stopLoss) : '无'} tone="text-down" />
                      <Readout label="止盈" value={decision.takeProfit ? fmtPrice(decision.takeProfit) : '无'} tone="text-up" />
                      <Readout label="风险预算（USDT）" value={fmtUsd(decision.riskUsd, 2)} />
                      <Readout label="名义价值（USDT）" value={fmtUsd(decision.positionSizeUsd, 2)} />
                    </div>

                    {decision.reasoning && (
                      <p className="mt-2 whitespace-pre-wrap text-base leading-relaxed text-ink-mid">
                        {decision.reasoning}
                      </p>
                    )}

                    {decision.adjustments.length > 0 && (
                      <div className="mt-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2">
                        <div className="text-xs font-semibold uppercase tracking-wide text-warn">风控引擎调整</div>
                        <ul className="mt-1 space-y-0.5">
                          {decision.adjustments.map((note, noteIndex) => (
                            <li key={noteIndex} className="text-xs leading-relaxed text-warn/90">
                              • {note}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/*
                      The machine code, spelled out: the stored `action` is what the
                      audit trail and the risk engine both use, and rendering only
                      the Chinese label hides the value an operator greps for.
                      所以这一行明确写成"存储值"，和上面的中文徽章各司其职。
                    */}
                    <div className="num mt-2 text-xs text-ink-faint">
                      存储值 action = {decision.action}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </section>

        {/* Reasoning + execution log ---------------------------------------- */}
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {/* Chain of thought ------------------------------------------------ */}
          <Panel
            title="思维链"
            actions={<span className="num text-xs text-ink-faint">{fmtInt(record.cotTrace.length)} 字符</span>}
            bodyClassName="p-0"
            padded={false}
          >
            {record.cotTrace ? (
              <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-ink-mid">
                {record.cotTrace}
              </pre>
            ) : (
              <p className="px-4 py-3 text-base text-ink-faint">
                本周期模型未返回 {'<reasoning>'} 块。
              </p>
            )}
          </Panel>

          {/* Execution log --------------------------------------------------- */}
          <Panel
            title="执行日志"
            actions={
              <span className="flex items-center gap-1.5">
                {executed.length > 0 && <Badge tone="up">{executed.length} 成功</Badge>}
                {rejected.length > 0 && <Badge tone="warn">{rejected.length} 拒绝</Badge>}
                {failed.length > 0 && <Badge tone="down">{failed.length} 失败</Badge>}
              </span>
            }
            bodyClassName="p-3"
            padded={false}
          >
            <ExecutionList log={record.executionLog} />
          </Panel>
        </div>

        {/* Candidates -------------------------------------------------------- */}
        <section>
          <SectionLabel
            title="候选交易对"
            count={candidates.length}
            actions={
              candidates.length > MAX_CANDIDATE_CHIPS ? (
                <span className="num text-xs text-ink-faint">显示前 {MAX_CANDIDATE_CHIPS} 个</span>
              ) : undefined
            }
          />
          <Panel padded={false} bodyClassName="p-3">
            {candidates.length === 0 ? (
              <p className="text-base text-ink-faint">本周期没有筛选出候选交易对。</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {candidates.slice(0, MAX_CANDIDATE_CHIPS).map((symbol) => (
                  <span key={symbol} className="chip border-base-700 bg-base-850 text-ink-mid">
                    {symbol}
                  </span>
                ))}
                {candidates.length > MAX_CANDIDATE_CHIPS && (
                  <span className="chip border-base-700 bg-base-900 text-ink-faint">
                    +{candidates.length - MAX_CANDIDATE_CHIPS} 个
                  </span>
                )}
              </div>
            )}
          </Panel>
        </section>

        <PromptBlocks record={record} />
      </PageShell>
    </div>
  );
}

function Readout({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-base-850 py-1 last:border-0">
      <span className="text-xs uppercase tracking-wide text-ink-lo">{label}</span>
      <span className={`num whitespace-nowrap text-base ${tone ?? 'text-ink-hi'}`}>{value}</span>
    </div>
  );
}
