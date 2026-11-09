/**
 * 命令面板（⌘K / Ctrl+K）。
 *
 * 这是"少动鼠标"最有效的一招：切页面、切机器人、开关循环都不用去点导航。
 *
 * 两条硬规则：
 *
 * 1. **危险操作必须二次确认。** 启动实盘、立即执行周期都可能真的下单，
 *    所以选中之后不是立刻执行，而是把面板换成一段确认页，把后果写清楚
 *    （模式、环境、"真实资金"），默认焦点落在"取消"上。
 * 2. **只调用已经存在的接口。** 这里不发明新的后端行为 —— 用到的
 *    `startTrader` / `stopTrader` / `runTraderOnce` / `checkStrategy`
 *    都是页面里已经在用的那几个。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import {
  Bot,
  FlaskConical,
  KeyRound,
  LoaderCircle,
  Play,
  Search,
  Square,
  TriangleAlert,
  X,
} from 'lucide-react';
import { api, type PreflightCheck, type TraderRow } from '../lib/api';
import { useApp, useEvents } from '../lib/store';
import { usePolled } from '../lib/hooks';
import { useRunOnce } from '../lib/actions';
import type { StrategyRecord } from '@aq/shared';
import { NAV_ITEMS } from './nav';
import { StopConsequence } from './ConfirmStopTrader';
import { Badge, Button, Dot, cn } from './ui';

/** 选中一个需要确认的动作后，面板会切成这个状态。 */
type Pending =
  | { kind: 'run-once'; trader: TraderRow }
  /*
   * ⚠️ `stop` 也走这个 `pending` 流程（外部 issue #121）。
   *
   * 它此前**唯独**这个动作绕过 `pending`，直接在 `onSelect` 里 `void stopBot(trader)` ——
   * 于是"回车即停"。而同一个面板里更轻的「立即执行一次周期」反而是有确认的，
   * 这个不对称本身就是漏改的证据。
   *
   * 为什么必须确认：停止**不会平仓**，误停一台持有杠杆仓位的机器人 =
   * 那些仓位从此没人管保护位。而命令面板是键盘驱动的，误触代价更高。
   */
  | { kind: 'stop'; trader: TraderRow };

const ITEM_CLASS =
  'flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-base text-ink-mid ' +
  'data-[selected=true]:bg-base-850 data-[selected=true]:text-ink-hi ' +
  /* 选中态：底色 + **左侧 2px 主色条**（inset，不改变盒模型）。只用底色的话，
     在深浅两套主题下都偏弱，键盘选择时不容易确认"回车会执行哪一条"。 */
  'data-[selected=true]:[box-shadow:inset_2px_0_0_var(--aq-accent)]';

const GROUP_CLASS =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 ' +
  '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold ' +
  '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.1em] ' +
  '[&_[cmdk-group-heading]]:text-ink-lo';

/** 底部快捷键提示用的键帽。 */
const KBD = 'inline-flex h-4 min-w-4 items-center justify-center rounded border border-base-700 bg-base-850 px-1 text-[10px] leading-none text-ink-lo';

/** 正在输入框里打字时，单键快捷键（`/`、`g`）不该抢走按键。 */
function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const traders = useApp((s) => s.traders);
  const system = useApp((s) => s.system);
  const refreshTraders = useApp((s) => s.refreshTraders);
  const refreshSystem = useApp((s) => s.refreshSystem);
  const notify = useEvents((s) => s.notify);
  const { runOnce, busyId } = useRunOnce();

  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  // 策略列表只有这里需要，所以只在面板打开时拉一次；关掉就不要再轮询。
  const strategiesQuery = usePolled((signal) => api.strategies(signal), { enabled: open });
  const strategies: StrategyRecord[] = strategiesQuery.data ?? [];

  /** `g` 前缀需要记住上一个按键，且只在很短的时间窗内有效。 */
  const jumpPendingRef = useRef(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ⌘K / Ctrl+K：开关面板。即使焦点在输入框里也要生效。
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpenChange(!open);
        return;
      }

      if (open || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;

      // `/` 直接打开面板，省掉"先用鼠标点搜索框"这一步。
      if (event.key === '/') {
        event.preventDefault();
        jumpPendingRef.current = 0;
        onOpenChange(true);
        return;
      }

      // `g` 后接字母跳页（vim 风格）：`g` `t` → 机器人。
      const now = Date.now();
      if (event.key === 'g') {
        jumpPendingRef.current = now;
        return;
      }
      if (now - jumpPendingRef.current < 900) {
        const target = NAV_ITEMS.find((item) => item.jump === event.key.toLowerCase());
        if (target) {
          event.preventDefault();
          jumpPendingRef.current = 0;
          navigate(target.to);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, onOpenChange, open]);

  // 每次关闭都回到干净状态：残留的查询词会让下次打开"看不见全部命令"。
  useEffect(() => {
    if (!open) {
      setQuery('');
      setPending(null);
      setBusy(false);
    }
  }, [open]);

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };

  const stopBot = async (trader: TraderRow) => {
    setBusy(true);
    try {
      await api.stopTrader(trader.id);
      await refreshTraders();
      void refreshSystem();
      notify({ kind: 'ok', title: `「${trader.name}」已停止`, body: '循环已退出；已开的仓位不会自动平掉。' });
      onOpenChange(false);
    } catch (error) {
      notify({ kind: 'error', title: `「${trader.name}」停止失败`, body: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const startBot = async (trader: TraderRow) => {
    setBusy(true);
    try {
      /* 运行模式在创建时就已固定，启动不再选择（2026-11-10）。 */
      const fixedDryRun = trader.dryRun ?? true;
      const result = await api.startTrader(trader.id);
      await refreshTraders();
      void refreshSystem();
      const blocking = (result.preflight ?? []).filter((check) => !check.ok && check.blocking);
      if (!result.ok || blocking.length > 0) {
        notify({
          kind: 'error',
          title: `「${trader.name}」未通过预检`,
          body: blocking.map((check) => check.name).join('、') || result.error || '启动被拒绝。',
        });
      } else {
        notify({
          kind: 'ok',
          title: `「${trader.name}」已启动`,
          body: fixedDryRun ? '模拟盘：订单只在本地撮合，不涉及真实资金。' : '实盘：接下来会用真实资金下单。',
        });
      }
      onOpenChange(false);
    } catch (error) {
      // 预检失败会以 4xx + preflight 列表返回，列表比一句错误信息有用得多。
      const payload = (error as Error & { payload?: { preflight?: PreflightCheck[] } }).payload;
      const blocking = (payload?.preflight ?? []).filter((check) => !check.ok && check.blocking);
      notify({
        kind: 'error',
        title: `「${trader.name}」启动失败`,
        body: blocking.length > 0 ? blocking.map((check) => `${check.name}：${check.detail}`).join('；') : (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  const runCycle = async (trader: TraderRow) => {
    await runOnce(trader.id, trader.name);
    onOpenChange(false);
  };

  /**
   * 跑一次策略体检。
   *
   * 接口要求一个模型 id，但策略本身不带模型（模型是绑在机器人上的），
   * 所以优先用"正在用这个策略的机器人"的模型，没有就退到第一个可用模型。
   * 体检全程跑在模拟账户上，不下任何真实订单，因此不需要二次确认。
   */
  const checkStrategy = async (strategy: StrategyRecord) => {
    setBusy(true);
    try {
      const models = await api.aiModels();
      if (models.length === 0) throw new Error('还没有配置 AI 模型 —— 请先到「AI 模型」页添加。');
      const preferredId = traders.find((trader) => trader.strategyId === strategy.id)?.aiModelId;
      const chosen = models.find((model) => model.id === preferredId) ?? models[0];
      if (!chosen) throw new Error('没有可用的 AI 模型。');

      const result = await api.checkStrategy(strategy.id, { aiModelId: chosen.id });
      notify({
        kind: result.ok ? 'ok' : 'error',
        title: `策略体检 · ${strategy.name}`,
        body: `${result.verdict}（模型：${chosen.label}）`,
      });
      onOpenChange(false);
    } catch (error) {
      notify({ kind: 'error', title: `策略体检 · ${strategy.name}`, body: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const running = traders.filter((trader) => trader.isRunning);
  /*
   * ⚠️ **`starting` 不能混进 `stopped`**（2026-11-10 回归实测）。
   *
   * 启动是异步的（`stopped → starting → running`）。之前 `stopped` 只判
   * `!isRunning`，于是**刚点过启动的那台**会在面板里继续显示「启动」项 ——
   * 再回车一次 → 服务端拒绝「正在启动中」，面板只弹一条错误提示。
   * 现在它单独成一项、禁用，文案与列表页一致。
   */
  const starting = traders.filter((trader) => !trader.isRunning && trader.status === 'starting');
  const stopped = traders.filter((trader) => !trader.isRunning && trader.status !== 'starting');
  const runningCount = system?.runningTraders.length ?? running.length;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-overlay backdrop-blur-sm" />
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[8vh]">
          {/* 焦点归还由 Radix 负责：它记下打开前的活动元素，关闭时还回去
              （顶栏搜索按钮、或按 ⌘K 时所在的任何位置）。 */}
          <DialogPrimitive.Content className="panel flex max-h-[72vh] w-full max-w-xl animate-slide-up flex-col overflow-hidden shadow-overlay">
            <DialogPrimitive.Title className="sr-only">命令面板</DialogPrimitive.Title>

            {pending ? (
              <ConfirmStep
                pending={pending}
                busy={busy}
                onCancel={() => setPending(null)}
                onConfirm={() => {
                  if (pending.kind === 'stop') void stopBot(pending.trader);
                  else void runCycle(pending.trader);
                }}
              />
            ) : (
              <Command label="命令面板" loop className="flex min-h-0 flex-1 flex-col">
                {/*
                  ⚠️ **搜索框不要那圈粗焦点环**（2026-11-10 用户反馈：
                  「输入框有很重的蓝色 focus ring，且与容器边缘重叠」）。
                  quill 的全局 `html.aq-quill :focus-visible` 是 0,2,1，压过
                  Tailwind 的 `outline-none`（0,1,0）；而面板一打开焦点就在这个
                  输入框上，那圈环没有传达任何新信息，只让顶部显得脏。用内联
                  `outline: none`（内联样式优先级最高）+ 输入行底部的一条 focus 线
                  代替它 —— 输入区本身已经是"当前在打字"的视觉信号。
                */}
                <div className="flex shrink-0 items-center gap-2 border-b border-base-800 px-3 transition-colors focus-within:border-accent/60">
                  <Search aria-hidden className="h-4 w-4 shrink-0 text-ink-lo" />
                  <Command.Input
                    autoFocus
                    value={query}
                    onValueChange={setQuery}
                    placeholder="搜索页面、机器人、操作…"
                    style={{ outline: 'none' }}
                    className="h-11 w-full bg-transparent text-md text-ink-hi placeholder:text-ink-faint"
                  />
                  <kbd className={KBD}>Esc</kbd>
                </div>

                <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5">
                  <Command.Empty className="px-3 py-8 text-center text-base text-ink-lo">
                    没有匹配的结果。
                    <span className="mt-1 block text-xs text-ink-faint">试试页面名、机器人名，或「停止」「体检」。</span>
                  </Command.Empty>

                  <Command.Group heading="页面" className={GROUP_CLASS}>
                    {NAV_ITEMS.map((item) => (
                      <Command.Item
                        key={item.to}
                        value={`${item.label} ${item.to}`}
                        className={ITEM_CLASS}
                        onSelect={() => go(item.to)}
                      >
                        <item.icon aria-hidden className="h-4 w-4 shrink-0 text-ink-faint" />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.to === '/traders' && runningCount > 0 && <Badge tone="up">{runningCount} 运行中</Badge>}
                      </Command.Item>
                    ))}
                    {/* 旧链接仍然可达，所以命令面板里也给一条。 */}
                    <Command.Item value="设置 settings" className={ITEM_CLASS} onSelect={() => go('/settings')}>
                      <KeyRound aria-hidden className="h-4 w-4 shrink-0 text-ink-faint" />
                      <span className="min-w-0 flex-1 truncate">设置</span>
                      <span className="text-xs text-ink-faint">旧入口</span>
                    </Command.Item>
                  </Command.Group>

                  {traders.length > 0 && (
                    <Command.Group heading="切换机器人" className={GROUP_CLASS}>
                      {traders.map((trader) => (
                        <Command.Item
                          key={trader.id}
                          value={`机器人 ${trader.name} trader ${trader.id}`}
                          className={ITEM_CLASS}
                          onSelect={() => go(`/traders/${trader.id}`)}
                        >
                          <Bot aria-hidden className="h-4 w-4 shrink-0 text-ink-faint" />
                          <span className="min-w-0 flex-1 truncate">{trader.name}</span>
                          <span className="flex shrink-0 items-center gap-1.5 text-xs text-ink-lo">
                            <Dot
                              tone={trader.isRunning ? 'up' : trader.status === 'starting' ? 'warn' : 'muted'}
                              pulse={trader.isRunning || trader.status === 'starting'}
                            />
                            {trader.isRunning ? '运行中' : trader.status === 'starting' ? '启动中' : '已停止'}
                          </span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}

                  {(running.length > 0 || stopped.length > 0) && (
                    <Command.Group heading="机器人操作" className={GROUP_CLASS}>
                      {starting.map((trader) => (
                        <Command.Item
                          key={`starting-${trader.id}`}
                          value={`启动中 ${trader.name} starting ${trader.id}`}
                          disabled
                          className={ITEM_CLASS}
                        >
                          <LoaderCircle aria-hidden className="h-4 w-4 shrink-0 animate-spin text-ink-faint" />
                          <span className="min-w-0 flex-1 truncate">启动中「{trader.name}」</span>
                          <span className="shrink-0 text-xs text-ink-faint">正在预检</span>
                        </Command.Item>
                      ))}
                      {running.map((trader) => (
                        <Command.Item
                          key={`stop-${trader.id}`}
                          value={`停止 ${trader.name} stop ${trader.id}`}
                          disabled={busy}
                          className={ITEM_CLASS}
                          onSelect={() => setPending({ kind: 'stop', trader })}
                        >
                          <Square aria-hidden className="h-4 w-4 shrink-0 text-down" />
                          <span className="min-w-0 flex-1 truncate">停止「{trader.name}」</span>
                          {busyId === trader.id && <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />}
                        </Command.Item>
                      ))}
                      {running.map((trader) => (
                        <Command.Item
                          key={`once-${trader.id}`}
                          value={`立即执行 周期 ${trader.name} run once ${trader.id}`}
                          className={ITEM_CLASS}
                          onSelect={() => setPending({ kind: 'run-once', trader })}
                        >
                          <Play aria-hidden className="h-4 w-4 shrink-0 text-accent" />
                          <span className="min-w-0 flex-1 truncate">立即执行一次周期「{trader.name}」</span>
                          {busyId === trader.id && <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />}
                        </Command.Item>
                      ))}
                      {stopped.map((trader) => (
                        <Command.Item
                          key={`start-${trader.id}`}
                          value={`启动 ${trader.name} start ${trader.id}`}
                          className={ITEM_CLASS}
                          onSelect={() => void startBot(trader)}
                        >
                          <Play aria-hidden className="h-4 w-4 shrink-0 text-up" />
                          <span className="min-w-0 flex-1 truncate">启动「{trader.name}」</span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}

                  {strategies.length > 0 && (
                    <Command.Group heading="策略" className={GROUP_CLASS}>
                      {strategies.map((strategy) => (
                        <Command.Item
                          key={`open-${strategy.id}`}
                          value={`打开策略 ${strategy.name} strategy ${strategy.id}`}
                          className={ITEM_CLASS}
                          onSelect={() => go(`/strategy/${strategy.id}`)}
                        >
                          <FlaskConical aria-hidden className="h-4 w-4 shrink-0 text-ink-faint" />
                          <span className="min-w-0 flex-1 truncate">{strategy.name}</span>
                          <span className="shrink-0 text-xs text-ink-faint">打开</span>
                        </Command.Item>
                      ))}
                      {strategies.map((strategy) => (
                        <Command.Item
                          key={`check-${strategy.id}`}
                          value={`策略体检 检查 ${strategy.name} check ${strategy.id}`}
                          disabled={busy}
                          className={ITEM_CLASS}
                          onSelect={() => void checkStrategy(strategy)}
                        >
                          <TriangleAlert aria-hidden className="h-4 w-4 shrink-0 text-accent" />
                          <span className="min-w-0 flex-1 truncate">对「{strategy.name}」跑一次策略体检</span>
                          <span className="shrink-0 text-xs text-ink-faint">不下单 · 约 10-60 秒</span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}

                  {strategiesQuery.loading && (
                    <div className="flex items-center gap-2 px-2.5 py-3 text-xs text-ink-faint">
                      <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
                      正在读取策略…
                    </div>
                  )}
                </Command.List>

                <div className="flex shrink-0 items-center justify-between gap-2 border-t border-base-800 px-3 py-1.5 text-xs text-ink-lo">
                  <span className="flex items-center gap-1.5">
                    <kbd className={KBD}>↑</kbd>
                    <kbd className={KBD}>↓</kbd>
                    <span>选择</span>
                    <kbd className={KBD}>↵</kbd>
                    <span>执行</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <kbd className={KBD}>⌘K</kbd>
                    <span>开关</span>
                    <kbd className={KBD}>/</kbd>
                    <span>打开</span>
                  </span>
                </div>
              </Command>
            )}
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * 二次确认。
 *
 * 默认停在「模拟」上：想用真钱的人必须**主动**多点一下，而不是手滑按到 Enter
 * 就把实盘循环拉起来。实盘那一路整段用警告色，并把环境名写出来。
 */
function ConfirmStep({
  pending,
  busy,
  onCancel,
  onConfirm,

}: {
  pending: Pending;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const trader = pending.trader;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="panel-head shrink-0">
        <h2 className="min-w-0 truncate text-md font-semibold text-ink-hi">
          {pending.kind === 'stop' ? `停止「${trader.name}」` : `立即执行一次周期「${trader.name}」`}
        </h2>
        <Button size="icon" variant="ghost" aria-label="关闭" onClick={onCancel}>
          <X aria-hidden className="h-4 w-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {pending.kind === 'stop' ? (
          /* 后果文案与另外三个入口共用同一份（见 `ConfirmStopTrader.tsx`）。 */
          <StopConsequence name={trader.name} />
        ) : (
          <p className="rounded-md border border-warn/60 bg-warn/10 px-3 py-2 text-base text-warn">
            会立刻让模型做一次决策并执行 —— 如果该机器人是实盘模式，
            <strong className="font-semibold">这一步会真实下单</strong>，不等下一个周期。
          </p>
        )}

      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-base-800 px-4 py-2.5">
        <Button autoFocus onClick={onCancel}>
          取消
        </Button>
        {/*
          stop 用 danger（与另外三个入口一致），而不是 primary ——
          这是**停止真实在跑的循环**，不是"继续"。
        */}
        <Button
          variant={pending.kind === 'stop' ? 'danger' : 'warn'}
          busy={busy}
          onClick={onConfirm}
        >
          {pending.kind === 'stop' ? '确认停止' : '立即执行'}
        </Button>
      </footer>
    </div>
  );
}
