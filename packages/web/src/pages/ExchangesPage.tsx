/**
 * 交易所页。
 *
 * 只做包装：页面级标题 + 一行说明。凭证列表、余额与增删改全部在
 * `ExchangeAccountsSection` 里（那一块自己负责加载/空/错误态）。
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
        sub="保存下单用的 API 凭证，并查看交易所回报的实时余额。模拟盘不需要任何密钥；接实盘前先用测试网密钥验证这条链路。"
      />
      <ExchangeAccountsSection />
    </div>
  );
}
