/**
 * 操作员账户。
 *
 * 这一页是**安全设置**，不是资料页：系统没有注册入口，账号在服务首次启动时
 * 自动创建，之后只能在这里改。版面按 `LAYOUT.md` §1 分成两半：
 *
 *   左指标栏（只读状态）：当前身份 / 角色 / 账户创建时间 / 服务端版本 / 数据库 / 运行环境。
 *     这些数字回答的是"我现在改的是哪个账号、跑在什么环境里" —— 它们是**状态**，
 *     改密码时不需要动它们，所以不该和表单抢同一列。
 *   主内容区：凭据变更表单（用户名 / 当前密码 / 新密码）。
 *
 * **供应商目录已删除**：那是一张"这个版本支持哪些模型厂商"的静态清单，与
 * "改我的账号凭据"没有任何关系，而它占了整页最下方一大块。要看供应商清单去
 * 「AI 模型」页 —— 那里每一行都是**你实际配置过的**模型，比一张通用目录有用。
 * （见 `git log` 里 `fix(ui): 账号页删掉与它无关的供应商目录`。）
 *
 * `PATCH /api/auth/account` 要求**当前密码**，这是有意为之：能碰到这台浏览器的人
 * 不应该因此就能永久接管账户。这一道校验在前端不做任何"放宽" ——
 * 契约保持原样：`currentPassword` 必填，`username` 与 `newPassword`（≥8）可选，
 * 服务端重新签发令牌后本地必须换掉那一份（否则后续请求带的还是旧身份）。
 */
import { useState } from 'react';
import { Save } from 'lucide-react';
import { userRoleLabel } from '@aq/shared';
import { api, setToken } from '../../lib/api';
import { useApp } from '../../lib/store';
import { usePolled } from '../../lib/hooks';
import { Button, ErrorNote, Field, Panel, TextInput } from '../ui';
import { Metric, MetricGroup, SectionLabel } from '../shell';
import { fmtDateTime } from '../../lib/format';

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

  /*
   * 部署版本，以及"线上是不是最新的"。
   *
   * 版本比对**单独加载**，因为服务端要为它出网（打 GitHub，8 秒超时）——
   * 塞进 `/api/system` 会让整页的加载被一个有则更好、没有也无妨的诊断拖住。
   * 不带 interval：打开这一页查一次就够，服务端自己缓存 10 分钟。
   */
  const build = system?.build ?? null;
  const update = usePolled((signal) => api.updateCheck(signal), { intervalMs: 0 });

  const updateLabel = update.error
    ? '检查失败'
    : update.loading
      ? '检查中…'
      : update.data?.state === 'up-to-date'
        ? '一致'
        : update.data?.state === 'behind'
          ? `落后${update.data.behindBy === null ? '' : ` ${update.data.behindBy} 个提交`}`
          : update.data?.state === 'ahead'
            ? '领先（未推送）'
            : update.data?.state === 'diverged'
              ? '已分叉'
              : '未知';
  const updateTone: 'default' | 'up' | 'warn' = update.error
    ? 'warn'
    : update.data?.state === 'up-to-date'
      ? 'up'
      : update.data?.state === 'behind' ||
          update.data?.state === 'ahead' ||
          update.data?.state === 'diverged'
        ? 'warn'
        : 'default';

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

  /* ------------------------------------------------------------------------ */
  /*  状态：**横排占整宽**，不放进窄栏                                        */
  /* ------------------------------------------------------------------------ */
  /*
   * 这一块原来在 `PageShell` 的右栏里（只占视口的 40%），而 `MetricGroup` 在 xl
   * 下是 4 列网格 —— 每列只剩约 150px，而 `Metric` 的数值是 `truncate` 的：
   * `main @ 222ae15`、`2026-09-20 03:33`、`autoquant.sqlite` 全被切掉，
   * 界面上看起来只是"有点挤"，实际是**信息被静默丢掉了**。
   *
   * 状态信息需要的是宽度，不是"伴随信息"的位置。所以它横排占整宽。
   */
  const status = (
    <MetricGroup title="当前账户" columns={4}>
      <Metric label="用户名" value={user?.username ?? '—'} size="lg" tone="strong" />
      <Metric label="角色" value={user?.role ? userRoleLabel(user.role) : '—'} sub={user?.role ?? undefined} />
      <Metric label="账户创建时间" value={fmtDateTime(user?.createdAt)} />
      <Metric
        label="运行环境"
        value={system?.dryRun ? '模拟' : '实盘'}
        tone={system?.dryRun ? 'default' : 'warn'}
        sub={system?.environmentLabel ?? system?.environment ?? '—'}
      />
    </MetricGroup>
  );

  /*
   * 服务端信息 —— **放在右栏，与说明卡同列**。
   *
   * ## 为什么它和「当前账户」分开
   *
   * 这两组回答的是不同的问题：「当前账户」是"我在改谁的凭据"，服务端信息是
   * "这套东西跑在什么版本上"。把它们堆成一组九个数、横排占满整宽，结果是
   * 上方一大条指标、下方左栏一个长表单而右栏一张短卡 —— 右下角那片空白。
   *
   * ## ⚠️ 列数必须跟着栏宽降下来
   *
   * 上面那段注释记着一次事故：这组指标曾经**就在右栏里**，而 `MetricGroup` 在
   * `xl` 下是 4 列网格 —— 每列只剩约 150px，而 `Metric` 的值是 `truncate` 的，
   * `main @ 222ae15`、`2026-09-20 03:33`、`autoquant.sqlite` 全被切掉，
   * 界面上看起来只是"有点挤"，实际是**信息被静默丢掉了**。
   *
   * 所以这里显式给 `columns={2}`：右栏约 920px，两列各 460px，值是放得下的。
   * **不要改回 4** —— 那是把同一个 bug 再犯一次。
   */
  const serverStatus = (
    <MetricGroup title="服务端" columns={2} layout="vertical">
      <Metric
        label="服务端版本"
        value={build ? `${build.branch} @ ${build.commitShort}` : '未知'}
        sub={build?.subject || (build ? undefined : '本次部署没有写出版本信息')}
        tone={build?.dirty ? 'warn' : 'default'}
      />
      <Metric label="部署时间" value={build?.deployedAt ? fmtDateTime(build.deployedAt) : '—'} />
      <Metric
        label="与 GitHub"
        value={updateLabel}
        tone={updateTone}
        sub={update.error ?? update.data?.message}
      />
      <Metric label="产品版本" value={system?.version ?? health?.version ?? '—'} />
      <Metric label="数据库" value={health?.db ?? '—'} />
    </MetricGroup>
  );

  /*
   * 右栏 = 安全说明 + 服务端信息。
   *
   * 说明原来是一张孤零零的短卡，而左栏的表单有五个字段 —— 于是右下角空出一大块。
   * 把「服务端」那组指标移到它下面之后，两栏高度接近，而"我改的这套东西跑在什么
   * 版本上"也回到了它该在的位置：和"关于这个账户"是同一类**只读的背景信息**。
   */
  const notes = (
    <div className="space-y-5">
      <Panel>
        <h3 className="text-sm font-semibold text-ink-hi">关于这个账户</h3>
        <div className="mt-2 space-y-2 text-xs leading-relaxed text-ink-mid">
          <p>
            本系统面向单人部署：管理员账号在服务首次启动时自动创建，<strong>不提供注册入口</strong>
            ，也没有找回密码的流程 —— 修改只能在这里做，且必须验证当前密码。
          </p>
          <p>如果用户名与密码都忘了，只能到服务器上重置数据库里的凭据记录。</p>
          {build?.dirty && (
            <p className="text-warn">
              ⚠ 打包时工作区有未提交改动 —— 线上跑的代码<strong>不等于</strong> {build.commitShort}{' '}
              这个提交，它的行为无法用仓库里的任何一版解释。
            </p>
          )}
        </div>
      </Panel>

      {serverStatus}
    </div>
  );

  /*
   * 布局：状态横排（整宽）→ 表单 / 说明两栏 → 供应商目录（整宽）。
   *
   * 供应商目录占整宽、而不是缩在表单下面：它是一张需要横向空间的网格，每个卡片的
   * URL 动辄三四十个字符，放在窄栏里只能截断 —— 而 URL 恰恰是那一格最有用的信息。
   *
   * ## ⚠️ 左列宽度必须**等于表单的限宽**
   *
   * 原来写的是 `2fr 1fr`（左列约占 2/3）而表单自己 `max-w-xl`（36rem）。
   * 在 1600px 的屏上左列约 1000px、表单只占 576px —— **左边空出四百多像素**，
   * 整页看起来像"内容缩在左上角"。两个数字各自都合理，问题在于它们是**两个**
   * 数字：列宽不知道表单会自己限宽。
   *
   * 现在列宽就是 `36rem`，表单不再需要自己限宽（小屏单列时仍然保留 `max-w-xl`，
   * 否则输入框会横跨整个手机屏之外）。
   */
  return (
    <div className="min-w-0 space-y-5">
      {status}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,36rem)_minmax(0,1fr)]">
        <section className="min-w-0 max-w-xl">
          <SectionLabel
            title="修改用户名与密码"
            actions={<span className="text-xs text-ink-faint">Enter 提交 · Esc 清空</span>}
          />
          <Panel>
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
              </div>
            </form>
          </Panel>
        </section>

        {notes}
      </div>
    </div>
  );
}
