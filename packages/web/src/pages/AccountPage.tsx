/**
 * 操作员账户页。
 *
 * 包装层负责两件界面上的事：页面级标题（含当前身份），以及一个偏窄的
 * 宽度上限 —— 这一页是表单，输入框横跨 1600px 只会让"标签在左、输入在右"
 * 的对应关系断掉。账户信息与改密表单用两列，窄屏自动落成一列。
 */
import { useApp } from '../lib/store';
import { useDocumentTitle } from '../lib/hooks';
import { AccountSection } from '../components/settings/AccountSection';

export function AccountPage() {
  useDocumentTitle('操作员账户');
  const user = useApp((s) => s.user);

  return (
    <div className="mx-auto max-w-5xl space-y-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-wide text-ink-hi">操作员账户</h1>
        <p className="mt-0.5 text-base text-ink-lo">
          {user
            ? `当前身份：${user.username}${user.role ? ` · ${user.role}` : ''}。修改用户名或密码需要验证当前密码。`
            : '账户、密码与服务端信息。'}
        </p>
      </div>
      <AccountSection />
    </div>
  );
}
