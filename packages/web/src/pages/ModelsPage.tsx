import { useApp } from '../lib/store';
import { useDocumentTitle } from '../lib/hooks';
import { SectionHeading } from '../components/Badges';
import { AiModelsSection } from '../components/settings/AiModelsSection';

export function ModelsPage() {
  useDocumentTitle('AI 模型');
  const system = useApp((s) => s.system);

  return (
    <div className="space-y-3">
      <SectionHeading
        title="AI 模型"
        sub={
          system
            ? `${system.environmentLabel} · 默认${system.dryRun ? '模拟' : '可实盘'}`
            : '每个交易周期都由这里的模型给出决策。'
        }
      />
      <AiModelsSection />
    </div>
  );
}
