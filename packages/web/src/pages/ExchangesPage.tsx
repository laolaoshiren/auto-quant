import { useDocumentTitle } from '../lib/hooks';
import { SectionHeading } from '../components/Badges';
import { ExchangeAccountsSection } from '../components/settings/ExchangeAccountsSection';

export function ExchangesPage() {
  useDocumentTitle('交易所');

  return (
    <div className="space-y-3">
      <SectionHeading
        title="交易所"
        sub="模拟模式无需任何密钥；接入实盘前先用测试网密钥验证这一条链路。"
      />
      <ExchangeAccountsSection />
    </div>
  );
}
