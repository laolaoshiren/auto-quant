import { useDocumentTitle } from '../lib/hooks';
import { Panel } from '../components/ui';
import { SectionHeading } from '../components/Badges';

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: '模拟与实盘到底有什么差别？',
    a: '模拟模式会在启动请求里设置 dryRun: true。行情、选币、指标计算、模型调用、风控复核与审计记录都与实盘完全一致 — 只有下单是模拟的，成交按真实价格记录。实盘模式会用你保存的密钥把同样的请求发到交易所，因此每一单都是用真金白银下的真实订单。',
  },
  {
    q: '为什么止损挂在交易所，而不是放在机器人里？',
    a: '只存在于本进程内的止损会随进程一起消失。如果 VPS 重启、网络中断或模型卡住，本地止损永远不会触发，一笔小亏就会变成无底洞。把止损作为交易所侧的真实挂单，意味着交易所会替我们强制执行。这就是 requireStopLoss 默认为 true 的原因，也是 fallbackStopLossPercent 存在的原因（模型漏给止损时，开仓依然带止损），以及持仓页会给没有止损的持仓打上醒目警告的原因。',
  },
  {
    q: '回撤守卫做什么？',
    a: '它保护已有浮盈，而不是限制亏损。当一个持仓的峰值浮盈超过 activationPercent 时，守卫启动。如果此后回吐超过该峰值的 givebackRatio（0.5 = 一半），就以市价平仓。一笔曾跑到 +4% 又回到 +2% 的持仓会被平掉，而不是任由它坐一趟过山车变成亏损。',
  },
  {
    q: '熔断器做什么？',
    a: '两道独立的急停。maxDailyLossPercent：当日已实现亏损超过权益的这一比例后，当天不再允许新开仓 — 已有持仓仍会被管理与平仓。maxTotalDrawdownPercent：权益从其高水位回撤到该幅度后停止新开仓。safeModeAfterFailures 配合 safeModeProbeCycles 应对模型或交易所故障：连续失败 N 次后循环进入安全模式，只偶尔探测，而不是每个周期都去猛敲一个已经故障的接口。',
  },
  {
    q: '限流是干什么用的？',
    a: '语言模型总是很热情。maxEntriesPerCycle 和 maxEntriesPerHour 限制仓位累积的速度，reentryCooldownMinutes 让一个交易对平仓后被锁定一段时间，模型无法立刻把同一个想法再买回来，minHoldMinutes 则防止持仓还没来得及跑出结果就被反向平掉。',
  },
  {
    q: '币种从哪里来？',
    a: '四种来源，可在策略工坊中选择：你手写的静态列表、动态排名的币种池（按成交额、涨幅、跌幅、波动率或极端资金费率）、持仓量增长筛选，或以上几者的并集。成交额与持仓量下限始终生效，因此即使某个交易对在你的静态列表里，一旦流动性流失也会被剔除。',
  },
  {
    q: '怎么知道模型在想什么？',
    a: '每个周期都完整持久化：系统提示词、用户提示词、思维链、原始响应、解析并经风控调整后的决策、候选列表，以及带逐条状态的动作执行日志。在决策标签页打开任意一行即可审计。那份记录就是产品本身 — 没有可复现的凭证链，就不存在持仓。',
  },
  {
    q: 'API 密钥应该给什么权限？',
    a: '开启合约交易，禁止提现，最好再限制为服务器 IP。如果要存只读密钥，请关掉“该密钥可以下单”；风控引擎会拒绝用它交易。密钥静态存储时加密，且只会以掩码形式返回浏览器。',
  },
  {
    q: '页头的图表、时钟偏移和 API 权重是什么？',
    a: '时钟偏移是本机与交易所之间的差异；漂移过大会导致签名错误，所以常驻显示。API 权重是当前分钟已消耗的请求额度与交易所上限之比。两者都取自实时连接，而不是缓存。',
  },
];

export function FaqPage() {
  useDocumentTitle('帮助 / 常见问题');
  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <SectionHeading title="这个终端如何运作" sub="在投入真金白银之前，值得先弄清楚的机制要点。" />

      <div className="rounded border border-down/50 bg-down/10 px-3 py-2.5">
        <div className="text-xs font-bold uppercase tracking-wide text-down">风险警示</div>
        <p className="mt-1 text-xs leading-relaxed text-ink-mid">
          带杠杆交易永续合约，亏钱的速度会比你读完这一页还快。杠杆放大亏损和放大盈利一样彻底，爆仓可以在几秒内
          吞掉整个持仓 — 包括它的保证金。语言模型不是理财顾问，看不到未来，而且时不时会自信地犯错；本控制台的
          风控只能减少伤害，无法消除伤害。模拟模式被设为默认是有原因的：让一个策略跑得足够久，看清它的回撤，
          再考虑投入真实资金。永远不要用输不起的钱去交易。
        </p>
      </div>

      <div className="space-y-2">
        {FAQ.map((item) => (
          <Panel key={item.q} title={item.q}>
            <p className="text-xs leading-relaxed text-ink-mid">{item.a}</p>
          </Panel>
        ))}
      </div>

      <Panel title="操作员清单">
        <ol className="space-y-1.5 text-xs leading-relaxed text-ink-mid">
          <li>
            <span className="num mr-1 text-ink-faint">01</span> 在<span className="text-ink-hi">设置</span>中添加一个
            AI 模型，反复点<span className="text-ink-hi">测试</span>，直到它报告延迟并回显模型 id。
          </li>
          <li>
            <span className="num mr-1 text-ink-faint">02</span> 添加凭证 — 先用模拟盘/测试网那把，开启合约交易、
            关闭提现。
          </li>
          <li>
            <span className="num mr-1 text-ink-faint">03</span> 在<span className="text-ink-hi">策略工坊</span>中从
            预设开始，然后逐段阅读并修改每一个提示词段落。数字约束模型，文字引导模型。
          </li>
          <li>
            <span className="num mr-1 text-ink-faint">04</span> 创建一个机器人，并用
            <span className="text-ink-hi">模拟</span>模式启动。阅读预检行 — 阻断性失败是红色的。
          </li>
          <li>
            <span className="num mr-1 text-ink-faint">05</span> 让它跑几天。关注权益曲线、最大回撤和决策审计链，
            而不只是胜率。
          </li>
          <li>
            <span className="num mr-1 text-ink-faint">06</span> 只有到那时才考虑实盘，且仓位规模要控制在
            “全亏了也只是麻烦，而不是问题”的范围。
          </li>
        </ol>
      </Panel>
    </div>
  );
}
