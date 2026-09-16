/**
 * 操作员账户页。
 *
 * 包装层只负责页面级标题：身份放在副标题里（`userRoleLabel` 把角色码翻译成中文，
 * 不再出现 `admin` 这种机器码），版面结构由 `AccountSection` 的 `PageShell` 决定。
 *
 * 不再套 `max-w-5xl`：宽度由骨架控制，`xl` 下左栏 280px、表单占剩余宽度；
 * 表单区再自己限宽，避免输入框横跨 1600px 后"标签在左、输入在右"对不上。
 */
import { userRoleLabel } from '@aq/shared';
import { useApp } from '../lib/store';
import { useDocumentTitle } from '../lib/hooks';
import { SectionHeading } from '../components/Badges';
import { AccountSection } from '../components/settings/AccountSection';

export function AccountPage() {
  useDocumentTitle('操作员账户');
  const user = useApp((s) => s.user);

  return (
    <div className="min-w-0">
      <SectionHeading
        title="操作员账户"
        sub={
          user
            ? `当前身份：${user.username}${user.role ? ` · ${userRoleLabel(user.role)}` : ''}。修改用户名或密码需要验证当前密码。`
            : '账户、密码与服务端信息。'
        }
      />
      <AccountSection />
    </div>
  );
}
