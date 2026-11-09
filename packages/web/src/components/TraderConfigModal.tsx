import { useEffect, useRef, useState } from 'react';
import { isAiDriven } from '@aq/shared';
import { api, type AiModelRow, type ExchangeAccountRow, type TraderRow } from '../lib/api';
import { fmtAsset } from '../lib/format';
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
  const [aiModelId, setAiModelId] = useState(0);
  /*
   * `null` = 这个机器人不引用任何策略（AI 托管）。见 `Trader.strategyId` ——
   * 那种情况下下面根本不渲染这个控件，但状态本身要能装下这个值：
   * 编辑一台 AI 托管机器人时 `trader.strategyId` 就是 `null`。
   */
  const [strategyId, setStrategyId] = useState<number | null>(null);
  const [cycleIntervalMinutes, setCycleIntervalMinutes] = useState(15);
  /** Set when the save left the trader with a 0 baseline. */
  const [baselineWarning, setBaselineWarning] = useState<string | null>(null);
  /**
   * 已经回填过表单的机器人 id —— 见下面那个 `useEffect` 里
   * 「轮询刷新不该重填表单」的说明（用户 2026-10-04 报的那个 BUG）。
   */
  const prefilledFor = useRef<string | null>(null);

  /*
   * ⚠️ **交易所账户在创建后不可修改**（服务端语义，2026-11 审计核对）。
   *
   * `PATCH /api/traders/:id` 会拿请求里的 `exchangeAccountId` 与库里的比较，
   * 一旦**值不同**就返回 400「暂不支持通过编辑修改交易所账户」（见
   * `packages/server/src/api/server.ts` 的 PATCH 实现）。
   *
   * 原来这里是一个可编辑的 `<Select>`：编辑纯模拟盘机器人时它的 `value` 是 `''`、
   * 选项里又没有对应项，于是**下拉显示空白**；操作员随便选一个账户再保存，
   * 必然拿到那个 400。反过来，绑了账户的机器人也**没有**「不绑账户」这一项 ——
   * 那行注释声称支持改，实际从未成立。
   *
   * 所以现在：账户 id 只从记录里读（用于读起始权益），界面上只**展示**，不发回。
   * 要换账户：新建一个机器人（当前这个可以停掉保留历史）—— 与服务端的建议一致。
   */
  const exchangeAccountId = trader?.exchangeAccountId ?? 0;
  /**
   * 纯模拟盘机器人（不绑账户）：本金是 `paper_starting_balance`，
   * 老数据上该列为 0 时回落到 `initial_equity`（与服务端
   * `manager.paperStartingBalanceOf()` 的回落顺序一致）。
   */
  const paperStartingBalance =
    trader === null
      ? null
      : trader.paperStartingBalance > 0
        ? trader.paperStartingBalance
        : trader.initialEquity > 0
          ? trader.initialEquity
          : null;
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
    /*
     * ⚠️ **回填只能在"刚打开 / 换了另一台机器人"时做一次。**
     *
     * 用户 2026-10-04 报的原话：
     *
     * > 「我修改赚大钱机器人的 AI 模型为 OPENCODE GO，**我什么都没做**，
     * >  页面上选择框会自动变成 command code」
     * > （补充）「**我还没点保存，页面上就自动变成 command code**」
     *
     * 根因就在这个 effect 的依赖：`[open, trader]` 里的 `trader` 是一个**对象**，
     * 而父组件那份来自**每几秒一次的轮询** —— 每次刷新都是新对象、引用变化，
     * 于是 effect 重跑，`setAiModelId(trader.aiModelId)` 把操作员刚选的模型**改回去**。
     *
     * 他选中 OpenCode GO 之后什么也没做，几秒后轮询到达，选择就自己变回了
     * 数据库里那个值（Command Code）—— 看起来像"这个控件不听话"。
     *
     * **这个 BUG 比"界面跳一下"更危险**：若不注意而直接点保存，
     * 会把机器人真的改回旧模型，而他以为自己改成功了。表单回填与"后台数据刷新"
     * 是两件事，前者只该在**打开那一刻**发生。
     *
     * 用 `trader.id` 当标记：轮询刷新（同一个 id）不再重填，换机器人（id 变了）才重填。
     * 依赖数组保持 `[open, trader]` 不动 —— 这样 `exhaustive-deps` 仍然满意，
     * 而"什么时候真的重填"由这里显式决定，不靠引用相等这种偶然性质。
     */
    const fillKey = String(trader.id);
    if (prefilledFor.current === fillKey) return;
    prefilledFor.current = fillKey;

    setName(trader.name);
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

  /* 关闭时清掉标记：下次打开（哪怕还是同一台）必须重新回填。 */
  useEffect(() => {
    if (!open) prefilledFor.current = null;
  }, [open]);

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
        /*
         * ⚠️ **不发 `exchangeAccountId`。**
         *
         * 它是创建后不可改的字段（服务端会拒绝不同的值），而"原样发回去"也
         * 只是让请求体多一个永远不该变化的键。不发的语义是"别动它" —— 这正是
         * 服务端在 `undefined` 时的行为（`parsed.data` 里没这个键就不比较）。
         */
        aiModelId,
        /*
         * AI 托管时 `strategyId` 是 `null` —— 传 `undefined` 让服务端**不动这个字段**
         * （它本来就是空的）。绝不能传一个数字：那等于又把机器人绑回一个策略，
         * 而用户要的正是"完全独立"。
         */
        strategyId: strategyId ?? undefined,
        cycleIntervalMinutes,
        ...(manualEquity !== undefined ? { initialEquity: manualEquity } : {}),
      });

      if (updated.initialEquity <= 0) {
        /*
         * ⚠️ 文案要分两种情形：纯模拟盘机器人**没有**交易所可读，
         * 说"未能从交易所读取钱包余额"会把人指向一个不存在的东西
         * （创建时如果没填模拟本金，`initial_equity` 就是 0）。
         */
        setBaselineWarning(
          trader.exchangeAccountId === null
            ? '已保存，但该机器人的起始权益为 0（创建时没有填写模拟盘本金）。在补上本金之前，收益率等业绩指标都没有意义。'
            : '已保存，但未能从交易所读取钱包余额，该机器人的起始权益为 0。在凭证可用之前，收益率等业绩指标都没有意义。',
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

          {/*
            交易所账户**只展示、不编辑**。

            它原来是一个可编辑的下拉；而服务端 PATCH 明确拒绝"改账户"
            （400「暂不支持通过编辑修改交易所账户」）。于是那个控件的最坏形态是：
            纯模拟盘机器人显示一个**空白**下拉（value 为 `null`、选项里没有对应项），
            操作员以为该选一个，一选一存就撞 400；绑了账户的机器人也没有
            「不绑账户」选项，那行注释声称的支持从未成立。
          */}
          <Field
            label="交易所账户"
            hint="创建后不可更改。要换账户请新建一个机器人（当前这个可以停掉并保留历史）。"
          >
            <div className="text-base text-ink-mid">
              {trader.exchangeAccountId === null ? (
                <span className="text-ink-faint">不绑账户（纯模拟盘）</span>
              ) : selectedAccount ? (
                <>
                  {selectedAccount.label} · {selectedAccount.testnet ? '测试网' : '主网'} ·{' '}
                  {selectedAccount.canTrade ? '可交易' : '只读'}
                </>
              ) : (
                `账户 #${trader.exchangeAccountId}（当前账户列表里没有它）`
              )}
            </div>
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

          {/*
            **AI 驱动的模式（智能托管 / AI 团队 / JEV）都不显示策略选择器。**

            判据必须用共享包的 `isAiDriven()`，不能写死 `'ai_managed'` ——
            这与 `TraderModals.tsx` 里 `strategyIdFor()` 那个 P0 是同一个坑：
            `AI_DRIVEN_MODES` 已经包含 `ai_team` / `jev`，而写死单个模式名时
            后加的模式会落进 `else` 分支，显示一个**改了也不生效**的下拉框。

            页头（`TraderPage`）对这三种模式分别做了同样的处理，这里与它保持一致。
          */}
          {isAiDriven(trader.mode) ? (
            <Field
              label="策略"
              hint="AI 驱动的模式不引用策略 —— 参数由 AI 自己设定并持续调整（JEV 模式的参数在机器人页的「JEV 模式」标签里调）。"
            >
              <div className="text-base text-ink-faint">不使用策略参数</div>
            </Field>
          ) : (
            <Field label="策略">
              <Select value={strategyId ?? ''} onChange={(e) => setStrategyId(Number(e.target.value))}>
                {strategies.map((strategy) => (
                  <option key={strategy.id} value={strategy.id}>
                    {strategy.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="周期间隔（分钟）">
            <NumberInput value={cycleIntervalMinutes} onValueChange={setCycleIntervalMinutes} step={1} />
          </Field>

          {/*
            起始权益的来源分两种 —— 与「新建机器人」弹窗同一个判据：

              · **绑了账户**：从该凭证读真实钱包余额（`EquitySourceField`）；
              · **不绑账户**：纯模拟盘，本金是创建时填的模拟本金。

            ⚠️ 原来纯模拟盘也渲染 `EquitySourceField`：那里面有一个「立即从交易所读取」
            按钮，而它在 `exchangeAccountId === 0` 时**永远不发请求**（effect 提前返回），
            点下去什么也不会发生；字段名还写着「钱包余额」，暗示余额来自真实账户。
            一个点了没反应、又在说假话的控件，属于客观缺陷 —— 不是取舍。
            模拟本金本身不在这里改：服务端 PATCH 支持它，但控制台没有这条编辑路径
            （见汇报里的"发现但未修"）。
          */}
          {trader.exchangeAccountId === null ? (
            <Field
              label="模拟盘起始余额（USDT）"
              hint="纯模拟盘机器人不绑任何交易所账户；模拟钱包余额 = 本金 + 已实现净额。本金在创建时设定。"
            >
              <div className="num text-base text-ink-mid">
                {paperStartingBalance === null ? '—（首次启动时使用默认本金）' : fmtAsset(paperStartingBalance, 'USDT', 2)}
              </div>
            </Field>
          ) : (
            <EquitySourceField state={equity} editing />
          )}          {baselineWarning && (
            <div className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-base text-warn">
              <span className="font-semibold">权益基准为 0。</span> {baselineWarning}
            </div>
          )}

          <div className="flex items-start gap-2 rounded-md border border-base-800 bg-base-850/50 px-3 py-2">
            <Badge tone="muted" className="mt-px">
              不可变更
            </Badge>
            <span className="text-xs leading-relaxed text-ink-lo">
              运行模式（模拟 / 实盘）在创建机器人时固定，不在此处修改。最近周期 #{trader.lastCycleNumber}。
              停止中的机器人保存后会立即生效，但不会自动重新启动。
            </span>
          </div>

          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      )}
    </Modal>
  );
}
