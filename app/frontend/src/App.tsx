import { useEffect, useRef } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Wallet } from './pages/Wallet';
import { Settings } from './pages/Settings';
import { NotFound } from './pages/NotFound';

const ROUTE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/wallet': 'Wallet',
  '/settings': 'Settings',
};

function getRouteTitle(pathname: string): string {
  return ROUTE_TITLES[pathname] ?? 'Page not found';
}

function NavigationFeedback() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement | null>(null);
  const previousPathRef = useRef<string | null>(null);

  useEffect(() => {
    const title = getRouteTitle(location.pathname);
    document.title = `${title} | Handsoff`;

    const isGenuineRouteChange =
      previousPathRef.current !== null &&
      previousPathRef.current !== location.pathname;
    previousPathRef.current = location.pathname;

    if (!isGenuineRouteChange) {
      return;
    }

    const main = mainRef.current ?? document.getElementById('main-content');
    if (main) {
      if (!main.hasAttribute('tabindex')) {
        main.setAttribute('tabindex', '-1');
      }
      main.focus({ preventScroll: false });
    }
  }, [location.pathname]);

  return (
    <main id="main-content" ref={mainRef} aria-live="polite" aria-atomic="true">
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="wallet" element={<Wallet />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </main>
  );
}

export default function App() {
  return <NavigationFeedback />;
}
