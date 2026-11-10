/**
 * 交易所页。
 *
 * 只做包装：页面级标题 + 一行说明。凭证列表、余额与增删改全部在
 * `ExchangeAccountsSection` 里（那一块自己负责加载/空/错误态）。
 *
 * 支持的交易所**从 `EXCHANGES` 读**，不在文案里硬编码币安 —— 加一家交易所
 * 只需要改共享包，这一页自动跟上。
 */
import { EXCHANGES } from '@aq/shared';
import { useDocumentTitle } from '../lib/hooks';
import { SectionHeading } from '../components/Badges';
import { ExchangeAccountsSection } from '../components/settings/ExchangeAccountsSection';

export function ExchangesPage() {
  useDocumentTitle('交易所');

  return (
    <div className="min-w-0">
      <SectionHeading
        title="交易所"
        sub={`支持 ${EXCHANGES.map((entry) => entry.label).join(' / ')}。保存下单用的 API 凭证，并查看交易所回报的实时余额；不接实盘就不需要凭证，正式网请先用测试网验证链路。`}
      />
      <ExchangeAccountsSection />
    </div>
  );
}
