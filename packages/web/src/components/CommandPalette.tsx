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
import { Badge, Button, Dot, cn } from './ui';

/** 选中一个需要确认的动作后，面板会切成这个状态。 */
type Pending = { kind: 'start'; trader: TraderRow; dryRun: boolean } | { kind: 'run-once'; trader: TraderRow };

const ITEM_CLASS =
  'flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-base text-ink-mid ' +
  'data-[selected=true]:bg-base-850 data-[selected=true]:text-ink-hi';

const GROUP_CLASS =
  '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 ' +
  '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold ' +
  '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-ink-lo';

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

  const startBot = async (trader: TraderRow, dryRun: boolean) => {
    setBusy(true);
    try {
      const result = await api.startTrader(trader.id, dryRun);
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
          body: dryRun ? '模拟模式：订单只在本地撮合，不涉及真实资金。' : '实盘模式：接下来会用真实资金下单。',
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
  const stopped = traders.filter((trader) => !trader.isRunning);
  const runningCount = system?.runningTraders.length ?? running.length;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-overlay backdrop-blur-sm" />
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[8vh]">
          {/* 焦点归还由 Radix 负责：它记下打开前的活动元素，关闭时还回去
              （顶栏搜索按钮、或按 ⌘K 时所在的任何位置）。 */}
          <DialogPrimitive.Content className="panel flex max-h-[80vh] w-full max-w-xl animate-slide-up flex-col overflow-hidden shadow-overlay">
            <DialogPrimitive.Title className="sr-only">命令面板</DialogPrimitive.Title>

            {pending ? (
              <ConfirmStep
                pending={pending}
                busy={busy}
                onDryRunChange={(dryRun) =>
                  setPending((prev) => (prev && prev.kind === 'start' ? { ...prev, dryRun } : prev))
                }
                onCancel={() => setPending(null)}
                onConfirm={() => {
                  if (pending.kind === 'start') void startBot(pending.trader, pending.dryRun);
                  else void runCycle(pending.trader);
                }}
              />
            ) : (
              <Command label="命令面板" loop className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center gap-2 border-b border-base-800 px-3">
                  <Search aria-hidden className="h-4 w-4 shrink-0 text-ink-faint" />
                  <Command.Input
                    autoFocus
                    value={query}
                    onValueChange={setQuery}
                    placeholder="搜索页面、机器人、操作…"
                    className="h-12 w-full bg-transparent text-md text-ink-hi outline-none placeholder:text-ink-faint"
                  />
                  <kbd className="shrink-0 rounded border border-base-700 px-1.5 py-0.5 text-xs text-ink-faint">Esc</kbd>
                </div>

                <Command.List className="min-h-0 flex-1 overflow-y-auto p-2">
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
                            <Dot tone={trader.isRunning ? 'up' : 'muted'} pulse={trader.isRunning} />
                            {trader.isRunning ? '运行中' : '已停止'}
                          </span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}

                  {(running.length > 0 || stopped.length > 0) && (
                    <Command.Group heading="机器人操作" className={GROUP_CLASS}>
                      {running.map((trader) => (
                        <Command.Item
                          key={`stop-${trader.id}`}
                          value={`停止 ${trader.name} stop ${trader.id}`}
                          disabled={busy}
                          className={ITEM_CLASS}
                          onSelect={() => void stopBot(trader)}
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
                          onSelect={() => setPending({ kind: 'start', trader, dryRun: true })}
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

                <div className="flex shrink-0 items-center justify-between gap-2 border-t border-base-800 px-3 py-1.5 text-xs text-ink-faint">
                  <span>↑↓ 选择 · Enter 执行</span>
                  <span className="num">⌘K 开关 · / 打开</span>
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
  onDryRunChange,
}: {
  pending: Pending;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onDryRunChange: (dryRun: boolean) => void;
}) {
  const environmentLabel = useApp((s) => s.system?.environmentLabel ?? '交易所');
  const trader = pending.trader;
  const live = pending.kind === 'start' && !pending.dryRun;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="panel-head shrink-0">
        <h2 className="min-w-0 truncate text-md font-semibold text-ink-hi">
          {pending.kind === 'start' ? `启动「${trader.name}」` : `立即执行一次周期「${trader.name}」`}
        </h2>
        <Button size="icon" variant="ghost" aria-label="关闭" onClick={onCancel}>
          <X aria-hidden className="h-4 w-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {pending.kind === 'start' ? (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => onDryRunChange(true)}
                className={cn(
                  'rounded-md border px-3 py-2 text-left transition',
                  pending.dryRun ? 'border-accent/70 bg-accent/10' : 'border-base-700 bg-base-850 hover:border-base-600',
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="text-base font-semibold text-ink-hi">模拟</span>
                  <Badge tone="accent">dryRun</Badge>
                  <Badge tone="muted">推荐</Badge>
                </span>
                <span className="mt-1 block text-xs text-ink-lo">订单在本地按实时行情撮合，不碰任何真实资金。</span>
              </button>

              <button
                type="button"
                onClick={() => onDryRunChange(false)}
                className={cn(
                  'rounded-md border px-3 py-2 text-left transition',
                  !pending.dryRun ? 'border-warn/70 bg-warn/10' : 'border-base-700 bg-base-850 hover:border-base-600',
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="text-base font-semibold text-ink-hi">实盘</span>
                  <Badge tone="warn">真实资金</Badge>
                </span>
                <span className="mt-1 block text-xs text-ink-lo">
                  在 {environmentLabel} 上真实下单。风控仍会限制杠杆并要求止损，但亏损不可逆。
                </span>
              </button>
            </div>

            {live ? (
              <p className="rounded-md border border-warn/60 bg-warn/10 px-3 py-2 text-base text-warn">
                接下来这个循环会用真实资金开仓。确认前请再核对一次交易所凭证与策略。
              </p>
            ) : (
              <p className="rounded-md border border-base-750 bg-base-850/60 px-3 py-2 text-base text-ink-mid">
                模拟模式：不会产生任何真实委托，可以随时停止。
              </p>
            )}
          </>
        ) : (
          <p className="rounded-md border border-warn/60 bg-warn/10 px-3 py-2 text-base text-warn">
            会立刻让模型做一次决策并执行 —— 如果该机器人是实盘模式，
            <strong className="font-semibold">这一步会真实下单</strong>，不等下一个周期。
          </p>
        )}

        <p className="text-xs leading-relaxed text-ink-faint">
          停止机器人不会自动平仓：已有仓位继续由交易所侧止损 / 止盈保护。
        </p>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-base-800 px-4 py-2.5">
        <Button autoFocus onClick={onCancel}>
          取消
        </Button>
        <Button variant={live ? 'warn' : 'primary'} busy={busy} onClick={onConfirm}>
          {pending.kind === 'start' ? (pending.dryRun ? '以模拟模式启动' : '实盘启动 — 真实资金') : '立即执行'}
        </Button>
      </footer>
    </div>
  );
}
