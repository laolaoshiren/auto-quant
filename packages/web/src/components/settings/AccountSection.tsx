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
import { PageShell, SectionLabel } from '../shell';
import { fmtDateTime, tradingEnvironmentLabel } from '../../lib/format';

/**
 * 只读的「键 — 值」一行。
 *
 * ## 为什么这一页不用 `Metric` 卡
 *
 * 这一页原来在伴随栏里塞了两组 `MetricGroup`（身份 3 项 + 运行环境 1 项 +
 * 版本与部署 3 项 + 运行时 2 项），每项都是一张 60px 高的卡：9 项 ≈ 540px。
 * 而这一页**总共只有 4 个输入框**，却要滚动 262px 才能看到底 ——
 * 用户的原话是「这个页面重新设计好，别出现滚动翻页，本身就没几个显示的东西」。
 *
 * `Metric` 那套排版是给**盯盘用的读数**设计的（大号数字、副行、贴底对齐），
 * 而这里的值全是"我是谁 / 跑在什么版本上"这类**静态事实**，一眼扫过去就够，
 * 不需要 2xl 的字号也不需要等高的卡片。换成一行 20px 的键值对之后，
 * 同样的 9 项只占 180px 左右，整页因此能收进一屏。
 *
 * 值一律 `break-all` 且带 `title`：版本号、提交哈希这类长串在窄栏里会被
 * 截断，而截掉的部分必须能从悬停读到（见 `Metric.subTitle` 那段说明）。
 */
function FactRow({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'warn' | 'up';
}) {
  const toneClass = tone === 'warn' ? 'text-warn' : tone === 'up' ? 'text-up' : 'text-ink-hi';
  return (
    /*
     * `py-0.5` 而不是 `py-1`：一行 25px，正好对上设计规范里"紧凑密度"的
     * 表格行高（`--aq-row-h` 24px）。这一页有 9 行，每行省 4px 就是 36px ——
     * 那 36px 正好是"一屏放得下"与"要多滚一下"的分界（实测 1405x722 下
     * 差 10px）。行高再小就该看不清了，所以这里不再往下压。
     */
    <div className="flex items-baseline gap-2 border-b border-base-800 py-0.5 last:border-b-0">
      <span className="shrink-0 text-xs text-ink-faint">{label}</span>
      <span className="min-w-0 flex-1" />
      <span className={`num min-w-0 break-all text-right text-base ${toneClass}`} title={sub ?? value}>
        {value}
      </span>
    </div>
  );
}

/**
 * 一组 `FactRow`，带小标题。
 *
 * 标题用 `MetricGroup` 同一套排版（`text-xs` + 大写字距 + `ink-faint`），
 * 让"身份 / 运行环境 / 版本与部署 / 运行时"四组在视觉上仍然分得开 ——
 * 换成键值行省掉的是**卡片的体积**，不是分组本身。
 *
 * 组之间一条 `border-t`：两行数值挨着时，没有它读者会以为
 * 「账户创建时间」下面那行还是身份信息。
 */
function FactGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-base-800 pt-1.5 first:border-t-0 first:pt-0">
      <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">{title}</h3>
      {children}
    </section>
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

  /*
   * 部署版本，以及"线上是不是最新的"。
   *
   * 版本比对**单独加载**，因为服务端要为它出网（打 GitHub，8 秒超时）——
   * 塞进 `/api/system` 会让整页的加载被一个有则更好、没有也无妨的诊断拖住。
   * 不带 interval：打开这一页查一次就够，服务端自己缓存 10 分钟。
   */
  const build = system?.build ?? null;
  const update = usePolled((signal) => api.updateCheck(signal), { intervalMs: 0 });

  /*
   * ⚠️ **产品版本的权威来源是 GitHub 上的最新 release，不是 `package.json`**
   *（2026-10-15 用户报的 BUG）。
   *
   * 原来这一格读 `system.version` / `health.version`，两者都来自 `package.json`
   * 的 `version` —— 而那个字段**从 `0.1.0` 起就没再更新过**（发版走的是
   * release-drafter 从提交推导 tag）。实测界面上写 `0.1.0`，
   * 而 GitHub 上最新发布已经是 **`v0.1.32`** —— 差了 32 个版本。
   *
   * 取不到（没发过 release / 网络不通）时回落到本地那个值，并且**说明它是本地的** ——
   * 不假装它是远端版本。
   */
  const latestRelease = update.data?.latestRelease ?? null;

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
  /*  伴随栏：只读状态与部署信息                                              */
  /* ------------------------------------------------------------------------ */
  /*
   * ## 为什么状态回到伴随栏，而不是"横排占整宽"
   *
   * 这块指标**曾经**就在伴随栏里被截断过：`MetricGroup` 的列数是按**视口**
   * 断点算的（不看容器宽度），伴随栏只占视口的 40%，`columns={4}` 却照样排
   * 四列 —— 每列约 150px，而 `Metric` 的数值带 `truncate`：`main @ 222ae15`、
   * `2026-09-20 03:33`、`autoquant.sqlite` 全被静默切掉。
   *
   * 当时的修法是"横排占整宽"。宽度是够了，但页面变成了**两张互不相干的表**：
   * 上面一条占满整宽的大字指标带，下面左边一个表单、右边一段说明，中间大片空白。
   *
   * 现在回到伴随栏，但换一条思路解决截断：**列数跟着栏宽显式降下来**。
   * 这一栏里所有指标都用 `columns={1}`（一行一个），于是长值天然放得下 ——
   * 不再依赖"整宽"这件事，也就不需要占满整宽。
   *
   * ⚠️ **不要给这里的任何一组改回 3/4 列**：那是把同一次静默截断再犯一次。
   *
   * ## ⚠️ 2026-10-13：这里从 `Metric` 卡换成了 `FactRow`
   *
   * 用户的原话：「这个页面重新设计好，别出现滚动翻页，本身就没几个显示的东西」。
   *
   * 实测（1405x722）：页面总高 **776px**、视口只有 **542px**，溢出 **262px**。
   * 高度全花在两处，而它们都不是用户来这一页要做的事：
   *
   *   · 右栏两张卡 9 项 `Metric`：356 + 350 = **706px**；
   *   · 左栏表单 4 个输入框：410px。
   *
   * `Metric` 那套排版是给**盯盘读数**用的（2xl 数字、副行贴底、等高卡片），
   * 而这里 9 项全是"我是谁 / 跑在什么版本上"的静态事实 —— 一眼扫过就够。
   * 换成 20px 一行的 `FactRow` 之后，同样 9 项只占 180px 上下，
   * 页面从 776px 收到 542px 以内，**一屏放得下**。
   *
   * 分组没有丢：`FactGroup` 仍然给每组一个小标题和上下分隔线，
   * 读者依然知道"身份 / 运行环境 / 版本与部署 / 运行时"是四组不同的东西。
   */
  const rail = (
    <div className="space-y-3">
      <Panel title="当前账户" bodyClassName="px-4 py-2">
        <FactGroup title="身份">
          <FactRow label="用户名" value={user?.username ?? '—'} />
          <FactRow label="角色" value={user?.role ? userRoleLabel(user.role) : '—'} sub={user?.role ?? undefined} />
          <FactRow label="账户创建时间" value={fmtDateTime(user?.createdAt)} />
        </FactGroup>

        <FactGroup title="运行环境">
          {/*
            ⚠️ **兜底那一支也要翻译**（2026-10-17，t52 的 B2）。

            这一格的 `sub` 有两个来源：`environmentLabel`（交易所端点名，中文）
            与 `environment`（机器码）。老服务端不给前者时，第二个来源就直接
            渲染成 `production` / `demo` —— 一个兜底路径上的露码，
            而它恰好出现在一次**跨版本升级**之后（最容易让人困惑的时刻）。

            改成过 `tradingEnvironmentLabel`：与「数据与日志」页、登录页同一套词。
          */}
          <FactRow
            label="模式"
            value={system?.dryRun ? '模拟' : '实盘'}
            sub={
              system?.environmentLabel ??
              (system?.environment ? tradingEnvironmentLabel(system.environment) : undefined)
            }
            tone={system?.dryRun ? undefined : 'warn'}
          />
        </FactGroup>
      </Panel>

      <Panel title="服务端" bodyClassName="px-4 py-2">
        <FactGroup title="版本与部署">
          <FactRow
            label="服务端版本"
            value={build ? `${build.branch} @ ${build.commitShort}` : '未知'}
            sub={build?.subject || (build ? undefined : '本次部署没有写出版本信息')}
            tone={build?.dirty ? 'warn' : undefined}
          />
          <FactRow label="部署时间" value={build?.deployedAt ? fmtDateTime(build.deployedAt) : '—'} />
          <FactRow
            label="与 GitHub"
            value={updateLabel}
            sub={update.error ?? update.data?.message}
            tone={updateTone === 'up' ? 'up' : updateTone === 'warn' ? 'warn' : undefined}
          />
        </FactGroup>

        <FactGroup title="运行时">
          <FactRow
            label="产品版本"
            value={latestRelease ?? system?.version ?? health?.version ?? '—'}
            sub={
              latestRelease !== null
                ? 'GitHub 上最新发布的版本'
                : '本地 package.json 的版本 —— GitHub 上的发布没取到'
            }
          />
          <FactRow label="数据库" value={health?.db ?? '—'} />
        </FactGroup>
      </Panel>
    </div>
  );

  /*
   * 账户说明 = 表单的注脚。
   *
   * 它原来在右栏里、和「服务端」那些指标叠在一起，而左栏的表单比它高一截 ——
   * 两栏底部对不齐，右下角空出半屏。这一段只说三件事（没有注册入口、忘记密码
   * 只能去服务器、打包不干净时线上代码无法解释），而**读它的人正在做"改密码"
   * 这件事**，所以它跟着表单走，落在表单下面。
   */
  const notes = (
    <Panel title="账户说明" bodyClassName="px-4 py-2.5">
      <div className="space-y-1.5 text-xs leading-snug text-ink-mid">
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
  );

  /*
   * 版面：伴随栏放**只读的**（我是谁、跑在什么版本上），主区放**唯一的动作**
   * （改凭据）—— 与「交易所」页同一套结构，两屏之间不用重新学怎么读。
   *
   * `fillHeight={false}`：这一页内容少，撑满视口只会在最下面空出半屏纯黑。
   * 表单也不再自己限宽（原来 `max-w-xl` + 外层再套列宽，结果左边空出四百多
   * 像素）：它现在只占主内容列，输入框横跨这一列正是该有的宽度。
   *
   * ## 四个输入框改成 2x2 栅格（2026-10-13）
   *
   * 原来是单列 `space-y-3`：4 个字段各占一整行（标签 17 + 输入 38 + 说明 16
   * + 间距 12 ≈ 83px），合计 **410px** —— 这一栏里最贵的一块，而它只装了
   * 四个输入框。用户要的是"别出现滚动翻页，本身就没几个显示的东西"。
   *
   * 换成 `sm:grid-cols-2` 之后同样的字段只占两行（约 242px），省下 168px。
   * 语义上也更顺：**新用户名 / 当前密码** 是第一行（"改成什么" + "凭什么"），
   * **新密码 / 确认新密码** 是第二行（一对必须一致的字段并排，比对更直观）。
   *
   * 窄屏（`< sm`）仍然退回单列 —— 320px 宽的屏幕上两个密码框并排会各剩
   * 不到 140px，输入的圆点根本看不清。
   */
  return (
    <PageShell aside={rail} fillHeight={false}>
      <section className="min-w-0">
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
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
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
            </div>

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
    </PageShell>
  );
}
