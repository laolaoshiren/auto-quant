import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, ErrorNote, Field, Panel, TextInput } from '../components/ui';
import { useApp } from '../lib/store';
import { useDocumentTitle } from '../lib/hooks';

/**
 * 登录页。
 *
 * 这里**没有注册入口**，这是设计而非遗漏：本系统面向单人部署，
 * 管理员账号在服务首次启动时自动创建，凭据只打印一次。
 *
 * 保留注册入口意味着：任何能访问到控制台的人，在数据库为空时都能把自己变成管理员。
 * 那个窗口在部署脚本尚未跑完、或数据卷被误删重建时会真实出现 ——
 * 对单人部署来说，这个风险没有任何对应的收益。
 */
export function LoginPage() {
  const login = useApp((s) => s.login);
  const health = useApp((s) => s.health);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  useDocumentTitle('登录');

  // 服务端还没初始化出账号。正常情况下首次启动就会创建，出现这个状态
  // 多半是服务刚起来、或数据卷被清空了。
  const noAccountYet = health ? !health.hasOwner : false;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
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
            <p className="text-2xs text-ink-faint">LLM 驱动的合约交易终端</p>
          </div>
        </div>

        <Panel title="登录" bodyClassName="p-4" padded={false}>
          <form onSubmit={submit} className="space-y-3">
            {noAccountYet && (
              <div className="rounded border border-warn/50 bg-warn/10 px-2.5 py-2 text-2xs leading-relaxed text-ink-mid">
                <span className="font-semibold text-warn">该实例还没有账户。</span>
                <br />
                管理员账号在服务首次启动时自动创建，凭据只打印一次。请查看服务日志：
                <br />
                <code className="mt-1 block rounded bg-base-950 px-1.5 py-1 font-mono text-2xs text-ink-lo">
                  docker logs autoquant | grep FIRST_RUN_CREDENTIALS
                </code>
              </div>
            )}

            <Field label="用户名">
              <TextInput
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                placeholder="请输入用户名"
                required
              />
            </Field>

            <Field label="密码">
              <TextInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="••••••••"
                required
              />
            </Field>

            {error && <ErrorNote>{error}</ErrorNote>}

            <Button type="submit" variant="primary" block busy={busy}>
              登录
            </Button>

            <p className="text-center text-2xs leading-relaxed text-ink-faint">
              登录后可在「操作员账户」中修改用户名与密码。
            </p>
          </form>
        </Panel>

        <p className="mt-3 text-center text-2xs leading-relaxed text-ink-faint">
          {health
            ? `${health.environment.toUpperCase()} 环境 · 版本 ${health.version} · 运行 ${Math.floor(health.uptimeSeconds / 60)}分`
            : '无法连接后端 — 请确认服务已在运行。'}
          {health?.tradingDisabled && <span className="text-down"> · 全局交易已禁用</span>}
        </p>
      </div>
    </div>
  );
}
