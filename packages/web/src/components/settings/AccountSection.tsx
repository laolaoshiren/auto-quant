import { useState } from 'react';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { useCopy } from '../../lib/hooks';
import { Badge, Button, ErrorNote, Field, Panel, TextInput } from '../ui';
import { fmtDateTime } from '../../lib/format';

export function AccountSection() {
  const user = useApp((s) => s.user);
  const catalog = useApp((s) => s.catalog);
  const system = useApp((s) => s.system);
  const health = useApp((s) => s.health);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const catalogCopy = useCopy();

  const submit = async () => {
    setError(null);
    setDone(false);
    if (newPassword.length < 6) return setError('新密码至少需要 6 个字符。');
    if (newPassword !== confirm) return setError('两次输入的密码不一致。');

    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setDone(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <Panel title="账户">
        <div className="space-y-1.5">
          <Row label="用户名" value={user?.username ?? '—'} />
          <Row label="角色" value={user?.role ?? '—'} />
          <Row label="账户创建时间" value={fmtDateTime(user?.createdAt)} />
          <Row label="服务端版本" value={health?.version ?? '—'} />
          <Row label="数据库" value={health?.db ?? '—'} mono />
          <Row label="环境" value={system?.environmentLabel ?? '—'} />
        </div>
        <p className="mt-3 text-2xs leading-relaxed text-ink-faint">
          拥有者账户可以继续创建账户、管理凭证并启动机器人。第一个账户存在后，注册即关闭。
        </p>
      </Panel>

      <Panel title="修改密码">
        <div className="space-y-3">
          <Field label="当前密码">
            <TextInput
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <Field label="新密码">
            <TextInput
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label="确认新密码">
            <TextInput
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
          {error && <ErrorNote>{error}</ErrorNote>}
          {done && <div className="rounded border border-up/40 bg-up/10 px-2.5 py-1.5 text-xs text-up">密码已更新。</div>}
          <Button variant="primary" busy={busy} onClick={() => void submit()}>
            更新密码
          </Button>
        </div>
      </Panel>

      <Panel
        title="供应商目录"
        actions={
          <Button small onClick={() => catalogCopy.copy(JSON.stringify(catalog?.providers ?? [], null, 2))}>
            {catalogCopy.copied ? '✓ 已复制' : '复制 JSON'}
          </Button>
        }
        className="lg:col-span-2"
      >
        <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2 xl:grid-cols-3">
          {(catalog?.providers ?? []).map((provider) => (
            <div key={provider.id} className="rounded border border-base-800 bg-base-850/40 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-ink-hi">{provider.label}</span>
                {provider.openAiCompatible ? <Badge tone="muted">OpenAI 兼容</Badge> : <Badge tone="warn">原生</Badge>}
              </div>
              <div className="num mt-0.5 truncate text-2xs text-ink-faint" title={provider.baseUrl}>
                {provider.baseUrl || '（自定义）'}
              </div>
              <div className="num mt-0.5 text-2xs text-ink-lo">
                {provider.authStyle} · json {provider.jsonMode}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-base-850 py-1 last:border-0">
      <span className="text-2xs uppercase tracking-wide text-ink-lo">{label}</span>
      <span className={`text-xs text-ink-hi ${mono ? 'num max-w-[320px] truncate' : 'num'}`} title={mono ? value : undefined}>
        {value}
      </span>
    </div>
  );
}
