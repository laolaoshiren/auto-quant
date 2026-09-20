/**
 * 帮助 / 常见问题。
 *
 * 读者画像很具体：**出事了的人**。所以这一页的质量标准不是"好看"，是"读得下去"：
 *
 * - 正文 `text-md`（14px）而不是 `text-xs`，行高放宽 —— 这一页是本项目里
 *   唯一需要连续阅读的长文，也是 `DESIGN.md` §3 的字号体系里唯一"越大越好"的场景；
 * - 左栏是目录（`LAYOUT.md` §1 的指标栏位置放"这里有什么"），主区是问答与清单：
 *   目录让人先看到全局，正文再用 `SectionLabel` 分出"风险警示 / 常见问题 / 操作员清单"
 *   三级 —— 之前只有一个 18px 的标题，长文读起来是一堵没有接缝的墙；
 * - 风险警示用 `warn` 令牌写在最前面，而不是藏进某一条问答里。
 *
 * 正文对比度用 `ink-mid` 而不是 `ink-faint`：`ink-faint` 是禁用/占位级别的灰，
 * 拿它写一整页说明会让"出事了正在找答案的人"读不下去。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useDocumentTitle } from '../lib/hooks';
import { Badge, Button, Panel, cn } from '../components/ui';
import { SectionHeading } from '../components/Badges';
import { PageShell, SectionLabel } from '../components/shell';

/**
 * 短标题（目录与折叠头用）+ 完整问答。
 *
 * `id` 是干净的 ASCII：锚点要能在 URL 里出现（`#faq-live-vs-demo`），
 * 用中文 id 虽然合法但复制出来会被转义成一串百分号。
 */
const FAQ: Array<{ id: string; q: string; short: string; a: string }> = [
  {
    id: 'faq-live-vs-demo',
    q: '模拟与实盘到底有什么差别？',
    short: '模拟 vs 实盘',
    a: '模拟模式会在启动请求里设置 dryRun: true。行情、选币、指标计算、模型调用、风控复核与审计记录都与实盘完全一致 — 只有下单是模拟的，成交按真实价格记录。实盘模式会用你保存的密钥把同样的请求发到交易所，因此每一单都是用真金白银下的真实订单。',
  },
  {
    id: 'faq-stop-loss',
    q: '为什么止损挂在交易所，而不是放在机器人里？',
    short: '止损为什么挂在交易所',
    a: '只存在于本进程内的止损会随进程一起消失。如果 VPS 重启、网络中断或模型卡住，本地止损永远不会触发，一笔小亏就会变成无底洞。把止损作为交易所侧的真实挂单，意味着交易所会替我们强制执行。这就是 requireStopLoss 默认为 true 的原因，也是 fallbackStopLossPercent 存在的原因（模型漏给止损时，开仓依然带止损），以及持仓页会给没有止损的持仓打上醒目警告的原因。',
  },
  {
    id: 'faq-drawdown-guard',
    q: '回撤守卫做什么？',
    short: '回撤守卫',
    a: '它保护已有浮盈，而不是限制亏损。当一个持仓的峰值浮盈超过 activationPercent 时，守卫启动。如果此后回吐超过该峰值的 givebackRatio（0.5 = 一半），就以市价平仓。一笔曾跑到 +4% 又回到 +2% 的持仓会被平掉，而不是任由它坐一趟过山车变成亏损。',
  },
  {
    id: 'faq-circuit-breaker',
    q: '熔断器做什么？',
    short: '熔断器',
    a: '两道独立的急停。maxDailyLossPercent：当日已实现亏损超过权益的这一比例后，当天不再允许新开仓 — 已有持仓仍会被管理与平仓。maxTotalDrawdownPercent：权益从其高水位回撤到该幅度后停止新开仓。safeModeAfterFailures 配合 safeModeProbeCycles 应对模型或交易所故障：连续失败 N 次后循环进入安全模式，只偶尔探测，而不是每个周期都去猛敲一个已经故障的接口。',
  },
  {
    id: 'faq-throttle',
    q: '限流是干什么用的？',
    short: '限流与冷却',
    a: '语言模型总是很热情。maxEntriesPerCycle 和 maxEntriesPerHour 限制仓位累积的速度，reentryCooldownMinutes 让一个交易对平仓后被锁定一段时间，模型无法立刻把同一个想法再买回来，minHoldMinutes 则防止持仓还没来得及跑出结果就被反向平掉。',
  },
  {
    id: 'faq-symbols',
    q: '币种从哪里来？',
    short: '币种从哪里来',
    a: '四种来源，可在策略工坊中选择：你手写的静态列表、动态排名的币种池（按成交额、涨幅、跌幅、波动率或极端资金费率）、持仓量增长筛选，或以上几者的并集。成交额与持仓量下限始终生效，因此即使某个交易对在你的静态列表里，一旦流动性流失也会被剔除。',
  },
  {
    id: 'faq-audit',
    q: '怎么知道模型在想什么？',
    short: '模型决策的审计链',
    a: '每个周期都完整持久化：系统提示词、用户提示词、思维链、原始响应、解析并经风控调整后的决策、候选列表，以及带逐条状态的动作执行日志。在决策标签页打开任意一行即可审计。那份记录就是产品本身 — 没有可复现的凭证链，就不存在持仓。',
  },
  {
    id: 'faq-key-permissions',
    q: 'API 密钥应该给什么权限？',
    short: 'API 密钥该给什么权限',
    a: '开启合约交易，禁止提现，最好再限制为服务器 IP。如果要存只读密钥，请关掉“该密钥可以下单”；风控引擎会拒绝用它交易。密钥静态存储时加密，且只会以掩码形式返回浏览器 —— 完整密钥永远不会出现在这个界面上。',
  },
  {
    id: 'faq-header-strip',
    q: '页头的图表、时钟偏移和 API 权重是什么？',
    short: '页头的时钟偏移与权重',
    a: '时钟偏移是本机与交易所之间的差异；漂移过大会导致签名错误，所以常驻显示。API 权重是当前分钟已消耗的请求额度与交易所上限之比。两者都取自实时连接，而不是缓存。',
  },
];

const CHECKLIST: ReactNode[] = [
  <>
    在<span className="text-ink-hi">模型</span>页添加一个 AI 模型，反复点<span className="text-ink-hi">测试</span>
    ，直到它报告延迟并回显模型 id。
  </>,
  <>
    在<span className="text-ink-hi">交易所</span>页添加凭证 —— 先用测试网那把，开启合约交易、关闭提现。
    添加后立刻点<span className="text-ink-hi">测试连接</span>，确认余额能读出来。
  </>,
  <>
    在<span className="text-ink-hi">策略工坊</span>中从预设开始，然后逐段阅读并修改每一个提示词段落。
    数字约束模型，文字引导模型。
  </>,
  <>
    创建一个机器人，并用<span className="text-ink-hi">模拟</span>模式启动。读预检行 —— 阻断性失败是红色的。
  </>,
  <>让它跑几天。关注权益曲线、最大回撤和决策审计链，而不只是胜率。</>,
  <>
    只有到那时才考虑实盘，且仓位规模要控制在“全亏了也只是麻烦，而不是问题”的范围。
  </>,
];

export function FaqPage() {
  useDocumentTitle('帮助 / 常见问题');

  /**
   * 默认展开第一条。
   *
   * 全部折叠会让页面看起来像"什么都没有"，全部展开又等于没有折叠。
   * 展开第一条既提示了"点标题能展开"，也把最常问的那个问题直接摊开。
   */
  const [open, setOpen] = useState<Record<string, boolean>>({ [FAQ[0]?.id ?? '']: true });
  const allOpen = FAQ.every((item) => open[item.id]);

  const jump = (id: string) => {
    setOpen((current) => ({ ...current, [id]: true }));
    // 滚动由内容区（Layout 的 <main>）承担，scrollIntoView 会自己找最近的可滚动祖先
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /*
   * 目录里的"当前读到哪一节"。
   *
   * ## 为什么监听 `<main>` 的 scroll，而不是用 `IntersectionObserver`
   *
   * 滚动发生在 `Layout` 的 `<main>` 里（内容区自己滚，顶栏钉住），**viewport 本身
   * 从来不动**。所以 `IntersectionObserver` 用默认 root（viewport）观察不到任何
   * 变化 —— 它会把所有区块都判成"始终可见"。要它工作就得把 `root` 指到 `<main>`，
   * 而那需要把那个元素一路传进来，耦合比这里需要的多。
   *
   * 直接算 `getBoundingClientRect().top` 更省事，而且判据一眼可读：
   * **最后一个顶部越过阈值线的区块，就是当前节**。
   */
  const navIds = useMemo(() => [...FAQ.map((item) => item.id), 'faq-checklist'], []);
  const [activeId, setActiveId] = useState<string>(navIds[0] ?? '');

  useEffect(() => {
    const scroller = document.querySelector('main');
    if (!scroller) return;
    /* 阈值取 120px：大约是一条区块标题刚滚到接近顶部时的位置。 */
    const THRESHOLD = 120;
    const onScroll = () => {
      let current = navIds[0] ?? '';
      for (const id of navIds) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= THRESHOLD) current = id;
      }
      setActiveId(current);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [navIds]);

  /* ------------------------------------------------------------------------ */
  /*  左栏：目录。长文的"这里有什么"                                          */
  /* ------------------------------------------------------------------------ */
  /*
   * ⚠️ **目录不能用 `MetricGroup` 包。**
   *
   * 它是"指标组"，在 `xl` 下排成 **4 列网格** —— 而这里只有一个 `<nav>`，
   * 于是目录被塞进四分之一的栏宽（约 150px），「止损为什么挂在交易所」这种
   * 11 个字的标题必然折成两行，读起来支离破碎。目录要的是**整栏宽度**。
   */
  const rail = (
    /*
     * `sticky top-0`：目录是**导航**，翻到第 7 节时它必须在场。
     *
     * ⚠️ 粘的是 `Layout` 的 `<main>`（滚动容器），不是 viewport —— 所以 `top-0`
     * 指的是"内容区顶部"，正好落在顶栏下面，不需要给顶栏的 h-14 留偏移。
     */
    <section className="sticky top-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">目录</h3>
      <nav aria-label="常见问题目录">
        {/*
          一条竖线把目录从"一列浮动文字"变成**轨道**，当前项在轨道上有一个点。
          在这之前"我读到哪一节了"只能靠猜 —— 而这一页有十节。
        */}
        <ol className="relative space-y-0.5 border-l border-base-750 pl-3">
          {[
            ...FAQ.map((item, index) => ({
              id: item.id,
              label: item.short,
              num: String(index + 1).padStart(2, '0'),
            })),
            { id: 'faq-checklist', label: '操作员清单', num: '10' },
          ].map((entry) => {
            const active = entry.id === activeId;
            return (
              <li key={entry.id} className="relative">
                {active && (
                  <span
                    aria-hidden
                    className="absolute -left-3 top-2 h-4 w-0.5 rounded-full bg-accent"
                  />
                )}
                <button
                  type="button"
                  onClick={() => jump(entry.id)}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-base transition',
                    active ? 'text-ink-hi' : 'text-ink-lo hover:bg-base-850/70 hover:text-ink-hi',
                  )}
                >
                  <span className={cn('num shrink-0 text-xs', active ? 'text-accent' : 'text-ink-faint')}>
                    {entry.num}
                  </span>
                  <span className="min-w-0">{entry.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
    </section>
  );

  return (
    <div className="min-w-0">
      <SectionHeading
        title="这个终端如何运作"
        sub="在投入真金白银之前，值得先弄清楚的机制要点。"
        right={
          <Button
            size="sm"
            onClick={() => setOpen(allOpen ? {} : Object.fromEntries(FAQ.map((item) => [item.id, true])))}
          >
            {allOpen ? (
              <ChevronUp aria-hidden className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown aria-hidden className="h-3.5 w-3.5" />
            )}
            {allOpen ? '全部折叠' : '全部展开'}
          </Button>
        }
      />

      <PageShell aside={rail}>
        {/* 风险警示：整页最重要的一段，放在所有人都会看到的位置 */}
        <section>
          <SectionLabel title="风险警示" />
          {/*
           * 框宽 = 文字宽。原来是整宽的框配 68ch 的文字，右半边空出一大片，
           * 看起来像"文字没排满"；而框一旦收窄到文字宽，它立刻变成一块**重点块**。
           */}
          <div className="max-w-[68ch] rounded-lg border border-warn/50 bg-warn/10 px-4 py-3">
            <h3 className="flex items-center gap-2 text-md font-bold tracking-wide text-warn">
              <span aria-hidden className="rounded border border-warn/50 px-1.5 text-xs">
                !
              </span>
              带杠杆交易永续合约
            </h3>
            <p className="mt-2 text-md leading-relaxed text-ink-hi">
              亏钱的速度会比你读完这一页还快。杠杆放大亏损和放大盈利一样彻底，爆仓可以在几秒内吞掉整个持仓
              — 包括它的保证金。语言模型不是理财顾问，看不到未来，而且时不时会自信地犯错；本控制台的风控
              只能减少伤害，无法消除伤害。<span className="text-warn">模拟模式被设为默认是有原因的</span>
              ：让一个策略跑得足够久，看清它的回撤，再考虑投入真实资金。永远不要用输不起的钱去交易。
            </p>
          </div>
        </section>

        <section>
          <SectionLabel title="常见问题" count={FAQ.length} />
          <div className="space-y-2">
            {FAQ.map((item, index) => {
              const expanded = open[item.id] === true;
              return (
                <div
                  key={item.id}
                  id={item.id}
                  className="scroll-mt-2 rounded-lg border border-base-750 bg-base-900 shadow-panel"
                >
                  <h3>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={`${item.id}-answer`}
                      onClick={() => setOpen((current) => ({ ...current, [item.id]: !expanded }))}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-base-850/60"
                    >
                      <span className="num shrink-0 text-xs text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                      <span className="min-w-0 flex-1 text-lg font-semibold text-ink-hi">{item.q}</span>
                      <ChevronDown
                        aria-hidden
                        className={cn('h-4 w-4 shrink-0 text-ink-faint transition-transform', expanded && 'rotate-180')}
                      />
                    </button>
                  </h3>
                  {expanded && (
                    // 一行长度限制在 ~68 个字符：正文横跨 1600px 时眼睛会丢行
                    <div id={`${item.id}-answer`} className="border-t border-base-800 px-4 py-3">
                      {/* 模型契约名（requireStopLoss 等）保持等宽，正文 14px、行高放宽 */}
                      <p className="max-w-[68ch] text-md leading-relaxed text-ink-mid">{item.a}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section id="faq-checklist" className="scroll-mt-2">
          <SectionLabel title="操作员清单" actions={<Badge tone="muted">按顺序做</Badge>} />
          <Panel bodyClassName="p-3.5">
            <ol className="space-y-2.5">
              {CHECKLIST.map((item, index) => (
                <li key={index} className="flex gap-3">
                  <span className="num mt-0.5 shrink-0 rounded border border-base-700 bg-base-850 px-1.5 text-xs text-ink-lo">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="min-w-0 max-w-[68ch] text-md leading-relaxed text-ink-mid">{item}</span>
                </li>
              ))}
            </ol>
          </Panel>
        </section>
      </PageShell>
    </div>
  );
}
