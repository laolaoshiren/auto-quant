/**
 * 交易所页。
 *
 * 只做一件包装的事：给 `ExchangeAccountsSection` 一个页面级的标题和宽度上限。
 * 宽度给到 `6xl` 是因为这一屏的核心是余额卡与凭证行 —— 太窄会把
 * 权益数字挤到换行，而它正是操作员最需要一眼看清的那个数字。
 */
import { useDocumentTitle } from '../lib/hooks';
import { ExchangeAccountsSection } from '../components/settings/ExchangeAccountsSection';

export function ExchangesPage() {
  useDocumentTitle('交易所');

  return (
    <div className="mx-auto max-w-6xl space-y-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-wide text-ink-hi">交易所</h1>
        <p className="mt-0.5 text-base text-ink-lo">
          这里保存下单用的 API 凭证，也是查看交易所实时余额的地方。
          模拟模式无需任何密钥；接入实盘前请先用测试网密钥验证这条链路。
        </p>
      </div>
      <ExchangeAccountsSection />
    </div>
  );
}
