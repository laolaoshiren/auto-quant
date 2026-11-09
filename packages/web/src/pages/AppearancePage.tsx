/**
 * 外观：模板 · 主题 · 界面密度。
 *
 * 三项**正交**的设置：模板决定骨架（导航/工具栏），主题是深/浅，密度只改表格行高。
 * 切换全部即时生效、不刷新页面（只写 `<html>` 上的根类名与 localStorage）。
 *
 * 2026-11-10 UI 重设计：
 * - 三块共用一个 `OptionCard` 排版（图标 + 标题 + 一行说明 + 选中勾）；
 * - 内置模板只有一套时**整块不渲染**（「多余」）；只有第三方模板注册进来才出现；
 * - 删掉三处页脚技术说明（`aq.skin` / 本地存储 / 内联脚本这类实现细节），
 *   页面上只留用户需要判断的那一句；实现细节进代码注释；
 * - 密度预览保留：它是唯一能当场验证"改了什么"的东西。
 */
import { useState, type ReactNode } from 'react';
import { Check, Moon, Sun } from 'lucide-react';
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

/** 三个区块共用的选项卡片：尺寸只用 token（rounded-md / px-3 / py-2.5）。 */
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
      title={title}
      className={cn(
        'flex min-w-0 items-center gap-3 rounded-md border px-3 py-2.5 text-left transition',
        disabled
          ? 'cursor-not-allowed border-base-800 bg-base-900/40 opacity-50'
          : active
            ? 'border-accent bg-accent-soft'
            : 'border-base-700 bg-base-900 hover:border-base-600',
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
          <span className="truncate text-base font-semibold text-ink-hi">{label}</span>
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
  /*
   * 全部可用模板（内置 + 运行时注册的第三方）。内置收敛后只剩 quill 一套 ——
   * 那时**不渲染模板区块**；第三方模板通过 `templates/<目录>/` 自动注册进来，
   * 出现第二套时这一块才出现（否则就是一个只有一个选项的选择器 = 多余）。
   */
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
      <SectionHeading title="外观" sub="只影响这台设备的显示，不影响任何交易行为。" />

      {templates.length > 1 && (
        <section>
          <SectionLabel title="模板" count={templates.length} />
          <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2">
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

      <section>
        <SectionLabel title="主题" />
        <div className="grid grid-cols-2 items-start gap-2 sm:max-w-md">
          {SKINS.map((option) => {
            const supported = isSkinSupported(activeTemplate.supportedSkins, option.id);
            return (
              <OptionCard
                key={option.id}
                active={skin === option.id}
                disabled={!supported}
                onClick={() => pickSkin(option.id)}
                title={supported ? undefined : `「${activeTemplate.label}」模板固定深色，不支持浅色主题`}
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

      <section>
        <SectionLabel title="界面密度" />
        <div className="grid grid-cols-3 items-start gap-2 sm:max-w-xl">
          {DENSITIES.map((option) => (
            <OptionCard
              key={option.id}
              active={density === option.id}
              onClick={() => pickDensity(option.id)}
              label={option.label}
              hint={option.hint}
            />
          ))}
        </div>
      </section>

      {/* 预览必须用真实的 `.th/.td` 与 `--aq-row-h`：示意图永远差几个像素，而差的就是要判断的东西。 */}
      <section>
        <SectionLabel title="预览" actions={<span className="text-xs text-ink-faint">行高随密度变化，字号不变</span>} />
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
