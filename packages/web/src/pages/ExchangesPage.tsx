/**
 * 交易所页。
 *
 * 只做包装的事：页面级标题（`SectionHeading`）与页面说明。
 *
 * **不再套 `max-w-6xl`**：这一屏用的是 `LAYOUT.md` §1 的左指标栏 + 主内容区骨架，
 * 主区的宽度应当全部给内容；再塞一个居中窄栏会让余额与凭证行被迫换行，
 * 而"一眼看清"正是这一屏的全部要求。
 */
import { useDocumentTitle } from '../lib/hooks';
import { SectionHeading } from '../components/Badges';
import { ExchangeAccountsSection } from '../components/settings/ExchangeAccountsSection';

export function ExchangesPage() {
  useDocumentTitle('交易所');

  return (
    <div className="min-w-0">
      <SectionHeading
        title="交易所"
        sub="保存下单用的 API 凭证，并查看交易所回报的实时余额。模拟模式无需任何密钥；接入实盘前请先用测试网密钥验证这条链路。"
      />
      <ExchangeAccountsSection />
    </div>
  );
}
