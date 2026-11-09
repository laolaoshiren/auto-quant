/**
 * AI 模型页：每个交易周期都由这里的模型给出决策。
 *
 * 这一页只做一件事：把"这些模型是干什么用的"用**一行说明**交代清楚，
 * 然后把真正干活的 `AiModelsSection`（列表 + 搜索 + 测试）放上来。
 *
 * 曾经的"三步走"卡片与底部一段长说明已删除（用户 2026-11-10：「多余」）——
 * 那两块占掉首屏一大截，却只重复表格里已有的信息。首次配置怎么走，
 * 现在压进标题下的一行说明里。
 */
import { Link } from 'react-router-dom';
import { useApp } from '../lib/store';
import { useDocumentTitle } from '../lib/hooks';
import { Badge } from '../components/ui';
import { SectionHeading } from '../components/Badges';
import { PageShell } from '../components/shell';
import { AiModelsSection } from '../components/settings/AiModelsSection';

export function ModelsPage() {
  useDocumentTitle('AI 模型');
  const system = useApp((s) => s.system);

  return (
    <PageShell>
      <SectionHeading
        title="AI 模型"
        sub={
          <span>
            添加模型 → 点「测试」确认密钥/端点/模型 id 都对得上 → 在机器人里选用。密钥只以掩码显示。
            {system ? ` 当前环境：${system.environmentLabel}。` : ''}
            <Link to="/faq" className="ml-1 text-accent hover:underline">
              常见问题
            </Link>
          </span>
        }
        right={system ? <Badge tone={system.dryRun ? 'accent' : 'warn'}>{system.dryRun ? '模拟环境' : '可实盘'}</Badge> : undefined}
      />

      {system?.tradingDisabled && (
        <div className="mb-2 rounded-md border border-down/50 bg-down/10 px-3 py-2 text-base text-down" role="alert">
          全局交易已被禁用：模型仍会被调用并给出决策，但所有开仓都会被拦截。
        </div>
      )}

      <AiModelsSection />
    </PageShell>
  );
}
