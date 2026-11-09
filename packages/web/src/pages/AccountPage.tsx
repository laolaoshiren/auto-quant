/**
 * 操作员账户页。
 *
 * 包装层只负责页面级标题：身份/角色在左侧只读栏里，这里不再重复一遍。
 * 表单本体在 `AccountSection` 里（就地校验、当前密码必填）。
 */
import { useDocumentTitle } from '../lib/hooks';
import { SectionHeading } from '../components/Badges';
import { AccountSection } from '../components/settings/AccountSection';

export function AccountPage() {
  useDocumentTitle('操作员账户');

  return (
    <div className="min-w-0">
      <SectionHeading title="操作员账户" sub="修改用户名或密码需要验证当前密码；修改后服务端会重新签发会话令牌。" />
      <AccountSection />
    </div>
  );
}
