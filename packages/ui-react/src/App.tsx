import { useEffect, useState } from "react";
import Dashboard from "./components/Dashboard";
import Login from "./components/Login";
import WatchView from "./components/WatchView";
import { getToken, setToken } from "./lib/client";

type ConsoleMode = "chrome" | "electron";

function resolveMode(pathname: string): ConsoleMode {
  return pathname.startsWith("/console/electron") ? "electron" : "chrome";
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [watchWinId, setWatchWinId] = useState<number | null>(null);
  const [mode, setMode] = useState<ConsoleMode>(() => resolveMode(window.location.pathname));

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    const urlWinId = params.get("win_id");
    const parsedWinId = urlWinId ? Number(urlWinId) : null;

    if (urlToken) {
      setToken(urlToken);
    }

    if (Number.isFinite(parsedWinId) && parsedWinId) {
      setWatchWinId(parsedWinId);
    }

    if (urlToken) {
      const nextSearch = Number.isFinite(parsedWinId) && parsedWinId ? `?win_id=${parsedWinId}` : "";
      window.history.replaceState({}, "", `${window.location.pathname}${nextSearch}`);
    }

    setMode(resolveMode(window.location.pathname));
    setIsAuthenticated(Boolean(getToken() || urlToken));
    setIsChecking(false);

    const handlePopState = () => {
      const nextParams = new URLSearchParams(window.location.search);
      const nextWinId = Number(nextParams.get("win_id"));
      setMode(resolveMode(window.location.pathname));
      setWatchWinId(Number.isFinite(nextWinId) && nextWinId > 0 ? nextWinId : null);
      setIsAuthenticated(Boolean(getToken()));
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const handleModeChange = (nextMode: ConsoleMode) => {
    const nextPath = `/console/${nextMode}`;
    if (nextPath !== window.location.pathname) {
      window.history.pushState({}, "", nextPath);
    }
    setWatchWinId(null);
    setMode(nextMode);
  };

  if (isChecking) {
    return <div className="min-h-screen bg-[var(--app-bg)]" />;
  }

  if (watchWinId) {
    return <WatchView winId={watchWinId} />;
  }

  if (!isAuthenticated) {
    return <Login onLogin={() => setIsAuthenticated(true)} />;
  }

  return <Dashboard mode={mode} onModeChange={handleModeChange} />;
}
