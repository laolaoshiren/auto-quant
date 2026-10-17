import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Layout } from './components/Layout';
import { FeedErrorBoundary } from './components/FeedErrorBoundary';
import { StaleTraderBanner } from './components/StaleTraderBanner';
import { Spinner, Spinner3 } from './components/ui';
import { useApp } from './lib/store';
import { boundaryKeyFor } from './lib/routeBoundary';

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
const AppearancePage = lazy(() =>
  import('./pages/AppearancePage').then((m) => ({ default: m.AppearancePage })),
);
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
    <>
      {/*
        ⚠️ **全局停摆横幅挂在最顶层**（2026-10-17 · t99）—— 它是**跨页面**的事：
        挂在某个页面顶部的话，人停在别的页面就看不见，那等于没解决
        "信号在没人看的地方"（`#10` 真实资金停摆 5.5 小时就是这么发生的）。
        放在 `<Routes>` **外面**：所有路由（含登录页）都会渲染它。
      */}
      <StaleTraderBanner />
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
          path="/appearance"
          element={
            <Lazy>
              <AppearancePage />
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
    </>
  );
}

/**
 * 一个路由元素 + 它自己的 Suspense 边界 + 它自己的**错误边界**。
 *
 * 边界放在元素这一层而不是整个 `<Routes>` 外面：这样加载下一页时外壳
 * （顶栏、导航、推送状态）保持挂载，只有内容区换成 fallback；
 * 放在外面会让整棵树连同 socket 状态一起卸载重建。
 *
 * ## ⚠️ 错误边界必须在这里（外部 issue #169）
 *
 * `Suspense` **只捕挂起，不捕抛错**。而在渲染期抛错且没有错误边界时，
 * React 会**卸载整棵树** —— 表现是**整个控制台白屏**，
 * 连"去别的地方看看"都做不到。
 *
 * 本仓库自己记录过这次事故：
 * `docs/archive/REPORT-TRIAGE-20260926.md:98` 把「前端缺 ErrorBoundary
 * （渲染期抛错会白屏）」列在"已确认但仍未修"；`FeedErrorBoundary.tsx` 的头部
 * 注释也记了一次真实白屏（一条字段不全的决策记录 → 读 `undefined.length`）。
 *
 * 而**风险面不止决策看板**：`OverviewPage` / `TradersPage` / `MarketPage` /
 * `TraderTables`（持仓、订单、成交、权益曲线）消费的**同样是"模型输出解析而来"
 * 的不可信数据**（按 `docs/AGENTS.md` §2.4，模型的输出是不可信输入）。
 * 之前只有决策卡片那一条路径有兜底。
 *
 * ## 为什么 key 必须随路由变化
 *
 * React 的错误边界**进入 error 状态后不会自己恢复**。没有 `key` 的话，
 * 一次崩溃会粘住整个会话 —— 用户切到别的（好的）页面看到的仍是"这一块渲染失败"。
 * 所以用当前路径当 `key`：**换页即重置**。
 *
 * 用 `pathname` 而不是 `location.key`：后者每次导航都换新值（含同页查询串变化），
 * 会让"在崩溃页点一个筛选"重置边界、于是又崩一次。见 `lib/routeBoundary.ts`。
 */
function Lazy({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <FeedErrorBoundary key={boundaryKeyFor(pathname)} fallback={<RouteCrashFallback />}>
      <Suspense fallback={<RouteFallback />}>{children}</Suspense>
    </FeedErrorBoundary>
  );
}

/**
 * 页面渲染崩溃时显示什么。
 *
 * ⚠️ **必须保住"还能去别处"这条路**：外壳（顶栏/导航/侧栏）在边界之外仍然挂载，
 * 所以用户可以直接点导航切走。fallback 里也要说清这一点 ——
 * 白屏时用户最需要知道的是"这是数据问题还是系统挂了、我还能做什么"。
 */
function RouteCrashFallback() {
  return (
    <div
      role="alert"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <div className="text-base font-medium text-warn">这个页面渲染失败了</div>
      <div className="max-w-md text-xs leading-relaxed text-ink-lo">
        最可能的原因是某条数据不完整（页面内容一部分来自模型输出解析，字段缺失是常态）。
        <br />
        <strong className="font-semibold text-ink-mid">
          顶栏与侧栏仍然可用 —— 点别的页面即可继续操作
        </strong>
        ，不需要重启服务。
      </div>
      <div className="text-xs text-ink-faint">
        切走再切回来会重新渲染这个页面；若每次都崩，请把浏览器控制台的报错发出来。
      </div>
    </div>
  );
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
