import { Link } from 'react-router-dom';
import { Panel } from '../components/ui';
import { useDocumentTitle } from '../lib/hooks';

export function NotFoundPage() {
  useDocumentTitle('页面不存在');
  return (
    <Panel title="页面不存在">
      <p className="text-xs text-ink-lo">
        控制台中不存在该路由。请检查地址，或返回概览页。
      </p>
      <Link to="/" className="btn btn-primary mt-3 inline-flex">
        返回概览
      </Link>
    </Panel>
  );
}
