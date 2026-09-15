import { useApp } from '../lib/store';
import { useDocumentTitle } from '../lib/hooks';
import { SectionHeading } from '../components/Badges';
import { AccountSection } from '../components/settings/AccountSection';

export function AccountPage() {
  useDocumentTitle('操作员账户');
  const user = useApp((s) => s.user);

  return (
    <div className="space-y-3">
      <SectionHeading title="操作员账户" sub={user ? `当前身份：${user.username}` : '账户、密码与服务端信息。'} />
      <AccountSection />
    </div>
  );
}
