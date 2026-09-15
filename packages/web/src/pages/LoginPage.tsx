import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, ErrorNote, Field, Panel, TextInput } from '../components/ui';
import { useApp } from '../lib/store';
import { useDocumentTitle } from '../lib/hooks';

export function LoginPage() {
  const login = useApp((s) => s.login);
  const register = useApp((s) => s.register);
  const health = useApp((s) => s.health);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const navigate = useNavigate();
  useDocumentTitle('登录');

  // Registration is only open while the instance has no owner at all.
  const needsOwner = health ? !health.hasOwner : false;
  const effectiveMode = needsOwner ? 'register' : mode;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (effectiveMode === 'register' && password !== confirm) {
      setError('两次输入的密码不一致。');
      return;
    }
    if (password.length < 6) {
      setError('密码至少需要 6 个字符。');
      return;
    }

    setBusy(true);
    try {
      if (effectiveMode === 'register') {
        await register(username.trim(), password);
      } else {
        await login(username.trim(), password);
      }
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-base-950 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-4 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-accent/15 text-sm font-bold text-accent">
            AQ
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-wide text-ink-hi">AutoQuant</h1>
            <p className="text-2xs text-ink-faint">LLM 驱动的加密合约终端</p>
          </div>
        </div>

        <Panel
          title={effectiveMode === 'register' ? '创建拥有者账户' : '登录'}
          bodyClassName="p-4"
          padded={false}
        >
          <form onSubmit={submit} className="space-y-3">
            {needsOwner && (
              <div className="rounded border border-accent/40 bg-accent/10 px-2.5 py-2 text-2xs text-ink-mid">
                该实例还没有任何账户。你创建的第一个账户将成为拥有者，可管理凭证、策略与机器人。
              </div>
            )}

            <Field label="用户名">
              <TextInput
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                placeholder="admin"
                required
              />
            </Field>

            <Field label="密码">
              <TextInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={effectiveMode === 'register' ? 'new-password' : 'current-password'}
                placeholder="••••••••"
                required
              />
            </Field>

            {effectiveMode === 'register' && (
              <Field label="确认密码">
                <TextInput
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  placeholder="••••••••"
                  required
                />
              </Field>
            )}

            {error && <ErrorNote>{error}</ErrorNote>}

            <Button type="submit" variant="primary" block busy={busy}>
              {effectiveMode === 'register' ? '创建账户并登录' : '登录'}
            </Button>

            {!needsOwner && (
              <button
                type="button"
                onClick={() => {
                  setMode(effectiveMode === 'login' ? 'register' : 'login');
                  setError(null);
                }}
                className="w-full text-center text-2xs text-ink-faint transition hover:text-accent"
              >
                {mode === 'login' ? '还没有账户？注册拥有者' : '返回登录'}
              </button>
            )}
          </form>
        </Panel>

        <p className="mt-3 text-center text-2xs leading-relaxed text-ink-faint">
          {health
            ? `${health.environment.toUpperCase()} 环境 · 版本 ${health.version} · 运行 ${Math.floor(health.uptimeSeconds / 60)}分`
            : '无法连接后端 — 请启动端口 3200 的服务。'}
          {health?.tradingDisabled && <span className="text-down"> · 全局交易已禁用</span>}
        </p>
      </div>
    </div>
  );
}
