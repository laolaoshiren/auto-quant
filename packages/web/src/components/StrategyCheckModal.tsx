/**
 * 策略体检 — run a saved strategy end to end against a simulated account.
 *
 * Answers the two questions a strategy editor cannot: does the model actually
 * answer, and does the runtime accept what it says. The check is slow (a real
 * model call, 10–60s) so the modal shows the stage it is on and refuses to close
 * on a backdrop click while it runs.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, type CheckStage, type StrategyCheckResult, type StrategyCheckSample } from '../lib/api';
import { Button, ErrorNote, Field, Modal, Select, Spinner, TextInput } from './ui';
import { ExecutionList, PromptBlock, RejectedBanner } from './DecisionAudit';
import { fmtInt, fmtLatency, fmtUsd } from '../lib/format';

/** Stage names the backend reports, in the order it reports them. */
const KNOWN_STAGES = [
  '交易所连接与合约元数据',
  '选出候选标的',
  '组装行情与指标',
  '构建提示词',
  '调用模型',
  '解析模型输出',
  '硬风控审查',
];

interface AiModelOption {
  id: number;
  label: string;
  model: string;
}

export interface StrategyCheckTarget {
  id: number;
  name: string;
  /** Called first when the editor has unsaved changes. */
  saveFirst?: (() => Promise<void>) | undefined;
  dirty?: boolean;
}

export function StrategyCheckModal({
  target,
  open,
  onClose,
}: {
  target: StrategyCheckTarget | null;
  open: boolean;
  onClose: () => void;
}) {
  const [models, setModels] = useState<AiModelOption[] | null>(null);
  const [modelId, setModelId] = useState<number | ''>('');
  const [symbol, setSymbol] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StrategyCheckResult | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Reset every time the modal is opened for a (possibly different) strategy.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError(null);
    setSymbol('');
    setModels(null);
    setModelId('');
    setStartedAt(null);
    let alive = true;
    void api
      .aiModels()
      .then((rows) => {
        if (!alive) return;
        setModels(rows.map((row) => ({ id: row.id, label: row.label, model: row.model })));
        if (rows[0]) setModelId(rows[0].id);
      })
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [open, target?.id]);

  // A visible clock is the only honest progress signal for a 10–60s wait.
  useEffect(() => {
    if (!busy || startedAt === null) return;
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 250);
    return () => window.clearInterval(timer);
  }, [busy, startedAt]);

  const run = async () => {
    if (!target) return;
    if (modelId === '') {
      setError('请先选择一个用于测试的 AI 模型。');
      return;
    }

    setError(null);
    setResult(null);

    // A health check reads the *saved* strategy, so unsaved edits must be
    // committed first — otherwise the report describes a different strategy.
    if (target.dirty && target.saveFirst) {
      setSaving(true);
      try {
        await target.saveFirst();
      } catch (err) {
        setError(`先保存策略失败：${(err as Error).message}`);
        setSaving(false);
        return;
      }
      setSaving(false);
    }

    setBusy(true);
    setStartedAt(Date.now());
    setElapsed(0);
    try {
      const trimmed = symbol.trim().toUpperCase();
      const response = await api.checkStrategy(target.id, {
        aiModelId: Number(modelId),
        ...(trimmed ? { symbol: trimmed } : {}),
      });
      setResult(response);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setStartedAt(null);
    }
  };

  const stages: CheckStage[] = result?.stages ?? [];
  const failedStage = stages.find((stage) => !stage.ok);
  const currentStep = failedStage?.name ?? stages[stages.length - 1]?.name ?? '正在准备';

  return (
    <Modal
      open={open}
      onClose={() => {
        // Long-running and destructive to interrupt by accident: the modal only
        // closes through the explicit buttons while a check is in flight.
        if (!busy && !saving) onClose();
      }}
      title={target ? `策略体检 · ${target.name}` : '策略体检'}
      width="max-w-4xl"
      footer={
        <>
          <span className="mr-auto text-2xs text-ink-faint">
            {busy
              ? `正在执行：${currentStep}（已用 ${fmtLatency(elapsed)}）`
              : '全程使用模拟账户，不会下任何真实订单。'}
          </span>
          <Button onClick={onClose} disabled={busy || saving}>
            {result ? '关闭' : '取消'}
          </Button>
          <Button variant="primary" busy={busy || saving} onClick={() => void run()} disabled={models !== null && models.length === 0}>
            {result ? '重新体检' : '开始体检'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {target?.dirty && (
          <div className="rounded border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
            编辑器中有未保存的修改。体检读取的是已保存的策略，因此会<span className="font-semibold">先自动保存</span>
            再运行。
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_220px]">
          <Field label="用于测试的 AI 模型" hint="体检会用该模型真实调用一次；推理模型可能需要 30 秒以上。">
            {models === null ? (
              <div className="text-2xs text-ink-faint">正在加载模型…</div>
            ) : models.length === 0 ? (
              <div className="rounded border border-warn/50 bg-warn/10 px-2 py-1.5 text-2xs text-warn">
                还没有配置任何 AI 模型。请先到「AI 模型」页面添加一个。
              </div>
            ) : (
              <Select value={modelId} onChange={(event) => setModelId(Number(event.target.value))} disabled={busy}>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label} · {model.model}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="限定标的（可选）" hint="留空则体检整份候选币池；填入则只测这一个。">
            <TextInput
              className="num"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
              placeholder="例如 BTCUSDT"
              disabled={busy}
            />
          </Field>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        {busy && (
          <div className="flex items-center gap-3 rounded border border-accent/40 bg-accent/10 px-3 py-3">
            <Spinner className="h-4 w-4 text-accent" />
            <div>
              <div className="text-xs font-semibold text-accent">正在执行策略体检…</div>
              <div className="text-2xs text-ink-lo">
                当前步骤：{currentStep} · 已用 {fmtLatency(elapsed)}
                <span className="text-ink-faint">（完整流程通常需要 10–60 秒）</span>
              </div>
            </div>
          </div>
        )}

        {result && <CheckReport result={result} />}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Report                                                                     */
/* -------------------------------------------------------------------------- */

function CheckReport({ result }: { result: StrategyCheckResult }) {
  const stages = result.stages ?? [];
  // Present the canonical order even if a run aborted before reaching a stage.
  const ordered = useMemo(() => {
    const byName = new Map(stages.map((stage) => [stage.name, stage]));
    const known = KNOWN_STAGES.map((name) => byName.get(name) ?? { name, ok: false, detail: '未执行', ms: 0, skipped: true });
    const extras = stages.filter((stage) => !KNOWN_STAGES.includes(stage.name));
    return [...known, ...extras];
  }, [stages]);

  const passed = stages.filter((stage) => stage.ok).length;

  return (
    <div className="space-y-3">
      {/* Verdict ---------------------------------------------------------- */}
      <div
        className={
          result.ok
            ? 'rounded border border-up/50 bg-up/10 px-3 py-2.5'
            : 'rounded border border-down/50 bg-down/10 px-3 py-2.5'
        }
      >
        <div className="flex items-center gap-2">
          <span className={result.ok ? 'text-lg text-up' : 'text-lg text-down'}>{result.ok ? '✓' : '✕'}</span>
          <span className={`text-sm font-semibold leading-snug ${result.ok ? 'text-up' : 'text-down'}`}>
            {result.verdict || (result.ok ? '体检完成。' : '体检失败。')}
          </span>
        </div>
        <div className="num mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-ink-lo">
          {result.strategyName && <span>策略 {result.strategyName}</span>}
          {result.modelLabel && (
            <span>
              模型 {result.modelLabel}
              {result.model ? `（${result.model}）` : ''}
            </span>
          )}
          <span>
            阶段 {passed}/{stages.length} 通过
          </span>
        </div>
      </div>

      {/* Stage checklist -------------------------------------------------- */}
      <div className="space-y-1">
        {ordered.map((stage, index) => {
          const skipped = 'skipped' in stage && stage.skipped === true;
          return (
            <div
              key={`${stage.name}-${index}`}
              className={
                skipped
                  ? 'flex items-start gap-2 rounded border border-base-800 bg-base-850/40 px-2.5 py-1.5 opacity-70'
                  : stage.ok
                    ? 'flex items-start gap-2 rounded border border-up/30 bg-up/5 px-2.5 py-1.5'
                    : 'flex items-start gap-2 rounded border border-down/60 bg-down/10 px-2.5 py-1.5'
              }
            >
              <span
                className={`mt-px w-3 shrink-0 text-center text-xs font-bold ${
                  skipped ? 'text-ink-faint' : stage.ok ? 'text-up' : 'text-down'
                }`}
              >
                {skipped ? '—' : stage.ok ? '✓' : '✕'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="num text-2xs text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                  <span className={`text-xs font-semibold ${stage.ok ? 'text-ink-hi' : 'text-down'}`}>{stage.name}</span>
                  <span className="num ml-auto text-2xs text-ink-faint">
                    {skipped ? '未执行' : fmtLatency(stage.ms)}
                  </span>
                </div>
                <div
                  className={`mt-0.5 whitespace-pre-wrap break-words text-2xs leading-relaxed ${
                    stage.ok ? 'text-ink-lo' : 'font-semibold text-down'
                  }`}
                >
                  {stage.detail}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Sample ----------------------------------------------------------- */}
      {result.sample ? (
        <SampleReport sample={result.sample} />
      ) : (
        <p className="text-2xs text-ink-faint">本次运行没有产生可展示的样本（流程在更早的阶段中断）。</p>
      )}
    </div>
  );
}

function SampleReport({ sample }: { sample: StrategyCheckSample }) {
  const rejected = sample.executionLog.filter((entry) => entry.status === 'rejected');

  return (
    <div className="space-y-2">
      <div className="rounded border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-2xs leading-relaxed text-accent">
        本次体检针对一个<span className="font-semibold">模拟账户</span>运行（模拟权益 {fmtUsd(sample.simulatedEquity, 2)}），
        只做决策与风控复核，<span className="font-semibold">绝不下单</span>，也不接触任何交易所凭证。
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <MiniStat label="候选标的" value={fmtInt(sample.candidateSymbols.length)} />
        <MiniStat label="解析出的决策" value={fmtInt(sample.decisions.length)} />
        <MiniStat label="风控通过" value={fmtInt(sample.approved.length)} />
        <MiniStat label="被拒绝" value={fmtInt(sample.rejected.length + sample.riskRejected.length)} />
      </div>

      {sample.candidateSymbols.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {sample.candidateSymbols.map((symbol) => (
            <span key={symbol} className="chip border-base-700 bg-base-850 text-ink-mid">
              {symbol}
            </span>
          ))}
        </div>
      )}

      <RejectedBanner log={sample.executionLog} />

      <div>
        <div className="panel-title mb-1">风控判定</div>
        <ExecutionList
          log={sample.executionLog}
          empty={
            rejected.length === 0
              ? '本次没有任何提案进入执行阶段 — 模型可能选择了观望，或全部提案被结构校验拒绝（见上方“被拒绝”条目）。'
              : undefined
          }
        />
      </div>

      <PromptBlock title="思维链" body={sample.cotTrace} defaultOpen />
      <PromptBlock title="模型原始输出" body={sample.rawResponse} defaultOpen />
      <PromptBlock title="完整系统提示词" body={sample.systemPrompt} />
      <PromptBlock title="完整用户提示词" body={sample.userPrompt} />
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-base-800 bg-base-850/50 px-2 py-1.5">
      <div className="text-2xs uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="num text-sm text-ink-hi">{value}</div>
    </div>
  );
}

/** Small trigger button so the list page and the editor share one look. */
export function StrategyCheckButton({ onClick, small }: { onClick: () => void; small?: boolean }) {
  return (
    <Button small={small} variant="primary" onClick={onClick} title="用真实模型跑一遍完整决策链路，验证策略是否能正常工作">
      ⇢ 策略体检
    </Button>
  );
}
