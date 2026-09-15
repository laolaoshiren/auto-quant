import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TraderStatus } from '@aq/shared';
import {
  api,
  type AiModelRow,
  type EquitySource,
  type ExchangeAccountRow,
  type PreflightCheck,
  type TraderRow,
} from '../lib/api';
import { useApp } from '../lib/store';
import { Badge, Button, ErrorNote, Field, Modal, NumberInput, Select, Spinner3, TextInput } from './ui';
import { CheckList } from './Badges';
import { EquitySourceField, equityPayload, useExchangeEquity } from './EquitySourceField';
import { fmtUsd } from '../lib/format';

/* -------------------------------------------------------------------------- */
/*  Create a trader                                                            */
/* -------------------------------------------------------------------------- */

export function NewTraderModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (trader: TraderRow) => void;
}) {
  const [accounts, setAccounts] = useState<ExchangeAccountRow[] | null>(null);
  const [models, setModels] = useState<AiModelRow[] | null>(null);
  const [strategyList, setStrategyList] = useState<Array<{ id: number; name: string }> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [exchangeAccountId, setExchangeAccountId] = useState<number | ''>('');
  const [aiModelId, setAiModelId] = useState<number | ''>('');
  const [strategyId, setStrategyId] = useState<number | ''>('');
  const [cycleIntervalMinutes, setCycleIntervalMinutes] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the server could not seed the baseline from the exchange. */
  const [baselineWarning, setBaselineWarning] = useState<string | null>(null);

  const selectedAccountId = exchangeAccountId === '' ? 0 : Number(exchangeAccountId);
  // The credential's own read error, so the field explains the failure even
  // before our own `?refresh=1` probe comes back.
  const selectedAccount = accounts?.find((row) => row.id === selectedAccountId) ?? null;
  const equity = useExchangeEquity({
    open,
    exchangeAccountId: selectedAccountId,
    fallbackError: selectedAccount?.balanceError ?? null,
  });

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoadError(null);
    setBaselineWarning(null);
    void Promise.all([api.exchangeAccounts(), api.aiModels(), api.strategies()])
      .then(([accountRows, modelRows, strategyRows]) => {
        if (!alive) return;
        setAccounts(accountRows);
        setModels(modelRows);
        setStrategyList(strategyRows.map((s) => ({ id: s.id, name: s.name })));
        if (accountRows[0]) setExchangeAccountId(accountRows[0].id);
        if (modelRows[0]) setAiModelId(modelRows[0].id);
        if (strategyRows[0]) setStrategyId(strategyRows[0].id);
      })
      .catch((err: Error) => alive && setLoadError(err.message));
    return () => {
      alive = false;
    };
  }, [open]);

  const ready = accounts !== null && models !== null && strategyList !== null;
  const missing = useMemo(() => {
    const gaps: string[] = [];
    if (accounts && accounts.length === 0) gaps.push('交易所凭证');
    if (models && models.length === 0) gaps.push('AI 模型');
    if (strategyList && strategyList.length === 0) gaps.push('策略');
    return gaps;
  }, [accounts, models, strategyList]);

  const submit = async () => {
    setError(null);
    setBaselineWarning(null);
    if (!name.trim()) return setError('请为机器人起个名字。');
    if (exchangeAccountId === '' || aiModelId === '' || strategyId === '') return setError('请选择凭证、模型与策略。');

    setBusy(true);
    try {
      const manualEquity = equityPayload(equity);
      const trader = await api.createTrader({
        name: name.trim(),
        exchangeAccountId: Number(exchangeAccountId),
        aiModelId: Number(aiModelId),
        strategyId: Number(strategyId),
        cycleIntervalMinutes,
        // Omitted unless the operator took over: the server then reads the real
        // wallet balance itself. `undefined` drops the key from the JSON body.
        ...(manualEquity !== undefined ? { initialEquity: manualEquity } : {}),
      });

      if (trader.equitySource === 'unavailable') {
        // The trader exists, but its return baseline is 0 — every performance
        // percentage derived from it will be meaningless. Say so and let the
        // operator act, without throwing their work away.
        setBaselineWarning(
          '机器人已创建，但未能从交易所读取钱包余额，起始权益被记为 0。在凭证可用之前，该机器人的收益率等业绩指标都没有意义。',
        );
        return;
      }

      onCreated({ ...trader, isRunning: false });
      setName('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建机器人"
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit} busy={busy} disabled={!ready || missing.length > 0}>
            创建机器人
          </Button>
        </>
      }
    >
      {!ready && !loadError && <Spinner3 label="正在加载凭证与策略" />}

      {loadError && <ErrorNote>{loadError}</ErrorNote>}

      {ready && missing.length > 0 && (
        <div className="mb-3 rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-base text-warn">
          创建机器人前，需要先添加{missing.join('、')}。
          {accounts && accounts.length === 0 && (
            <>
              {' '}
              <Link to="/exchanges" className="font-semibold underline">
                前往交易所页添加凭证
              </Link>
              。
            </>
          )}
        </div>
      )}

      {ready && missing.length === 0 && (
        <div className="space-y-3">
          <Field label="名称" hint="在控制台与审计记录中显示。">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="BTC 动量 · 模拟"
              autoFocus
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="交易所凭证">
              <Select value={exchangeAccountId} onChange={(e) => setExchangeAccountId(Number(e.target.value))}>
                {accounts?.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label} · {account.testnet ? '测试网' : '主网'}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="AI 模型">
              <Select value={aiModelId} onChange={(e) => setAiModelId(Number(e.target.value))}>
                {models?.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label} · {model.model}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="策略">
            <Select value={strategyId} onChange={(e) => setStrategyId(Number(e.target.value))}>
              {strategyList?.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="周期间隔（分钟）" hint="多久向模型请求一次决策。">
            <NumberInput value={cycleIntervalMinutes} onValueChange={setCycleIntervalMinutes} step={1} />
          </Field>

          {/* 起始权益 is read from the selected credential, not typed -------- */}
          <EquitySourceField state={equity} />

          {baselineWarning && (
            <div className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-base text-warn">
              <span className="font-semibold">权益基准为 0。</span> {baselineWarning}
            </div>
          )}

          {error && <ErrorNote>{error}</ErrorNote>}

          <p className="text-xs leading-relaxed text-ink-faint">
            创建机器人并不会启动它。启动时会要求你确认模拟或实盘模式，并在循环开始前展示预检项。
          </p>
        </div>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Start a trader — paper by default, preflight results rendered              */
/* -------------------------------------------------------------------------- */

export function StartTraderModal({
  trader,
  open,
  onClose,
  onStarted,
  initialDryRun = true,
}: {
  trader: TraderRow | null;
  open: boolean;
  onClose: () => void;
  onStarted: (status: TraderStatus) => void;
  initialDryRun?: boolean;
}) {
  const [dryRun, setDryRun] = useState(initialDryRun);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null);
  const [started, setStarted] = useState(false);

  const environmentLabel = useApp((s) => s.system?.environmentLabel ?? 'Binance USDⓈ-M Futures');

  useEffect(() => {
    if (open) {
      setDryRun(initialDryRun);
      setError(null);
      setChecks(null);
      setStarted(false);
    }
  }, [open, initialDryRun]);

  if (!trader) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.startTrader(trader.id, dryRun);
      setChecks(result.preflight ?? []);
      setStarted(true);
      onStarted('running');
    } catch (err) {
      const apiError = err as Error & { payload?: unknown };
      const payload = apiError.payload as { preflight?: PreflightCheck[] } | null;
      if (payload?.preflight) setChecks(payload.preflight);
      setError(apiError.message);
    } finally {
      setBusy(false);
    }
  };

  const blocking = (checks ?? []).some((check) => !check.ok && check.blocking);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`启动“${trader.name}”`}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>{started ? '关闭' : '取消'}</Button>
          {!started && (
            <Button variant={dryRun ? 'primary' : 'warn'} onClick={run} busy={busy}>
              {dryRun ? '以模拟模式启动' : '实盘启动 — 真实资金'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setDryRun(true)}
            aria-pressed={dryRun}
            className={`rounded-md border px-3 py-2.5 text-left transition ${
              dryRun ? 'border-accent/70 bg-accent/10' : 'border-base-700 bg-base-850 hover:border-base-600'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-ink-hi">模拟</span>
              <Badge tone="accent">dryRun: true</Badge>
              <Badge tone="muted">推荐</Badge>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-ink-lo">
              订单基于实时行情模拟撮合，不涉及任何交易所凭证，也不会产生真实盈亏。
            </p>
          </button>

          <button
            type="button"
            onClick={() => setDryRun(false)}
            aria-pressed={!dryRun}
            className={`rounded-md border px-3 py-2.5 text-left transition ${
              !dryRun ? 'border-warn/70 bg-warn/10' : 'border-base-700 bg-base-850 hover:border-base-600'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-ink-hi">实盘</span>
              <Badge tone="warn">dryRun: false</Badge>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-ink-lo">
              在 {environmentLabel} 上用真实资金下真实订单。每次开仓都会带上交易所侧止损。
            </p>
          </button>
        </div>

        {!dryRun && (
          <div className="rounded-md border border-warn/60 bg-warn/10 px-3 py-2 text-base text-warn">
            <span className="font-semibold">你即将使用真实资金交易。</span>{' '}
            风控引擎仍会限制杠杆与仓位并要求止损，但亏损是真实且不可逆的 — 启动后该循环会持续下单，直到你停止它。
          </div>
        )}

        {error && <ErrorNote>{error}</ErrorNote>}

        {checks && checks.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="panel-title">预检项</span>
              <Badge tone={blocking ? 'down' : 'up'}>{blocking ? '被阻断' : '已通过'}</Badge>
            </div>
            <CheckList checks={checks} />
          </div>
        )}

        {started && !blocking && (
          <div className="rounded-md border border-up/50 bg-up/10 px-3 py-2 text-base text-up">
            循环正在启动。实时状态、委托与决策将流入面板。
          </div>
        )}

        {!checks && (
          <p className="text-xs leading-relaxed text-ink-faint">
            启动会执行完整预检：时钟漂移、交易所连通性、交易对目录、凭证权限与模型可达性。策略中的回撤与
            单日亏损熔断从第一个周期起生效。
          </p>
        )}

        {trader.lastError && (
          <div className="rounded-md border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
            最近错误： <span className="num">{trader.lastError}</span>
          </div>
        )}

        <div className="num flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-base-800 pt-2 text-xs text-ink-faint">
          <span>每 {trader.cycleIntervalMinutes}m 一个周期</span>
          <span title="创建时从交易所读取的基准，用于计算总收益率。">
            起始权益 {fmtUsd(trader.initialEquity, 0)}
          </span>
          <span>已运行周期 {trader.lastCycleNumber}</span>
        </div>
      </div>
    </Modal>
  );
}
