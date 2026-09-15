import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { Layout } from './components/Layout';
import { Spinner3 } from './components/ui';
import { useApp } from './lib/store';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { TraderPage } from './pages/TraderPage';
import { DecisionDetailPage } from './pages/DecisionDetailPage';
import { StrategyListPage } from './pages/StrategyListPage';
import { StrategyEditorPage } from './pages/StrategyEditorPage';
import { MarketPage } from './pages/MarketPage';
import { ModelsPage } from './pages/ModelsPage';
import { ExchangesPage } from './pages/ExchangesPage';
import { AccountPage } from './pages/AccountPage';
import { TradersPage } from './pages/TradersPage';
import { SettingsPage } from './pages/SettingsPage';
import { DataPage } from './pages/DataPage';
import { FaqPage } from './pages/FaqPage';
import { NotFoundPage } from './pages/NotFoundPage';

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
          <p className="text-2xs text-ink-faint">AutoQuant · LLM 合约终端</p>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={status === 'authenticated' ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<OverviewPage />} />
        <Route path="/traders" element={<TradersPage />} />
        <Route path="/traders/:id" element={<TraderPage />} />
        <Route path="/traders/:id/decisions/:recordId" element={<DecisionDetailPage />} />
        <Route path="/strategy" element={<StrategyListPage />} />
        <Route path="/strategy/:id" element={<StrategyEditorPage />} />
        <Route path="/market" element={<MarketPage />} />
        <Route path="/models" element={<ModelsPage />} />
        <Route path="/exchanges" element={<ExchangesPage />} />
        <Route path="/account" element={<AccountPage />} />
        {/* Legacy: the three settings tabs are now first-class nav items. */}
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/data" element={<DataPage />} />
        <Route path="/faq" element={<FaqPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
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
