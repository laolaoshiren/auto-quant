/**
 * 策略体检 —— 用模拟账户把整条决策链跑一遍。
 *
 * 它回答编辑器回答不了的两个问题：模型到底会不会答，以及运行时会不会接受它的答案。
 * 体检很慢（真实模型调用，10–60 秒），所以运行期间显示秒表，并且**运行中禁止点遮罩关闭**。
 *
 * 全文最重要的一件事：**把"模型什么都没返回"和"风控把所有提案都拒了"分开**。
 * 这两种故障在外部看起来完全一样（机器人一动不动），但修法毫无交集 ——
 * 前者要改模型/提示词/输出上限，后者要放宽风控或改策略的文字要求。
 * 所以下面既有单一结论横幅，也有一条「模型侧 / 风控侧」的双轴读数。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, Bot, Check, Info, LoaderCircle, Minus, ShieldAlert, ShieldCheck, WifiOff, X } from 'lucide-react';
import { api, type CheckStage, type StrategyCheckResult, type StrategyCheckSample } from '../lib/api';
import { Badge, Button, Collapsible, Empty, ErrorNote, Field, Modal, Select, Spinner, TextInput, cn } from './ui';
import { SectionLabel } from './shell';
import { ExecutionList, PromptBlock, RejectedBanner, actionLabel } from './DecisionAudit';
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

const MODEL_STAGE = '调用模型';
const PARSE_STAGE = '解析模型输出';
const RISK_STAGE = '硬风控审查';

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

/* -------------------------------------------------------------------------- */
/*  Diagnosis                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 结论的几种形态。命名直接对应"该去改哪里"。
 *
 * - `model-empty`      模型返回空内容 —— 调用通了但没有正文
 * - `model-unreachable` 模型调用本身失败（密钥、地址、模型 id）
 * - `model-no-decision` 模型有输出但没有可执行的决策块
 * - `pipeline-failed`  更早的阶段就断了（连接 / 选币 / 行情 / 提示词）
 * - `risk-rejected-all` 模型正常输出，开仓提案被风控全部拒绝
 * - `healthy`          有提案通过了风控
 * - `no-opportunity`   模型明确判断当前没有机会（合法结果，不是故障）
 */
type OutcomeKind =
  | 'model-empty'
  | 'model-unreachable'
  | 'model-no-decision'
  | 'pipeline-failed'
  | 'risk-rejected-all'
  | 'healthy'
  | 'no-opportunity';

interface Diagnosis {
  kind: OutcomeKind;
  /** 模型侧与风控侧分别发生了什么 —— 这两行是全文的重点。 */
  modelSide: { value: string; note: string; ok: boolean | null };
  riskSide: { value: string; note: string; ok: boolean | null };
  headline: string;
  meaning: string;
  fix: string;
}

const isOpen = (action: string) => action.startsWith('open_');

/**
 * 从**阶段结果与样本**里判定结论，不猜。
 *
 * 判定依据全部来自 API：失败阶段的名字与明细、`sample` 是否为空、
 * `sample.decisions` / `approved` / `riskRejected` 的条数。
 */
function diagnose(result: StrategyCheckResult): Diagnosis {
  const stages = result.stages ?? [];
  const failed = stages.find((stage) => !stage.ok);
  const modelStage = stages.find((stage) => stage.name === MODEL_STAGE);
  const parseStage = stages.find((stage) => stage.name === PARSE_STAGE);
  const sample = result.sample;

  if (sample) {
    const decisions = sample.decisions ?? [];
    const approved = sample.approved ?? [];
    const riskRejected = sample.riskRejected ?? [];
    const opens = decisions.filter((d) => isOpen(d.action));
    const approvedOpens = approved.filter((d) => isOpen(d.action));
    const riskRejectedOpens = riskRejected.filter((r) => isOpen(r.action));
    const chars = sample.rawResponse.trim().length;

    const modelSide = {
      value: chars > 0 ? `正常输出 ${fmtInt(chars)} 字符` : '输出为空',
      note: `解析出 ${fmtInt(decisions.length)} 条决策${sample.cotTrace ? ` · 思维链 ${fmtInt(sample.cotTrace.length)} 字符` : ''}`,
      ok: chars > 0 && parseStage?.ok !== false,
    };

    const riskSide = {
      value: `${fmtInt(approvedOpens.length)} 通过 / ${fmtInt(riskRejected.length)} 拒绝`,
      note: opens.length > 0 ? `模型提出了 ${fmtInt(opens.length)} 个开仓提案` : '模型没有提出开仓提案',
      ok: approvedOpens.length > 0 ? true : opens.length === 0 ? null : false,
    };

    if (opens.length === 0) {
      // 没有开仓提案：区分"模型明确观望"与"模型没给出可执行决策"。
      const structuralRejected = (sample.rejected ?? []).length;
      if (parseStage && !parseStage.ok) {
        return {
          kind: 'model-no-decision',
          modelSide,
          riskSide,
          headline: '模型答了，但没有可执行的决策块',
          meaning:
            '模型有正文输出，却没有按要求输出 <decision> 块，因此没有任何提案进入风控。风控不是问题所在 —— 它根本没收到东西。',
          fix: '先看下方「完整系统提示词」和「模型原始输出」：多数情况是模型指令跟随能力不足，换一个更强的模型即可；也可能是输出被截断，需要调大「最大输出 Token」。',
        };
      }
      if (decisions.length === 0 && structuralRejected > 0) {
        return {
          kind: 'model-no-decision',
          modelSide,
          riskSide: {
            value: '未收到提案',
            note: `${fmtInt(structuralRejected)} 条在结构校验就被拒绝`,
            ok: false,
          },
          headline: `模型提出了 ${fmtInt(structuralRejected)} 条决策，但全部未通过结构校验`,
          meaning:
            '模型确实回答了，但它的决策在进入风控之前就被结构校验丢掉了（常见原因：交易对不在候选池、止损止盈方向写反、字段缺失）。风控依旧没有收到任何提案。',
          fix: '看下方「已拒绝」条目里的具体原因。这类问题通常改提示词就能解决 —— 明确要求它只在候选池内、并按方向填写止损止盈。',
        };
      }
      return {
        kind: 'no-opportunity',
        modelSide,
        riskSide,
        headline: '策略可正常运作：模型判断当前没有机会',
        meaning:
          '整条链路都通了：模型有输出、解析成功、风控也执行了。它只是认为当前没有值得出手的机会 —— 这对低频策略是完全正常的答案。',
        fix: '不需要修。想确认它真的会开仓，可以在「限定标的」里填一个正在剧烈波动的交易对再跑一次。',
      };
    }

    if (approvedOpens.length > 0) {
      return {
        kind: 'healthy',
        modelSide,
        riskSide,
        headline: `策略可正常运作：${approvedOpens.length} 个开仓提案通过风控`,
        meaning: `模型给出了 ${fmtInt(opens.length)} 个开仓提案，其中 ${fmtInt(approvedOpens.length)} 个通过了硬风控。这条链路是通的。`,
        fix: '不需要修。若真实运行时仍然不动手，去看机器人的运行日志与预检结果，而不是策略本身。',
      };
    }

    return {
      kind: 'risk-rejected-all',
      modelSide,
      riskSide,
      headline: `模型正常输出，但 ${fmtInt(opens.length)} 个开仓提案被风控全部拒绝`,
      meaning:
        '模型这一侧没有任何问题 —— 它正常返回、正常解析。是硬风控把每一个提案都拒了，所以机器人会一直空仓。',
      fix:
        riskRejectedOpens.length > 0
          ? '看下方「被拒绝」的原因：多数是杠杆/仓位上限、最小盈亏比或最小置信度卡住了。放开某个阈值，或者改提示词让模型别再提超出限制的仓位。'
          : '下方执行记录里有具体拒绝原因，按原因逐条放宽对应的风控阈值。',
    };
  }

  /* --- 没有样本：流程在组装样本之前就中断了 ---------------------------- */

  if (modelStage && !modelStage.ok) {
    const detail = modelStage.detail ?? '';
    // 明细里同时说明"空内容"和"输入过大/被截断"——原文比任何总结都准确，整条透传。
    const truncated = /截断|finish_reason=length/.test(detail);
    const empty = /返回空内容|没有正文|空内容/.test(detail);
    const unreachable = !empty && /调用失败/.test(detail);

    if (unreachable) {
      return {
        kind: 'model-unreachable',
        modelSide: { value: '调用失败', note: '请求没有成功返回', ok: false },
        riskSide: { value: '未执行', note: '没有提案可审', ok: null },
        headline: '模型调用失败 —— 风控根本没轮到执行',
        meaning: '请求在到达模型之前就失败了，所以既没有输出也没有提案。这不是风控问题，也不是策略问题。',
        fix: '检查该模型的 API Key、基础 URL 与模型 id；「AI 模型」页面里的「测试连接」能直接用同样的凭据验一次。',
      };
    }

    return {
      kind: 'model-empty',
      modelSide: {
        value: truncated ? '返回空内容（被截断）' : '返回空内容',
        note: truncated ? '输出预算耗尽，还没开始回答就停了' : '接口返回成功但没有正文',
        ok: false,
      },
      riskSide: { value: '未执行', note: '没有提案可审', ok: null },
      headline: '模型返回了空内容 —— 不是风控拒绝了它',
      meaning:
        '模型请求成功了，但正文是空的。风控这一步**完全没有执行**：没有任何提案送到它面前。所以放宽杠杆或仓位上限不会有任何帮助。',
      fix: truncated
        ? '根因通常在输入太大：减少候选标的、时间周期或启用的指标，把提示词压回预算内；只在输入并不大时才调大「最大输出 Token」。'
        : '先确认这个模型 id 真的可用、账号余额充足；仍为空则换一个指令跟随能力更强的模型。',
    };
  }

  if (parseStage && !parseStage.ok) {
    return {
      kind: 'model-no-decision',
      modelSide: { value: '输出无法解析', note: parseStage.detail, ok: false },
      riskSide: { value: '未执行', note: '没有提案可审', ok: null },
      headline: '模型答了，但没有输出可执行的决策块',
      meaning: '风控没有拒绝任何东西 —— 它没有收到任何提案。',
      fix: '换一个指令跟随能力更强的模型，或检查提示词里的输出格式要求是否被自定义提示词覆盖了。',
    };
  }

  return {
    kind: 'pipeline-failed',
    modelSide: { value: '未执行', note: '流程在到达模型之前中断', ok: null },
    riskSide: { value: '未执行', note: '没有提案可审', ok: null },
    headline: failed ? `流程在「${failed.name}」中断` : '流程未能完成',
    meaning: '还没有走到模型与风控那一步，因此现在讨论"模型不输出"或"风控拒绝"都太早。',
    fix: failed?.detail || '按下方阶段的明细逐条排查。',
  };
}

/** 结论 → 颜色与图标。绿=真的通了，红=确定是故障，黄=还需要人判断。 */
function outcomeTone(kind: OutcomeKind): { tone: 'up' | 'down' | 'warn'; Icon: typeof Check } {
  switch (kind) {
    case 'healthy':
    case 'no-opportunity':
      return { tone: 'up', Icon: ShieldCheck };
    case 'risk-rejected-all':
      return { tone: 'warn', Icon: ShieldAlert };
    case 'model-unreachable':
      return { tone: 'down', Icon: WifiOff };
    case 'pipeline-failed':
      return { tone: 'down', Icon: Ban };
    case 'model-no-decision':
      return { tone: 'warn', Icon: Bot };
    default:
      return { tone: 'down', Icon: Bot };
  }
}

/* -------------------------------------------------------------------------- */
/*  Modal                                                                      */
/* -------------------------------------------------------------------------- */

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
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelId, setModelId] = useState<number | ''>('');
  const [symbol, setSymbol] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StrategyCheckResult | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const loadModels = useCallback(() => {
    setModels(null);
    setModelsError(null);
    api
      .aiModels()
      .then((rows) => {
        setModels(rows.map((row) => ({ id: row.id, label: row.label, model: row.model })));
        setModelId((current) => (current === '' && rows[0] ? rows[0].id : current));
      })
      .catch((err: Error) => setModelsError(err.message));
  }, []);

  // Reset every time the modal is opened for a (possibly different) strategy.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError(null);
    setSymbol('');
    setModelId('');
    setStartedAt(null);
    loadModels();
  }, [open, target?.id, loadModels]);

  // A visible clock is the only honest progress signal for a 10–60s wait: the
  // endpoint answers once, at the end, so there is no per-stage progress to show.
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
      description="全程使用模拟账户：只做决策与风控复核，绝不下单，也不接触任何交易所凭证。"
      width="max-w-4xl"
      footer={
        <>
          <span className="mr-auto text-xs text-ink-faint">
            {busy ? `已用 ${fmtLatency(elapsed)} · 结果会一次性返回` : '通常需要 10–60 秒（一次真实模型调用）。'}
          </span>
          <Button onClick={onClose} disabled={busy || saving}>
            {result ? '关闭' : '取消'}
          </Button>
          <Button
            variant="primary"
            busy={busy || saving}
            onClick={() => void run()}
            disabled={models !== null && models.length === 0}
          >
            {result ? '重新体检' : '开始体检'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {target?.dirty && (
          <div className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-base text-warn">
            编辑器中有未保存的修改。体检读取的是已保存的策略，因此会<span className="font-semibold">先自动保存</span>
            再运行。
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_220px]">
          <Field label="用于测试的 AI 模型" hint="体检会用该模型真实调用一次；推理模型可能需要 30 秒以上。">
            {modelsError ? (
              <div className="space-y-1.5">
                <ErrorNote>读取模型列表失败：{modelsError}</ErrorNote>
                <Button size="sm" onClick={loadModels}>
                  重试
                </Button>
              </div>
            ) : models === null ? (
              <div className="flex items-center gap-2 rounded-md border border-base-750 bg-base-850 px-3 py-2 text-base text-ink-lo">
                <Spinner />
                正在加载模型…
              </div>
            ) : models.length === 0 ? (
              <div className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-base text-warn">
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
              spellCheck={false}
              disabled={busy}
            />
          </Field>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        {busy && (
          <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-3">
            <div className="flex items-center gap-2">
              <LoaderCircle aria-hidden className="h-4 w-4 shrink-0 animate-spin text-accent" />
              <span className="text-base font-semibold text-accent">正在执行策略体检…</span>
              <span className="num ml-auto text-base text-ink-mid">已用 {fmtLatency(elapsed)}</span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-lo">
              依次跑完 7 个阶段：合约元数据 → 选出候选 → 组装行情 → 构建提示词 → 调用模型 → 解析输出 → 硬风控。
              接口在全部完成后才返回，所以这里只能显示总耗时。
            </p>
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
    const known = KNOWN_STAGES.map(
      (name) => byName.get(name) ?? { name, ok: false, detail: '未执行', ms: 0, skipped: true },
    );
    const extras = stages.filter((stage) => !KNOWN_STAGES.includes(stage.name));
    return [...known, ...extras];
  }, [stages]);

  const diagnosis = useMemo(() => diagnose(result), [result]);
  const { tone, Icon } = outcomeTone(diagnosis.kind);
  const passed = stages.filter((stage) => stage.ok).length;

  const toneRing =
    tone === 'up' ? 'border-up/50 bg-up/10' : tone === 'warn' ? 'border-warn/50 bg-warn/10' : 'border-down/50 bg-down/10';
  const toneText = tone === 'up' ? 'text-up' : tone === 'warn' ? 'text-warn' : 'text-down';

  return (
    <div className="space-y-3">
      {/* 结论 ------------------------------------------------------------ */}
      <div className={cn('rounded-md border px-3 py-2.5', toneRing)}>
        <div className="flex items-start gap-2.5">
          <Icon aria-hidden className={cn('mt-0.5 h-5 w-5 shrink-0', toneText)} />
          <div className="min-w-0 flex-1">
            <h3 className={cn('text-md font-semibold leading-snug', toneText)}>{diagnosis.headline}</h3>
            <p className="mt-1 text-base leading-relaxed text-ink-mid">{diagnosis.meaning}</p>
            <p className="mt-1.5 text-base leading-relaxed text-ink-hi">
              <span className="font-semibold">先修什么：</span>
              {diagnosis.fix}
            </p>
          </div>
        </div>
        <div className="num mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-base-750/70 pt-2 text-xs text-ink-lo">
          {result.strategyName && <span>策略 {result.strategyName}</span>}
          {result.modelLabel && (
            <span>
              模型 {result.modelLabel}
              {result.model ? `（${result.model}）` : ''}
            </span>
          )}
          <span>
            阶段 {passed}/{stages.length} 执行无异常
          </span>
        </div>
      </div>

      {/* 双轴读数：模型侧 vs 风控侧 -------------------------------------- */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <AxisCard
          title="模型侧（调用与解析）"
          Icon={Bot}
          value={diagnosis.modelSide.value}
          note={diagnosis.modelSide.note}
          ok={diagnosis.modelSide.ok}
        />
        <AxisCard
          title="风控侧（硬限制复核）"
          Icon={ShieldAlert}
          value={diagnosis.riskSide.value}
          note={diagnosis.riskSide.note}
          ok={diagnosis.riskSide.ok}
        />
      </div>

      {/* 阶段清单：一眼看出卡在哪一步 ------------------------------------ */}
      <div>
        {/* 区块标题统一走 SectionLabel（LAYOUT.md §5）：小字距标签 + 延伸线，
            与下面的阶段列表在视觉上绑在一起。 */}
        <SectionLabel
          title="阶段"
          count={ordered.length}
          actions={<span className="text-xs text-ink-faint">图标 = 通过 / 失败 / 未执行</span>}
        />
        <ol className="space-y-1">
          {ordered.map((stage, index) => {
            const skipped = 'skipped' in stage && stage.skipped === true;
            return (
              <li
                key={`${stage.name}-${index}`}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-2.5 py-1.5',
                  skipped
                    ? 'border-base-800 bg-base-850/40'
                    : stage.ok
                      ? 'border-up/30 bg-up/5'
                      : 'border-down/60 bg-down/10',
                )}
              >
                <span
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                    skipped ? 'bg-base-700 text-ink-faint' : stage.ok ? 'bg-up/20 text-up' : 'bg-down/20 text-down',
                  )}
                >
                  {skipped ? (
                    <Minus aria-hidden className="h-3 w-3" />
                  ) : stage.ok ? (
                    <Check aria-hidden className="h-3 w-3" />
                  ) : (
                    <X aria-hidden className="h-3 w-3" />
                  )}
                </span>
                <span className="num w-5 shrink-0 text-xs text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                <span className={cn('shrink-0 text-base font-semibold', stage.ok ? 'text-ink-hi' : skipped ? 'text-ink-lo' : 'text-down')}>
                  {stage.name}
                </span>
                {/* 一行摘要：完整明细在下方折叠区，这里只给"结论性的一行" */}
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-xs',
                    stage.ok ? 'text-ink-lo' : skipped ? 'text-ink-faint' : 'font-semibold text-down',
                  )}
                  title={stage.detail}
                >
                  {stage.detail}
                </span>
                <span className="num shrink-0 text-xs text-ink-faint">
                  {skipped ? '未执行' : fmtLatency(stage.ms)}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {/* 全部明细（默认收起） -------------------------------------------- */}
      <Collapsible title={<span className="font-semibold">全部阶段明细</span>} meta={`${stages.length} 个阶段`}>
        <div className="space-y-2">
          {ordered.map((stage, index) => (
            <div key={`detail-${stage.name}-${index}`} className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="num text-xs text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                <span className="text-base font-semibold text-ink-hi">{stage.name}</span>
                <span className="num text-xs text-ink-faint">{fmtLatency(stage.ms)}</span>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-mid">
                {stage.detail}
              </p>
            </div>
          ))}
        </div>
      </Collapsible>

      {/* 样本 ------------------------------------------------------------ */}
      {result.sample ? (
        <SampleReport sample={result.sample} />
      ) : (
        <p className="text-base text-ink-faint">
          本次运行没有产生可展示的样本 —— 流程在更早的阶段就中断了，因此没有提示词、也没有模型的原始输出可看。
        </p>
      )}
    </div>
  );
}

/** 模型侧 / 风控侧的读数卡。`ok === null` 表示"没轮到它执行"，不是失败。 */
function AxisCard({
  title,
  Icon,
  value,
  note,
  ok,
}: {
  title: string;
  Icon: typeof Bot;
  value: string;
  note: string;
  ok: boolean | null;
}) {
  const tone = ok === true ? 'up' : ok === false ? 'down' : 'muted';
  return (
    <div
      className={cn(
        'min-w-0 rounded-md border px-3 py-2.5',
        ok === true ? 'border-up/40 bg-up/5' : ok === false ? 'border-down/50 bg-down/10' : 'border-base-750 bg-base-850/50',
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon aria-hidden className={cn('h-3.5 w-3.5 shrink-0', ok === false ? 'text-down' : ok === true ? 'text-up' : 'text-ink-lo')} />
        <span className="truncate text-xs font-semibold uppercase tracking-[0.12em] text-ink-lo">{title}</span>
        <Badge tone={tone} className="ml-auto shrink-0">
          {ok === true ? '正常' : ok === false ? '异常' : '未执行'}
        </Badge>
      </div>
      <div className={cn('num mt-1.5 truncate text-xl leading-tight', ok === false ? 'text-down' : 'text-ink-hi')}>
        {value}
      </div>
      <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-ink-faint" title={note}>
        {note}
      </div>
    </div>
  );
}

function SampleReport({ sample }: { sample: StrategyCheckSample }) {
  const rejected = (sample.executionLog ?? []).filter((entry) => entry.status === 'rejected');
  const approvedOpens = (sample.approved ?? []).filter((d) => isOpen(d.action));
  const riskRejectedOpens = (sample.riskRejected ?? []).filter((r) => isOpen(r.action));

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs leading-relaxed text-accent">
        本次体检针对一个<span className="font-semibold">模拟账户</span>运行（模拟权益 {fmtUsd(sample.simulatedEquity, 2)}），
        只做决策与风控复核，<span className="font-semibold">绝不下单</span>，也不接触任何交易所凭证。
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <MiniStat label="候选标的" value={fmtInt(sample.candidateSymbols.length)} />
        <MiniStat label="解析出的决策" value={fmtInt(sample.decisions.length)} />
        <MiniStat label="风控通过（开仓）" value={fmtInt(approvedOpens.length)} tone={approvedOpens.length > 0 ? 'text-up' : undefined} />
        <MiniStat
          label="被拒绝"
          value={fmtInt(rejected.length)}
          tone={rejected.length > 0 ? 'text-down' : undefined}
        />
      </div>

      {sample.candidateSymbols.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-ink-faint">候选</span>
          {sample.candidateSymbols.slice(0, 40).map((symbol) => (
            <span key={symbol} className="num rounded border border-base-700 bg-base-850 px-1.5 text-xs text-ink-mid">
              {symbol}
            </span>
          ))}
          {sample.candidateSymbols.length > 40 && (
            <span className="num text-xs text-ink-faint">+{sample.candidateSymbols.length - 40}</span>
          )}
        </div>
      )}

      <RejectedBanner log={sample.executionLog ?? []} />

      {/* 风控判定：先给"模型想干什么"，再给"风控怎么处理" */}
      <div className="space-y-2">
        <SectionLabel title="模型提出的开仓提案" className="mb-1.5" />
        {(sample.decisions ?? []).filter((d) => isOpen(d.action)).length === 0 ? (
          <Empty
            message="模型没有提出任何开仓提案"
            hint="它要么判断当前没有机会，要么输出里没有可执行的决策 —— 看上方结论里的模型侧读数。"
          />
        ) : (
          <div className="space-y-1">
            {(sample.decisions ?? [])
              .filter((d) => isOpen(d.action))
              .map((decision, index) => {
                const pass = (sample.approved ?? []).some(
                  (d) => d.symbol === decision.symbol && d.action === decision.action,
                );
                const reason = riskRejectedOpens.find(
                  (r) => r.symbol === decision.symbol && r.action === decision.action,
                )?.reason;
                return (
                  <div
                    key={`${decision.action}-${decision.symbol}-${index}`}
                    className={cn(
                      'rounded-md border px-2.5 py-1.5',
                      pass ? 'border-up/40 bg-up/5' : 'border-warn/50 bg-warn/10',
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn('flex h-4 w-4 items-center justify-center rounded-full', pass ? 'bg-up/20 text-up' : 'bg-warn/20 text-warn')}>
                        {pass ? <Check aria-hidden className="h-3 w-3" /> : <X aria-hidden className="h-3 w-3" />}
                      </span>
                      <span className="text-base font-semibold text-ink-hi">{actionLabel(decision.action)}</span>
                      <span className="num text-xs text-ink-mid">{decision.symbol}</span>
                      <Badge tone={pass ? 'up' : 'warn'} className="ml-auto">
                        {pass ? '通过风控' : '被风控拒绝'}
                      </Badge>
                    </div>
                    <div className="num mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-lo">
                      <span>名义 {fmtUsd(decision.positionSizeUsd, 2)}</span>
                      <span>杠杆 {decision.leverage}×</span>
                      <span>止损 {decision.stopLoss ?? '无'}</span>
                      <span>止盈 {decision.takeProfit ?? '无'}</span>
                      <span>置信度 {decision.confidence}</span>
                    </div>
                    {reason && <p className="mt-1 text-xs leading-relaxed text-warn">{reason}</p>}
                  </div>
                );
              })}
          </div>
        )}
      </div>

      <div>
        <SectionLabel title="执行记录" className="mb-1.5" />
        <ExecutionList
          log={sample.executionLog ?? []}
          empty={
            rejected.length === 0
              ? '本次没有任何提案进入执行阶段 —— 模型可能选择了观望，或全部提案被结构校验拒绝（见上方「被拒绝」条目）。'
              : undefined
          }
        />
      </div>

      {/* 完整原文：全部折叠，需要时才展开 */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs text-ink-faint">
          <Info aria-hidden className="h-3.5 w-3.5" />
          下面是这次真实调用产生的完整原文，只在本机展示。
        </div>
        <PromptBlock title="思维链" body={sample.cotTrace} />
        <PromptBlock title="模型原始输出" body={sample.rawResponse} />
        <PromptBlock title="完整系统提示词" body={sample.systemPrompt} />
        <PromptBlock title="完整用户提示词" body={sample.userPrompt} />
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-base-800 bg-base-850/50 px-2.5 py-1.5">
      <div className="truncate text-xs uppercase tracking-wide text-ink-faint">{label}</div>
      <div className={cn('num text-xl leading-tight', tone ?? 'text-ink-hi')}>{value}</div>
    </div>
  );
}

/** Small trigger button so the list page and the editor share one look. */
export function StrategyCheckButton({ onClick, small }: { onClick: () => void; small?: boolean }) {
  return (
    <Button
      small={small}
      variant="primary"
      onClick={onClick}
      title="用真实模型跑一遍完整决策链路，验证策略是否能正常工作（不会下单）"
    >
      <ShieldCheck aria-hidden className="h-3.5 w-3.5" />
      策略体检
    </Button>
  );
}
