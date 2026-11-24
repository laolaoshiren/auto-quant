/**
 * 操作员账户 —— 安全设置与服务端状态总览。
 *
 * 2026-11-25 UI/UX 重构：
 * - 顶部紧凑身份横幅（头像、用户名、角色、创建时间、运行环境一目了然）；
 * - 下方 12 列均衡两栏：左 7 列「凭据安全」表单（当前密码验证 + 变更项分区）、
 *   右 5 列「服务端与版本」状态卡（清晰徽章 + 提交说明 + GitHub 同步态），一屏舒适呈现。
 */
import { useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  Clock,
  Database,
  GitBranch,
  KeyRound,
  Lock,
  Save,
  Server,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { userRoleLabel } from '@aq/shared';
import { api, setToken } from '../../lib/api';
import { useApp } from '../../lib/store';
import { usePolled } from '../../lib/hooks';
import { Badge, Button, Dot, ErrorNote, Field, Panel, TextInput, Tooltip, cn } from '../ui';
import { fmtDateTime, tradingEnvironmentLabel } from '../../lib/format';

function StatusRow({
  icon,
  label,
  value,
  sub,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-base-800/80 py-2.5 last:border-b-0">
      <span className="flex shrink-0 items-center gap-2 text-xs text-ink-lo">
        <span className="text-ink-faint">{icon}</span>
        {label}
      </span>
      <div className="min-w-0 text-right">
        <div className="text-sm font-medium text-ink-hi">{value}</div>
        {sub && (
          <div className="mt-0.5 truncate text-xs text-ink-faint" title={sub}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}

export function AccountSection() {
  const user = useApp((s) => s.user);
  const system = useApp((s) => s.system);
  const health = useApp((s) => s.health);
  const bootstrap = useApp((s) => s.bootstrap);

  const [newUsername, setNewUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const build = system?.build ?? null;
  const update = usePolled((signal) => api.updateCheck(signal), { intervalMs: 0 });
  const latestRelease = update.data?.latestRelease ?? null;
  const productVersion = latestRelease ?? (system?.version ? `v${system.version.replace(/^v/i, '')}` : health?.version ?? '—');

  const syncBadge = (() => {
    if (update.error) return { tone: 'warn' as const, label: '检查失败', tip: update.error };
    if (update.loading) return { tone: 'muted' as const, label: '检查中…', tip: '正在与 GitHub 比对当前提交' };
    const state = update.data?.state;
    const tip = update.data?.message ?? undefined;
    if (state === 'up-to-date') return { tone: 'up' as const, label: '已同步', tip };
    if (state === 'ahead') return { tone: 'accent' as const, label: '领先（未推送）', tip };
    if (state === 'behind') {
      const n = update.data?.behindBy;
      return { tone: 'warn' as const, label: n !== null && n !== undefined ? `落后 ${n} 个提交` : '落后 GitHub', tip };
    }
    if (state === 'diverged') return { tone: 'down' as const, label: '已分叉', tip };
    return { tone: 'muted' as const, label: '暂无法比对', tip };
  })();

  const reset = () => {
    setNewUsername('');
    setCurrentPassword('');
    setNewPassword('');
    setConfirm('');
    setError(null);
  };

  const submit = async () => {
    setError(null);
    setDone(null);

    const username = newUsername.trim();
    const wantsUsername = username.length > 0 && username !== user?.username;
    const wantsPassword = newPassword.length > 0;

    if (!wantsUsername && !wantsPassword) {
      return setError('没有需要修改的内容 —— 请填写新用户名或新密码。');
    }
    if (!currentPassword) {
      return setError('请输入当前密码。修改凭据必须验证当前密码。');
    }
    if (wantsPassword && newPassword.length < 8) {
      return setError('新密码至少需要 8 个字符。');
    }
    if (wantsPassword && newPassword !== confirm) {
      return setError('两次输入的密码不一致。');
    }

    setBusy(true);
    try {
      const result = await api.updateAccount({
        currentPassword,
        ...(wantsUsername ? { username } : {}),
        ...(wantsPassword ? { newPassword } : {}),
      });
      setToken(result.token);
      await bootstrap();

      const parts: string[] = [];
      if (wantsUsername) parts.push('用户名');
      if (wantsPassword) parts.push('密码');
      setDone(`${parts.join('与')}已更新。`);
      reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const envLabel =
    system?.environmentLabel ??
    (system?.environment ? tradingEnvironmentLabel(system.environment) : undefined);

  return (
    <div className="space-y-4">
      {/* 顶部身份概览带 */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-base-700 bg-base-900 px-5 py-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-accent/30 bg-accent/12 text-lg font-bold text-accent">
          {(user?.username ?? '?').slice(0, 1).toUpperCase()}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-lg font-semibold text-ink-strong">{user?.username ?? '—'}</span>
            <Badge tone="accent">{user?.role ? userRoleLabel(user.role) : '未知角色'}</Badge>
            <Badge tone={system?.dryRun ? 'accent' : 'warn'} title={envLabel}>
              <Dot tone={system?.dryRun ? 'accent' : 'warn'} />
              {system?.dryRun ? '模拟环境' : '实盘环境'}
            </Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-lo">
            <span className="inline-flex items-center gap-1">
              <UserCheck aria-hidden className="h-3.5 w-3.5 text-ink-faint" />
              创建于 <span className="num text-ink-mid">{fmtDateTime(user?.createdAt)}</span>
            </span>
            {envLabel && (
              <span className="truncate text-ink-faint" title={envLabel}>
                {envLabel}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge tone="neutral" className="px-2.5 py-1 text-xs">
            <ShieldCheck aria-hidden className="h-3.5 w-3.5 text-up" />
            单人私有部署
          </Badge>
        </div>
      </div>

      {/* 主体两栏：左安全凭据修改 · 右服务端运行时 */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
        <Panel
          className="lg:col-span-7"
          title={
            <span className="inline-flex items-center gap-2">
              <KeyRound aria-hidden className="h-4 w-4 text-accent" />
              登录凭据管理
            </span>
          }
          bodyClassName="p-5"
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') reset();
            }}
          >
            {/* 第一步：身份验证 */}
            <div className="rounded-lg border border-base-750 bg-base-850/40 p-3.5">
              <div className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-ink-mid">
                <Lock aria-hidden className="h-3.5 w-3.5 text-accent" />
                安全验证（必填）
              </div>
              <Field label="当前密码" hint="提交任意修改前必须验证当前密码，修改后会自动签发新会话令牌。">
                <TextInput
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                  placeholder="请输入当前登录密码"
                />
              </Field>
            </div>

            {/* 第二步：变更内容 */}
            <div className="space-y-3">
              <Field label="新用户名（可选）" hint="留空保持当前用户名不变。">
                <TextInput
                  value={newUsername}
                  onChange={(event) => setNewUsername(event.target.value)}
                  autoComplete="username"
                  placeholder={user?.username ? `当前：${user.username}` : '留空则不修改'}
                />
              </Field>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="新密码（可选）" hint="至少 8 位字符，留空不修改。">
                  <TextInput
                    type="password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    autoComplete="new-password"
                    placeholder="输入新密码"
                  />
                </Field>

                <Field
                  label="确认新密码"
                  hint={
                    confirm && newPassword && confirm !== newPassword
                      ? undefined
                      : '再次输入新密码以确认。'
                  }
                  error={confirm && newPassword && confirm !== newPassword ? '两次输入的新密码不一致' : null}
                >
                  <TextInput
                    type="password"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    autoComplete="new-password"
                    placeholder="再次输入新密码"
                  />
                </Field>
              </div>
            </div>

            {error && <ErrorNote>{error}</ErrorNote>}
            {done && (
              <div
                role="status"
                className="flex items-center gap-2 rounded-lg border border-up/40 bg-up/10 px-3.5 py-2.5 text-sm text-up"
              >
                <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  {done}
                  {done.includes('用户名') && ' 已自动续签当前登录会话。'}
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-base-800 pt-3.5">
              <p className="text-xs text-ink-faint">
                不提供注册与自助找回；忘记密码请在服务器执行重置脚本。
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" onClick={reset} disabled={busy}>
                  重置
                </Button>
                <Button type="submit" variant="primary" busy={busy}>
                  <Save aria-hidden className="h-3.5 w-3.5" />
                  保存修改
                </Button>
              </div>
            </div>
          </form>
        </Panel>

        <Panel
          className="lg:col-span-5"
          title={
            <span className="inline-flex items-center gap-2">
              <Server aria-hidden className="h-4 w-4 text-ink-lo" />
              服务端与版本信息
            </span>
          }
          bodyClassName="px-5 py-2.5"
        >
          <StatusRow
            icon={<ShieldCheck aria-hidden className="h-3.5 w-3.5" />}
            label="产品版本"
            value={
              <Badge tone="accent" className="num">
                {productVersion}
              </Badge>
            }
            sub={latestRelease ? '来自 GitHub 最新发行版' : '来自本地 package.json'}
          />

          <StatusRow
            icon={<GitBranch aria-hidden className="h-3.5 w-3.5" />}
            label="服务端提交"
            value={
              <span className={cn('num', build?.dirty ? 'text-warn' : 'text-ink-hi')}>
                {build ? `${build.branch} @ ${build.commitShort}${build.dirty ? '*' : ''}` : '未知'}
              </span>
            }
            sub={build?.subject || (build ? undefined : '本次部署未包含版本元数据')}
          />

          <StatusRow
            icon={<CheckCircle2 aria-hidden className="h-3.5 w-3.5" />}
            label="GitHub 同步"
            value={
              <Tooltip side="left" content={syncBadge.tip}>
                <Badge tone={syncBadge.tone} className="cursor-help">
                  <Dot tone={syncBadge.tone} />
                  {syncBadge.label}
                </Badge>
              </Tooltip>
            }
            sub={
              update.data?.latestCommitShort
                ? `远端最新 ${update.data.latestCommitShort}`
                : update.data?.message
            }
          />

          <StatusRow
            icon={<Clock aria-hidden className="h-3.5 w-3.5" />}
            label="部署时间"
            value={<span className="num">{build?.deployedAt ? fmtDateTime(build.deployedAt) : '—'}</span>}
          />

          <StatusRow
            icon={<Database aria-hidden className="h-3.5 w-3.5" />}
            label="本地数据库"
            value={<span className="num text-ink-mid">{health?.db ?? '—'}</span>}
          />

          {build?.dirty && (
            <div className="my-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
              打包时工作区存在未提交改动，线上代码可能与 {build.commitShort} 不完全一致。
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
