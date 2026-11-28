import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Lock, Sparkles, TriangleAlert } from 'lucide-react';
import type { DecisionRecord } from '@aq/shared';
import { api } from '../../lib/api';
import { cn } from '../ui';

/* -------------------------------------------------------------------------- */
/*  底部：两个纯文字按钮 + 展开内容                                             */
/* -------------------------------------------------------------------------- */

export type DetailTab = 'cot' | 'prompt';

/**
 * 一轮的底部：`✨ 思考过程 │ 🔒 提示词` 两个**纯文字按钮**。
 *
 * 它们是文字 + 图标，不是带边框的按钮、也不是标签页控件（§4）。展开状态用
 * **勾选标记 + 强调色**表示 —— 参考里展开的那一项是绿的带 ✓。用颜色 + 符号双重
 * 表达而不是只用颜色：`DESIGN.md` §2 要求不能只靠颜色传递状态。
 *
 * 这两个按钮**只管推理内容**，上面的决策永远可见 —— 折叠了决策，面板就会在
 * 没人点的时候什么都不显示，而"它到底决定了什么"才是操作者一直要看的东西。
 */
/**
 * 兼容被 JSON 二次转义的字面量换行（`\r\n` / `\n` / `\t`），还原为真实换行，
 * 避免长思考过程里出现成串 `\n\n` 不换行。
 */
function unescapeReasoningText(text: string): string {
  if (!text) return '';
  if (!text.includes('\\n') && !text.includes('\\r') && !text.includes('\\t')) return text;
  return text.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '  ');
}

export function CycleDetails({
  record,
  counts,
}: {
  record: DecisionRecord;
  counts: { failed: number; rejected: number; skipped: number };
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DetailTab>('cot');

  const cotTrace = unescapeReasoningText(record.cotTrace ?? '');
  const inlineSystem = record.systemPrompt ?? '';
  const inlineUser = record.userPrompt ?? '';
  const hasInlinePrompt = inlineSystem.trim() !== '' || inlineUser.trim() !== '';

  /*
   * 提示词懒加载提升到 `CycleDetails`：服务端列表接口为了避免单页数 MB 载荷会剥离
   * `systemPrompt` / `userPrompt`，因此一次 `traderDecision` 请求同时填充两段提示词，
   * 避免两个 `PromptSection` 各自发重复双请求。
   */
  const [loadedPrompt, setLoadedPrompt] = useState<{
    recordId: number;
    systemPrompt: string;
    userPrompt: string;
  } | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const fetchedForThis = loadedPrompt !== null && loadedPrompt.recordId === record.id;

  useEffect(() => {
    if (!open || tab !== 'prompt') return;
    if (hasInlinePrompt || fetchedForThis || record.id <= 0) return;
    let alive = true;
    const controller = new AbortController();
    setPromptLoading(true);
    api
      .traderDecision(record.traderId, record.id, controller.signal)
      .then((full) => {
        if (!alive) return;
        setLoadedPrompt({
          recordId: record.id,
          systemPrompt: full.systemPrompt ?? '',
          userPrompt: full.userPrompt ?? '',
        });
      })
      .catch(() => {
        if (!alive) return;
        setLoadedPrompt({ recordId: record.id, systemPrompt: '', userPrompt: '' });
      })
      .finally(() => {
        if (alive) setPromptLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [open, tab, hasInlinePrompt, fetchedForThis, record.traderId, record.id]);

  /**
   * 点一个按钮既切换内容也展开（§4）。
   *
   * 再点**同一个**按钮才收起 —— 两个按钮各管自己那一份内容，所以它们是"看什么"
   * 的切换，而不是一个全局的开/关。第一次点击必须能打开：只切不展，用户会以为
   * 按钮没反应。
   */
  const toggle = (next: DetailTab): void => {
    const collapse = open && tab === next;
    setTab(next);
    setOpen(!collapse);
  };

  const notes: string[] = [];
  if (counts.failed > 0) notes.push(`${counts.failed} 条执行失败`);
  if (counts.skipped > 0) notes.push(`${counts.skipped} 条未执行`);
  if (counts.rejected > 0) notes.push(`${counts.rejected} 条被风控拒绝`);

  /*
   * 列表响应已剥离提示词原文 —— 对已持久化记录（`record.id > 0`）允许点击展开懒加载，
   * 不再因列表里 `systemPrompt`/`userPrompt` 为空且无思考过程而把按钮整体隐藏。
   */
  const hasDetail = cotTrace.trim() !== '' || hasInlinePrompt || record.id > 0;
  if (!hasDetail && notes.length === 0) return null;

  const systemBody = hasInlinePrompt
    ? inlineSystem
    : fetchedForThis
      ? loadedPrompt.systemPrompt
      : promptLoading
        ? '正在加载提示词…'
        : '';
  const userBody = hasInlinePrompt
    ? inlineUser
    : fetchedForThis
      ? loadedPrompt.userPrompt
      : promptLoading
        ? '正在加载提示词…'
        : '';

  const tabClass = (active: boolean): string =>
    cn(
      'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11.5px] transition',
      active
        ? 'border-up/40 bg-up/10 font-semibold text-up'
        : "border-transparent text-ink-lo hover:border-base-700 hover:bg-base-850 hover:text-ink-hi [[data-skin='light']_&]:text-ink-mid [[data-skin='light']_&]:hover:text-ink-strong",
    );

  return (
    <div className="min-w-0">
      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-0.5">
        {hasDetail && (
          <>
            <button
              type="button"
              onClick={() => toggle('cot')}
              aria-expanded={open && tab === 'cot'}
              title={open && tab === 'cot' ? '收起思考过程' : '展开思考过程'}
              className={tabClass(open && tab === 'cot')}
            >
              <Sparkles
                aria-hidden
                className={cn(
                  'h-3 w-3 shrink-0',
                  open && tab === 'cot' ? 'text-up' : "text-violet-300/80 [[data-skin='light']_&]:text-violet-700",
                )}
              />
              思考过程
              {open && tab === 'cot' && <Check aria-hidden className="h-3 w-3 shrink-0" />}
            </button>

            <button
              type="button"
              onClick={() => toggle('prompt')}
              aria-expanded={open && tab === 'prompt'}
              title={open && tab === 'prompt' ? '收起提示词' : '展开提示词'}
              className={tabClass(open && tab === 'prompt')}
            >
              <Lock
                aria-hidden
                className={cn(
                  'h-3 w-3 shrink-0',
                  open && tab === 'prompt' ? 'text-up' : "text-sky-300/80 [[data-skin='light']_&]:text-sky-700",
                )}
              />
              提示词
              {open && tab === 'prompt' && <Check aria-hidden className="h-3 w-3 shrink-0" />}
            </button>
          </>
        )}

        {notes.length > 0 && (
          <span className="ml-auto flex items-center gap-1 rounded-md bg-warn/10 px-1.5 py-0.5 text-[11px] font-medium text-warn">
            <TriangleAlert aria-hidden className="h-3 w-3 shrink-0" />
            {notes.join(' · ')}
          </span>
        )}
      </div>

      {/* 展开的内容留在同一个盒子的语义范围内、按钮下方，并且**可滚动**（§5）。 */}
      {open && (
        <div className="mt-2 min-w-0">
          {tab === 'cot' ? (
            <ScrollArea
              body={cotTrace}
              empty="本周期模型未返回 <reasoning> 块。"
              onCollapse={() => setOpen(false)}
            />
          ) : (
            <div className="space-y-2">
              <PromptSection title="系统提示词" body={systemBody} defaultOpen={false} />
              <PromptSection title="用户提示词" body={userBody} defaultOpen={true} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PromptSection({
  title,
  body,
  defaultOpen = false,
}: {
  title: string;
  body: string;
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const charCount = (body ?? '').trim().length;
  const sizeHint =
    charCount >= 1000 ? `${(charCount / 1000).toFixed(1)}K 字` : charCount > 0 ? `${charCount} 字` : '空';

  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-base-750 bg-base-900/50">
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-semibold text-ink-mid transition hover:text-ink-hi"
        >
          {expanded ? (
            <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          ) : (
            <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          )}
          <span className="truncate">{title}</span>
          <span className="num shrink-0 text-[11px] font-normal text-ink-faint">({sizeHint})</span>
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded-md border border-base-700 bg-base-850 px-2 py-0.5 text-[11px] text-ink-lo transition hover:border-base-600 hover:text-ink-hi"
        >
          {expanded ? '收起' : '展开'}
        </button>
      </div>
      {expanded && (
        <div className="border-t border-base-750/80 p-2">
          <ScrollArea body={body} empty="（空）" onCollapse={() => setExpanded(false)} />
        </div>
      )}
    </section>
  );
}

/**
 * 可滚动的等宽文本块（附底部快捷收起按钮，避免鼠标滚轮陷进长篇文本难以下滚页面）。
 */
function ScrollArea({
  body,
  empty,
  onCollapse,
}: {
  body: string;
  empty: string;
  onCollapse?: () => void;
}) {
  const safe = body ?? '';
  if (!safe.trim()) return <p className="px-1 py-2 text-xs text-ink-faint">{empty}</p>;
  return (
    <div className="min-w-0">
      <pre className="max-h-60 min-w-0 overflow-auto overscroll-auto whitespace-pre-wrap break-words rounded-md border border-base-800 bg-base-950 px-2.5 py-2 font-mono text-xs leading-relaxed text-ink-mid">
        {safe}
      </pre>
      {onCollapse && (
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={onCollapse}
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-faint transition hover:bg-base-800 hover:text-ink-hi"
          >
            收起此段
          </button>
        </div>
      )}
    </div>
  );
}

