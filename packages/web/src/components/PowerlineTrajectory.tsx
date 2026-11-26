/**
 * Powerline / Starship 风格无缝衔接箭头色带（决策步骤轨迹）。
 *
 * 2026-11-26 紧凑单行精修：
 * - 宽屏下尽量保持**单行不换行**（即使 4+ 条笔记也紧凑收进一条无缝色带）：
 *   `❯ 步骤 ▶ ◆ 计划 ▶ ✎ VVV ▶ ✎ 1000PEPE ▶ ✎ PIEVERSE ▶ ✎ MMT ▶ ✓ 提交(4)`；
 * - 完整中文语义保留在每段的 `title` 悬停提示里；
 * - 极窄屏幕自动横向顺滑滚动（无可见滚动条），绝不裂成参差三行。
 */
import { cn } from './ui';

export interface PowerlineSegment {
  icon: string;
  label: string;
  title: string;
  /** 实心段底色（Catppuccin / Tokyo-Night 柔和粉彩，深炭黑文字保证高对比度）。 */
  bg: string;
  fg?: string;
}

const NOTE_PALETTE = [
  '#cba6f7', // Lavender
  '#f5c2e7', // Flamingo Pink
  '#89dceb', // Sky
  '#b4befe', // Periwinkle
];

/**
 * 解析服务端执行日志中的 `三段式决策轨迹：plan → note:MANTRA → finalize(4)`。
 */
export function parsePowerlineTrajectory(raw: string): PowerlineSegment[] | null {
  const m = /三段式决策轨迹[：:]\s*(.+)$/.exec(raw.trim());
  if (!m?.[1]) return null;
  const tokens = m[1]
    .split(/\s*→\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;

  const noteCount = tokens.filter((t) => /^note:/i.test(t)).length;
  let noteIdx = 0;
  const segments: PowerlineSegment[] = [
    {
      icon: '❯',
      label: '步骤',
      title: '三段式决策步骤轨迹',
      bg: '#89b4fa',
    },
  ];

  for (const tok of tokens) {
    if (tok === 'plan') {
      segments.push({
        icon: '◆',
        label: '计划',
        title: '制定本轮分析计划',
        bg: '#fab387',
      });
      continue;
    }
    const noteMatch = /^note:(.+)$/i.exec(tok);
    if (noteMatch?.[1]) {
      const sym = noteMatch[1].replace(/USDT$/i, '');
      const bg = NOTE_PALETTE[noteIdx % NOTE_PALETTE.length]!;
      noteIdx += 1;
      // 笔记 ≥ 2 条时省略重复的「记笔记」前缀，靠 ✎ 图标 + 币种短名紧凑排进单行
      segments.push({
        icon: '✎',
        label: noteCount >= 2 ? sym : `笔记 ${sym}`,
        title: `记录观察笔记：${noteMatch[1]}`,
        bg,
      });
      continue;
    }
    const delMatch = /^note_del:(.+)$/i.exec(tok);
    if (delMatch?.[1]) {
      const sym = delMatch[1].replace(/USDT$/i, '');
      segments.push({
        icon: '✕',
        label: `清 ${sym}`,
        title: `清理失效笔记：${delMatch[1]}`,
        bg: '#f38ba8',
      });
      continue;
    }
    const thesisMatch = /^thesis:(.+)$/i.exec(tok);
    if (thesisMatch?.[1]) {
      const sym = thesisMatch[1].replace(/USDT$/i, '');
      segments.push({
        icon: '⚑',
        label: `论点 ${sym}`,
        title: `更新持仓论点：${thesisMatch[1]}`,
        bg: '#f9e2af',
      });
      continue;
    }
    const klineMatch = /^kline[s]?:(.+)$/i.exec(tok);
    if (klineMatch?.[1]) {
      segments.push({
        icon: '∿',
        label: `K线 ${klineMatch[1]}`,
        title: `拉取补充 K 线：${klineMatch[1]}`,
        bg: '#74c7ec',
      });
      continue;
    }
    const finMatch = /^finalize(?:\((\d+)\))?$/i.exec(tok);
    if (finMatch) {
      segments.push({
        icon: '✓',
        label: finMatch[1] ? `提交(${finMatch[1]})` : '提交',
        title: finMatch[1] ? `提交最终决策（共 ${finMatch[1]} 项）` : '提交最终决策',
        bg: '#a6e3a1',
      });
      continue;
    }
    segments.push({ icon: '•', label: tok, title: tok, bg: '#b4befe' });
  }

  return segments;
}

const CLIP_FIRST = 'polygon(0 0, calc(100% - 7px) 0, 100% 50%, calc(100% - 7px) 100%, 0 100%)';
const CLIP_MIDDLE = 'polygon(0 0, calc(100% - 7px) 0, 100% 50%, calc(100% - 7px) 100%, 0 100%, 7px 50%)';
const CLIP_LAST = 'polygon(0 0, 100% 0, 100% 100%, 0 100%, 7px 50%)';

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
        'aq-no-scrollbar inline-flex max-w-full flex-nowrap items-center overflow-x-auto rounded-lg bg-[#0d0f17]/90 px-1.5 py-1 shadow-inner ring-1 ring-white/5',
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
            title={seg.title}
            style={{
              backgroundColor: seg.bg,
              color: seg.fg ?? '#11111b',
              clipPath,
              zIndex: segments.length - idx,
            }}
            className={cn(
              'relative inline-flex h-[20px] shrink-0 select-none items-center gap-0.5 whitespace-nowrap font-mono text-[10.5px] font-bold leading-none tracking-tight',
              isSingle
                ? 'rounded-full px-2.5'
                : isFirst
                  ? 'rounded-l-full pl-2 pr-3'
                  : isLast
                    ? '-ml-[6px] rounded-r-full pl-3 pr-2.5'
                    : '-ml-[6px] pl-3 pr-3',
            )}
          >
            <span aria-hidden className="text-[9.5px] opacity-85">
              {seg.icon}
            </span>
            <span>{seg.label}</span>
          </span>
        );
      })}
    </div>
  );
}
