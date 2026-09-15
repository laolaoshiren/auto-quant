/**
 * 交易所凭证管理。
 *
 * 这一屏是全站风险最高的一屏：它握住下单用的密钥，也是操作员判断
 * "我的钱还在不在"的地方。所以版面按**操作员的提问顺序**排：
 *
 *   1. 钱在不在？      —— 顶部余额卡（交易所回报的权益，`text-3xl`）+ 读取时刻
 *   2. 这是真钱吗？    —— 主网凭证在卡上、行里、横幅里三处写明白
 *   3. 密钥能用吗？    —— 连接测试结果带通过项、阻断项与测试时刻
 *   4. 怎么管理？      —— 下方一行一张凭证卡片，危险操作在行尾
 *
 * 余额单独成卡而不是塞进表格单元格：表格列宽有限，权益数字会被压成
 * 和"添加时间"一样大，而这一屏最不该被压小的就是它。
 */
import { useCallback, useState } from 'react';
import { Plus, RotateCw, Trash2 } from 'lucide-react';
import { api, type ExchangeAccountInput, type ExchangeAccountRow, type ExchangeBalance, type ExchangeBalanceResult, type PreflightCheck } from '../../lib/api';
import { useApp } from '../../lib/store';
import { usePolled, useTicker } from '../../lib/hooks';
import {
  Badge,
  Button,
  Collapsible,
  Empty,
  ErrorNote,
  Field,
  Modal,
  Panel,
  Select,
  Spinner3,
  TextInput,
  Toggle,
} from '../ui';
import { CheckList } from '../Badges';
import { BalanceCell } from '../BalanceCells';
import { BALANCE_LABEL, DEFAULT_SETTLE_ASSET, fmtAsset, fmtDateTime, fmtNum, fmtSigned, fmtTime, pnlColor, timeAgo } from '../../lib/format';

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

/**
 * 余额卡网格：最多 3 列。
 *
 * 不用 `auto-fit minmax(20rem, 1fr)` —— 那个写法在窄容器里会**先缩成一列再
 * 掉出横向溢出**，而这里必须保证 150% 缩放下没有横向滚动条。
 * 显式断点（1 → 2 → 3 列）在每种缩放下都是确定的。
 */
const BALANCE_GRID = 'grid grid-cols-1 gap-2 md:grid-cols-2 3xl:grid-cols-3';

function checksPassed(checks: PreflightCheck[]): boolean {
  return checks.every((check) => check.ok || !check.blocking);
}

function severityOf(check: PreflightCheck): 'ok' | 'warn' | 'error' {
  return check.severity ?? (check.ok ? 'ok' : check.blocking ? 'error' : 'warn');
}

/** 一次连接测试的结果 + 它发生的时刻。时刻不能省：昨天的绿勾证明不了今天。 */
interface TestOutcome {
  at: number;
  checks: PreflightCheck[];
  error: string | null;
}

/**
 * 环境标签。
 *
 * 测试网是**灰的**、主网是**琥珀的**，而且两者都带文字：
 * 颜色不是所有人都能分辨，而这里分辨错的代价是真金白银。
 */
function EnvBadge({ testnet, className }: { testnet: boolean; className?: string }) {
  return (
    <Badge
      tone={testnet ? 'muted' : 'warn'}
      className={className}
      title={
        testnet
          ? '测试网 / 模拟盘：订单不会进入真实市场。'
          : '主网 / 实盘：这里的订单是真钱，会在真实市场成交。'
      }
    >
      {testnet ? '测试网 · 模拟' : '主网 · 真实资金'}
    </Badge>
  );
}

/**
 * 一张凭证的实时余额卡。
 *
 * 余额是这一屏的主数字，所以它单独成卡、用 `text-3xl`；凭证列表里的
 * `BalanceCell` 是它的紧凑副本，两者共用同一份读数（见列表里的 `fresh`）。
 */
function BalanceCard({
  row,
  fresh,
  onRefresh,
  refreshing,
}: {
  row: ExchangeAccountRow;
  /** 手动刷新拿到的更新读数；比最近一次轮询新时才生效。 */
  fresh: { at: number; result: ExchangeBalanceResult } | undefined;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const balance: ExchangeBalance | null = fresh ? (fresh.result.ok ? fresh.result.balance : null) : row.balance;
  const error: string | null = fresh
    ? fresh.result.ok
      ? null
      : fresh.result.error
    : row.balanceError;

  const asset = balance?.asset?.trim() || DEFAULT_SETTLE_ASSET;

  return (
    <article className="flex flex-col gap-2 rounded-md border border-base-750 bg-base-850/40 p-3">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-base font-semibold text-ink-hi" title={row.label}>
          {row.label}
        </span>
        <span className="text-xs text-ink-lo">{row.exchange}</span>
        <EnvBadge testnet={row.testnet} className="ml-auto" />
      </header>

      {balance ? (
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-ink-lo">{BALANCE_LABEL.equity}（交易所回报）</div>
          <div className="num mt-0.5 break-all text-3xl leading-tight text-ink-strong" title={fmtAsset(balance.equity, asset)}>
            {fmtAsset(balance.equity, asset)}
          </div>
        </div>
      ) : error ? (
        // 读不到也是一条信息 —— 空白单元格会让人以为"余额是 0"。
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-ink-lo">{BALANCE_LABEL.equity}（交易所回报）</div>
          <div className="mt-1 text-base font-semibold text-warn">读取失败</div>
          <p className="mt-1 break-words text-xs leading-relaxed text-warn/90">
            交易所原样返回：{error}
          </p>
        </div>
      ) : (
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-ink-lo">{BALANCE_LABEL.equity}（交易所回报）</div>
          <div className="num mt-1 text-3xl leading-tight text-ink-faint">—</div>
          <p className="mt-1 text-xs text-ink-faint">尚未读取到余额。点右侧刷新向交易所重新查询。</p>
        </div>
      )}

      {balance && (
        <div className="num space-y-0.5 text-xs text-ink-lo">
          <div>
            {BALANCE_LABEL.short.wallet} <span className="text-ink-mid">{fmtNum(balance.walletBalance)}</span> ·{' '}
            {BALANCE_LABEL.short.available} <span className="text-ink-mid">{fmtNum(balance.availableBalance)}</span>
          </div>
          {balance.unrealizedPnl !== 0 && (
            <div className={pnlColor(balance.unrealizedPnl)}>
              {BALANCE_LABEL.unrealized} {fmtSigned(balance.unrealizedPnl)} {asset}
            </div>
          )}
        </div>
      )}

      <footer className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-base-800 pt-2">
        <span className="num min-w-0 text-xs text-ink-faint" title={balance ? `交易所返回的读取时刻 ${fmtTime(balance.readAt)}` : undefined}>
          {balance ? `读取于 ${timeAgo(balance.readAt)}（${fmtTime(balance.readAt)}）` : error ? '读取未成功' : '未读取'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto shrink-0"
          busy={refreshing}
          onClick={onRefresh}
          title="向交易所强制重新读取该凭证的余额（绕过服务端缓存）"
        >
          <RotateCw aria-hidden className="h-3.5 w-3.5" />
          刷新
        </Button>
      </footer>

      {/*
       * 读数确实来自手动刷新时说明一句：否则操作员按了刷新、标题上的读数没动，
       * 会以为按钮坏了。（卡片里的"读取于"跟着读数一起走，见上面的 readAt。）
       */}
      {fresh && (
        <p className="text-xs text-ink-faint">
          本卡为最近一次手动刷新的读数（{timeAgo(new Date(fresh.at).toISOString())}）。
        </p>
      )}
    </article>
  );
}

export function ExchangeAccountsSection() {
  const catalog = useApp((s) => s.catalog);
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

  /**
   * 手动刷新的读数，按凭证 id 存放，并记录取样时刻。
   *
   * 手动刷新回答的是"现在"，所以必须盖过轮询来的那一行 —— 但只到下一次
   * 轮询真正落地为止（服务端缓存 20s、这里 30s 轮询一次，所以轮询回来的
   * 确实更新）。比时刻而不是无条件覆盖，这一列才不会永远停在最后一次点击上。
   */
  const [overrides, setOverrides] = useState<Record<number, { at: number; result: ExchangeBalanceResult }>>({});
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  /** 每秒走一次的时钟，让"12 秒前"在两次轮询之间也不说谎。 */
  const now = useTicker(1000);

  const accounts = query.data ?? [];
  const exchanges = catalog?.exchanges ?? [];
  const liveAccounts = accounts.filter((row) => !row.testnet);

  const overrideFor = useCallback(
    (id: number) => {
      const fresh = overrides[id];
      if (fresh === undefined) return undefined;
      // 轮询已拿到更新的数据时，手动读数就已经过期了。
      return query.updatedAt === null || fresh.at > query.updatedAt ? fresh : undefined;
    },
    [overrides, query.updatedAt],
  );

  const refreshOne = useCallback(async (id: number) => {
    setRefreshingId(id);
    try {
      const result = await api.exchangeBalance(id, true);
      setOverrides((current) => ({ ...current, [id]: { at: Date.now(), result } }));
    } catch (err) {
      // 传输层失败同样是一次失败的读取 —— 绝不能把单元格留空。
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
      // `refreshExchangeBalances` 只在传输层出问题时才 reject。
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
    // 默认选中目录里第一个真正可用的交易所。
    const usable = exchanges.find((row) => row.available) ?? exchanges[0];
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
      // 密钥本身永远不进草稿：编辑时它只作为"留空 = 保持原样"的占位语义。
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

  /** 创建 / 测试接口期望的确切载荷。 */
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

  /**
   * 删除凭证。走 Radix 对话框而不是 `window.confirm`：确认文案要说清后果，
   * 而原生确认框没法排版，操作员也就不会读。
   */
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

  return (
    <div className="space-y-3">
      {error && <ErrorNote>{error}</ErrorNote>}

      {/* ------------------------------------------------------------------ */}
      {/*  主网横幅：整屏最不能看错的一条                                     */}
      {/* ------------------------------------------------------------------ */}
      {liveAccounts.length > 0 && (
        <div className="flex flex-wrap items-start gap-2 rounded-md border border-warn/50 bg-warn/10 px-3 py-2.5 text-warn">
          <span className="rounded border border-warn/50 px-1.5 text-xs font-bold uppercase tracking-wide">实盘</span>
          <p className="min-w-0 flex-1 text-base leading-relaxed">
            有 <span className="num font-semibold">{liveAccounts.length}</span> 个凭证是
            <span className="font-semibold">主网 / 实盘</span>：
            {liveAccounts.map((row) => row.label).join('、')}。
            它们下的每一单都会在真实市场成交并动用真实资金 ——
            不确定时请先切到测试网密钥。
          </p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/*  余额：操作员的第一个问题                                            */}
      {/* ------------------------------------------------------------------ */}
      <Panel
        title="账户余额"
        actions={
          <>
            <span className="hidden text-xs text-ink-faint sm:inline">
              每 30 秒轮询一次；「刷新」会绕过服务端缓存
            </span>
            <Button
              size="sm"
              busy={refreshingAll}
              disabled={accounts.length === 0}
              title="强制刷新所有凭证的实时余额（绕过服务端缓存）"
              onClick={() => void refreshAll(accounts.map((row) => row.id))}
            >
              <RotateCw aria-hidden className="h-3.5 w-3.5" />
              刷新全部
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate} disabled={exchanges.length === 0}>
              <Plus aria-hidden className="h-3.5 w-3.5" />
              添加凭证
            </Button>
          </>
        }
      >
        {query.loading && accounts.length === 0 ? (
          <Spinner3 label="正在加载凭证与余额" />
        ) : accounts.length === 0 ? (
          <Empty
            message="还没有交易所凭证，因此没有余额可读。"
            hint="模拟模式不需要任何密钥。要接实盘，先添加一把测试网密钥，确认行情、签名与风控这条链路通了再换主网。"
            action={
              <Button variant="primary" onClick={openCreate} disabled={exchanges.length === 0}>
                <Plus aria-hidden className="h-3.5 w-3.5" />
                添加第一个凭证
              </Button>
            }
          />
        ) : (
          <div className={BALANCE_GRID}>
            {accounts.map((row) => (
              <BalanceCard
                key={row.id}
                row={row}
                fresh={overrideFor(row.id)}
                onRefresh={() => void refreshOne(row.id)}
                refreshing={refreshingId === row.id}
              />
            ))}
          </div>
        )}

        {query.error && <ErrorNote className="mt-2">读取凭证列表失败：{query.error}</ErrorNote>}
      </Panel>

      {/* ------------------------------------------------------------------ */}
      {/*  凭证本身：一行一张，管理操作在行尾                                  */}
      {/* ------------------------------------------------------------------ */}
      <Panel title="交易所凭证" bodyClassName="p-3">
        {query.loading && accounts.length === 0 ? (
          <Spinner3 label="正在加载凭证" />
        ) : accounts.length === 0 ? (
          <p className="text-base leading-relaxed text-ink-lo">
            暂无凭证。点上方
            <span className="mx-1 text-ink-hi">添加凭证</span>
            录入密钥 —— 测试网密钥可以先在实盘前验证整条链路。
          </p>
        ) : (
          <ul className="space-y-2">
            {accounts.map((row) => {
              const outcome = tests[row.id];
              const passed = outcome ? checksPassed(outcome.checks) : false;
              // 同一行里的两个余额视图必须同源，否则手动刷新后上下会互相矛盾。
              const fresh = overrideFor(row.id);
              const balance = fresh ? (fresh.result.ok ? fresh.result.balance : null) : row.balance;
              const balanceError = fresh ? (fresh.result.ok ? null : fresh.result.error) : row.balanceError;
              const testedAtLabel = (
                <span className="num text-xs text-ink-faint">
                  测试于 {outcome ? fmtTime(new Date(outcome.at).toISOString()) : '—'}
                </span>
              );

              return (
                <li key={row.id} className="rounded-md border border-base-750 bg-base-850/40 p-3">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <span className="min-w-0 truncate text-lg font-semibold text-ink-hi" title={row.label}>
                      {row.label}
                    </span>
                    <Badge tone="accent">{exchangeLabel(row.exchange)}</Badge>
                    <EnvBadge testnet={row.testnet} />
                    {row.canTrade ? <Badge tone="up">可下单</Badge> : <Badge tone="warn">只读</Badge>}

                    <span className="ml-auto flex flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        busy={testingId === row.id}
                        onClick={() => void test(row)}
                        title="用已保存的密钥向交易所发起一次只读探测"
                      >
                        测试连接
                      </Button>
                      <Button size="sm" onClick={() => openEdit(row)}>
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setRemoving(row)}
                        aria-label={`删除凭证 ${row.label}`}
                      >
                        <Trash2 aria-hidden className="h-3.5 w-3.5" />
                        删除
                      </Button>
                    </span>
                  </div>

                  {/* 元信息：密钥只以服务端给出的掩码出现，且没有回退到原值 */}
                  <div className="num mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-lo">
                    <span className="min-w-0">
                      API Key <span className="text-ink-mid">{row.apiKeyMasked || '—'}</span>
                    </span>
                    <span>
                      添加于 <span className="text-ink-faint">{fmtDateTime(row.createdAt)}</span>
                    </span>
                    <span>
                      最后更新 <span className="text-ink-faint">{fmtDateTime(row.updatedAt)}</span>
                    </span>
                  </div>

                  <div className="mt-2">
                    <BalanceCell balance={balance} error={balanceError} testnet={row.testnet} now={now} />
                  </div>

                  {/* 连接测试结果：结论、通过项、阻断项、时刻缺一不可 */}
                  {outcome && (
                    <Collapsible
                      className="mt-2"
                      open={openTests[row.id] ?? true}
                      onOpenChange={(next) => setOpenTests((current) => ({ ...current, [row.id]: next }))}
                      meta={testedAtLabel}
                      title={
                        <span className="flex flex-wrap items-center gap-2">
                          <span>连接测试</span>
                          <Badge tone={passed ? 'up' : 'down'}>{passed ? '通过' : '未通过'}</Badge>
                          <span className="num text-xs text-ink-lo">
                            {outcome.checks.filter((check) => severityOf(check) === 'ok').length} 项通过 ·{' '}
                            {outcome.checks.filter((check) => severityOf(check) === 'error').length} 项失败 ·{' '}
                            {outcome.checks.filter((check) => severityOf(check) === 'warn').length} 项待确认
                          </span>
                        </span>
                      }
                    >
                      {outcome.error && <ErrorNote className="mb-2">{outcome.error}</ErrorNote>}
                      <CheckList checks={outcome.checks} />
                    </Collapsible>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {/* ------------------------------------------------------------------ */}
      {/*  添加 / 编辑                                                        */}
      {/* ------------------------------------------------------------------ */}
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
            <span className="mr-auto text-xs text-ink-faint">
              {draftChecks
                ? `${checksPassed(draftChecks) ? '检查通过' : '存在阻断项'}${
                    draftTestedAt ? ` · 测试于 ${fmtTime(new Date(draftTestedAt).toISOString())}` : ''
                  }`
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
          {editing && (
            <div className="rounded-md border border-base-700 bg-base-850/60 px-3 py-2 text-xs leading-relaxed text-ink-lo">
              正在编辑 <span className="text-ink-hi">{editing.label}</span>。已保存的密钥
              <span className="mx-1 text-ink-hi">不会回传到浏览器</span>
              —— 它只以掩码出现，因此这里的输入框是空的。留空即保持原密钥不变，只有粘贴新值才会替换。
            </div>
          )}

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

          <Field label="API Key" hint={editing ? '留空则保留已存储的 Key。' : '在交易所后台创建，只勾选合约交易。'}>
            <TextInput
              className="num"
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              placeholder={editing ? '留空保持不变' : '粘贴密钥'}
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
              placeholder={editing ? '留空保持不变' : '粘贴密钥'}
              autoComplete="off"
            />
          </Field>

          <div className="space-y-2 rounded-md border border-base-750 bg-base-850/40 p-2">
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

          {/*
           * 关闭"测试网"的那一刻才是真正会亏钱的那一刻，所以警告就放在开关下面，
           * 而不是只靠在别处写一句说明。
           */}
          {draft.testnet ? (
            <div className="rounded-md border border-base-700 bg-base-850/60 px-3 py-2 text-base leading-relaxed text-ink-lo">
              这是<span className="mx-1 text-ink-hi">测试网 / 模拟盘</span>凭证：下单不会进入真实市场。
            </div>
          ) : (
            <div className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-base leading-relaxed text-warn">
              <span className="font-semibold">主网 / 真实资金。</span>
              保存后，使用该凭证的机器人会向真实市场提交真实订单，盈亏从账户里真实增减。
              请确认密钥已关闭提现权限，并尽量限制为服务器 IP。
            </div>
          )}

          {/* 草稿连接测试 ------------------------------------------------ */}
          {draftError && <ErrorNote>{draftError}</ErrorNote>}
          {draftChecks && (
            <div>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span className="panel-title">连接测试</span>
                  <Badge tone={checksPassed(draftChecks) ? 'up' : 'down'}>
                    {checksPassed(draftChecks) ? '通过' : '未通过'}
                  </Badge>
                </span>
                {draftTestedAt && (
                  <span className="num text-xs text-ink-faint">
                    测试于 {fmtTime(new Date(draftTestedAt).toISOString())}
                  </span>
                )}
              </div>
              <CheckList checks={draftChecks} />
            </div>
          )}

          <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
            请使用已开启合约交易、但<span className="font-semibold">已禁用提现</span>的密钥。
            如果交易所支持，再按 IP 限制。
          </div>
        </div>
      </Modal>

      {/* ------------------------------------------------------------------ */}
      {/*  删除确认：后果写在按钮旁边，不是"确定吗？"                          */}
      {/* ------------------------------------------------------------------ */}
      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="删除交易所凭证"
        width="max-w-md"
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>取消</Button>
            <Button variant="danger" busy={busy} onClick={() => void remove()}>
              永久删除
            </Button>
          </>
        }
      >
        {removing && (
          <div className="space-y-3">
            <p className="text-base leading-relaxed text-ink-hi">
              即将永久删除凭证“<span className="font-semibold">{removing.label}</span>”（{exchangeLabel(removing.exchange)}
              ，{removing.testnet ? '测试网 · 模拟' : '主网 · 真实资金'}）。
            </p>
            <ul className="space-y-1.5 text-base leading-relaxed text-ink-lo">
              <li>• 服务端存储的 API Key 与加密后的 Secret 会一并删除，<span className="text-ink-hi">无法恢复</span>。</li>
              <li>• 仍在引用该凭证的机器人会失去交易所连接，无法开仓，也无法平掉已有持仓。</li>
              <li>• 已成交的历史订单与账本记录不受影响；若还要继续运行，请先把机器人改配到另一把凭证。</li>
              {!removing.testnet && (
                <li className="text-warn">• 这是主网凭证：删除后本终端将无法再对这个真实账户下单或平仓，请先到交易所确认持仓。</li>
              )}
            </ul>
            <p className="num text-xs text-ink-faint">
              最近一次读取的权益：
              {removing.balance ? fmtAsset(removing.balance.equity, removing.balance.asset) : '未读取到'}
            </p>
            <div className="rounded-md border border-base-750 bg-base-850/60 px-3 py-2 text-xs leading-relaxed text-ink-lo">
              交易所可能出于安全策略自动禁用被泄露的密钥；本操作不会在交易所侧撤销该密钥的权限，
              如需彻底失效请同时到交易所后台删除该 API Key。
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
