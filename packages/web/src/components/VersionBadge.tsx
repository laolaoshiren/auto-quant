/**
 * **全局版本指示器**（2026-11-10 用户要求）。
 *
 * 用户原话：
 * > 「版本检测放到全局页面顶部，方便我随时知道当前我看到得版本是不是最新得（生成环境），
 * >   我本地测试你也要想办法让我知道是你当前开发最新得还是 github 最新得，你要想一个
 * >   两全其美办法。」
 *
 * 两全：
 *   · **生产 / 部署**（无 `.git`）→ 显示部署版本（build-info.json）与 GitHub 最新比的落后数；
 *   · **本地开发**（有 `.git`）→ 显示**当前 HEAD**（不是上次部署的旧产物），并标 dirty。
 *
 * 文本极简：`dev · 7f2f1ea` / `v0.2.0 · 86dce7a`，后面按需带 `· 领先 3` / `· 落后 2`。
 * 详细说明（提交标题、远端最新、检查时间）全部放 `title`，不占版面。
 */
import { usePolled } from '../lib/hooks';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { cn } from './ui';

const STATE_TONE: Record<string, { dot: string; label: string }> = {
  'up-to-date': { dot: 'bg-up', label: '与 GitHub 一致' },
  behind: { dot: 'bg-warn', label: '落后 GitHub' },
  ahead: { dot: 'bg-accent', label: '本地领先 GitHub' },
  diverged: { dot: 'bg-down', label: '与 GitHub 分叉' },
  unknown: { dot: 'bg-base-600', label: '无法比对' },
};

export function VersionBadge({ className }: { className?: string }) {
  /*
   * ⚠️ **未登录时不要请求**（2026-11-10 实测：首屏 store 还没恢复 token 就发请求，
   * 拿到 401 后徽章一直停在「版本…」）。
   *
   * 与 `StaleTraderBanner` 同一个坑、同一个修法：等会话状态变成 `authenticated`
   * 再启用查询。版本信息是可选信息，晚两秒出现无所谓；401 才是脏的。
   */
  const authenticated = useApp((s) => s.status === 'authenticated');
  const query = usePolled((signal) => api.systemVersion(signal), {
    intervalMs: 5 * 60_000,
    enabled: authenticated,
  });
  const data = query.data;

  if (!data) {
    return (
      <span
        className={cn('num inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-ink-faint', className)}
        title="正在读取版本信息…"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-base-600" />
        版本…
      </span>
    );
  }

  const state = data.update.state;
  const tone = STATE_TONE[state] ?? STATE_TONE.unknown!;
  const isDev = data.mode === 'dev';
  const head = data.local ? `${data.local.commitShort}${data.dirty ? '*' : ''}` : '—';
  const prefix = isDev ? 'dev' : data.version;
  const relation =
    state === 'behind' && data.update.behindBy !== null
      ? ` · 落后 ${data.update.behindBy}`
      : state === 'ahead'
        ? ' · 领先'
        : state === 'diverged'
          ? ' · 分叉'
          : '';

  const title = [
    isDev
      ? `本地开发版：${data.local?.commitShort ?? '—'}${data.dirty ? '（工作区有未提交改动）' : ''}`
      : `部署版本：${data.local?.commitShort ?? '—'}`,
    data.local?.subject ? `「${data.local.subject}」` : '',
    data.update.latestCommitShort
      ? `GitHub 最新：${data.update.latestCommitShort}${data.update.latestSubject ? `「${data.update.latestSubject}」` : ''}`
      : '',
    data.update.message,
    `检查于 ${new Date(data.update.checkedAt).toLocaleString('zh-CN', { hour12: false })}`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span
      className={cn(
        'num inline-flex shrink-0 items-center gap-1.5 rounded border border-base-750 bg-base-850/60 px-1.5 py-0.5 text-xs text-ink-lo',
        className,
      )}
      title={title}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} aria-hidden />
      <span className="truncate">
        {prefix} · {head}
        {relation}
      </span>
      <span className="sr-only">{tone.label}</span>
    </span>
  );
}
