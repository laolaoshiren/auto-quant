/**
 * 操作员账户。
 *
 * 这一页是**安全设置**，不是资料页：系统没有注册入口，账号在服务首次启动时
 * 自动创建，之后只能在这里改。因此版面围绕三件事组织：
 *
 *   1. 先看清当前身份（用户名 / 角色 / 服务端版本），别在改错账号；
 *   2. 再改用户名或密码 —— 表单用真实 `<form>`，Enter 能提交、Esc 能清空；
 *   3. 供应商目录只是参考信息，放在最下面，长 URL 自己截断。
 *
 * `PATCH /api/auth/account` 要求**当前密码**，这是有意为之：能碰到这台浏览器的人
 * 不应该因此就能永久接管账户。这一道校验在前端不做任何"放宽"。
 */
import { useState } from 'react';
import { Save } from 'lucide-react';
import { userRoleLabel } from '@aq/shared';
import { api, setToken } from '../../lib/api';
import { useApp } from '../../lib/store';
import { useCopy } from '../../lib/hooks';
import { Badge, Button, CopyButton, Empty, ErrorNote, Field, KV, Panel, TextInput } from '../ui';
import { fmtDateTime } from '../../lib/format';

export function AccountSection() {
  const user = useApp((s) => s.user);
  const catalog = useApp((s) => s.catalog);
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
  const catalogCopy = useCopy();
  const providers = catalog?.providers ?? [];

  const reset = () => {
    setNewUsername('');
    setCurrentPassword('');
    setNewPassword('');
    setConfirm('');
  };

  const submit = async () => {
    setError(null);
    setDone(null);

    const username = newUsername.trim();
    const wantsUsername = username.length > 0 && username !== user?.username;
    const wantsPassword = newPassword.length > 0;

    // 前端先拦一道，避免为明显的输入问题跑一趟网络；
    // 真正的校验在服务端，这里只是省一次往返。
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

      // 用户名变了，服务端会重新签发令牌 —— 必须换掉本地那份，
      // 否则后续请求带的还是旧身份。
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

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <Panel title="账户">
        <div className="num">
          <KV label="用户名" value={user?.username ?? '—'} />
          <KV label="角色" value={user?.role ? userRoleLabel(user.role) : '—'} />
          <KV label="账户创建时间" value={fmtDateTime(user?.createdAt)} />
          <KV label="服务端版本" value={health?.version ?? '—'} />
          <KV label="数据库" value={health?.db ?? '—'} />
          <KV
            label="环境"
            value={
              <span className="flex items-center justify-end gap-1.5">
                <Badge tone={system?.dryRun ? 'accent' : 'warn'}>{system?.dryRun ? '模拟' : '实盘'}</Badge>
                <span className="min-w-0 truncate">{system?.environmentLabel ?? '—'}</span>
              </span>
            }
          />
        </div>
        <p className="mt-3 text-base leading-relaxed text-ink-lo">
          本系统面向单人部署：管理员账号在服务首次启动时自动创建，
          <span className="text-ink-hi">不提供注册入口</span>
          ，也没有找回密码的流程 —— 修改只能在这里做，且需要验证当前密码。
          如果两样都忘了，只能到服务器上重置数据库里的凭据记录。
        </p>
      </Panel>

      <Panel title="修改用户名与密码">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={(event) => {
            // Esc 清空表单：和对话框里的取消保持一致，别让半填的密码留在屏幕上
            if (event.key === 'Escape') reset();
          }}
        >
          <Field label="新用户名" hint="留空则不修改。">
            <TextInput
              value={newUsername}
              onChange={(event) => setNewUsername(event.target.value)}
              autoComplete="username"
              placeholder={user?.username ? `留空则保持 ${user.username}` : '留空则不修改'}
            />
          </Field>

          <Field
            label="当前密码"
            hint="修改任何一项都必须验证当前密码 —— 服务端会拒绝没有它的请求。"
          >
            <TextInput
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="修改任何一项都需要验证"
            />
          </Field>

          <Field label="新密码" hint="留空则不修改，至少 8 个字符。">
            <TextInput
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              placeholder="留空则不修改"
            />
          </Field>

          <Field label="确认新密码" hint="与新密码完全一致。">
            <TextInput
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
              placeholder="与新密码一致"
            />
          </Field>

          {error && <ErrorNote>{error}</ErrorNote>}
          {done && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-md border border-up/40 bg-up/10 px-3 py-2 text-base text-up"
            >
              <span aria-hidden>✓</span>
              <span className="min-w-0">
                {done}
                {done.includes('用户名') && ' 服务端已重新签发令牌，当前会话继续有效。'}
              </span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" busy={busy}>
              <Save aria-hidden className="h-3.5 w-3.5" />
              保存修改
            </Button>
            <Button type="button" onClick={reset} disabled={busy}>
              清空
            </Button>
            <span className="text-xs text-ink-faint">Enter 提交 · Esc 清空</span>
          </div>
        </form>
      </Panel>

      <Panel
        title="供应商目录"
        actions={
          providers.length > 0 ? (
            <CopyButton
              copied={catalogCopy.copied}
              onCopy={() => catalogCopy.copy(JSON.stringify(providers, null, 2))}
            />
          ) : undefined
        }
        className="lg:col-span-2"
      >
        {providers.length === 0 ? (
          <Empty
            message="服务端没有返回任何模型供应商。"
            hint="这通常意味着目录接口失败或版本不匹配 —— 先看「数据与日志」里的报错，再重启服务。"
          />
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4">
            {providers.map((provider) => (
              <div key={provider.id} className="min-w-0 rounded-md border border-base-750 bg-base-850/40 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate text-base font-semibold text-ink-hi">{provider.label}</span>
                  {provider.openAiCompatible ? <Badge tone="muted">OpenAI 兼容</Badge> : <Badge tone="warn">原生</Badge>}
                </div>
                <div className="num mt-1 truncate text-xs text-ink-faint" title={provider.baseUrl}>
                  {provider.baseUrl || '（自定义）'}
                </div>
                <div className="num mt-1 flex flex-wrap items-center gap-x-2 text-xs text-ink-lo">
                  <span>认证 {provider.authStyle}</span>
                  <span>JSON {provider.jsonMode}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
