/**
 * 单轮决策完整审计详情页（16:9 宽屏双栏工作台版式）。
 *
 * - 顶栏一字排开周期元信息与诊断胶囊（延迟 / Token / 缓存 / 候选数），消除底部冗余诊断区；
 * - 主体 12 列双栏：左 7 列 2×2 卡片网格展示全部决策（自动隐藏非开仓动作的无意义 0x / $0.00 / 无止损），
 *   右 5 列聚合思维链、中文步骤执行日志与「用户提示词 / 系统提示词 / 原始响应」三合一选项卡。
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, Copy, Check, TriangleAlert } from 'lucide-react';
import type { Decision, DecisionRecord, ExecutionLogEntry } from '@aq/shared';
import { api } from '../lib/api';
import { useCopy, useDocumentTitle, usePolled } from '../lib/hooks';
import { Badge, ErrorNote, Panel, Spinner3, cn } from '../components/ui';
import {
  ActionBadge,
  RejectedBanner,
  STATUS_LABELS,
  STATUS_TONE,
  actionLabel,
  isOpenAction,
} from '../components/DecisionAudit';
import { CoinIcon } from '../components/CoinIcon';
import { PowerlineTrajectory, parsePowerlineTrajectory } from '../components/PowerlineTrajectory';
import { fmtDateTime, fmtInt, fmtLatency, fmtPrice, fmtUsd } from '../lib/format';
import { plainText } from '../lib/plainText';
import { humanizeToolNames } from '../lib/toolLabels';
import { classifyZeroDecision } from './decisionZeroState';
import { zeroDecisionCopy } from './decisionZeroStateCopy';

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

function actionBorderClass(action: Decision['action']): string {
  switch (action) {
    case 'open_long':
      return 'border-l-up/85';
    case 'open_short':
      return 'border-l-down/85';
    case 'close_long':
    case 'close_short':
      return 'border-l-warn/85';
    case 'hold':
      return 'border-l-sky-400/75';
    case 'wait':
      return 'border-l-violet-400/55';
    case 'skip':
      return 'border-l-base-600/60';
    default:
      return 'border-l-accent/75';
  }
}

const HIGHLIGHT_RE =
  /([+-]\d+(?:\.\d+)?%|\b\d{2,3}\s*分(?!钟)|(?:\d+(?:\.\d+)?×ATR)|(?:ATR15m\s*\d+(?:\.\d+)?%)|(?:净?RR\s*[≈<>≤≥]=?\s*\d+(?:\.\d+)?(?::\d+(?:\.\d+)?)?))/g;

function HighlightedProse({ text }: { text: string }) {
  const parts = plainText(text).split(HIGHLIGHT_RE);
  return (
    <p className="mt-2 whitespace-pre-wrap break-words text-[12.5px] leading-[1.66] text-ink-mid">
      {parts.map((p, i) => {
        if (!p) return null;
        if (/^\+\d+(?:\.\d+)?%$/.test(p)) return <span key={i} className="num font-medium text-up">{p}</span>;
        if (/^-\d+(?:\.\d+)?%$/.test(p)) return <span key={i} className="num font-medium text-down">{p}</span>;
        if (/^\d{2,3}\s*分$/.test(p)) {
          const score = Number.parseInt(p, 10);
          return (
            <span
              key={i}
              className={cn(
                'num mx-0.5 inline-block rounded px-1 py-px text-[11px] font-semibold',
                score >= 75 ? 'bg-up/12 text-up' : score >= 65 ? 'bg-warn/12 text-warn' : 'bg-base-800 text-ink-hi',
              )}
            >
              {p}
            </span>
          );
        }
        if (/×ATR$|^ATR15m|^净?RR/.test(p)) {
          return <span key={i} className="num font-medium text-ink-hi">{p}</span>;
        }
        return <span key={i}>{p}</span>;
      })}
    </p>
  );
}

type RawTab = 'user' | 'system' | 'raw';

function RawMaterialTabs({ record }: { record: DecisionRecord }) {
  const [tab, setTab] = useState<RawTab>('user');
  const { copy, copied } = useCopy();

  const contentMap: Record<RawTab, { label: string; text: string }> = {
    user: { label: '用户提示词', text: record.userPrompt ?? '' },
    system: { label: '系统提示词', text: record.systemPrompt ?? '' },
    raw: { label: '原始模型响应', text: record.rawResponse ?? '' },
  };

  const active = contentMap[tab];
  const lines = active.text ? active.text.split('\n').length : 0;

  return (
    <Panel
      padded={false}
      bodyClassName="p-0"
      title={
        <div className="flex flex-wrap items-center gap-1">
          {(['user', 'system', 'raw'] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                'rounded-md px-2 py-0.5 text-xs font-medium transition',
                tab === id
                  ? 'bg-accent/15 text-accent'
                  : 'text-ink-lo hover:bg-base-800 hover:text-ink-hi',
              )}
            >
              {contentMap[id].label}
            </button>
          ))}
        </div>
      }
      actions={
        <div className="flex items-center gap-2">
          <span className="num text-[11px] text-ink-faint">
            {fmtInt(active.text.length)} 字 · {fmtInt(lines)} 行
          </span>
          {active.text && (
            <button
              type="button"
              onClick={() => void copy(active.text)}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-base-700 bg-base-850 px-2 text-[11px] text-ink-mid transition hover:border-base-600 hover:text-ink-hi"
            >
              {copied ? <Check className="h-3 w-3 text-up" /> : <Copy className="h-3 w-3" />}
              {copied ? '已复制' : '复制'}
            </button>
          )}
        </div>
      }
    >
      {active.text.trim() ? (
        <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap break-words bg-base-950/70 px-3 py-2.5 font-mono text-xs leading-relaxed text-ink-mid">
          {active.text}
        </pre>
      ) : (
        <p className="px-3 py-4 text-xs text-ink-faint">该项暂无持久化内容。</p>
      )}
    </Panel>
  );
}

function CompactExecutionLog({ log }: { log: ExecutionLogEntry[] }) {
  if (log.length === 0) {
    return <p className="text-xs text-ink-faint">本轮无执行记录。</p>;
  }
  return (
    <ul className="space-y-2">
      {log.map((entry, idx) => {
        const cleaned = plainText(humanizeToolNames(entry.detail ?? ''));
        const trajectory = entry.status === 'data' ? parsePowerlineTrajectory(cleaned) : null;
        if (trajectory) {
          return (
            <li key={idx}>
              <PowerlineTrajectory segments={trajectory} />
            </li>
          );
        }
        return (
          <li
            key={idx}
            className="flex flex-wrap items-start gap-2 rounded-lg border border-base-750/80 bg-base-850/60 px-2.5 py-2 text-xs"
          >
            <Badge tone={STATUS_TONE[entry.status] ?? 'muted'} className="shrink-0">
              {STATUS_LABELS[entry.status] ?? entry.status}
            </Badge>
            {entry.symbol && entry.symbol !== '-' && (
              <span className="inline-flex items-center gap-1 font-mono font-semibold text-ink-hi">
                <CoinIcon symbol={entry.symbol} className="h-4 w-4 text-[9px]" />
                {actionLabel(entry.action)} {entry.symbol}
              </span>
            )}
            {cleaned && <span className="min-w-0 flex-1 break-words text-ink-mid">{cleaned}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** 单条周期的 16:9 宽屏完整审计视图。 */
export function DecisionAuditView({ record, traderId }: { record: DecisionRecord; traderId: number }) {
  const executionLog = record.executionLog ?? [];
  const decisions = record.decisions ?? [];
  const candidates = record.candidateSymbols ?? [];
  const cotTrace = record.cotTrace ?? '';
  const rejected = executionLog.filter((entry) => entry.status === 'rejected');
  const failed = executionLog.filter((entry) => entry.status === 'failed');
  const executed = executionLog.filter((entry) => entry.status === 'ok');

  const zeroDecisionKind = classifyZeroDecision(record.rawResponse ?? '');
  const zeroDecision = zeroDecisionCopy(zeroDecisionKind);
  const isFailure = zeroDecisionKind !== 'no-block-judgment';

  const cachePct =
    record.cachedTokens != null && record.promptTokens != null && record.promptTokens > 0
      ? Math.round((record.cachedTokens / record.promptTokens) * 100)
      : null;

  return (
    <div className="w-full space-y-3">
      {/* 16:9 紧凑全宽顶栏（集成原底部所有诊断指标，一屏尽览） */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-base-750 bg-base-900 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/traders/${traderId}`}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-ink-lo transition hover:bg-base-850 hover:text-accent"
          >
            <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
            机器人面板
          </Link>
          <span className="h-4 w-px bg-base-750" aria-hidden />
          <h1 className="num text-base font-bold text-ink-hi">周期 #{record.cycleNumber}</h1>
          <Badge tone={record.success ? 'up' : 'down'}>{record.success ? '周期成功' : '周期失败'}</Badge>
          <span className="num text-xs text-ink-faint">
            {fmtDateTime(record.timestamp)} · 记录 #{record.id} · 机器人 #{traderId}
          </span>
        </div>

        <div className="num flex flex-wrap items-center gap-1.5 text-xs">
          <span className="rounded-md bg-sky-500/12 px-2 py-0.5 font-medium text-sky-300 [[data-skin='light']_&]:text-sky-700">
            耗时 {fmtLatency(record.aiLatencyMs)}
          </span>
          <span className="rounded-md bg-base-850 px-2 py-0.5 text-ink-mid">
            输入 {fmtInt(record.promptTokens ?? 0)} / 输出 {fmtInt(record.completionTokens ?? 0)}
          </span>
          {cachePct !== null && (
            <span className={cn('rounded-md px-2 py-0.5 font-medium', cachePct >= 50 ? 'bg-up/12 text-up' : 'bg-warn/12 text-warn')}>
              缓存 {cachePct}%
            </span>
          )}
          <span className="rounded-md bg-base-850 px-2 py-0.5 text-ink-lo">
            候选 {fmtInt(candidates.length)}
          </span>
        </div>
      </div>

      <RejectedBanner log={executionLog} />

      {failed.length > 0 && (
        <div className="rounded-xl border border-down/50 bg-down/10 px-3.5 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-down">
            <TriangleAlert className="h-3.5 w-3.5" />
            {failed.length} 个操作在交易所失败
          </div>
          <ul className="mt-1 space-y-1">
            {failed.map((entry, index) => (
              <li key={index} className="text-xs text-down/90">
                <span className="num font-semibold" title={entry.action}>
                  {actionLabel(entry.action)} {entry.symbol}
                </span>{' '}
                — {plainText(entry.detail)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 16:9 双栏宽屏工作台：左 7 列解析决策 + 候选池 | 右 5 列思维链 + 执行日志 + 原始材料 */}
      <div className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-12">
        {/* 左栏（7/12）：决策卡片 2 列网格 */}
        <div className="space-y-3.5 xl:col-span-7">
          <Panel
            padded={false}
            bodyClassName="p-3"
            title={
              <span className="inline-flex items-center gap-2">
                <span>解析后的决策</span>
                <span className="num rounded bg-base-800 px-1.5 py-0.5 text-[11px] font-normal text-ink-lo">
                  {decisions.length}
                </span>
              </span>
            }
            actions={
              <span className="flex items-center gap-1.5">
                <span className="text-[11px] text-ink-faint">风控复核后</span>
                {executed.length > 0 && <Badge tone="up">{executed.length} 已执行</Badge>}
                {rejected.length > 0 && <Badge tone="warn">{rejected.length} 被拒</Badge>}
              </span>
            }
          >
            {decisions.length === 0 ? (
              <div className="px-1 py-2">
                <p className={`text-sm font-medium ${isFailure ? 'text-warn' : 'text-ink-faint'}`}>
                  {zeroDecision.headline}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-ink-faint">{plainText(zeroDecision.detail)}</p>
              </div>
            ) : (
              <div
                className={cn(
                  'grid grid-cols-1 gap-2.5',
                  decisions.length >= 2 && 'md:grid-cols-2',
                )}
              >
                {decisions.map((decision, index) => {
                  const hasLeverage = typeof decision.leverage === 'number' && decision.leverage > 0;
                  const showParams =
                    isOpenAction(decision.action) ||
                    decision.action === 'add_to_position' ||
                    decision.action === 'reduce_position' ||
                    decision.action === 'adjust_protection' ||
                    decision.stopLoss != null ||
                    decision.takeProfit != null ||
                    (typeof decision.positionSizeUsd === 'number' && decision.positionSizeUsd > 0);

                  return (
                    <div
                      key={`${decision.symbol}-${index}`}
                      className={cn(
                        'min-w-0 rounded-lg border border-base-750 border-l-2 bg-base-850/75 p-3 transition hover:border-base-600',
                        actionBorderClass(decision.action),
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <CoinIcon symbol={decision.symbol} />
                        <span className="font-mono text-sm font-bold text-ink-hi">{decision.symbol}</span>
                        <span title={`存储值 action = ${decision.action}`}>
                          <ActionBadge action={decision.action} reasoning={decision.reasoning} />
                        </span>
                        {/* 修复 0x BUG：仅当 leverage > 0 时渲染杠杆徽章 */}
                        {hasLeverage && (
                          <Badge tone="accent" title="该决策建议的杠杆倍数">
                            {decision.leverage}x
                          </Badge>
                        )}
                        <span
                          className={cn(
                            'num ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium',
                            decision.confidence == null
                              ? 'text-ink-faint'
                              : decision.confidence >= 70
                                ? 'bg-up/12 text-up'
                                : decision.confidence >= 50
                                  ? "bg-sky-500/12 text-sky-300 [[data-skin='light']_&]:text-sky-700"
                                  : 'bg-warn/12 text-warn',
                          )}
                        >
                          {decision.confidence === null ? '置信度 未给出' : `置信度 ${decision.confidence}%`}
                        </span>
                      </div>

                      {/* 仅在实际存在仓位/保护位参数时显示参数胶囊，告别满屏 0x / 无 / $0.00 空白浪费 */}
                      {showParams && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                          {typeof decision.positionSizeUsd === 'number' && decision.positionSizeUsd > 0 && (
                            <span className="rounded bg-base-900/80 px-2 py-0.5">
                              <span className="text-ink-faint">仓位 </span>
                              <strong className="num text-ink-hi">{fmtUsd(decision.positionSizeUsd, 2)}</strong>
                            </span>
                          )}
                          {decision.stopLoss != null && (
                            <span className="rounded bg-base-900/80 px-2 py-0.5">
                              <span className="text-ink-faint">止损 </span>
                              <strong className="num text-down">{fmtPrice(decision.stopLoss)}</strong>
                            </span>
                          )}
                          {decision.takeProfit != null && (
                            <span className="rounded bg-base-900/80 px-2 py-0.5">
                              <span className="text-ink-faint">止盈 </span>
                              <strong className="num text-up">{fmtPrice(decision.takeProfit)}</strong>
                            </span>
                          )}
                          {typeof decision.riskUsd === 'number' && decision.riskUsd > 0 && (
                            <span className="rounded bg-base-900/80 px-2 py-0.5">
                              <span className="text-ink-faint">风险 </span>
                              <strong className="num text-warn">{fmtUsd(decision.riskUsd, 2)}</strong>
                            </span>
                          )}
                        </div>
                      )}

                      {decision.reasoning && <HighlightedProse text={decision.reasoning} />}

                      {(decision.adjustments ?? []).length > 0 && (
                        <div className="mt-2 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5">
                          <div className="text-[11px] font-semibold text-warn">风控引擎调整</div>
                          <ul className="mt-0.5 space-y-0.5">
                            {(decision.adjustments ?? []).map((note, noteIndex) => (
                              <li key={noteIndex} className="text-xs leading-relaxed text-warn/90">
                                • {note}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          {/* 候选交易对紧凑条 */}
          <Panel
            padded={false}
            bodyClassName="p-3"
            title={
              <span className="inline-flex items-center gap-2">
                <span>候选交易对</span>
                <span className="num rounded bg-base-800 px-1.5 py-0.5 text-[11px] font-normal text-ink-lo">
                  {candidates.length}
                </span>
              </span>
            }
          >
            {candidates.length === 0 ? (
              <p className="text-xs text-ink-faint">本周期没有筛选出候选交易对。</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {candidates.slice(0, MAX_CANDIDATE_CHIPS).map((symbol) => (
                  <span
                    key={symbol}
                    className="inline-flex items-center gap-1.5 rounded-md border border-base-750 bg-base-850/80 px-2 py-1 font-mono text-xs font-medium text-ink-mid"
                  >
                    <CoinIcon symbol={symbol} className="h-4 w-4 text-[9px]" />
                    {symbol}
                  </span>
                ))}
                {candidates.length > MAX_CANDIDATE_CHIPS && (
                  <span className="inline-flex items-center rounded-md border border-base-750 bg-base-900 px-2 py-1 text-xs text-ink-faint">
                    +{candidates.length - MAX_CANDIDATE_CHIPS} 个
                  </span>
                )}
              </div>
            )}
          </Panel>
        </div>

        {/* 右栏（5/12）：思维链 + 执行日志 + 三合一原始材料 */}
        <div className="space-y-3.5 xl:col-span-5">
          <Panel
            title="思维链"
            actions={<span className="num text-xs text-ink-faint">{fmtInt(cotTrace.length)} 字符</span>}
            bodyClassName="p-0"
            padded={false}
          >
            {cotTrace ? (
              <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words px-3.5 py-2.5 font-mono text-xs leading-relaxed text-ink-mid">
                {cotTrace}
              </pre>
            ) : (
              <p className="px-3.5 py-3 text-xs text-ink-faint">
                本周期模型未返回 {'<reasoning>'} 块。
              </p>
            )}
          </Panel>

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
            <CompactExecutionLog log={executionLog} />
          </Panel>

          <RawMaterialTabs record={record} />
        </div>
      </div>
    </div>
  );
}
