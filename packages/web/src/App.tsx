import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Layout } from './components/Layout';
import { Spinner, Spinner3 } from './components/ui';
import { useApp } from './lib/store';

/*
 * 路由级代码分割。
 *
 * 之前所有页面（连同 recharts / lightweight-charts）都打进入口 chunk，
 * 首屏必须先把**从没打开过的页面**也下载、解析完才能出画面 —— 单文件近 1MB。
 * 现在每个页面按需加载：入口只剩外壳与登录判定，图表库跟着用到它的页面走。
 *
 * 代价是切换页面时会有一次极短的 chunk 拉取，用 `RouteFallback` 兜住：
 * 它撑满内容区，所以顶栏不动，也不会出现"内容先塌成一条再弹回来"的跳版。
 */
const LoginPage = lazy(() => import('./pages/LoginPage').then((m) => ({ default: m.LoginPage })));
const OverviewPage = lazy(() => import('./pages/OverviewPage').then((m) => ({ default: m.OverviewPage })));
const TradersPage = lazy(() => import('./pages/TradersPage').then((m) => ({ default: m.TradersPage })));
const TraderPage = lazy(() => import('./pages/TraderPage').then((m) => ({ default: m.TraderPage })));
const DecisionDetailPage = lazy(() =>
  import('./pages/DecisionDetailPage').then((m) => ({ default: m.DecisionDetailPage })),
);
const StrategyListPage = lazy(() => import('./pages/StrategyListPage').then((m) => ({ default: m.StrategyListPage })));
const StrategyEditorPage = lazy(() =>
  import('./pages/StrategyEditorPage').then((m) => ({ default: m.StrategyEditorPage })),
);
const MarketPage = lazy(() => import('./pages/MarketPage').then((m) => ({ default: m.MarketPage })));
const ModelsPage = lazy(() => import('./pages/ModelsPage').then((m) => ({ default: m.ModelsPage })));
const ExchangesPage = lazy(() => import('./pages/ExchangesPage').then((m) => ({ default: m.ExchangesPage })));
const AccountPage = lazy(() => import('./pages/AccountPage').then((m) => ({ default: m.AccountPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const DataPage = lazy(() => import('./pages/DataPage').then((m) => ({ default: m.DataPage })));
const FaqPage = lazy(() => import('./pages/FaqPage').then((m) => ({ default: m.FaqPage })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));

export function App() {
  const status = useApp((s) => s.status);
  const bootstrap = useApp((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (status === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-base-950">
        <div className="flex flex-col items-center gap-2">
          <Spinner3 label="正在恢复会话" />
          <p className="text-xs text-ink-faint">AutoQuant · LLM 合约终端</p>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          status === 'authenticated' ? (
            <Navigate to="/" replace />
          ) : (
            <Lazy>
              <LoginPage />
            </Lazy>
          )
        }
      />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route
          path="/"
          element={
            <Lazy>
              <OverviewPage />
            </Lazy>
          }
        />
        <Route
          path="/traders"
          element={
            <Lazy>
              <TradersPage />
            </Lazy>
          }
        />
        <Route
          path="/traders/:id"
          element={
            <Lazy>
              <TraderPage />
            </Lazy>
          }
        />
        <Route
          path="/traders/:id/decisions/:recordId"
          element={
            <Lazy>
              <DecisionDetailPage />
            </Lazy>
          }
        />
        <Route
          path="/strategy"
          element={
            <Lazy>
              <StrategyListPage />
            </Lazy>
          }
        />
        <Route
          path="/strategy/:id"
          element={
            <Lazy>
              <StrategyEditorPage />
            </Lazy>
          }
        />
        <Route
          path="/market"
          element={
            <Lazy>
              <MarketPage />
            </Lazy>
          }
        />
        <Route
          path="/models"
          element={
            <Lazy>
              <ModelsPage />
            </Lazy>
          }
        />
        <Route
          path="/exchanges"
          element={
            <Lazy>
              <ExchangesPage />
            </Lazy>
          }
        />
        <Route
          path="/account"
          element={
            <Lazy>
              <AccountPage />
            </Lazy>
          }
        />
        {/* Legacy: the three settings tabs are now first-class nav items. */}
        <Route
          path="/settings"
          element={
            <Lazy>
              <SettingsPage />
            </Lazy>
          }
        />
        <Route
          path="/data"
          element={
            <Lazy>
              <DataPage />
            </Lazy>
          }
        />
        <Route
          path="/faq"
          element={
            <Lazy>
              <FaqPage />
            </Lazy>
          }
        />
        <Route
          path="*"
          element={
            <Lazy>
              <NotFoundPage />
            </Lazy>
          }
        />
      </Route>
    </Routes>
  );
}

/**
 * 一个路由元素 + 它自己的 Suspense 边界。
 *
 * 边界放在元素这一层而不是整个 `<Routes>` 外面：这样加载下一页时外壳
 * （顶栏、导航、推送状态）保持挂载，只有内容区换成 fallback；
 * 放在外面会让整棵树连同 socket 状态一起卸载重建。
 */
function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/** 撑满内容区的加载态 —— 高度接近一屏，所以出现/消失都不会造成跳版。 */
function RouteFallback() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-ink-lo"
    >
      <Spinner className="h-5 w-5 text-accent" />
      <span className="text-base">正在加载页面…</span>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const status = useApp((s) => s.status);
  const location = useLocation();

  if (status !== 'authenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
