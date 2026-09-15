import { useEffect, useState } from 'react';
import { api, type AiModelRow, type ExchangeAccountRow, type TraderRow } from '../lib/api';
import { Badge, Button, ErrorNote, Field, Modal, NumberInput, Select, Spinner3, TextInput } from './ui';
import { EquitySourceField, equityPayload, useExchangeEquity } from './EquitySourceField';

/**
 * Edit a stopped trader. The API refuses configuration changes while the loop is
 * running, so the caller disables the entry point instead of failing here.
 */
export function TraderConfigModal({
  trader,
  open,
  onClose,
  onSaved,
}: {
  trader: TraderRow | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [accounts, setAccounts] = useState<ExchangeAccountRow[] | null>(null);
  const [models, setModels] = useState<AiModelRow[] | null>(null);
  const [strategies, setStrategies] = useState<Array<{ id: number; name: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [exchangeAccountId, setExchangeAccountId] = useState(0);
  const [aiModelId, setAiModelId] = useState(0);
  const [strategyId, setStrategyId] = useState(0);
  const [cycleIntervalMinutes, setCycleIntervalMinutes] = useState(15);
  /** Set when the save left the trader with a 0 baseline. */
  const [baselineWarning, setBaselineWarning] = useState<string | null>(null);

  const selectedAccount = accounts?.find((row) => row.id === exchangeAccountId) ?? null;
  const equity = useExchangeEquity({
    open,
    exchangeAccountId,
    // Editing starts from what the trader was created with; the read replaces
    // it as soon as the credential answers.
    prefill: trader?.initialEquity ?? 0,
    fallbackError: selectedAccount?.balanceError ?? null,
  });

  useEffect(() => {
    if (!open || !trader) return;
    setName(trader.name);
    setExchangeAccountId(trader.exchangeAccountId);
    setAiModelId(trader.aiModelId);
    setStrategyId(trader.strategyId);
    setCycleIntervalMinutes(trader.cycleIntervalMinutes);
    setError(null);
    setBaselineWarning(null);

    let alive = true;
    void Promise.all([api.exchangeAccounts(), api.aiModels(), api.strategies()])
      .then(([a, m, s]) => {
        if (!alive) return;
        setAccounts(a);
        setModels(m);
        setStrategies(s.map((row) => ({ id: row.id, name: row.name })));
      })
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [open, trader]);

  if (!trader) return null;

  const save = async () => {
    setBusy(true);
    setError(null);
    setBaselineWarning(null);
    try {
      // Re-read only when the operator took the baseline over; otherwise the
      // stored value (or the server's own exchange read) stays authoritative.
      const manualEquity = equityPayload(equity);
      const updated = await api.updateTrader(trader.id, {
        name: name.trim(),
        exchangeAccountId,
        aiModelId,
        strategyId,
        cycleIntervalMinutes,
        ...(manualEquity !== undefined ? { initialEquity: manualEquity } : {}),
      });

      if (updated.initialEquity <= 0) {
        setBaselineWarning(
          '已保存，但未能从交易所读取钱包余额，该机器人的起始权益为 0。在凭证可用之前，收益率等业绩指标都没有意义。',
        );
        return;
      }

      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ready = accounts && models && strategies;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`配置“${trader.name}”`}
      width="max-w-lg"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} busy={busy} disabled={!ready}>
            保存修改
          </Button>
        </>
      }
    >
      {!ready ? (
        <Spinner3 label="正在加载可选项" />
      ) : (
        <div className="space-y-3">
          <Field label="名称">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field label="交易所凭证" hint="测试网凭证无法下主网订单。">
            <Select value={exchangeAccountId} onChange={(e) => setExchangeAccountId(Number(e.target.value))}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label} · {account.testnet ? '测试网' : '主网'} · {account.canTrade ? '可交易' : '只读'}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="AI 模型">
            <Select value={aiModelId} onChange={(e) => setAiModelId(Number(e.target.value))}>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} · {model.model}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="策略">
            <Select value={strategyId} onChange={(e) => setStrategyId(Number(e.target.value))}>
              {strategies.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="周期间隔（分钟）">
            <NumberInput value={cycleIntervalMinutes} onValueChange={setCycleIntervalMinutes} step={1} />
          </Field>

          {/* 起始权益 is read from the selected credential, not typed -------- */}
          <EquitySourceField state={equity} editing />

          {baselineWarning && (
            <div className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-base text-warn">
              <span className="font-semibold">权益基准为 0。</span> {baselineWarning}
            </div>
          )}

          <div className="flex items-start gap-2 rounded-md border border-base-800 bg-base-850/50 px-3 py-2">
            <Badge tone="muted" className="mt-px">
              不可变更
            </Badge>
            <span className="text-xs leading-relaxed text-ink-lo">
              模拟与实盘在每次启动时选择，不在此处保存。最近周期 #{trader.lastCycleNumber}。
              停止中的机器人保存后会立即生效，但不会自动重新启动。
            </span>
          </div>

          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      )}
    </Modal>
  );
}
