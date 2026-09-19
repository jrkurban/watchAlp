import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const App = lazy(() => import('./App.tsx'));
const Home = lazy(() => import('./Home.tsx'));
const Logs = lazy(() => import('./Logs.tsx'));

const params = new URLSearchParams(window.location.search);
const path = window.location.pathname.replace(/\/$/, '') || '/';
const isLogs = path === '/logs' || params.get('view') === 'logs';
const roomId = params.get('room')?.trim();
const Screen = isLogs ? Logs : roomId ? App : Home;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="min-h-screen bg-stone-50 dark:bg-stone-900" />}>
      <Screen />
    </Suspense>
  </StrictMode>,
);
