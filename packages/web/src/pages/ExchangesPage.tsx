/**
 * 交易所页：紧凑直观的 16:9 宽屏凭证与资产工作台。
 */
import { EXCHANGES } from '@aq/shared';
import { useDocumentTitle } from '../lib/hooks';
import { ExchangeAccountsSection } from '../components/settings/ExchangeAccountsSection';

export function ExchangesPage() {
  useDocumentTitle('交易所');

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h1 className="text-lg font-bold tracking-tight text-ink-hi">交易所与凭证</h1>
          <span className="text-xs text-ink-lo">
            支持 {EXCHANGES.map((entry) => entry.label).join(' / ')} · 实盘与测试网资产严格隔离汇总
          </span>
        </div>
      </div>
      <ExchangeAccountsSection />
    </div>
  );
}
