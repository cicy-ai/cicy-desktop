import { useEffect, useState } from 'react';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import WatchView from './components/WatchView';
import { getToken, removeToken, setToken } from './lib/client';

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [watchWinId, setWatchWinId] = useState<number | null>(null);
  const currentPath = window.location.pathname;
  const initialMode = currentPath.startsWith('/console/electron') ? 'electron' : 'chrome';

  useEffect(() => {
    // Check URL params
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    const urlWinId = params.get('win_id');

    if (urlToken) {
      setToken(urlToken);
      // Clean up URL
      const newUrl = window.location.pathname + (urlWinId ? `?win_id=${urlWinId}` : '');
      window.history.replaceState(null, '', newUrl);
    }

    if (urlWinId) {
      setWatchWinId(parseInt(urlWinId));
      setIsChecking(false);
      return;
    }

    const token = getToken();
    if (token || urlToken) {
      setIsAuthenticated(true);
    }
    setIsChecking(false);
  }, []);

  const handleLogin = () => {
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    removeToken();
    setIsAuthenticated(false);
  };

  if (isChecking) return null;

  if (watchWinId) {
    return <WatchView winId={watchWinId} />;
  }

  return (
    <>
      {isAuthenticated ? (
        <Dashboard onLogout={handleLogout} initialMode={initialMode} />
      ) : (
        <Login onLogin={handleLogin} />
      )}
    </>
  );
}
