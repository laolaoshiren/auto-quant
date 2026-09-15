import { useCallback, useState } from 'react';
import { api, type ExchangeAccountInput, type ExchangeAccountRow, type ExchangeBalanceResult, type PreflightCheck } from '../../lib/api';
import { useApp } from '../../lib/store';
import { usePolled, useTicker } from '../../lib/hooks';
import { Badge, Button, Empty, ErrorNote, Field, Modal, Panel, Select, Spinner3, TextInput, Toggle } from '../ui';
import { CheckList } from '../Badges';
import { BalanceCell } from '../BalanceCells';
import { fmtDateTime, shortId } from '../../lib/format';

interface AccountDraft {
  exchange: string;
  label: string;
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
  canTrade: boolean;
}

const EMPTY_ACCOUNT: AccountDraft = {
  exchange: 'binance',
  label: '',
  apiKey: '',
  apiSecret: '',
  testnet: true,
  canTrade: true,
};

export function ExchangeAccountsSection() {
  const catalog = useApp((s) => s.catalog);
  const query = usePolled((signal) => api.exchangeAccounts(signal), { intervalMs: 30_000 });

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ExchangeAccountRow | null>(null);
  const [draft, setDraft] = useState<AccountDraft>(EMPTY_ACCOUNT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<number, PreflightCheck[]>>({});
  const [testingId, setTestingId] = useState<number | null>(null);
  const [draftChecks, setDraftChecks] = useState<PreflightCheck[] | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [testingDraft, setTestingDraft] = useState(false);

  /**
   * Fresh readings, keyed by credential id and stamped with when we took them.
   *
   * A manual refresh answers "right now", so it must win over the polled row —
   * but only until the next poll actually lands (the server's cache is 20s and
   * we poll every 30s, so a polled payload is genuinely newer). Comparing
   * timestamps keeps the column live instead of pinning it to the last click.
   */
  const [overrides, setOverrides] = useState<Record<number, { at: number; result: ExchangeBalanceResult }>>({});
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  /** Ticking clock so `12 秒前` stays honest between polls. */
  const now = useTicker(1000);

  const accounts = query.data ?? [];
  const exchanges = catalog?.exchanges ?? [];

  const refreshOne = useCallback(async (id: number) => {
    setRefreshingId(id);
    try {
      const result = await api.exchangeBalance(id, true);
      setOverrides((current) => ({ ...current, [id]: { at: Date.now(), result } }));
    } catch (err) {
      // A transport failure is a failed read too — never leave the cell blank.
      setOverrides((current) => ({
        ...current,
        [id]: { at: Date.now(), result: { ok: false, error: (err as Error).message } },
      }));
    } finally {
      setRefreshingId(null);
    }
  }, []);

  const refreshAll = useCallback(async (ids: number[]) => {
    if (ids.length === 0) return;
    setRefreshingAll(true);
    try {
      const results = await api.refreshExchangeBalances(ids);
      const at = Date.now();
      setOverrides((current) => {
        const next = { ...current };
        for (const [id, result] of results) next[id] = { at, result };
        return next;
      });
    } catch (err) {
      // `refreshExchangeBalances` rejects only on a transport-level problem.
      const at = Date.now();
      const message = (err as Error).message;
      setOverrides((current) => {
        const next = { ...current };
        for (const id of ids) next[id] = { at, result: { ok: false, error: message } };
        return next;
      });
    } finally {
      setRefreshingAll(false);
    }
  }, []);

  const openCreate = () => {
    // Default to the first venue the catalogue says is actually usable.
    const usable = exchanges.find((row) => row.available) ?? exchanges[0];
    setDraft({ ...EMPTY_ACCOUNT, exchange: usable?.id ?? 'binance' });
    setError(null);
    setDraftChecks(null);
    setDraftError(null);
    setCreating(true);
  };

  const openEdit = (row: ExchangeAccountRow) => {
    setDraft({
      exchange: row.exchange,
      label: row.label,
      apiKey: row.apiKey,
      apiSecret: '',
      testnet: row.testnet,
      canTrade: row.canTrade,
    });
    setError(null);
    setDraftChecks(null);
    setDraftError(null);
    setEditing(row);
  };

  const close = () => {
    setCreating(false);
    setEditing(null);
    setDraftChecks(null);
    setDraftError(null);
  };

  /** The exact payload the create/test endpoints expect for the current draft. */
  const buildPayload = (): ExchangeAccountInput => ({
    exchange: draft.exchange,
    label: draft.label.trim() || draft.exchange,
    apiKey: draft.apiKey.trim(),
    apiSecret: draft.apiSecret,
    testnet: draft.testnet,
    canTrade: draft.canTrade,
  });

  const runDraftTest = async () => {
    setDraftError(null);
    setDraftChecks(null);
    if (!draft.apiKey.trim() || !draft.apiSecret) {
      setDraftError('请先填写 API Key 与 API Secret，然后再测试。');
      return;
    }
    setTestingDraft(true);
    try {
      const result = await api.testExchangeDraft(buildPayload());
      setDraftChecks(result.checks ?? []);
    } catch (err) {
      const payload = (err as Error & { payload?: { checks?: PreflightCheck[] } }).payload;
      setDraftChecks(payload?.checks ?? []);
      setDraftError((err as Error).message);
    } finally {
      setTestingDraft(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await api.updateExchangeAccount(editing.id, {
          exchange: draft.exchange,
          label: draft.label.trim(),
          apiKey: draft.apiKey.trim() || undefined,
          ...(draft.apiSecret ? { apiSecret: draft.apiSecret } : {}),
          testnet: draft.testnet,
          canTrade: draft.canTrade,
        });
      } else {
        if (!draft.label.trim() || !draft.apiKey.trim() || !draft.apiSecret) {
          throw new Error('名称、API Key 与 API Secret 为必填项。');
        }
        await api.createExchangeAccount(buildPayload());
      }
      close();
      query.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: ExchangeAccountRow) => {
    if (!window.confirm(`删除凭证“${row.label}”？使用它的机器人需要先改配其他凭证。`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteExchangeAccount(row.id);
      query.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const test = async (row: ExchangeAccountRow) => {
    setTestingId(row.id);
    setError(null);
    try {
      const result = await api.testExchangeAccount(row.id);
      setChecks((current) => ({ ...current, [row.id]: result.checks ?? [] }));
    } catch (err) {
      const payload = (err as Error & { payload?: { checks?: PreflightCheck[] } }).payload;
      setChecks((current) => ({ ...current, [row.id]: payload?.checks ?? [] }));
      setError((err as Error).message);
    } finally {
      setTestingId(null);
    }
  };

  const exchangeLabel = (id: string) => exchanges.find((row) => row.id === id)?.label ?? id;

  return (
    <div className="space-y-2">
      {error && <ErrorNote>{error}</ErrorNote>}

      <Panel
        title="交易所凭证"
        actions={
          <>
            <Button
              small
              busy={refreshingAll}
              title="强制刷新所有凭证的实时余额（绕过服务端缓存）"
              disabled={accounts.length === 0}
              onClick={() => void refreshAll(accounts.map((row) => row.id))}
            >
              ⟳ 刷新全部
            </Button>
            <Button variant="primary" onClick={openCreate} disabled={exchanges.length === 0}>
              + 添加凭证
            </Button>
          </>
        }
        padded={false}
      >
        {query.loading && accounts.length === 0 ? (
          <Spinner3 label="正在加载凭证" />
        ) : accounts.length === 0 ? (
          <Empty
            message="暂无交易所凭证。"
            hint="模拟模式无需任何密钥 — 添加一把测试网密钥，可在实盘前先验证交易所链路。"
          />
        ) : (
          <div className="scroll-x">
            <table className="w-full border-collapse">
              <thead className="border-b border-base-800 bg-base-850/60">
                <tr>
                  <th className="th">名称</th>
                  <th className="th">交易所</th>
                  <th className="th">环境</th>
                  <th className="th">权限</th>
                  <th className="th" title="权益为机器人实际交易的保证金余额；钱包余额为已结算余额。">
                    余额
                  </th>
                  <th className="th">API Key</th>
                  <th className="th">添加时间</th>
                  <th className="th text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((row) => {
                  // A manual refresh wins until a genuinely newer poll lands.
                  const fresh = overrides[row.id];
                  const useFresh =
                    fresh !== undefined && (query.updatedAt === null || fresh.at > query.updatedAt);
                  const balance = useFresh ? (fresh.result.ok ? fresh.result.balance : null) : row.balance;
                  const balanceError = useFresh
                    ? fresh.result.ok
                      ? null
                      : fresh.result.error
                    : row.balanceError;

                  return (
                    <tr key={row.id} className="row-hover align-top">
                      <td className="td font-semibold text-ink-hi">
                        {row.label}
                        {checks[row.id] && (
                          <div className="mt-1.5 w-[420px] max-w-full whitespace-normal">
                            <CheckList checks={checks[row.id] ?? []} />
                          </div>
                        )}
                      </td>
                      <td className="td">
                        <Badge tone="accent">{exchangeLabel(row.exchange)}</Badge>
                      </td>
                      <td className="td">
                        <Badge tone={row.testnet ? 'muted' : 'warn'}>{row.testnet ? '测试网' : '主网'}</Badge>
                      </td>
                      <td className="td">{row.canTrade ? <Badge tone="up">可下单</Badge> : <Badge tone="warn">只读</Badge>}</td>
                      <td className="td">
                        <div className="flex items-start gap-1.5">
                          <BalanceCell
                            balance={balance}
                            error={balanceError}
                            testnet={row.testnet}
                            now={now}
                          />
                          <Button
                            small
                            variant="ghost"
                            busy={refreshingId === row.id}
                            title="强制刷新该凭证的实时余额"
                            onClick={() => void refreshOne(row.id)}
                          >
                            ⟳
                          </Button>
                        </div>
                      </td>
                      <td className="td num text-ink-lo">{row.apiKeyMasked || shortId(row.apiKey)}</td>
                      <td className="td num text-ink-faint">{fmtDateTime(row.createdAt)}</td>
                      <td className="td text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button small variant="ghost" busy={testingId === row.id} onClick={() => void test(row)}>
                            测试连接
                          </Button>
                          <Button small onClick={() => openEdit(row)}>
                            编辑
                          </Button>
                          <Button small variant="danger" busy={busy} onClick={() => void remove(row)}>
                            ✕
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Modal
        open={creating || editing !== null}
        onClose={close}
        title={editing ? `编辑“${editing.label}”` : '添加交易所凭证'}
        width="max-w-xl"
        footer={
          <>
            <Button variant="ghost" busy={testingDraft} onClick={() => void runDraftTest()}>
              测试连接
            </Button>
            <span className="mr-auto text-2xs text-ink-faint">
              {draftChecks
                ? draftChecks.every((c) => c.ok || !c.blocking)
                  ? '检查通过'
                  : '存在阻断项'
                : '保存前建议先测一次。'}
            </span>
            <Button onClick={close}>取消</Button>
            <Button variant="primary" busy={busy} onClick={() => void submit()}>
              {editing ? '保存凭证' : '添加凭证'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="交易所" hint={exchanges.find((row) => row.id === draft.exchange)?.market}>
            <Select value={draft.exchange} onChange={(event) => setDraft({ ...draft, exchange: event.target.value })}>
              {exchanges.map((row) => (
                <option key={row.id} value={row.id} disabled={!row.available}>
                  {row.label}
                  {row.available ? ` · ${row.market}` : '（尚未支持）'}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="名称" hint="便于识别的名称 — 例如“币安模拟盘”“主账户”。">
            <TextInput value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
          </Field>

          <Field label="API Key">
            <TextInput
              className="num"
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              placeholder="粘贴密钥"
              autoComplete="off"
            />
          </Field>

          <Field
            label="API Secret"
            hint={editing ? '留空则保留已存储的密钥。' : '静态存储时加密，绝不会回传给浏览器。'}
          >
            <TextInput
              type="password"
              className="num"
              value={draft.apiSecret}
              onChange={(event) => setDraft({ ...draft, apiSecret: event.target.value })}
              placeholder="粘贴密钥"
              autoComplete="off"
            />
          </Field>

          <div className="space-y-2 rounded border border-base-800 bg-base-850/40 p-2">
            <Toggle
              checked={draft.testnet}
              onChange={(value) => setDraft({ ...draft, testnet: value })}
              label="测试网 / 模拟盘环境"
              hint="为模拟盘签发的密钥无法下主网订单。"
            />
            <Toggle
              checked={draft.canTrade}
              onChange={(value) => setDraft({ ...draft, canTrade: value })}
              label="该密钥可以下单"
              hint="关闭则存储只读密钥。风控引擎会拒绝用它交易。"
            />
          </div>

          {/* Draft connection test ---------------------------------------- */}
          {draftError && <ErrorNote>{draftError}</ErrorNote>}
          {draftChecks && (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="panel-title">连接测试</span>
                <Badge tone={draftChecks.every((c) => c.ok || !c.blocking) ? 'up' : 'down'}>
                  {draftChecks.every((c) => c.ok || !c.blocking) ? '通过' : '未通过'}
                </Badge>
              </div>
              <CheckList checks={draftChecks} />
            </div>
          )}

          <div className="rounded border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-2xs leading-relaxed text-warn">
            请使用已开启合约交易、但<span className="font-semibold">已禁用提现</span>的密钥。
            如果交易所支持，再按 IP 限制。
          </div>
        </div>
      </Modal>
    </div>
  );
}
