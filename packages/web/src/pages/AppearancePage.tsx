/**
 * 外观：主题与界面密度并排呈现在同一行，下方紧跟实时表格预览。
 */
import { useState, type ReactNode } from 'react';
import { AlignJustify, Check, Moon, Rows2, Rows3, Sun } from 'lucide-react';
import { useDocumentTitle } from '../lib/hooks';
import { SectionHeading } from '../components/Badges';
import { PageShell, SectionLabel } from '../components/shell';
import { Panel, cn } from '../components/ui';
import { listTemplates, getTemplate } from '../templates/registry';
import { useTemplateStore } from '../templates/store';
import { templateIcon } from '../templates/lib/icons';
import type { TemplateId } from '../templates/types';
import {
  DENSITIES,
  SKINS,
  getDensity,
  getSkin,
  isSkinSupported,
  setDensity,
  setSkin,
  type Density,
  type Skin,
} from '../templates/lib/appearance';

const DENSITY_ICON: Record<Density, ReactNode> = {
  compact: <AlignJustify aria-hidden className="h-4 w-4" />,
  normal: <Rows3 aria-hidden className="h-4 w-4" />,
  cozy: <Rows2 aria-hidden className="h-4 w-4" />,
};

/** 选项卡片：统一圆角、高度与选中态，适配并排紧凑布局。 */
function OptionCard({
  active,
  disabled = false,
  onClick,
  title,
  icon,
  label,
  hint,
  extra,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  icon?: ReactNode;
  label: string;
  hint: string;
  extra?: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      title={title ?? hint}
      className={cn(
        'flex h-full min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition',
        disabled
          ? 'cursor-not-allowed border-base-800 bg-base-900/40 opacity-50'
          : active
            ? 'border-accent bg-accent/10'
            : 'border-base-700 bg-base-900 hover:border-base-600 hover:bg-base-850/60',
      )}
    >
      {icon && (
        <span
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border',
            active ? 'border-accent/50 bg-accent/15 text-accent' : 'border-base-700 text-ink-faint',
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-ink-hi">{label}</span>
          {active && <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />}
          {extra}
        </span>
        <span className="mt-0.5 block truncate text-xs text-ink-lo">{hint}</span>
      </span>
    </button>
  );
}

export function AppearancePage() {
  useDocumentTitle('外观');

  const templateId = useTemplateStore((s) => s.id);
  const setTemplateId = useTemplateStore((s) => s.setId);
  const activeTemplate = getTemplate(templateId);
  const templates = listTemplates();
  const [skin, setSkinState] = useState<Skin>(() => getSkin());
  const [density, setDensityState] = useState<Density>(() => getDensity());

  const pickSkin = (next: Skin) => {
    setSkin(next);
    setSkinState(next);
  };

  const pickDensity = (next: Density) => {
    setDensity(next);
    setDensityState(next);
  };

  return (
    <PageShell>
      <SectionHeading title="外观" sub="仅作用于当前设备的界面显示，不影响任何交易逻辑。" />

      {templates.length > 1 && (
        <section>
          <SectionLabel title="模板" count={templates.length} />
          <div className="grid grid-cols-1 items-stretch gap-2.5 sm:grid-cols-2">
            {templates.map((option) => {
              const Icon = templateIcon(option.id);
              return (
                <OptionCard
                  key={option.id}
                  active={templateId === option.id}
                  onClick={() => setTemplateId(option.id as TemplateId)}
                  icon={<Icon aria-hidden className="h-4 w-4" />}
                  label={option.label}
                  hint={option.hint}
                  extra={
                    option.ownsPalette ? (
                      <span className="chip chip-plain shrink-0 border-base-700 text-ink-lo" title="自带配色">
                        自带配色
                      </span>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        </section>
      )}

      {/* 主题与界面密度合并为同一行，左右分栏对齐 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <section className="lg:col-span-5">
          <SectionLabel title="主题" className="mb-2.5" />
          <div className="grid grid-cols-2 gap-2.5">
            {SKINS.map((option) => {
              const supported = isSkinSupported(activeTemplate.supportedSkins, option.id);
              return (
                <OptionCard
                  key={option.id}
                  active={skin === option.id}
                  disabled={!supported}
                  onClick={() => pickSkin(option.id)}
                  title={supported ? option.hint : `「${activeTemplate.label}」模板固定深色，不支持浅色主题`}
                  icon={
                    option.id === 'dark' ? (
                      <Moon aria-hidden className="h-4 w-4" />
                    ) : (
                      <Sun aria-hidden className="h-4 w-4" />
                    )
                  }
                  label={option.label}
                  hint={supported ? option.hint : '该模板固定深色'}
                />
              );
            })}
          </div>
        </section>

        <section className="lg:col-span-7">
          <SectionLabel title="界面密度" className="mb-2.5" />
          <div className="grid grid-cols-3 gap-2.5">
            {DENSITIES.map((option) => (
              <OptionCard
                key={option.id}
                active={density === option.id}
                onClick={() => pickDensity(option.id)}
                icon={DENSITY_ICON[option.id]}
                label={option.label}
                hint={option.hint}
              />
            ))}
          </div>
        </section>
      </div>

      {/* 预览用真实的 `.th/.td` 与 `--aq-row-h` */}
      <section>
        <SectionLabel title="表格密度实时预览" actions={<span className="text-xs text-ink-faint">行高随密度变化，字号保持不变</span>} />
        <Panel padded={false}>
          <table className="data-grid w-full border-collapse">
            <thead>
              <tr>
                <th className="th">交易对</th>
                <th className="th text-right">价格</th>
                <th className="th text-right">24h</th>
                <th className="th text-right">成交额</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['BTCUSDT', '82,713.40', '-0.60%', '103.30B'],
                  ['ETHUSDT', '2,530.86', '+0.76%', '104.84B'],
                  ['DOGEUSDT', '0.08510', '-1.56%', '107.33B'],
                ] as const
              ).map(([symbol, price, change, volume]) => (
                <tr key={symbol}>
                  <td className="td num">{symbol}</td>
                  <td className="td num text-right">{price}</td>
                  <td className={cn('td num text-right', change.startsWith('-') ? 'text-down' : 'text-up')}>{change}</td>
                  <td className="td num text-right text-ink-lo">{volume}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </section>
    </PageShell>
  );
}
