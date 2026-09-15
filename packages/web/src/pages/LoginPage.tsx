/**
 * 登录页。
 *
 * 这里**没有注册入口**，这是设计而非遗漏：本系统面向单人部署，
 * 管理员账号在服务首次启动时自动创建，凭据只打印一次。
 *
 * 保留注册入口意味着：任何能访问到控制台的人，在数据库为空时都能把自己变成管理员。
 * 那个窗口在部署脚本尚未跑完、或数据卷被误删重建时会真实出现 ——
 * 对单人部署来说，这个风险没有任何对应的收益。
 *
 * 所以这一页要解决的是**信任**问题，而不只是收两个输入框：它要说清这是什么、
 * 下单会花真钱、以及账号从哪里来（`docker logs` 那行命令是锁死的操作员唯一的
 * 恢复路径，必须显眼且可复制）。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TriangleAlert, ArrowRight, LineChart, ShieldCheck, Terminal, Wallet } from 'lucide-react';
import { Button, ErrorNote, Field, TextInput } from '../components/ui';
import { useApp } from '../lib/store';
import { useDocumentTitle } from '../lib/hooks';

const FIRST_RUN_HINT = 'docker logs autoquant | grep FIRST_RUN_CREDENTIALS';

export function LoginPage() {
  const login = useApp((s) => s.login);
  const health = useApp((s) => s.health);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
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

  const copyHint = () => {
    /*
     * `navigator.clipboard` is undefined on an insecure origin — a plain-HTTP
     * LAN address is a realistic way to reach this console, so the copy button
     * has to be a no-op there rather than a thrown TypeError. The command is on
     * screen and select-all, so nothing is lost.
     */
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    void clipboard
      .writeText(FIRST_RUN_HINT)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        /* 被浏览器策略拒绝：命令本身就在屏幕上，可以手选 */
      });
  };

  return (
    <div className="flex min-h-screen flex-col bg-base-950 lg:flex-row">
      {/* ---------------------------------------------------------------- */}
      {/*  品牌区：说清这是什么、以及下单意味着什么                          */}
      {/* ---------------------------------------------------------------- */}
      {/* 窄屏下这段被压成一条标题条而不是整块删除：「实盘会花真钱」这句话
          不应该只在宽屏上出现。 */}
      <aside className="flex flex-col justify-between gap-6 border-b border-base-800 bg-base-900 px-5 py-6 sm:px-8 lg:w-[46%] lg:max-w-2xl lg:border-b-0 lg:border-r lg:px-12 lg:py-14">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-md font-bold text-accent">
              AQ
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight text-ink-hi">AutoQuant</h1>
              <p className="text-xs text-ink-lo">LLM 驱动的加密货币合约交易终端</p>
            </div>
          </div>

          <p className="mt-6 max-w-md text-base leading-relaxed text-ink-mid">
            7×24 自动运行：模型判断方向，服务端风控逐笔约束杠杆、仓位与止损，交易记录逐条落库、可回放。
          </p>

          <ul className="mt-6 space-y-3">
            <TrustRow icon={<Wallet aria-hidden className="h-4 w-4" />} title="下单用真钱" text="实盘模式下会向币安提交真实订单。模拟模式不需要密钥，随时可切。" />
            <TrustRow icon={<ShieldCheck aria-hidden className="h-4 w-4" />} title="风控不可绕过" text="杠杆、保证金、单笔风险由服务端夹紧；模型给出的越界参数会被改写并记录。" />
            <TrustRow icon={<LineChart aria-hidden className="h-4 w-4" />} title="账是可核对的" text="净盈亏 = 毛盈亏 − 手续费 − 资金费，每笔成交都按这个等式展示。" />
          </ul>
        </div>

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
          <span>Apache-2.0 开源</span>
          <span aria-hidden>·</span>
          <span>单人部署</span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <Terminal aria-hidden className="h-3.5 w-3.5" />
            凭据只打印一次
          </span>
        </p>
      </aside>

      {/* ---------------------------------------------------------------- */}
      {/*  表单区                                                           */}
      {/* ---------------------------------------------------------------- */}
      <main className="flex flex-1 items-center justify-center px-5 py-8 sm:px-8 lg:py-14">
        <div className="w-full max-w-md">
          <h2 className="text-xl font-semibold text-ink-hi">登录控制台</h2>
          <p className="mt-1 text-xs text-ink-lo">
            本系统没有注册入口，账号在服务首次启动时自动生成。
          </p>

          <form onSubmit={submit} className="mt-5 space-y-4">
            {noAccountYet && (
              <div
                role="status"
                className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2.5 text-xs leading-relaxed text-ink-mid"
              >
                <span className="flex items-center gap-1.5 font-semibold text-warn">
                  <TriangleAlert aria-hidden className="h-3.5 w-3.5 shrink-0" />
                  该实例还没有账户
                </span>
                <p className="mt-1">
                  管理员账号在服务首次启动时自动创建，凭据只打印一次。若已丢失，只能从服务日志里取回：
                </p>
                <div className="mt-2 flex items-start gap-2">
                  <code className="num min-w-0 flex-1 select-all break-all rounded bg-base-950 px-2 py-1.5 text-2xs text-ink-mid">
                    {FIRST_RUN_HINT}
                  </code>
                  <Button small variant="ghost" onClick={copyHint} title="复制这条命令">
                    {copied ? '已复制' : '复制'}
                  </Button>
                </div>
                <p className="mt-1.5 text-ink-lo">
                  容器名不是 <span className="num">autoquant</span> 时，用{' '}
                  <span className="num">docker ps</span> 查到实际名称再替换。
                </p>
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

            {/* 提交按钮比输入框高一档：这是整页唯一的主操作，不该和字段一样大 */}
            <Button type="submit" variant="primary" block busy={busy} className="py-2.5">
              登录
              {!busy && <ArrowRight aria-hidden className="h-4 w-4" />}
            </Button>

            {/* 恢复路径的第二处提示。上面那块只在「还没有账户」时出现，而
                忘记密码的情况同样需要它 —— 那正是这条命令最有用的时候。 */}
            <p className="rounded-md border border-base-800 bg-base-900/60 px-3 py-2 text-xs leading-relaxed text-ink-lo">
              忘记密码？本系统不提供邮件重置。用服务端日志里的首次凭据登录后，可在「操作员账户」中修改用户名与密码：
              <code className="num mt-1 block select-all break-all text-2xs text-ink-faint">{FIRST_RUN_HINT}</code>
            </p>
          </form>

          <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-base-800 pt-3 text-xs text-ink-faint">
            {health ? (
              <>
                <span className="num">{health.environment.toUpperCase()}</span>
                <span aria-hidden>·</span>
                <span className="num">版本 {health.version}</span>
                <span aria-hidden>·</span>
                <span className="num">已运行 {Math.floor(health.uptimeSeconds / 60)} 分</span>
                {health.tradingDisabled && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="font-semibold text-down">全局交易已禁用</span>
                  </>
                )}
              </>
            ) : (
              <span className="text-warn">无法连接后端 — 请确认服务已在运行。</span>
            )}
          </div>

          {health?.tradingDisabled && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-down/90">
              <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              服务端设置了 GLOBAL_TRADING_DISABLED：登录与查看不受影响，但任何启动请求都会被拒绝。
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

/** 一条「为什么可以信这个系统」的短陈述。左栏用的，不出现在窄屏折叠区。 */
function TrustRow({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-base-750 bg-base-850 text-ink-lo">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-base font-medium text-ink-hi">{title}</span>
        <span className="block text-xs leading-relaxed text-ink-lo">{text}</span>
      </span>
    </li>
  );
}
