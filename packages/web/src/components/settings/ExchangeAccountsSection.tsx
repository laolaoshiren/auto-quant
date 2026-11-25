/**
 * 交易所凭证管理。
 *
 * 按操作员的提问顺序排布：左指标栏回答“钱在不在 / 这是真钱吗”，
 * 主内容区回答“密钥能用吗 / 怎么管理”。任何情况下都不渲染明文 Secret。
 */
import { useCallback, useMemo, useState } from 'react';
import { Plus, RotateCw } from 'lucide-react';
import { EXCHANGES, type ExchangeId } from '@aq/shared';
import { api, type ExchangeAccountRow, type PreflightCheck } from '../../lib/api';
import {
  EMPTY_ACCOUNT,
  buildExchangeAccountCreatePayload,
  buildExchangeAccountUpdatePayload,
  resolveDraftTestnet,
  type AccountDraft,
} from './exchangeAccountDraft';
import { useApp } from '../../lib/store';
import { usePolled, useTicker } from '../../lib/hooks';
import { Button, ErrorNote, Panel, Spinner3, cn } from '../ui';
import { PageShell } from '../shell';
import {
  aggregateBalance,
  ExchangeBalanceRail,
  SupportedExchangesPanel,
  type ExchangeOption,
  type FreshRead,
} from './ExchangeBalanceRail';
import { ExchangeAccountCard, type TestOutcome } from './ExchangeAccountCard';
import {
  DeleteExchangeAccountModal,
  ExchangeAccountFormModal,
} from './ExchangeAccountModals';

export function ExchangeAccountsSection() {
  const catalog = useApp((s) => s.catalog);
  const envTestnet = useApp((s) => (s.system?.environment ?? 'demo') !== 'production');
  const query = usePolled((signal) => api.exchangeAccounts(signal), { intervalMs: 30_000 });

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ExchangeAccountRow | null>(null);
  const [removing, setRemoving] = useState<ExchangeAccountRow | null>(null);
  const [draft, setDraft] = useState<AccountDraft>(EMPTY_ACCOUNT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<number, TestOutcome>>({});
  const [openTests, setOpenTests] = useState<Record<number, boolean>>({});
  const [testingId, setTestingId] = useState<number | null>(null);
  const [draftChecks, setDraftChecks] = useState<PreflightCheck[] | null>(null);
  const [draftTestedAt, setDraftTestedAt] = useState<number | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [testingDraft, setTestingDraft] = useState(false);
  const [overrides, setOverrides] = useState<Record<number, FreshRead>>({});
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [envFilter, setEnvFilter] = useState<'all' | 'live' | 'testnet'>('all');

  // 每秒驱动重渲染以刷新「读取于 N 秒前」文案。
  useTicker(1000);

  const accounts = useMemo(() => query.data ?? [], [query.data]);
  const exchanges: ExchangeOption[] = useMemo(() => {
    const rows = catalog?.exchanges ?? [];
    return EXCHANGES.map((entry) => {
      const row = rows.find((candidate) => candidate.id === entry.id);
      return {
        id: entry.id,
        label: row?.label ?? entry.label,
        market: row?.market ?? entry.market,
        available: row?.available ?? entry.available,
      };
    });
  }, [catalog]);
  const liveAccounts = useMemo(() => accounts.filter((row) => !row.testnet), [accounts]);
  const testnetAccounts = useMemo(() => accounts.filter((row) => row.testnet), [accounts]);

  const overrideFor = useCallback(
    (id: number) => {
      const fresh = overrides[id];
      if (fresh === undefined) return undefined;
      return query.updatedAt === null || fresh.at > query.updatedAt ? fresh : undefined;
    },
    [overrides, query.updatedAt],
  );

  // 实盘（主网）与测试网（虚拟资金）严格分开汇总。
  const liveTotals = useMemo(() => aggregateBalance(liveAccounts, overrideFor), [liveAccounts, overrideFor]);
  const testnetTotals = useMemo(
    () => aggregateBalance(testnetAccounts, overrideFor),
    [testnetAccounts, overrideFor],
  );
  const latestReadAt = useMemo(() => {
    const a = liveTotals.readAt ? Date.parse(liveTotals.readAt) : 0;
    const b = testnetTotals.readAt ? Date.parse(testnetTotals.readAt) : 0;
    if (!a && !b) return null;
    return a >= b ? liveTotals.readAt : testnetTotals.readAt;
  }, [liveTotals.readAt, testnetTotals.readAt]);
  const failedReads = liveTotals.failed + testnetTotals.failed;
  const skippedAssets = liveTotals.skippedAsset + testnetTotals.skippedAsset;

  const refreshOne = useCallback(async (id: number) => {
    setRefreshingId(id);
    try {
      const result = await api.exchangeBalance(id, true);
      setOverrides((current) => ({ ...current, [id]: { at: Date.now(), result } }));
    } catch (err) {
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

  const openCreate = (exchangeId?: ExchangeId) => {
    const picked = exchangeId ? exchanges.find((row) => row.id === exchangeId) : undefined;
    const usable = picked ?? exchanges.find((row) => row.available) ?? exchanges[0];
    setDraft({ ...EMPTY_ACCOUNT, exchange: usable?.id ?? 'binance' });
    setError(null);
    setDraftChecks(null);
    setDraftTestedAt(null);
    setDraftError(null);
    setCreating(true);
  };

  const openEdit = (row: ExchangeAccountRow) => {
    setDraft({
      exchange: row.exchange,
      label: row.label,
      apiKey: '',
      apiSecret: '',
      testnet: row.testnet,
      canTrade: row.canTrade,
    });
    setError(null);
    setDraftChecks(null);
    setDraftTestedAt(null);
    setDraftError(null);
    setEditing(row);
  };

  const close = () => {
    setCreating(false);
    setEditing(null);
    setDraftChecks(null);
    setDraftTestedAt(null);
    setDraftError(null);
  };

  const draftTestnet = resolveDraftTestnet(draft.exchange, draft.testnet, envTestnet);
  const buildPayload = () => buildExchangeAccountCreatePayload(draft, envTestnet);

  const runDraftTest = async () => {
    setDraftError(null);
    setDraftChecks(null);
    setDraftTestedAt(null);
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
      setDraftTestedAt(Date.now());
      setTestingDraft(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await api.updateExchangeAccount(editing.id, buildExchangeAccountUpdatePayload(draft, envTestnet));
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

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteExchangeAccount(removing.id);
      setRemoving(null);
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
      setTests((current) => ({ ...current, [row.id]: { at: Date.now(), checks: result.checks ?? [], error: null } }));
    } catch (err) {
      const payload = (err as Error & { payload?: { checks?: PreflightCheck[] } }).payload;
      setTests((current) => ({
        ...current,
        [row.id]: { at: Date.now(), checks: payload?.checks ?? [], error: (err as Error).message },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const exchangeLabel = (id: string) => exchanges.find((row) => row.id === id)?.label ?? id;

  const visibleAccounts =
    envFilter === 'live'
      ? liveAccounts
      : envFilter === 'testnet'
        ? testnetAccounts
        : [...liveAccounts, ...testnetAccounts];

  const rail = (
    <ExchangeBalanceRail
      loading={query.loading}
      accounts={accounts}
      liveAccounts={liveAccounts}
      testnetAccounts={testnetAccounts}
      liveTotals={liveTotals}
      testnetTotals={testnetTotals}
      latestReadAt={latestReadAt}
      failedReads={failedReads}
      skippedAssets={skippedAssets}
    />
  );

  return (
    <>
      <PageShell aside={accounts.length > 0 ? rail : null} fillHeight={false}>
        {error && <ErrorNote>{error}</ErrorNote>}

        {query.error && <ErrorNote>读取凭证列表失败：{query.error}</ErrorNote>}

        {query.loading && accounts.length === 0 ? (
          <Panel title="交易所凭证">
            <Spinner3 label="正在加载凭证" />
          </Panel>
        ) : accounts.length === 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed border-base-750 bg-base-900/40 px-3 py-2.5">
            <span className="text-base font-semibold text-ink-hi">还没有交易所凭证</span>
            <span className="min-w-0 flex-1 text-xs leading-relaxed text-ink-lo">
              模拟盘不需要密钥；要接实盘，先加一把测试网密钥，确认行情、签名与风控这条链路通了再换主网。
            </span>
            <Button variant="primary" size="sm" onClick={() => openCreate()} disabled={exchanges.length === 0}>
              <Plus aria-hidden className="h-3.5 w-3.5" />
              添加第一个凭证
            </Button>
          </div>
        ) : (
          <section>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="shrink-0 text-xs font-semibold uppercase tracking-[0.14em] text-ink-lo">
                交易所凭证 <span className="num ml-1 text-ink-faint">{accounts.length}</span>
              </h2>
              <Button
                size="sm"
                busy={refreshingAll}
                title="强制刷新所有凭证的实时余额（绕过服务端缓存）"
                onClick={() => void refreshAll(accounts.map((row) => row.id))}
              >
                <RotateCw aria-hidden className="h-3.5 w-3.5" />
                刷新全部
              </Button>
              <Button variant="primary" size="sm" onClick={() => openCreate()} disabled={exchanges.length === 0}>
                <Plus aria-hidden className="h-3.5 w-3.5" />
                添加凭证
              </Button>
              <span aria-hidden className="h-px min-w-4 flex-1 bg-base-800" />
              {liveAccounts.length > 0 && testnetAccounts.length > 0 && (
                <div
                  role="group"
                  aria-label="按网络筛选凭证"
                  className="inline-flex items-center rounded-lg border border-base-750 bg-base-950 p-0.5 text-xs"
                >
                  {(
                    [
                      ['all', `全部 ${accounts.length}`],
                      ['live', `实盘主网 ${liveAccounts.length}`],
                      ['testnet', `测试网 ${testnetAccounts.length}`],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={envFilter === id}
                      onClick={() => setEnvFilter(id)}
                      className={cn(
                        'h-6 rounded-md px-2 font-medium transition',
                        envFilter === id ? 'bg-base-800 text-ink-strong' : 'text-ink-lo hover:text-ink-hi',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <ul className="space-y-2">
              {visibleAccounts.map((row) => (
                <ExchangeAccountCard
                  key={row.id}
                  row={row}
                  exchangeLabel={exchangeLabel(row.exchange)}
                  fresh={overrideFor(row.id)}
                  outcome={tests[row.id]}
                  testOpen={openTests[row.id]}
                  testing={testingId === row.id}
                  refreshing={refreshingId === row.id}
                  onTest={() => void test(row)}
                  onEdit={() => openEdit(row)}
                  onRemove={() => setRemoving(row)}
                  onRefresh={() => void refreshOne(row.id)}
                  onToggleTest={(next) => setOpenTests((current) => ({ ...current, [row.id]: next }))}
                />
              ))}
            </ul>

            {accounts.length > 0 && (
              <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                合计来自交易所回报的账户权益（共享钱包），不是某个机器人的归属权益；多把密钥指向同一账户时，合计会把同一份钱算两次。
              </p>
            )}
          </section>
        )}

        <SupportedExchangesPanel exchanges={exchanges} onAdd={openCreate} />
      </PageShell>

      <ExchangeAccountFormModal
        open={creating || editing !== null}
        editing={editing}
        draft={draft}
        draftTestnet={draftTestnet}
        exchanges={exchanges}
        draftChecks={draftChecks}
        draftTestedAt={draftTestedAt}
        draftError={draftError}
        testingDraft={testingDraft}
        busy={busy}
        onClose={close}
        onChangeDraft={setDraft}
        onTestDraft={() => void runDraftTest()}
        onSubmit={() => void submit()}
      />

      <DeleteExchangeAccountModal
        removing={removing}
        exchangeLabel={removing ? exchangeLabel(removing.exchange) : ''}
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
      />
    </>
  );
}
