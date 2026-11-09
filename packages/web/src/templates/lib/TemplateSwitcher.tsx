/**
 * 模板切换器 —— 顶栏上的一枚下拉。
 *
 * ## 为什么它必须在**顶栏**，而不是只在「外观」页里
 *
 * 外观页在侧栏的某一行（而且每套模板的侧栏都不一样）。把切换入口只放在那里，
 * 意味着"换一套看看"要三次点击、还要先记得它藏在哪 —— 而这是个**随手可逆**的
 * 显示偏好，代价却比改密码还高。用户的原话是「不要藏这么深链路」。
 *
 * 顶栏是唯一在**所有页面、两套模板下都常驻**的位置，所以入口放这里。
 *
 * ## ⚠️ "每套外壳都要渲染它"是一条**契约**，不是建议
 *
 * 漏了它的后果是**用户被困住**：切到那套模板之后，唯一换回去的路是猜出
 * 外观页在侧栏第几行。所以 `registry.test.ts` 会逐个扫 `*Shell.tsx` 断言
 * 这一行存在 —— 包括第三方模板。实现放在公共库里，别人**照抄一行**即可，
 * 不必自己写一遍下拉（那正是要避免的重复造轮子）。
 *
 * ## 为什么是下拉，而不是两个并排的按钮
 *
 * 模板是**可扩展**的（`registerTemplate`，见 `TEMPLATES.md`）：内置虽然收敛成
 * 一套，但第三方模板仍可注册进来，数量没有上限 —— 并排按钮排不下，而顶栏的
 * 空间是有限的。下拉的宽度不随模板数量增长。
 *
 * 菜单里同时给出去「外观」页的入口 —— 那里有主题（深/浅）与密度，
 * 它们和模板是正交的三件事，混进这个菜单会让"换模板"变成一个设置面板。
 */
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { cn } from '../../components/ui';
import { useShell } from './context';
import { templateIcon } from './icons';

/**
 * 尺寸档。
 *
 * - `sm`：紧凑外壳（控件 `h-6`，内置的 quill 头部用它）；
 * - `md`：宽松外壳（控件 `h-9`）。
 *
 * 外壳的控件高度本来就不同（各自是成品设计），所以这里不强行统一，
 * 只暴露两档。**不要**在这里写 `h-6 md:h-9` 之类的响应式高度 —— 高度应该由
 * 宿主决定，那是宿主的排版。
 */
export function TemplateSwitcher({
  size = 'sm',
  className,
}: {
  size?: 'sm' | 'md';
  className?: string;
}) {
  /*
   * ⚠️ **读 context，不读 store。**
   *
   * `templates/store.ts` 求值期要经过 `registry.ts`，而注册表静态 import 每一套
   * 外壳 —— 外壳（经本文件）再 import store 就是一条在求值期闭合的环，
   * 症状是 `Cannot access 'BUILT_IN' before initialization`、整站白屏。
   * 数据由 `Layout` 通过 `<ShellRuntime>` 递下来，这也是 `lib/context.tsx`
   * 原本就写明的分工。
   */
  const shell = useShell();
  const id = shell.templateId;
  const setId = shell.setTemplateId;
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  // 跳页之后 popover 不会自己知道，得手动关（与两个外壳里的用户菜单同一处处理）。
  useEffect(() => setOpen(false), [pathname]);

  const templates = shell.templates;
  const current = templates.find((option) => option.id === id) ?? templates[0];
  const CurrentIcon = templateIcon(id);
  const compact = size === 'sm';

  /*
   * 先关菜单再切。
   *
   * 切换会把**整个外壳**换掉，这个组件的实例随之卸载 —— 所以 `setOpen(false)`
   * 其实没人看得到。但那一下是为了另一种情况：用户在**同一个模板**上再点一次
   * 当前项（例如误点），这时组件不卸载，菜单必须收起来。
   */
  const pick = (next: string) => {
    setOpen(false);
    setId(next);
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={`界面模板（当前：${current?.label ?? '—'}）`}
          title={`界面模板：${current?.label ?? '—'}。点这里直接换一套，不会离开当前页面。`}
          className={cn(
            'flex shrink-0 items-center border bg-base-800/60 text-ink-lo transition hover:text-ink-mid',
            compact
              ? 'h-6 gap-1.5 rounded border-base-600 px-1.5 text-xs'
              : 'h-9 gap-2 rounded-md border-base-700 px-2.5 text-base',
            className,
          )}
        >
          <CurrentIcon aria-hidden className={cn('shrink-0', compact ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
          {/*
            紧凑档在窄屏上只留图标：标题栏那一行的空间要优先给"当前在哪一页"
            和风控告警，而模板名不属于那两类。
          */}
          <span className={cn('truncate', compact && 'hidden lg:inline')}>{current?.label ?? '—'}</span>
          <ChevronDown aria-hidden className="h-3 w-3 shrink-0" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          role="menu"
          className="z-50 w-72 rounded-md border border-base-700 bg-base-900 p-1 shadow-overlay"
        >
          <div className="px-2.5 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">
            界面模板
          </div>
          {templates.map((option) => {
            const Icon = templateIcon(option.id);
            const active = option.id === id;
            return (
              <button
                key={option.id}
                type="button"
                /*
                 * `menuitemradio` 而不是 `menuitem`：这是一组**互斥选项**，
                 * 读屏会念出"已选中"而不是让用户自己猜当前用的是哪一套。
                 */
                role="menuitemradio"
                aria-checked={active}
                onClick={() => pick(option.id)}
                className={cn(
                  'flex w-full cursor-pointer items-start gap-2.5 rounded px-2.5 py-2 text-left transition',
                  active ? 'bg-accent-soft text-accent-hi' : 'text-ink-mid hover:bg-base-850',
                )}
              >
                <Icon
                  aria-hidden
                  className={cn('mt-0.5 h-4 w-4 shrink-0', active ? 'text-accent' : 'text-ink-faint')}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-base font-semibold">{option.label}</span>
                    {active && <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-lo">{option.hint}</span>
                </span>
              </button>
            );
          })}
          <div className="my-1 h-px bg-base-700" />
          <Link
            to="/appearance"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded px-2.5 py-1.5 text-base text-ink-mid transition hover:bg-accent-soft hover:text-accent-hi"
          >
            <SlidersHorizontal aria-hidden className="h-3.5 w-3.5 shrink-0" />
            深色 / 浅色与行高
          </Link>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
