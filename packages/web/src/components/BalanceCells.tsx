/**
 * Balance cells shared by the 交易所 credentials table and the trader dashboard.
 *
 * Both screens read the same exchange figures, so the vocabulary comes from
 * `BALANCE_LABEL` rather than being spelled out per screen — 钱包余额 has to mean
 * one number everywhere, or the operator has to guess which one is settled.
 */
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { Badge, Button } from './ui';
import {
  BALANCE_LABEL,
  DEFAULT_SETTLE_ASSET,
  fmtAsset,
  fmtInt,
  fmtNum,
  fmtSigned,
  pnlColor,
  timeAgo,
  fmtTime,
} from '../lib/format';
import type { ExchangeBalance } from '../lib/api';

/* -------------------------------------------------------------------------- */
/*  One credential's live balance                                              */
/* -------------------------------------------------------------------------- */

/**
 * The 余额 cell of the credentials table.
 *
 * Three lines, in the order an operator reads them:
 *
 *   1. 权益 — the margin balance, i.e. what the bot actually trades with;
 *   2. 钱包 / 可用 — the settled balance the exchange's own app calls
 *      “钱包余额”, plus what is still free;
 *   3. 未实现 — only when there is one, coloured by sign.
 *
 * A failed read is rendered as a warning here rather than as an empty cell:
 * “we could not read this” is information, a blank is not.
 */
export function BalanceCell({
  balance,
  error,
  testnet,
  now,
}: {
  balance: ExchangeBalance | null;
  error: string | null;
  testnet: boolean;
  /** Ticking clock, so the relative read time stays honest between renders. */
  now: number;
}) {
  const env = <Badge tone={testnet ? 'muted' : 'warn'}>{testnet ? '测试网' : '主网'}</Badge>;

  if (!balance) {
    const message = error ?? '尚未读取到余额。';
    /*
   * 账户上非本机器人的交易 —— 一句**安静的事实说明**。
   *
   * 提到变量里是因为**两个渲染分支都要用它**：第一次只加在"有实时读数"
   * 那个分支里，而机器人停止时走的是另一个分支，于是它一次都没显示过。
   */
  return (
      <div className="w-[196px] max-w-full space-y-1 whitespace-normal">
        <div className="flex items-start gap-1.5">
          {/*
           * An icon rather than a `⚠` character: the font fallback for that
           * glyph is a different width on every platform, so the wrapped second
           * line of the message used to indent differently on Windows and macOS.
           */}
          <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
          <span className="min-w-0 flex-1 text-xs text-warn" title={`余额读取失败：${message}`}>
            余额读取失败：{message}
          </span>
          {env}
        </div>
        <div className="pl-5 text-xs text-ink-faint">点右侧刷新按钮重试。</div>
      </div>
    );
  }

  const asset = balance.asset?.trim() || DEFAULT_SETTLE_ASSET;

  return (
    <div className="num w-[196px] max-w-full space-y-0.5 whitespace-normal">
      <div className="flex items-center gap-1.5">
        <span
          className="text-xs font-semibold text-ink-hi"
          title={`${BALANCE_LABEL.equity}（保证金余额 = 钱包 + 未实现盈亏）。这是「交易所账户」的权益，同一账户下的所有机器人共用这一个钱包。`}
        >
          {fmtAsset(balance.equity, asset)}
        </span>
        <span className="text-xs text-ink-faint">{BALANCE_LABEL.short.equity}</span>
        {env}
      </div>
      <div className="text-xs text-ink-lo">
        {BALANCE_LABEL.short.wallet} {fmtNum(balance.walletBalance)} · {BALANCE_LABEL.short.available}{' '}
        {fmtNum(balance.availableBalance)}
      </div>
      {balance.unrealizedPnl !== 0 && (
        <div className={`text-xs ${pnlColor(balance.unrealizedPnl)}`}>
          {BALANCE_LABEL.unrealized} {fmtSigned(balance.unrealizedPnl)}
        </div>
      )}
      <div className="text-xs text-ink-faint" title={`读取于 ${fmtTime(balance.readAt)}`}>
        读取于 {timeAgo(balance.readAt)}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Trader dashboard account panel                                             */
/* -------------------------------------------------------------------------- */

/** The live account object `GET /traders/:id/account` returns. */
export interface TraderAccountState {
  equity: number;
  walletBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginUsed: number;
  openOrderMargin?: number;
}

/**
 * The trader dashboard's account strip.
 *
 * Shares `BALANCE_LABEL` / `fmtAsset` with the credentials table on purpose:
 * 钱包余额 must mean the same number on both screens, otherwise the operator
 * has to guess which one is the settled balance.
 *
 * Laid out as one inline row: every figure carries its label and its unit, so the
 * strip stays scannable when it wraps to two lines on a narrow window.
 *
 * 版式：它现在是交易页主栏里的一行（右栏是决策流），带一个分组标题和上下边线，
 * 正是为了让这件事一眼可见：这些数字属于**交易所账户**（共享钱包），
 * 与上方那四张只讲本机器人的指标卡不是一个口径。以前它无标题地贴在归属权益下面，
 * 一个从未成交的机器人看起来也"有余额"。
 */
export function TraderAccountStrip({
  account,
  asset,
  busy,
  onRefresh,
  error,
  lastKnown,
  foreign,
}: {
  account: TraderAccountState | null;
  asset?: string;
  busy?: boolean;
  onRefresh?: () => void;
  error?: string | null;
  /**
   * 最近一条快照上的交易所读数。只在 `account` 为 null（机器人没在跑、
   * 拿不到实时值）时使用，用来回答「那上次看到的是多少」。
   *
   * `at` 是那条快照的时间 —— **必须显示出来**：一个陈旧的数字冒充实时，
   * 比不显示更糟。
   */
  lastKnown?: { account: TraderAccountState; at: string } | null;
  /**
   * 账户上**非本平台机器人**的交易 —— 一句安静的事实说明。
   *
   * ## 为什么它是这个语气
   *
   * 同一个钱包上「AI 在跑 + 用户自己手动做单」是**完全正当**的用法。
   * 原来它是一整块红色警示区、末尾还写「请立刻检查账户安全」——
   * 那**假设了恶意**，而对一个正常手动交易的用户，那块警示每次开面板
   * 都占着一整块、还在暗示他的账户出了问题。
   *
   * 系统的职责是**陈述事实**：这一行只说明「归属权益与余额的差额从哪来」。
   * 它分不清"用户手动"和"被盗"，而拿不准的事不该由它下结论。
   */
  foreign?: { rounds: number; net: number } | null;
}) {
  const unit = asset?.trim() || DEFAULT_SETTLE_ASSET;
  const openOrderMargin = account?.openOrderMargin ?? 0;

  /** 分组标题：与 `MetricGroup` 的组名同一套排版，让"这是另一组数字"一眼可见。 */
  const heading = (
    <span
      className="font-sans text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint"
      title="这些是「交易所账户」（共享钱包）的数字：同一账户下的所有机器人读数是同一个，所以它不等于任何一个机器人的归属权益。"
    >
      交易所账户
    </span>
  );
  /*
   * ⚠️ **这里原来写的是「非本机器人的交易」—— 那句话是错的，而且会吓到人。**
   *
   * 实际判据只有一条：**这个回合的入口单号在我们的 `orders` 表里查不到**
   * （`autoTrader.ts` 的归属闸门 `allOrders.has(trip.entryOrderId)`）。
   * 但"单号查不到"**不等于**"不是本机器人下的" —— 至少三种情况都会命中：
   *
   *   ① **本机器人自己的成交，但本地订单行缺失**（交易所侧触发的成交、
   *      历史清理、或迁移前的老单）；
   *   ② 用户或其它工具在同一账户上下的单；
   *   ③ 同一账户下另一个机器人的成交。
   *
   * 用户的原话：「**我完全没有手动操作过账户**……这是你系统内部应该处理完美的
   * 问题」—— 他就是被"非本机器人"这四个字误导的。实测那台机器人：8 笔、
   * 净额只有 **-0.0463 USDT**（平均每笔 -0.006，手续费量级），更像第 ① 种。
   *
   * **系统分不清这三者，所以只陈述事实、不下结论** —— 这与文件里另一条原则一致：
   * 「拿不准的事不该由它下结论」（见上面那段关于"账户可能被盗"的注释）。
   */
  const foreignNote =
    foreign != null && foreign.rounds > 0 ? (
      <span
        className="text-ink-faint"
        title={
          `账户上有 ${foreign.rounds} 笔成交没有匹配到本机器人的订单记录，` +
          `净 ${fmtSigned(foreign.net, 4)} ${unit}。` +
          '它们的盈亏直接从余额进出，不计入本机器人的绩效。\n\n' +
          '⚠️ 这**不代表**有人手动交易过。常见原因有三种：\n' +
          '  ① 本机器人自己的成交，但本地订单行缺失（交易所侧触发、或历史清理）；\n' +
          '  ② 你或你的其它工具在同一个账户上下的单；\n' +
          '  ③ 同一账户下另一个机器人的成交。\n\n' +
          '系统无法区分这三者，所以只陈述事实。'
        }
      >
        另有 <span className="text-ink-mid">{fmtInt(foreign.rounds)}</span> 笔未归属到本机器人的成交
        <span className="text-ink-mid"> {fmtSigned(foreign.net, 4)}</span>
      </span>
    ) : null;


  if (!account) {
    /*
     * 机器人没在运行时无实时读数。
     *
     * ⚠️ 这里原来写的是「未连接交易所」，**那是一句不成立的话**：凭证早就配好了，
     * 只是这个机器人当前没在跑、所以没有实时读数。操作者看到「未连接」会去交易所
     * 页面重新检查凭证 —— 那是白跑一趟，而且会让人怀疑自己的配置。
     *
     * 说清楚"没有读数"和"没有连接"的区别，是这一行唯一要做的事。
     */
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-base-800 bg-base-900/40 px-3 py-2 text-xs text-ink-lo">
        {heading}
        {error ? (
          <>
            <Badge tone="down">读取失败</Badge>
            <span className="text-warn">{error}</span>
          </>
        ) : (
          <>
            {/*
              ⚠️ 这里原来还报一遍钱包与可用 —— 现在那两个数在上面的「账户余额」卡里
              （用户的原话是「信息不要重复、多余」）。**这一行只剩它独有的两样**：
              读数有多旧、以及账户上不属于本机器人的交易。
            */}
            {lastKnown ? (
              <>
                <Badge tone="muted">上次读数</Badge>
                <span className="text-ink-faint">{timeAgo(lastKnown.at)}</span>
                <span className="text-ink-faint">
                  （机器人运行时记录的交易所真实余额，完整读数见上方指标卡）
                </span>
                {/*
                  ⚠️ **两个分支都要有这一句。**

                  第一次加的时候只加在了"有实时读数"那个分支里，
                  而机器人停止时页面走的是**这个**分支 —— 于是它一次都没显示过。
                  所以把它提成上面的 `foreignNote`，两处共用同一个节点。
                */}
                {foreignNote}
              </>
            ) : (
              <>
                <Badge tone="muted">暂无读数</Badge>
                <span>机器人启动后这里会显示交易所的真实账户余额（共享钱包）。</span>
              </>
            )}
          </>
        )}
      </div>
    );
  }


  return (
    <div className="num flex flex-wrap items-baseline gap-x-4 gap-y-1 border-y border-base-800 bg-base-900/40 px-3 py-2 text-xs text-ink-lo">
      {heading}
      {/*
        ⚠️ **这一行原来的五个数字，全部搬去了上面的指标卡。**

        用户这一轮的原话是「页面上信息不要重复、多余、杂乱」，而他点名要一眼看到的
        五项里有两项（**账户余额 / 保证金占用**）此前**只住在这一行里**、以 12px 的
        字号出现 —— 主次是颠倒的。

        于是做了一次搬家（`TraderPage.tsx` 的 `metricCards`）：

          账户权益 → 「账户余额」卡的主数字
          钱包余额 → 那张卡的副行
          可用     → 那张卡的副行
          未实现   → 「保证金占用」卡的副行
          保证金占用 → 「保证金占用」卡的主数字

        搬完之后这一行**不能再报一遍** —— 那正是用户说的"重复"。
        这里只留**别处没有的东西**：

          · **挂单占用** —— 它不属于任何一张卡（挂单不是持仓），却解释着"保证金
            为什么比持仓占的多"，删掉会让那个差额变得无法解释；
          · **读数时间** —— 快照兜底时最要紧的是"这个数有多旧"；
          · **foreignNote** —— 账户上不属于本机器人的交易（一句安静的事实）；
          · **刷新按钮** —— 唯一能手动重读账户的入口。

        `title` 保留完整口径，需要时鼠标放上去仍然查得到。
      */}
      <span
        className="text-ink-faint"
        title={
          `交易所账户（共享钱包）的权益 = 钱包 + 未实现盈亏。` +
          `同一账户下的所有机器人共用这一个数，所以它不等于本机器人的归属权益。` +
          `完整读数（钱包 / 可用 / 保证金 / 权益）见上方指标卡。`
        }
      >
        账户权益（共享钱包）
      </span>
      {openOrderMargin > 0 && (
        <span>
          {BALANCE_LABEL.openOrderMargin} <span className="text-ink-hi">{fmtNum(openOrderMargin)}</span>
        </span>
      )}
      {foreignNote}
      {onRefresh && (
        /* Label plus icon: a bare `⟳` glyph is unreadable to a screen reader and
           ambiguous to anyone who has not used this app before. */
        <Button small variant="ghost" busy={busy} title="重新从交易所读取账户余额" onClick={onRefresh}>
          <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          刷新余额
        </Button>
      )}
    </div>
  );
}
