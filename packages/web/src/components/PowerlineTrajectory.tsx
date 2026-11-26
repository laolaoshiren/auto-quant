/**
 * Powerline / Starship 风格无缝衔接箭头色带（决策步骤轨迹）。
 *
 * 几何还原经典终端 Powerline（Catppuccin / Tokyo-Night 配色）：
 * - 首段：左圆角胶囊 + 右箭头尖端（`>`）
 * - 中段：左内凹燕尾槽 + 右箭头尖端，负外边距 `-ml-[8px]` 无缝咬合
 * - 末段：左内凹燕尾槽 + 右圆角胶囊收尾
 * 纯 CSS `clip-path: polygon(...)` 实现，零字体依赖，高清屏边缘锐利。
 */
import { cn } from './ui';

export interface PowerlineSegment {
  icon: string;
  label: string;
  /** 实心段底色（高饱和柔和粉彩，深/浅主题下都用深炭黑字保证高对比度）。 */
  bg: string;
  /** 文字色，默认深炭黑 `#11111b`。 */
  fg?: string;
}

const NOTE_PALETTE = [
  '#cba6f7', // Catppuccin Mauve / Lavender
  '#f5c2e7', // Catppuccin Pink
  '#89dceb', // Catppuccin Sky
];

/**
 * 解析服务端执行日志中的 `三段式决策轨迹：plan → note:MANTRA → finalize(4)`。
 * 非轨迹文本返回 `null`。
 */
export function parsePowerlineTrajectory(raw: string): PowerlineSegment[] | null {
  const m = /三段式决策轨迹[：:]\s*(.+)$/.exec(raw.trim());
  if (!m?.[1]) return null;
  const tokens = m[1]
    .split(/\s*→\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;

  let noteIdx = 0;
  const segments: PowerlineSegment[] = [
    {
      icon: '❯',
      label: '决策步骤',
      bg: '#89b4fa', // Tokyo-Night / Catppuccin Blue
    },
  ];

  for (const tok of tokens) {
    if (tok === 'plan') {
      segments.push({ icon: '◆', label: '制定计划', bg: '#fab387' }); // Peach
      continue;
    }
    const noteMatch = /^note:(.+)$/i.exec(tok);
    if (noteMatch?.[1]) {
      const bg = NOTE_PALETTE[noteIdx % NOTE_PALETTE.length]!;
      noteIdx += 1;
      segments.push({
        icon: '✎',
        label: `记笔记 ${noteMatch[1].replace(/USDT$/i, '')}`,
        bg,
      });
      continue;
    }
    const delMatch = /^note_del:(.+)$/i.exec(tok);
    if (delMatch?.[1]) {
      segments.push({
        icon: '✕',
        label: `清笔记 ${delMatch[1].replace(/USDT$/i, '')}`,
        bg: '#f38ba8', // Red/Rose
      });
      continue;
    }
    const thesisMatch = /^thesis:(.+)$/i.exec(tok);
    if (thesisMatch?.[1]) {
      segments.push({
        icon: '⚑',
        label: `论点 ${thesisMatch[1].replace(/USDT$/i, '')}`,
        bg: '#f9e2af', // Yellow
      });
      continue;
    }
    const klineMatch = /^kline[s]?:(.+)$/i.exec(tok);
    if (klineMatch?.[1]) {
      segments.push({
        icon: '∿',
        label: `K线 ${klineMatch[1]}`,
        bg: '#74c7ec', // Sapphire
      });
      continue;
    }
    const finMatch = /^finalize(?:\((\d+)\))?$/i.exec(tok);
    if (finMatch) {
      segments.push({
        icon: '✓',
        label: finMatch[1] ? `提交决策 (${finMatch[1]})` : '提交决策',
        bg: '#a6e3a1', // Catppuccin Green / Mint
      });
      continue;
    }
    segments.push({ icon: '•', label: tok, bg: '#b4befe' });
  }

  return segments;
}

const CLIP_FIRST = 'polygon(0 0, calc(100% - 9px) 0, 100% 50%, calc(100% - 9px) 100%, 0 100%)';
const CLIP_MIDDLE = 'polygon(0 0, calc(100% - 9px) 0, 100% 50%, calc(100% - 9px) 100%, 0 100%, 9px 50%)';
const CLIP_LAST = 'polygon(0 0, 100% 0, 100% 100%, 0 100%, 9px 50%)';

export function PowerlineTrajectory({
  segments,
  className,
}: {
  segments: PowerlineSegment[];
  className?: string;
}) {
  if (segments.length === 0) return null;

  return (
    <div
      className={cn(
        'inline-flex max-w-full flex-wrap items-center gap-y-1.5 rounded-xl bg-[#0d0f17]/90 py-1.5 pl-3 pr-2.5 shadow-inner ring-1 ring-white/5',
        "[[data-skin='light']_&]:bg-[#1e2230]/95 [[data-skin='light']_&]:ring-black/10",
        className,
      )}
    >
      {segments.map((seg, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === segments.length - 1;
        const isSingle = segments.length === 1;
        const clipPath = isSingle
          ? undefined
          : isFirst
            ? CLIP_FIRST
            : isLast
              ? CLIP_LAST
              : CLIP_MIDDLE;

        return (
          <span
            key={`${seg.label}-${idx}`}
            style={{
              backgroundColor: seg.bg,
              color: seg.fg ?? '#11111b',
              clipPath,
              zIndex: segments.length - idx,
            }}
            className={cn(
              'relative inline-flex h-[24px] shrink-0 select-none items-center gap-1 whitespace-nowrap font-mono text-[11px] font-bold leading-none tracking-tight',
              isSingle
                ? 'rounded-full px-3'
                : isFirst
                  ? 'rounded-l-full pl-2.5 pr-4'
                  : isLast
                    ? '-ml-[8px] rounded-r-full pl-4 pr-3'
                    : '-ml-[8px] pl-4 pr-4',
            )}
          >
            <span aria-hidden className="text-[10px] opacity-85">
              {seg.icon}
            </span>
            <span>{seg.label}</span>
          </span>
        );
      })}
    </div>
  );
}
