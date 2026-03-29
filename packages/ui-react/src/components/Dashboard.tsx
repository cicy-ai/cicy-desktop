import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  ArrowUpRight,
  Copy,
  Eye,
  Link2,
  Monitor,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Square,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import { getSnapshotUrl, requestJson, rpc, rpcJson } from "../lib/client";

type ConsoleMode = "chrome" | "electron";
type WorkspaceView = "operate" | "launch" | "tune";
type NoticeTone = "neutral" | "success" | "error";

interface WindowInfo {
  id: number;
  title: string;
  url: string;
  bounds: { x: number; y: number; width: number; height: number };
}

interface ChromeProfile {
  profileKey: string;
  accountIdx: number;
  gmail: string;
  port: number | null;
  proxy: string | null;
  liveStatus?: { isRunning?: boolean };
}

interface DashboardProps {
  mode: ConsoleMode;
  onModeChange: (mode: ConsoleMode) => void;
}

const STORAGE_KEYS = {
  selectedWindow: "ELECTRON_MCP_SELECTED_WIN",
  selectedProfile: "ELECTRON_MCP_SELECTED_PROFILE",
  watchInterval: "ELECTRON_MCP_INTERVAL",
  captureQuality: "ELECTRON_MCP_QUALITY",
  captureScale: "ELECTRON_MCP_SCALE",
  snapshotMaxElements: "ELECTRON_MCP_SNAPSHOT_MAX_ELEMENTS",
  snapshotShowOverlays: "ELECTRON_MCP_SNAPSHOT_SHOW_OVERLAYS",
} as const;

const KEY_CODE_MAP: Record<string, string> = {
  Enter: "Return",
  Backspace: "Backspace",
  Tab: "Tab",
  Escape: "Escape",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

const QUICK_LAUNCH_TARGETS = [
  { label: "ChatGPT", url: "https://chatgpt.com" },
  { label: "Gemini", url: "https://gemini.google.com" },
  { label: "AI Studio", url: "https://aistudio.google.com" },
] as const;

const CHROME_TUNE_TARGETS = [
  { label: "api.myip.com", url: "https://api.myip.com" },
  { label: "ifconfig.me", url: "https://ifconfig.me" },
  { label: "ip138.com", url: "https://ip138.com" },
] as const;

function readStoredNumber(key: string, fallback: number) {
  const raw = localStorage.getItem(key);
  if (raw == null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readStoredBoolean(key: string, fallback: boolean) {
  const raw = localStorage.getItem(key);
  if (raw == null) return fallback;
  return raw === "true";
}

function readStoredNullableNumber(key: string) {
  const raw = localStorage.getItem(key);
  if (raw == null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatHost(url: string) {
  if (!url) return "No URL";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function shortenUrl(url: string) {
  if (!url) return "No URL";
  if (url.length <= 64) return url;
  return `${url.slice(0, 61)}...`;
}

function formatBounds(bounds: WindowInfo["bounds"]) {
  return `${bounds.width}×${bounds.height} · ${bounds.x},${bounds.y}`;
}

function buildWatchUrl(winId: number) {
  const url = new URL(window.location.href);
  url.searchParams.set("win_id", String(winId));
  return url.toString();
}

function isTypingTarget(target: EventTarget | null) {
  const node = target as HTMLElement | null;
  if (!node) return false;
  const tagName = node.tagName;
  return (
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT" ||
    node.isContentEditable ||
    Boolean(node.closest("[data-local-input='true']"))
  );
}

function Button({
  icon,
  label,
  onClick,
  disabled,
  active,
  dataId,
}: {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  dataId?: string;
}) {
  return (
    <button
      className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-45 ${
        active
          ? "border-[color:var(--accent)]/50 bg-[color:var(--accent)]/16 text-white"
          : "border-white/8 bg-white/[0.04] text-slate-300 hover:border-white/14 hover:bg-white/[0.08] hover:text-white"
      }`}
      data-id={dataId}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
    </button>
  );
}

function ModeChip({
  active,
  label,
  onClick,
  dataId,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  dataId?: string;
}) {
  return (
    <button
      className={`rounded-xl px-3 py-2 text-sm transition ${
        active ? "bg-[var(--accent)] text-slate-950" : "text-slate-400 hover:bg-white/[0.06] hover:text-white"
      }`}
      data-id={dataId}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function SidebarItem({
  active,
  label,
  meta,
  onClick,
  status,
  dataId,
}: {
  active: boolean;
  label: string;
  meta: string;
  onClick: () => void;
  status?: "online" | "offline";
  dataId?: string;
}) {
  return (
    <button
      className={`w-full self-start rounded-2xl border px-4 py-3 text-left transition ${
        active
          ? "border-[color:var(--accent)]/55 bg-[color:var(--accent)]/14"
          : "border-white/8 bg-white/[0.03] hover:border-white/14 hover:bg-white/[0.06]"
      }`}
      data-id={dataId}
      onClick={onClick}
      type="button"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-white">{label}</div>
          <div className="mt-1 truncate text-[11px] text-slate-500">{meta}</div>
        </div>
        {status ? <div className={`mt-1 h-2.5 w-2.5 rounded-full ${status === "online" ? "bg-emerald-400" : "bg-slate-600"}`} /> : null}
      </div>
    </button>
  );
}

function WorkspaceChip({
  active,
  label,
  onClick,
  dataId,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  dataId?: string;
}) {
  return (
    <button
      className={`rounded-xl px-3 py-2 text-sm transition ${
        active ? "bg-white/[0.08] text-white" : "text-slate-500 hover:bg-white/[0.05] hover:text-slate-300"
      }`}
      data-id={dataId}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function Field({
  label,
  value,
  dataId,
}: {
  label: string;
  value: string;
  dataId?: string;
}) {
  return (
    <div className="space-y-1" data-id={dataId}>
      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="text-sm text-slate-200">{value}</div>
    </div>
  );
}

function MetricPill({
  label,
  value,
  dataId,
}: {
  label: string;
  value: string;
  dataId?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-2" data-id={dataId}>
      <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-medium text-white">{value}</div>
    </div>
  );
}

function RangeField({
  label,
  valueLabel,
  min,
  max,
  step,
  value,
  onChange,
  dataId,
}: {
  label: string;
  valueLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  dataId?: string;
}) {
  return (
    <label className="block space-y-2" data-id={dataId} data-local-input="true">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono text-xs text-slate-500">{valueLabel}</span>
      </div>
      <input
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/8 accent-[var(--accent)]"
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="range"
        value={value}
      />
    </label>
  );
}

export default function Dashboard({ mode, onModeChange }: DashboardProps) {
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [profiles, setProfiles] = useState<ChromeProfile[]>([]);
  const [selectedWinId, setSelectedWinId] = useState<number | null>(() => readStoredNullableNumber(STORAGE_KEYS.selectedWindow));
  const [selectedProfileIdx, setSelectedProfileIdx] = useState<number | null>(() =>
    readStoredNullableNumber(STORAGE_KEYS.selectedProfile),
  );
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("operate");
  const [proxyDrafts, setProxyDrafts] = useState<Record<number, string>>({});

  const [windowsLoading, setWindowsLoading] = useState(false);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [boundsSaving, setBoundsSaving] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [windowAction, setWindowAction] = useState<string | null>(null);
  const [profileAction, setProfileAction] = useState<string | null>(null);

  const [watchInterval, setWatchInterval] = useState(() => readStoredNumber(STORAGE_KEYS.watchInterval, 1200));
  const [quality, setQuality] = useState(() => readStoredNumber(STORAGE_KEYS.captureQuality, 72));
  const [scale, setScale] = useState(() => readStoredNumber(STORAGE_KEYS.captureScale, 0.58));
  const [maxElements, setMaxElements] = useState(() => readStoredNumber(STORAGE_KEYS.snapshotMaxElements, 24));
  const [showOverlays, setShowOverlays] = useState(() => readStoredBoolean(STORAGE_KEYS.snapshotShowOverlays, false));

  const [bounds, setBounds] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [snapshotDialogText, setSnapshotDialogText] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);
  const [pingTime, setPingTime] = useState<number | null>(null);
  const [clickPulse, setClickPulse] = useState<{ x: number; y: number } | null>(null);

  const imgRef = useRef<HTMLImageElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const clickPulseTimerRef = useRef<number | null>(null);

  const selectedWindow = useMemo(
    () => windows.find((item) => item.id === selectedWinId) || null,
    [selectedWinId, windows],
  );
  const selectedProfile = useMemo(
    () => profiles.find((item) => item.accountIdx === selectedProfileIdx) || null,
    [profiles, selectedProfileIdx],
  );

  function announce(message: string, tone: NoticeTone = "neutral") {
    setNotice({ tone, message });
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2800);
  }

  function releasePreviewUrl() {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }

  async function fetchWindowList() {
    const data = await rpcJson<WindowInfo[]>("get_windows");
    return Array.isArray(data) ? data : [];
  }

  async function loadWindows() {
    setWindowsLoading(true);
    try {
      setWindows(await fetchWindowList());
    } catch (error) {
      announce(error instanceof Error ? error.message : "Failed to load windows.", "error");
    } finally {
      setWindowsLoading(false);
    }
  }

  async function loadProfiles() {
    setProfilesLoading(true);
    try {
      const data = await requestJson<{ profiles?: ChromeProfile[] }>("/api/chrome/profiles");
      setProfiles(Array.isArray(data?.profiles) ? data.profiles : []);
    } catch (error) {
      announce(error instanceof Error ? error.message : "Failed to load profiles.", "error");
    } finally {
      setProfilesLoading(false);
    }
  }

  async function focusWindow(winId: number) {
    await rpc("control_electron_BrowserWindow", { win_id: winId, code: "win.focus()" });
  }

  async function refreshPreview(winId: number, announceErrors = false) {
    setPreviewLoading(true);
    try {
      const response = await fetch(getSnapshotUrl(winId, quality, scale));
      if (!response.ok) {
        throw new Error(`Preview request failed with ${response.status}`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      releasePreviewUrl();
      previewUrlRef.current = objectUrl;
      if (imgRef.current) imgRef.current.src = objectUrl;
    } catch (error) {
      if (announceErrors) {
        announce(error instanceof Error ? error.message : "Preview failed.", "error");
      }
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleOpenWindow(targetUrl: string) {
    setWindowAction(`open:${targetUrl}`);
    try {
      const beforeIds = new Set(windows.map((item) => item.id));
      const existing = windows.find((item) => {
        try {
          return new URL(item.url).hostname === new URL(targetUrl).hostname;
        } catch {
          return item.url === targetUrl;
        }
      });

      if (existing) {
        await focusWindow(existing.id);
        setSelectedWinId(existing.id);
        setWorkspaceView("operate");
        announce(`Focused ${formatHost(targetUrl)}.`, "success");
        return;
      }

      await rpc("open_window", {
        accountIdx: selectedProfile?.accountIdx ?? 0,
        options: { width: 1280, height: 860 },
        reuseWindow: false,
        url: targetUrl,
      });

      const nextWindows = await fetchWindowList();
      setWindows(nextWindows);
      const createdWindow = nextWindows.find((item) => !beforeIds.has(item.id)) || nextWindows[nextWindows.length - 1];
      if (createdWindow) {
        setSelectedWinId(createdWindow.id);
        await refreshPreview(createdWindow.id);
      }
      setWorkspaceView("operate");
      announce(`Opened ${formatHost(targetUrl)}.`, "success");
    } catch (error) {
      announce(error instanceof Error ? error.message : "Open window failed.", "error");
    } finally {
      setWindowAction(null);
    }
  }

  async function handleProfileAction(action: "open" | "restart" | "stop", url?: string) {
    if (!selectedProfile) return;

    setProfileAction(action);
    try {
      await requestJson(`/api/chrome/profiles/${selectedProfile.accountIdx}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(url ? { url } : {}),
      });
      await loadProfiles();
      if (action === "open" && !url) setWorkspaceView("operate");
      announce(url ? `Opened ${formatHost(url)}.` : `${action} account_${selectedProfile.accountIdx}`, "success");
    } catch (error) {
      announce(error instanceof Error ? error.message : "Profile action failed.", "error");
    } finally {
      setProfileAction(null);
    }
  }

  async function handleSaveProxy(restart: boolean) {
    if (!selectedProfile) return;

    setProfileAction(restart ? "proxy-restart" : "proxy-save");
    try {
      await requestJson(`/api/chrome/profiles/${selectedProfile.accountIdx}/proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: Boolean(proxyDrafts[selectedProfile.accountIdx] || ""),
          proxy: proxyDrafts[selectedProfile.accountIdx] || "",
          restart,
        }),
      });
      await loadProfiles();
      announce(restart ? "Proxy saved + restarted." : "Proxy saved.", "success");
    } catch (error) {
      announce(error instanceof Error ? error.message : "Proxy save failed.", "error");
    } finally {
      setProfileAction(null);
    }
  }

  async function handleApplyBounds() {
    if (!selectedWindow) return;

    setBoundsSaving(true);
    try {
      const response = await rpc("set_window_bounds", {
        win_id: selectedWindow.id,
        x: bounds.x,
        y: bounds.y,
        width: bounds.w,
        height: bounds.h,
      });
      const payload = await response.json();
      if (!response.ok || payload?.result?.isError) {
        throw new Error(payload?.result?.content?.[0]?.text || "Bounds update failed.");
      }
      await loadWindows();
      announce("Bounds updated.", "success");
    } catch (error) {
      announce(error instanceof Error ? error.message : "Bounds update failed.", "error");
    } finally {
      setBoundsSaving(false);
    }
  }

  async function handleReloadPage() {
    if (!selectedWindow) return;

    setWindowAction("reload");
    try {
      await rpc("control_electron_BrowserWindow", { win_id: selectedWindow.id, code: "win.reload()" });
      window.setTimeout(() => {
        void refreshPreview(selectedWindow.id);
      }, 400);
      announce("Reload sent.", "success");
    } catch (error) {
      announce(error instanceof Error ? error.message : "Reload failed.", "error");
    } finally {
      setWindowAction(null);
    }
  }

  async function handleCloseWindow() {
    if (!selectedWindow) return;
    if (!window.confirm(`Close window #${selectedWindow.id}?`)) return;

    setWindowAction("close");
    try {
      await rpc("close_window", { win_id: selectedWindow.id });
      await loadWindows();
      announce(`Closed #${selectedWindow.id}.`, "success");
    } catch (error) {
      announce(error instanceof Error ? error.message : "Close failed.", "error");
    } finally {
      setWindowAction(null);
    }
  }

  async function handleCloseAllWindows() {
    if (!windows.length) return;
    if (!window.confirm("Close all managed windows?")) return;

    setWindowAction("close-all");
    try {
      await Promise.all(windows.map((item) => rpc("close_window", { win_id: item.id })));
      setWindows([]);
      setSelectedWinId(null);
      releasePreviewUrl();
      if (imgRef.current) imgRef.current.removeAttribute("src");
      announce("Closed all windows.", "success");
    } catch (error) {
      announce(error instanceof Error ? error.message : "Close all failed.", "error");
    } finally {
      setWindowAction(null);
    }
  }

  async function handleSnapshotCapture() {
    if (!selectedWindow) return;

    setSnapshotLoading(true);
    try {
      const response = await rpc("webpage_snapshot", {
        win_id: selectedWindow.id,
        max_elements: maxElements,
        include_screenshot: true,
        show_overlays: showOverlays,
      });
      const payload = await response.json();
      const text = payload?.result?.content?.[0]?.text;

      if (!response.ok || payload?.result?.isError) {
        throw new Error(text || "Snapshot failed.");
      }

      if (!text) {
        setSnapshotDialogText("No snapshot data.");
      } else {
        try {
          setSnapshotDialogText(JSON.stringify(JSON.parse(text), null, 2));
        } catch {
          setSnapshotDialogText(text);
        }
      }
    } catch (error) {
      announce(error instanceof Error ? error.message : "Snapshot failed.", "error");
    } finally {
      setSnapshotLoading(false);
    }
  }

  async function handleCopyWatchLink() {
    if (!selectedWindow) return;
    try {
      await navigator.clipboard.writeText(buildWatchUrl(selectedWindow.id));
      announce("Watch link copied.", "success");
    } catch {
      announce("Clipboard unavailable.", "error");
    }
  }

  async function handlePreviewClick(event: MouseEvent<HTMLImageElement>) {
    if (!selectedWindow || !imgRef.current) return;

    const rect = imgRef.current.getBoundingClientRect();
    const clickX = Math.round(((event.clientX - rect.left) / rect.width) * selectedWindow.bounds.width);
    const clickY = Math.round(((event.clientY - rect.top) / rect.height) * selectedWindow.bounds.height);

    setClickPulse({ x: event.clientX, y: event.clientY });
    if (clickPulseTimerRef.current) window.clearTimeout(clickPulseTimerRef.current);
    clickPulseTimerRef.current = window.setTimeout(() => setClickPulse(null), 700);

    try {
      await rpc("cdp_click", { win_id: selectedWindow.id, x: clickX, y: clickY, button: "left" });
      window.setTimeout(() => {
        void refreshPreview(selectedWindow.id);
      }, 160);
    } catch (error) {
      announce(error instanceof Error ? error.message : "Click failed.", "error");
    }
  }

  useEffect(() => {
    void loadWindows();
    void loadProfiles();
  }, []);

  useEffect(() => {
    setWorkspaceView("operate");
    if (mode === "electron") void loadWindows();
    else void loadProfiles();
  }, [mode]);

  useEffect(() => {
    setSelectedWinId((current) => {
      if (!windows.length) return null;
      return current && windows.some((item) => item.id === current) ? current : windows[0].id;
    });
  }, [windows]);

  useEffect(() => {
    setSelectedProfileIdx((current) => {
      if (!profiles.length) return null;
      return current != null && profiles.some((item) => item.accountIdx === current) ? current : profiles[0].accountIdx;
    });
  }, [profiles]);

  useEffect(() => {
    setProxyDrafts((current) => {
      const next = { ...current };
      for (const profile of profiles) {
        if (next[profile.accountIdx] === undefined) next[profile.accountIdx] = profile.proxy || "";
      }
      return next;
    });
  }, [profiles]);

  useEffect(() => {
    if (selectedWinId == null) localStorage.removeItem(STORAGE_KEYS.selectedWindow);
    else localStorage.setItem(STORAGE_KEYS.selectedWindow, String(selectedWinId));
  }, [selectedWinId]);

  useEffect(() => {
    if (selectedProfileIdx == null) localStorage.removeItem(STORAGE_KEYS.selectedProfile);
    else localStorage.setItem(STORAGE_KEYS.selectedProfile, String(selectedProfileIdx));
  }, [selectedProfileIdx]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.watchInterval, String(watchInterval));
  }, [watchInterval]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.captureQuality, String(quality));
  }, [quality]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.captureScale, String(scale));
  }, [scale]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.snapshotMaxElements, String(maxElements));
  }, [maxElements]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.snapshotShowOverlays, String(showOverlays));
  }, [showOverlays]);

  useEffect(() => {
    if (!selectedWindow) return;
    setBounds({
      x: selectedWindow.bounds.x,
      y: selectedWindow.bounds.y,
      w: selectedWindow.bounds.width,
      h: selectedWindow.bounds.height,
    });
    if (mode === "electron") {
      void focusWindow(selectedWindow.id).catch(() => undefined);
    }
  }, [mode, selectedWindow]);

  useEffect(() => {
    if (mode !== "electron" || !selectedWinId || workspaceView !== "operate") return;
    void refreshPreview(selectedWinId);
  }, [mode, quality, scale, selectedWinId, workspaceView]);

  useEffect(() => {
    async function ping() {
      const startedAt = Date.now();
      try {
        await rpc("ping", {});
        setPingTime(Date.now() - startedAt);
      } catch {
        setPingTime(null);
      }
    }

    void ping();
    const timer = window.setInterval(() => {
      void ping();
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (mode !== "electron" || workspaceView !== "operate" || !selectedWinId) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      const key = event.key;
      if (key.length !== 1 && !KEY_CODE_MAP[key]) return;

      try {
        const keyCode = KEY_CODE_MAP[key] || key.toUpperCase();
        await rpc("control_electron_WebContents", {
          win_id: selectedWinId,
          code: `webContents.sendInputEvent({type: 'keyDown', keyCode: '${keyCode}', key: '${key}'})`,
        });
        await rpc("control_electron_WebContents", {
          win_id: selectedWinId,
          code: `webContents.sendInputEvent({type: 'keyUp', keyCode: '${keyCode}', key: '${key}'})`,
        });
      } catch {
        announce("Keyboard forwarding failed.", "error");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, selectedWinId, workspaceView]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
      if (clickPulseTimerRef.current) window.clearTimeout(clickPulseTimerRef.current);
      releasePreviewUrl();
    };
  }, []);

  const noticeClass =
    notice?.tone === "success"
      ? "border-emerald-500/30 bg-emerald-500/14 text-emerald-50 shadow-[0_18px_60px_rgba(18,120,88,0.28)]"
      : notice?.tone === "error"
        ? "border-rose-500/30 bg-rose-500/14 text-rose-50 shadow-[0_18px_60px_rgba(190,24,93,0.24)]"
        : "border-white/10 bg-[#0d171d]/92 text-slate-100 shadow-[0_18px_60px_rgba(0,0,0,0.32)]";

  const chromeStatus = selectedProfile?.liveStatus?.isRunning ? "running" : "stopped";
  const onlineProfiles = profiles.filter((item) => item.liveStatus?.isRunning).length;

  return (
    <div className="min-h-screen bg-[var(--app-bg)] text-slate-100" data-id="dashboard-root">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_left,rgba(55,124,110,0.22),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(191,160,91,0.1),transparent_22%)]" />
      <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(420px,calc(100vw-2rem))] flex-col gap-3" data-id="notice-layer">
        {notice ? (
          <div
            className={`pointer-events-auto rounded-2xl border px-4 py-3 text-sm backdrop-blur-xl transition-all duration-200 ${noticeClass}`}
            data-id="notice-banner"
            role="status"
          >
            {notice.message}
          </div>
        ) : null}
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-[1640px] flex-col gap-4 p-4 xl:flex-row" data-id="dashboard-shell">
        <aside className="panel-surface flex w-full shrink-0 flex-col xl:w-[288px]" data-id="sidebar">
          <div className="flex items-center justify-between gap-3" data-id="sidebar-header">
            <div className="text-sm font-semibold text-white">CiCy</div>
            <div className={`rounded-full px-2 py-1 text-[11px] ${pingTime != null ? "bg-emerald-500/12 text-emerald-200" : "bg-rose-500/12 text-rose-200"}`} data-id="sidebar-connection-status">
              <Wifi className="mr-1 inline h-3 w-3" />
              {pingTime != null ? `${pingTime}ms` : "offline"}
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 p-1" data-id="mode-switch">
            <div className="grid grid-cols-2 gap-1">
              <ModeChip active={mode === "chrome"} dataId="mode-chip-chrome" label="Chrome" onClick={() => onModeChange("chrome")} />
              <ModeChip active={mode === "electron"} dataId="mode-chip-electron" label="Electron" onClick={() => onModeChange("electron")} />
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2 xl:grid-cols-2" data-id="sidebar-metrics">
            <MetricPill dataId="metric-node" label="Node" value={pingTime != null ? "healthy" : "offline"} />
            <MetricPill dataId="metric-windows" label="Windows" value={String(windows.length)} />
            <MetricPill dataId="metric-profiles" label="Profiles" value={String(onlineProfiles)} />
          </div>

          <div className="mt-5 flex items-center justify-between" data-id="sidebar-toolbar">
            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500" data-id="sidebar-list-label">{mode === "electron" ? "Sessions" : "Profiles"}</div>
            <button
              className="rounded-lg p-2 text-slate-400 transition hover:bg-white/[0.06] hover:text-white"
              data-id="sidebar-refresh"
              onClick={() => void (mode === "electron" ? loadWindows() : loadProfiles())}
              type="button"
            >
              <RefreshCw className={`h-4 w-4 ${(mode === "electron" ? windowsLoading : profilesLoading) ? "animate-spin" : ""}`} />
            </button>
          </div>

          <div className="mt-3 grid grid-flow-col auto-cols-[220px] gap-2 overflow-x-auto pb-1 xl:min-h-0 xl:flex-1 xl:auto-rows-max xl:grid-flow-row xl:auto-cols-auto xl:content-start xl:overflow-y-auto xl:overflow-x-hidden xl:pr-1" data-id="sidebar-list">
            {mode === "electron"
              ? windows.map((item) => (
                  <Fragment key={item.id}>
                    <SidebarItem
                      active={item.id === selectedWinId}
                      dataId={`sidebar-window-${item.id}`}
                      label={item.title || "Untitled"}
                      meta={`${formatHost(item.url)} · #${item.id}`}
                      onClick={() => setSelectedWinId(item.id)}
                    />
                  </Fragment>
                ))
              : profiles.map((item) => (
                  <Fragment key={item.profileKey}>
                    <SidebarItem
                      active={item.accountIdx === selectedProfileIdx}
                      dataId={`sidebar-profile-${item.accountIdx}`}
                      label={`account_${item.accountIdx}`}
                      meta={item.gmail || `port ${item.port ?? "—"}`}
                      onClick={() => setSelectedProfileIdx(item.accountIdx)}
                      status={item.liveStatus?.isRunning ? "online" : "offline"}
                    />
                  </Fragment>
                ))}
          </div>
        </aside>

        <main className="panel-surface flex min-w-0 flex-1 flex-col overflow-hidden" data-id="main-panel">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/8 pb-4" data-id="main-header">
            <div className="min-w-0" data-id="main-heading">
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500" data-id="main-heading-kicker">Node cockpit</div>
              <div className="mt-1 truncate text-2xl font-semibold text-white" data-id="main-heading-title">
                {mode === "electron"
                  ? selectedWindow?.title || "No window selected"
                  : selectedProfile
                    ? `account_${selectedProfile.accountIdx}`
                    : "No profile selected"}
              </div>
              <div className="mt-2 truncate text-sm text-slate-500" data-id="main-heading-meta">
                {mode === "electron"
                  ? selectedWindow
                    ? shortenUrl(selectedWindow.url)
                    : "Choose a session or launch a target"
                  : selectedProfile?.gmail || "Choose a profile"}
              </div>
            </div>

            <div className="flex flex-col items-start gap-3 sm:items-end" data-id="main-controls">
              <div className="flex flex-wrap items-center gap-2" data-id="main-status-metrics">
                <MetricPill dataId="metric-runtime" label="Runtime" value={mode} />
                <MetricPill dataId="metric-workspace" label="Workspace" value={workspaceView} />
              </div>
              <div className="rounded-2xl border border-white/8 bg-black/20 p-1" data-id="workspace-switch">
                <div className="flex gap-1">
                  <WorkspaceChip active={workspaceView === "operate"} dataId="workspace-chip-operate" label="Operate" onClick={() => setWorkspaceView("operate")} />
                  <WorkspaceChip active={workspaceView === "launch"} dataId="workspace-chip-launch" label="Launch" onClick={() => setWorkspaceView("launch")} />
                  <WorkspaceChip active={workspaceView === "tune"} dataId="workspace-chip-tune" label="Tune" onClick={() => setWorkspaceView("tune")} />
                </div>
              </div>

            </div>
          </div>

          {mode === "electron" && workspaceView === "operate" ? (
            <div className="mt-4 flex min-h-0 flex-1 flex-col" data-id="electron-operate-panel">
              {selectedWindow ? (
                <div className="relative flex min-h-[520px] flex-1 items-center justify-center overflow-hidden rounded-[30px] border border-white/8 bg-black/35" data-id="electron-operate-preview-shell">
                  <img
                    alt="Managed window preview"
                    className="max-h-full max-w-full cursor-crosshair rounded-[20px] object-contain shadow-[0_28px_90px_rgba(0,0,0,0.5)]"
                    data-id="electron-operate-preview"
                    draggable={false}
                    onClick={(event) => void handlePreviewClick(event)}
                    onDragStart={(event) => event.preventDefault()}
                    ref={imgRef}
                  />
                  <div className="absolute left-4 top-4 rounded-full border border-white/10 bg-black/55 px-3 py-1.5 text-xs text-slate-300 backdrop-blur" data-id="electron-operate-bounds">
                    {formatBounds(selectedWindow.bounds)}
                  </div>
                  <div className="absolute bottom-4 left-4 right-4 flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-white/8 bg-black/55 px-4 py-3 backdrop-blur" data-id="electron-operate-action-bar">
                    <div className="min-w-0" data-id="electron-operate-preview-meta">
                      <div className="truncate text-sm font-medium text-white" data-id="electron-operate-host">{formatHost(selectedWindow.url)}</div>
                      <div className="mt-1 truncate text-xs text-slate-500" data-id="electron-operate-hint">Click preview to interact. Keyboard forwarding is active in this mode.</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2" data-id="electron-operate-actions">
                      <Button
                        dataId="electron-operate-preview-button"
                        disabled={!selectedWindow || previewLoading}
                        icon={<RefreshCw className={`h-4 w-4 ${previewLoading ? "animate-spin" : ""}`} />}
                        label="Preview"
                        onClick={() => {
                          if (selectedWindow) void refreshPreview(selectedWindow.id, true);
                        }}
                      />
                      <Button
                        dataId="electron-operate-watch-button"
                        disabled={!selectedWindow}
                        icon={<Eye className="h-4 w-4" />}
                        label="Watch"
                        onClick={() => {
                          if (selectedWindow) window.open(buildWatchUrl(selectedWindow.id), "_blank", "noopener,noreferrer");
                        }}
                      />
                      <Button dataId="electron-operate-reload-button" disabled={!selectedWindow} icon={<RotateCcw className="h-4 w-4" />} label="Reload" onClick={() => void handleReloadPage()} />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex min-h-[520px] flex-1 items-center justify-center rounded-[30px] border border-dashed border-white/10 bg-black/20 text-sm text-slate-500" data-id="electron-operate-empty">
                  No session selected
                </div>
              )}
            </div>
          ) : null}

          {mode === "electron" && workspaceView === "launch" ? (
            <div className="mt-4 grid flex-1 gap-4 lg:grid-cols-3" data-id="electron-launch-panel">
              {QUICK_LAUNCH_TARGETS.map((target) => (
                <button
                  className="rounded-[28px] border border-white/8 bg-black/20 p-6 text-left transition hover:border-white/16 hover:bg-white/[0.05]"
                  data-id={`electron-launch-card-${target.label.toLowerCase().replace(/\s+/g, "-")}`}
                  disabled={Boolean(windowAction)}
                  key={target.label}
                  onClick={() => void handleOpenWindow(target.url)}
                  type="button"
                >
                  <ArrowUpRight className="h-5 w-5 text-[var(--accent)]" />
                  <div className="mt-10 text-xl font-semibold text-white">{target.label}</div>
                  <div className="mt-2 text-sm text-slate-500">{target.url}</div>
                </button>
              ))}
            </div>
          ) : null}

          {mode === "electron" && workspaceView === "tune" ? (
            <div className="mt-4 grid flex-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]" data-id="electron-tune-panel">
              <div className="rounded-[28px] border border-white/8 bg-black/20 p-5" data-id="electron-tune-bounds-card" data-local-input="true">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Bounds</div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  {[
                    { key: "x", label: "X" },
                    { key: "y", label: "Y" },
                    { key: "w", label: "W" },
                    { key: "h", label: "H" },
                  ].map((field) => (
                    <label className="space-y-2" data-id={`electron-tune-bound-${field.key}`} key={field.key}>
                      <span className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{field.label}</span>
                      <input
                        className="w-full rounded-xl border border-white/8 bg-white/[0.04] px-3 py-2 font-mono text-sm text-white outline-none transition focus:border-[color:var(--accent)]/60"
                        data-id={`electron-tune-bound-input-${field.key}`}
                        onChange={(event) =>
                          setBounds((current) => ({
                            ...current,
                            [field.key]: Number(event.target.value) || 0,
                          }))
                        }
                        type="number"
                        value={bounds[field.key as keyof typeof bounds]}
                      />
                    </label>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-2" data-id="electron-tune-bounds-actions">
                  <Button
                    dataId="electron-tune-apply-button"
                    disabled={!selectedWindow || boundsSaving}
                    icon={<RefreshCw className={`h-4 w-4 ${boundsSaving ? "animate-spin" : ""}`} />}
                    label="Apply"
                    onClick={() => void handleApplyBounds()}
                  />
                  <Button dataId="electron-tune-watch-link-button" disabled={!selectedWindow} icon={<Copy className="h-4 w-4" />} label="Watch link" onClick={() => void handleCopyWatchLink()} />
                </div>
              </div>

              <div className="space-y-4" data-id="electron-tune-side">
                <div className="rounded-[28px] border border-white/8 bg-black/20 p-5" data-id="electron-tune-capture-card">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Capture</div>
                  <div className="mt-4 space-y-4">
                    <RangeField
                      dataId="electron-tune-refresh-range"
                      label="Refresh"
                      max={5000}
                      min={200}
                      onChange={setWatchInterval}
                      step={100}
                      value={watchInterval}
                      valueLabel={`${(watchInterval / 1000).toFixed(1)}s`}
                    />
                    <RangeField dataId="electron-tune-quality-range" label="Quality" max={100} min={10} onChange={setQuality} step={5} value={quality} valueLabel={`${quality}%`} />
                    <RangeField dataId="electron-tune-scale-range" label="Scale" max={1} min={0.2} onChange={setScale} step={0.02} value={scale} valueLabel={`${Math.round(scale * 100)}%`} />
                  </div>
                </div>

                <div className="rounded-[28px] border border-white/8 bg-black/20 p-5" data-id="electron-tune-actions-card">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Actions</div>
                  <div className="mt-4 flex flex-wrap gap-2" data-id="electron-tune-actions">
                    <Button
                      dataId="electron-tune-snapshot-button"
                      disabled={!selectedWindow || snapshotLoading}
                      icon={<ScanSearch className={`h-4 w-4 ${snapshotLoading ? "animate-spin" : ""}`} />}
                      label="Snapshot"
                      onClick={() => void handleSnapshotCapture()}
                    />
                    <Button dataId="electron-tune-close-button" disabled={!selectedWindow} icon={<X className="h-4 w-4" />} label="Close" onClick={() => void handleCloseWindow()} />
                    <Button dataId="electron-tune-close-all-button" disabled={!windows.length} icon={<Trash2 className="h-4 w-4" />} label="Close all" onClick={() => void handleCloseAllWindows()} />
                  </div>
                  <label className="mt-4 flex items-center justify-between rounded-xl border border-white/8 bg-white/[0.04] px-3 py-2" data-id="electron-tune-overlays-toggle" data-local-input="true">
                    <span className="text-sm text-slate-300">Overlays</span>
                    <input checked={showOverlays} className="h-4 w-4 accent-[var(--accent)]" data-id="electron-tune-overlays-input" onChange={(event) => setShowOverlays(event.target.checked)} type="checkbox" />
                  </label>
                  <div className="mt-4">
                    <RangeField
                      dataId="electron-tune-snapshot-depth-range"
                      label="Snapshot depth"
                      max={100}
                      min={5}
                      onChange={setMaxElements}
                      step={5}
                      value={maxElements}
                      valueLabel={`${maxElements}`}
                    />
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {mode === "chrome" && workspaceView === "operate" ? (
            <div className="mt-4 flex min-h-0 flex-1 items-center justify-center" data-id="chrome-operate-panel">
              {selectedProfile ? (
                <div className="w-full max-w-[760px] rounded-[30px] border border-white/8 bg-black/20 p-8" data-id="chrome-operate-card">
                  <div className="flex items-start justify-between gap-4" data-id="chrome-operate-header">
                    <div data-id="chrome-operate-profile-meta">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Profile</div>
                      <div className="mt-2 text-3xl font-semibold text-white">account_{selectedProfile.accountIdx}</div>
                      <div className="mt-2 text-sm text-slate-500">{selectedProfile.gmail || "No mailbox label"}</div>
                    </div>
                    <div className={`rounded-full px-3 py-1 text-xs ${selectedProfile.liveStatus?.isRunning ? "bg-emerald-500/12 text-emerald-200" : "bg-white/[0.06] text-slate-400"}`} data-id="chrome-operate-status">
                      {chromeStatus}
                    </div>
                  </div>
                  <div className="mt-8 grid grid-cols-2 gap-4" data-id="chrome-operate-fields">
                    <Field dataId="chrome-operate-field-port" label="Port" value={selectedProfile.port != null ? String(selectedProfile.port) : "—"} />
                    <Field dataId="chrome-operate-field-proxy" label="Proxy" value={selectedProfile.proxy ? "enabled" : "disabled"} />
                  </div>
                  <div className="mt-8 flex flex-wrap gap-2 border-t border-white/8 pt-6" data-id="chrome-operate-actions">
                    <Button
                      dataId="chrome-operate-open-button"
                      disabled={Boolean(profileAction)}
                      icon={<ArrowUpRight className="h-4 w-4" />}
                      label={profileAction === "open" ? "Opening" : "Open"}
                      onClick={() => void handleProfileAction("open")}
                    />
                    <Button
                      dataId="chrome-operate-restart-button"
                      disabled={Boolean(profileAction)}
                      icon={<RotateCcw className="h-4 w-4" />}
                      label={profileAction === "restart" ? "Restarting" : "Restart"}
                      onClick={() => void handleProfileAction("restart")}
                    />
                    <Button
                      dataId="chrome-operate-stop-button"
                      disabled={Boolean(profileAction)}
                      icon={<Square className="h-4 w-4" />}
                      label={profileAction === "stop" ? "Stopping" : "Stop"}
                      onClick={() => void handleProfileAction("stop")}
                    />
                  </div>
                </div>
              ) : (
                <div className="text-sm text-slate-500" data-id="chrome-operate-empty">No profile selected</div>
              )}
            </div>
          ) : null}

          {mode === "chrome" && workspaceView === "launch" ? (
            <div className="mt-4 flex min-h-0 flex-1 items-center justify-center" data-id="chrome-launch-panel">
              {selectedProfile ? (
                <div className="w-full max-w-[640px] rounded-[30px] border border-white/8 bg-black/20 p-8" data-id="chrome-launch-card">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Launch</div>
                  <div className="mt-2 text-2xl font-semibold text-white">account_{selectedProfile.accountIdx}</div>
                  <div className="mt-6 flex flex-wrap gap-2" data-id="chrome-launch-actions">
                    <Button
                      dataId="chrome-launch-open-button"
                      disabled={Boolean(profileAction)}
                      icon={<ArrowUpRight className="h-4 w-4" />}
                      label={profileAction === "open" ? "Opening" : "Open"}
                      onClick={() => void handleProfileAction("open")}
                    />
                    <Button
                      dataId="chrome-launch-restart-button"
                      disabled={Boolean(profileAction)}
                      icon={<RotateCcw className="h-4 w-4" />}
                      label={profileAction === "restart" ? "Restarting" : "Restart"}
                      onClick={() => void handleProfileAction("restart")}
                    />
                    <Button
                      dataId="chrome-launch-stop-button"
                      disabled={Boolean(profileAction)}
                      icon={<Square className="h-4 w-4" />}
                      label={profileAction === "stop" ? "Stopping" : "Stop"}
                      onClick={() => void handleProfileAction("stop")}
                    />
                  </div>
                </div>
              ) : (
                <div className="text-sm text-slate-500" data-id="chrome-launch-empty">No profile selected</div>
              )}
            </div>
          ) : null}

          {mode === "chrome" && workspaceView === "tune" ? (
            <div className="mt-4 grid flex-1 gap-4 xl:grid-cols-[1fr_0.9fr]" data-id="chrome-tune-panel">
              <div className="rounded-[28px] border border-white/8 bg-black/20 p-5" data-id="chrome-tune-proxy-card" data-local-input="true">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Proxy</div>
                <textarea
                  className="mt-4 min-h-[220px] w-full rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-3 font-mono text-sm text-white outline-none transition focus:border-[color:var(--accent)]/60"
                  data-id="chrome-tune-proxy-input"
                  disabled={!selectedProfile}
                  onChange={(event) =>
                    setProxyDrafts((current) => ({
                      ...current,
                      [selectedProfile?.accountIdx ?? -1]: event.target.value,
                    }))
                  }
                  placeholder="socks5://127.0.0.1:1080"
                  value={selectedProfile ? proxyDrafts[selectedProfile.accountIdx] ?? "" : ""}
                />
                <div className="mt-4 flex flex-wrap gap-2" data-id="chrome-tune-proxy-actions">
                  <Button dataId="chrome-tune-save-button" disabled={!selectedProfile || Boolean(profileAction)} icon={<Link2 className="h-4 w-4" />} label="Save" onClick={() => void handleSaveProxy(false)} />
                  <Button
                    dataId="chrome-tune-save-restart-button"
                    disabled={!selectedProfile || Boolean(profileAction)}
                    icon={<RotateCcw className="h-4 w-4" />}
                    label="Save + restart"
                    onClick={() => void handleSaveProxy(true)}
                  />
                </div>
              </div>

              <div className="rounded-[28px] border border-white/8 bg-black/20 p-5" data-id="chrome-tune-details-card">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Details</div>
                <div className="mt-4 space-y-4" data-id="chrome-tune-details-fields">
                  <Field dataId="chrome-tune-field-account" label="Account" value={selectedProfile ? `account_${selectedProfile.accountIdx}` : "No selection"} />
                  <Field dataId="chrome-tune-field-mailbox" label="Mailbox" value={selectedProfile?.gmail || "—"} />
                  <Field dataId="chrome-tune-field-port" label="Port" value={selectedProfile?.port != null ? String(selectedProfile.port) : "—"} />
                  <Field dataId="chrome-tune-field-profile-key" label="Profile key" value={selectedProfile?.profileKey || "—"} />
                </div>
                <div className="mt-6 border-t border-white/8 pt-5" data-id="chrome-tune-targets">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Network checks</div>
                  <div className="mt-4 flex flex-wrap gap-2" data-id="chrome-tune-target-actions">
                    {CHROME_TUNE_TARGETS.map((target) => (
                      <Button
                        key={target.url}
                        dataId={`chrome-tune-open-${target.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                        disabled={!selectedProfile || Boolean(profileAction)}
                        icon={<ArrowUpRight className="h-4 w-4" />}
                        label={target.label}
                        onClick={() => void handleProfileAction("open", target.url)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </main>
      </div>

      {snapshotDialogText ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/78 p-4 backdrop-blur-sm" data-id="snapshot-dialog">
          <div className="flex max-h-[82vh] w-full max-w-4xl flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#0b1318]" data-id="snapshot-dialog-card">
            <div className="flex items-center justify-between border-b border-white/8 px-5 py-4" data-id="snapshot-dialog-header">
              <div className="text-sm font-medium text-white" data-id="snapshot-dialog-title">Snapshot</div>
              <button
                className="rounded-lg p-2 text-slate-400 transition hover:bg-white/[0.06] hover:text-white"
                data-id="snapshot-dialog-close"
                onClick={() => setSnapshotDialogText(null)}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-auto p-5" data-id="snapshot-dialog-body">
              <pre className="whitespace-pre-wrap break-words rounded-2xl border border-white/8 bg-black/20 p-4 text-xs leading-6 text-slate-200" data-id="snapshot-dialog-content">
                {snapshotDialogText}
              </pre>
            </div>
          </div>
        </div>
      ) : null}

      {clickPulse ? (
        <div className="pointer-events-none fixed z-50" style={{ left: clickPulse.x, top: clickPulse.y }}>
          <div className="relative -translate-x-1/2 -translate-y-1/2">
            <div className="h-10 w-10 animate-ping rounded-full border-2 border-[var(--accent)] bg-[color:var(--accent)]/20" />
            <div className="absolute inset-0 rounded-full border-2 border-[var(--accent)] bg-[color:var(--accent)]/28" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
