/**
 * AI 模型页：每个交易周期都由这里的模型给出决策。
 *
 * 这一页只做两件事：把"这些模型是干什么用的"说清（否则用户不知道要不要配第二个），
 * 以及把真正干活的 `AiModelsSection` 放上来。真正的状态（加载/空/错误）由它自己负责。
 *
 * 排版上按 LAYOUT.md §1：这是**列表页**，内容就是一张表，所以用整宽骨架、
 * 不套左指标栏。上面那三步说明压成三条紧凑的横条（§2）—— 它是首次配置的
 * 引路牌，不该占掉表格的位置。
 */
import { Link } from 'react-router-dom';
import { CircleHelp } from 'lucide-react';
import { useApp } from '../lib/store';
import { useDocumentTitle } from '../lib/hooks';
import { Badge } from '../components/ui';
import { SectionHeading } from '../components/Badges';
import { PageShell, SectionLabel } from '../components/shell';
import { AiModelsSection } from '../components/settings/AiModelsSection';

/** 三步走。空状态只写"暂无数据"等于没说，这三步才是真正的下一步。 */
const STEPS = [
  { title: '添加模型', detail: '填供应商、密钥与模型 id。密钥加密存储，界面只显示掩码。' },
  { title: '测试连接', detail: '发一次最小请求，确认密钥、端点与模型 id 三者都对得上。' },
  { title: '在机器人里选用', detail: '每个机器人绑定一个模型；一个模型可以给多个机器人共用。' },
];

export function ModelsPage() {
  useDocumentTitle('AI 模型');
  const system = useApp((s) => s.system);

  return (
    <PageShell>
      <SectionHeading
        title="AI 模型"
        sub={
          system
            ? `${system.environmentLabel} · 默认${system.dryRun ? '模拟' : '可实盘'}`
            : '每个交易周期都由这里的模型给出决策。'
        }
        right={
          system ? (
            <Badge tone={system.dryRun ? 'accent' : 'warn'}>{system.dryRun ? '当前为模拟环境' : '当前可实盘'}</Badge>
          ) : undefined
        }
      />

      {system?.tradingDisabled && (
        <div className="rounded-md border border-down/50 bg-down/10 px-3 py-2 text-base text-down" role="alert">
          全局交易已被禁用：模型仍然会被调用并给出决策，但所有开仓都会被拦截。
        </div>
      )}

      <section>
        <SectionLabel title="怎么用" />
        <ol className="grid grid-cols-1 items-start gap-1.5 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="flex min-w-0 gap-2 rounded-md border border-base-750 bg-base-850/50 px-2.5 py-1.5"
            >
              <span className="num mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/20 text-xs font-bold text-accent">
                {index + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-base font-semibold leading-tight text-ink-hi">{step.title}</span>
                <span className="mt-0.5 block text-xs leading-snug text-ink-lo">{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-ink-faint">
          <CircleHelp aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            模型只是决策来源之一：杠杆、仓位与止损上限由策略里的风控强制执行，模型无法覆盖。遇到"配好了却不交易"，
            先用策略页面里的「策略体检」定位是模型没答还是风控拒了 —— 也可以看
            <Link to="/faq" className="ml-1 text-accent hover:underline">
              常见问题
            </Link>
            。
          </span>
        </p>
      </section>

      <AiModelsSection />
    </PageShell>
  );
}
