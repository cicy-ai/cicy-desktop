import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  Gauge,
  Globe,
  LayoutGrid,
  Link2,
  LogOut,
  Monitor,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Shield,
  SlidersHorizontal,
  Square,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import { getSnapshotUrl, requestJson, rpc, rpcJson } from "../lib/client";

type ConsoleMode = "chrome" | "electron";
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
  onLogout: () => void;
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
  { label: "ChatGPT", url: "https://chatgpt.com", note: "LLM workspace" },
  { label: "Gemini", url: "https://gemini.google.com", note: "Google account context" },
  { label: "AI Studio", url: "https://aistudio.google.com", note: "Prompt + API surface" },
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

function formatBounds(bounds: WindowInfo["bounds"]) {
  return `${bounds.width}×${bounds.height} at ${bounds.x},${bounds.y}`;
}

function shortenUrl(url: string) {
  if (!url) return "No URL";
  if (url.length <= 54) return url;
  return `${url.slice(0, 51)}...`;
}

function toneClasses(tone: NoticeTone) {
  if (tone === "success") {
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-100";
  }
  if (tone === "error") {
    return "border-rose-500/25 bg-rose-500/10 text-rose-100";
  }
  return "border-white/10 bg-white/5 text-slate-100";
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

function buildWatchUrl(winId: number) {
  const url = new URL(window.location.href);
  url.searchParams.set("win_id", String(winId));
  return url.toString();
}

function SectionTitle({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow: string;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">{eyebrow}</div>
        <h2 className="mt-2 text-lg font-semibold text-white">{title}</h2>
        {detail ? <p className="mt-1 text-sm text-slate-400">{detail}</p> : null}
      </div>
      {action}
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-black/20 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-3 text-xl font-semibold text-white">{value}</div>
      {detail ? <div className="mt-1 text-sm text-slate-400">{detail}</div> : null}
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
}: {
  label: string;
  valueLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block space-y-2" data-local-input="true">
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

function WindowListItem({
  active,
  onClick,
  windowInfo,
}: {
  active: boolean;
  onClick: () => void;
  windowInfo: WindowInfo;
}) {
  return (
    <button
      className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
        active
          ? "border-[color:var(--accent)]/50 bg-[color:var(--accent)]/14 shadow-[0_16px_32px_rgba(0,0,0,0.18)]"
          : "border-white/8 bg-white/[0.03] hover:border-white/16 hover:bg-white/[0.05]"
      }`}
      onClick={onClick}
      type="button"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-white">{windowInfo.title || "Untitled window"}</div>
          <div className="mt-1 truncate font-mono text-[11px] text-slate-500">{formatHost(windowInfo.url)}</div>
        </div>
        <div className={`h-2.5 w-2.5 rounded-full ${active ? "bg-[var(--accent)]" : "bg-slate-600"}`} />
      </div>
      <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-400">
        <span className="rounded-full border border-white/8 px-2 py-0.5 font-mono">#{windowInfo.id}</span>
        <span>{windowInfo.bounds.width}×{windowInfo.bounds.height}</span>
      </div>
    </button>
  );
}

function ProfileListItem({
  active,
  onClick,
  profile,
}: {
  active: boolean;
  onClick: () => void;
  profile: ChromeProfile;
}) {
  const isRunning = Boolean(profile.liveStatus?.isRunning);
  return (
    <button
      className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
        active
          ? "border-[color:var(--accent)]/50 bg-[color:var(--accent)]/14"
          : "border-white/8 bg-white/[0.03] hover:border-white/16 hover:bg-white/[0.05]"
      }`}
      onClick={onClick}
      type="button"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">account_{profile.accountIdx}</div>
          <div className="mt-1 truncate font-mono text-[11px] text-slate-500">{profile.gmail || "No mailbox label"}</div>
        </div>
        <div className={`mt-1 h-2.5 w-2.5 rounded-full ${isRunning ? "bg-emerald-400" : "bg-slate-600"}`} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <span className="rounded-full border border-white/8 px-2 py-0.5 font-mono">port {profile.port ?? "—"}</span>
        <span>{profile.proxy ? "Proxy on" : "Proxy off"}</span>
      </div>
    </button>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  tone = "default",
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger";
}) {
  const toneClass =
    tone === "primary"
      ? "border-transparent bg-[var(--accent)] text-slate-950 hover:bg-[var(--accent-strong)]"
      : tone === "danger"
        ? "border-rose-500/25 bg-rose-500/10 text-rose-100 hover:bg-rose-500/16"
        : "border-white/8 bg-white/[0.04] text-slate-100 hover:border-white/16 hover:bg-white/[0.07]";

  return (
    <button
      className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${toneClass}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
    </button>
  );
}

export default function Dashboard({ mode, onLogout, onModeChange }: DashboardProps) {
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [profiles, setProfiles] = useState<ChromeProfile[]>([]);
  const [selectedWinId, setSelectedWinId] = useState<number | null>(() => readStoredNullableNumber(STORAGE_KEYS.selectedWindow));
  const [selectedProfileIdx, setSelectedProfileIdx] = useState<number | null>(() =>
    readStoredNullableNumber(STORAGE_KEYS.selectedProfile),
  );
  const [proxyDrafts, setProxyDrafts] = useState<Record<number, string>>({});

  const [windowsLoading, setWindowsLoading] = useState(false);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [boundsSaving, setBoundsSaving] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [profileAction, setProfileAction] = useState<string | null>(null);
  const [windowAction, setWindowAction] = useState<string | null>(null);

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
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 4200);
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
      announce(error instanceof Error ? error.message : "Failed to load Chrome profiles.", "error");
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

      if (imgRef.current) {
        imgRef.current.src = objectUrl;
      }
    } catch (error) {
      if (announceErrors) {
        announce(error instanceof Error ? error.message : "Failed to refresh preview.", "error");
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
        announce(`Focused existing window for ${formatHost(targetUrl)}.`, "success");
        return;
      }

      await rpc("open_window", {
        url: targetUrl,
        accountIdx: selectedProfile?.accountIdx ?? 0,
        reuseWindow: false,
        options: { width: 1280, height: 860 },
      });

      const nextWindows = await fetchWindowList();
      setWindows(nextWindows);
      const createdWindow = nextWindows.find((item) => !beforeIds.has(item.id)) || nextWindows[nextWindows.length - 1];
      if (createdWindow) {
        setSelectedWinId(createdWindow.id);
        await refreshPreview(createdWindow.id);
      }
      announce(`Opened ${formatHost(targetUrl)}.`, "success");
    } catch (error) {
      announce(error instanceof Error ? error.message : "Failed to open a new window.", "error");
    } finally {
      setWindowAction(null);
    }
  }

  async function handleProfileAction(action: "open" | "restart" | "stop") {
    if (!selectedProfile) return;

    setProfileAction(action);
    try {
      await requestJson(`/api/chrome/profiles/${selectedProfile.accountIdx}/${action}`, {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      await loadProfiles();
      announce(
        `${action === "open" ? "Opened" : action === "restart" ? "Restarted" : "Stopped"} account_${selectedProfile.accountIdx}.`,
        "success",
      );
    } catch (error) {
      announce(error instanceof Error ? error.message : "Chrome profile action failed.", "error");
    } finally {
      setProfileAction(null);
    }
  }

  async function handleSaveProxy(restart: boolean) {
    if (!selectedProfile) return;

    setProfileAction(restart ? "proxy-restart" : "proxy-save");
    try {
      await requestJson(`/api/chrome/profiles/${selectedProfile.accountIdx}/proxy`, {
        body: JSON.stringify({
          enabled: Boolean(proxyDrafts[selectedProfile.accountIdx] || ""),
          proxy: proxyDrafts[selectedProfile.accountIdx] || "",
          restart,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      await loadProfiles();
      announce(restart ? "Proxy saved and profile restarted." : "Proxy saved.", "success");
    } catch (error) {
      announce(error instanceof Error ? error.message : "Failed to save proxy settings.", "error");
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
      const resultText = payload?.result?.content?.[0]?.text;

      if (!response.ok || payload?.result?.isError) {
        throw new Error(resultText || "Failed to apply window bounds.");
      }

      await loadWindows();
      announce(resultText || "Window bounds updated.", "success");
    } catch (error) {
      announce(error instanceof Error ? error.message : "Failed to apply bounds.", "error");
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
      announce("Page reload sent to the selected window.", "success");
    } catch (error) {
      announce(error instanceof Error ? error.message : "Failed to reload the page.", "error");
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
      announce(`Closed window #${selectedWindow.id}.`, "success");
    } catch (error) {
      announce(error instanceof Error ? error.message : "Failed to close the window.", "error");
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
      announce(error instanceof Error ? error.message : "Failed to close all windows.", "error");
    } finally {
      setWindowAction(null);
    }
  }

  async function handleSnapshotCapture() {
    if (!selectedWindow) return;

    setSnapshotLoading(true);
    try {
      const response = await rpc("webpage_snapshot", {
        include_screenshot: true,
        max_elements: maxElements,
        show_overlays: showOverlays,
        win_id: selectedWindow.id,
      });
      const payload = await response.json();
      const text = payload?.result?.content?.[0]?.text;
      if (!response.ok || payload?.result?.isError) {
        throw new Error(text || "Failed to capture webpage snapshot.");
      }

      let dialogText = text || "No snapshot data returned.";
      if (text) {
        try {
          dialogText = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          dialogText = text;
        }
      }
      setSnapshotDialogText(dialogText);
    } catch (error) {
      announce(error instanceof Error ? error.message : "Snapshot capture failed.", "error");
    } finally {
      setSnapshotLoading(false);
    }
  }

  async function handleCopyWatchLink() {
    if (!selectedWindow) return;
    const watchUrl = buildWatchUrl(selectedWindow.id);
    try {
      await navigator.clipboard.writeText(watchUrl);
      announce("Watch link copied to the clipboard.", "success");
    } catch {
      announce("Clipboard access failed. Open the live watch instead.", "error");
    }
  }

  async function handlePreviewClick(event: MouseEvent<HTMLImageElement>) {
    if (!selectedWindow || !imgRef.current) return;

    const rect = imgRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const relativeX = x / rect.width;
    const relativeY = y / rect.height;

    const clickX = Math.round(relativeX * selectedWindow.bounds.width);
    const clickY = Math.round(relativeY * selectedWindow.bounds.height);

    setClickPulse({ x: event.clientX, y: event.clientY });
    if (clickPulseTimerRef.current) window.clearTimeout(clickPulseTimerRef.current);
    clickPulseTimerRef.current = window.setTimeout(() => setClickPulse(null), 700);

    try {
      await rpc("cdp_click", { button: "left", win_id: selectedWindow.id, x: clickX, y: clickY });
      window.setTimeout(() => {
        void refreshPreview(selectedWindow.id);
      }, 160);
    } catch (error) {
      announce(error instanceof Error ? error.message : "Failed to click inside the preview.", "error");
    }
  }

  useEffect(() => {
    void loadWindows();
    void loadProfiles();
  }, []);

  useEffect(() => {
    if (mode === "electron") {
      void loadWindows();
    } else {
      void loadProfiles();
    }
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
    if (selectedWinId == null) {
      localStorage.removeItem(STORAGE_KEYS.selectedWindow);
      return;
    }
    localStorage.setItem(STORAGE_KEYS.selectedWindow, String(selectedWinId));
  }, [selectedWinId]);

  useEffect(() => {
    if (selectedProfileIdx == null) {
      localStorage.removeItem(STORAGE_KEYS.selectedProfile);
      return;
    }
    localStorage.setItem(STORAGE_KEYS.selectedProfile, String(selectedProfileIdx));
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
      h: selectedWindow.bounds.height,
      w: selectedWindow.bounds.width,
      x: selectedWindow.bounds.x,
      y: selectedWindow.bounds.y,
    });

    if (mode === "electron") {
      void focusWindow(selectedWindow.id).catch(() => undefined);
    }
  }, [mode, selectedWindow]);

  useEffect(() => {
    if (mode !== "electron" || !selectedWinId) return;
    void refreshPreview(selectedWinId);
  }, [mode, quality, scale, selectedWinId]);

  useEffect(() => {
    async function ping() {
      const pingStart = Date.now();
      try {
        await rpc("ping", {});
        setPingTime(Date.now() - pingStart);
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
      if (mode !== "electron" || !selectedWinId) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      const key = event.key;
      if (key.length !== 1 && !KEY_CODE_MAP[key]) return;

      try {
        const keyCode = KEY_CODE_MAP[key] || key.toUpperCase();
        await rpc("control_electron_WebContents", {
          code: `webContents.sendInputEvent({type: 'keyDown', keyCode: '${keyCode}', key: '${key}'})`,
          win_id: selectedWinId,
        });
        await rpc("control_electron_WebContents", {
          code: `webContents.sendInputEvent({type: 'keyUp', keyCode: '${keyCode}', key: '${key}'})`,
          win_id: selectedWinId,
        });
      } catch {
        announce("Keyboard forwarding failed for the selected window.", "error");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, selectedWinId]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
      if (clickPulseTimerRef.current) window.clearTimeout(clickPulseTimerRef.current);
      releasePreviewUrl();
    };
  }, []);

  const chromeStatusLabel = selectedProfile?.liveStatus?.isRunning ? "Running" : "Stopped";

  return (
    <div className="min-h-screen bg-[var(--app-bg)] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_left,rgba(55,124,110,0.28),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(191,160,91,0.14),transparent_25%)]" />
      <div className="pointer-events-none fixed inset-0 opacity-30 [background-image:linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:36px_36px]" />

      <div className="relative mx-auto min-h-screen max-w-[1800px] p-4 xl:grid xl:grid-cols-[320px_minmax(0,1fr)_360px] xl:gap-4">
        <aside className="panel-surface flex flex-col gap-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-300">
                <Boxes className="h-3.5 w-3.5 text-[var(--accent)]" />
                CiCy Console
              </div>
              <h1 className="mt-4 text-2xl font-semibold tracking-tight text-white">Desktop launch control</h1>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                Cleaner session orchestration for Electron windows and Chrome profiles.
              </p>
            </div>

            <button
              className="rounded-xl border border-white/8 bg-white/[0.04] p-2 text-slate-300 transition hover:border-white/16 hover:bg-white/[0.08] hover:text-white"
              onClick={onLogout}
              title="Sign out"
              type="button"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <MetricCard detail={`${windows.length} tracked`} label="Electron" value={String(windows.length)} />
            <MetricCard detail={`${profiles.length} available`} label="Profiles" value={String(profiles.length)} />
          </div>

          <div className="rounded-2xl border border-white/8 bg-black/20 p-3">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Mode</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                  mode === "chrome"
                    ? "bg-[var(--accent)] text-slate-950"
                    : "border border-white/8 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]"
                }`}
                onClick={() => onModeChange("chrome")}
                type="button"
              >
                Chrome
              </button>
              <button
                className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                  mode === "electron"
                    ? "bg-[var(--accent)] text-slate-950"
                    : "border border-white/8 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]"
                }`}
                onClick={() => onModeChange("electron")}
                type="button"
              >
                Electron
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className={`rounded-full p-2 ${pingTime != null ? "bg-emerald-500/12 text-emerald-300" : "bg-rose-500/12 text-rose-300"}`}>
                <Wifi className="h-4 w-4" />
              </div>
              <div>
                <div className="text-sm font-medium text-white">Connection</div>
                <div className="text-xs text-slate-400">{pingTime != null ? `${pingTime} ms latency` : "Disconnected"}</div>
              </div>
            </div>
            <div className={`rounded-full px-2.5 py-1 text-xs font-medium ${pingTime != null ? "bg-emerald-500/12 text-emerald-200" : "bg-rose-500/12 text-rose-200"}`}>
              {pingTime != null ? "Healthy" : "Offline"}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <SectionTitle
              action={
                <button
                  className="rounded-xl border border-white/8 bg-white/[0.04] p-2 text-slate-300 transition hover:border-white/16 hover:bg-white/[0.08]"
                  onClick={() => void (mode === "electron" ? loadWindows() : loadProfiles())}
                  type="button"
                >
                  <RefreshCw className={`h-4 w-4 ${(mode === "electron" ? windowsLoading : profilesLoading) ? "animate-spin" : ""}`} />
                </button>
              }
              detail={mode === "electron" ? "Choose a managed browser window." : "Pick a Chrome profile to operate on."}
              eyebrow="Sessions"
              title={mode === "electron" ? "Window registry" : "Profile registry"}
            />

            <div className="min-h-[320px] space-y-2 overflow-y-auto pr-1">
              {mode === "electron"
                ? windows.map((item) => (
                    <Fragment key={item.id}>
                      <WindowListItem active={item.id === selectedWinId} onClick={() => setSelectedWinId(item.id)} windowInfo={item} />
                    </Fragment>
                  ))
                : profiles.map((item) => (
                    <Fragment key={item.profileKey}>
                      <ProfileListItem
                        active={item.accountIdx === selectedProfileIdx}
                        onClick={() => setSelectedProfileIdx(item.accountIdx)}
                        profile={item}
                      />
                    </Fragment>
                  ))}

              {mode === "electron" && !windowsLoading && windows.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-8 text-center text-sm text-slate-400">
                  No windows are currently managed by the worker.
                </div>
              ) : null}

              {mode === "chrome" && !profilesLoading && profiles.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-8 text-center text-sm text-slate-400">
                  No Chrome profiles were returned by the worker.
                </div>
              ) : null}
            </div>
          </div>

          {mode === "electron" ? (
            <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Quick launch</div>
              <div className="space-y-2">
                {QUICK_LAUNCH_TARGETS.map((target) => (
                  <button
                    className="flex w-full items-center justify-between rounded-xl border border-white/8 bg-white/[0.04] px-4 py-3 text-left transition hover:border-white/16 hover:bg-white/[0.08]"
                    disabled={Boolean(windowAction)}
                    key={target.label}
                    onClick={() => void handleOpenWindow(target.url)}
                    type="button"
                  >
                    <div>
                      <div className="text-sm font-medium text-white">{target.label}</div>
                      <div className="text-xs text-slate-400">{target.note}</div>
                    </div>
                    <ExternalLink className="h-4 w-4 text-slate-400" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Proxy status</div>
              <p className="text-sm leading-6 text-slate-400">
                Keep proxy configuration close to the profile that owns it. Save without restart when you are staging a change, or
                restart immediately when you need it live.
              </p>
            </div>
          )}
        </aside>

        <main className="panel-surface mt-4 flex min-h-[780px] flex-col overflow-hidden xl:mt-0">
          <div className="border-b border-white/8 px-6 py-5">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <SectionTitle
                detail={
                  mode === "electron"
                    ? selectedWindow
                      ? shortenUrl(selectedWindow.url)
                      : "Choose a window from the left rail to focus, inspect, and drive it."
                    : selectedProfile
                      ? selectedProfile.gmail || `account_${selectedProfile.accountIdx}`
                      : "Choose a Chrome profile from the left rail to manage it."
                }
                eyebrow={mode === "electron" ? "Active window" : "Active profile"}
                title={
                  mode === "electron"
                    ? selectedWindow?.title || "No window selected"
                    : selectedProfile
                      ? `account_${selectedProfile.accountIdx}`
                      : "No profile selected"
                }
              />

              <div className="flex flex-wrap items-center gap-2">
                {mode === "electron" ? (
                  <>
                    <ActionButton
                      disabled={!selectedWindow || previewLoading}
                      icon={<RefreshCw className={`h-4 w-4 ${previewLoading ? "animate-spin" : ""}`} />}
                      label="Refresh preview"
                      onClick={() => {
                        if (selectedWindow) void refreshPreview(selectedWindow.id, true);
                      }}
                    />
                    <ActionButton
                      disabled={!selectedWindow}
                      icon={<Eye className="h-4 w-4" />}
                      label="Open live watch"
                      onClick={() => {
                        if (selectedWindow) window.open(buildWatchUrl(selectedWindow.id), "_blank", "noopener,noreferrer");
                      }}
                    />
                  </>
                ) : (
                  <ActionButton
                    disabled={!selectedProfile}
                    icon={<RefreshCw className={`h-4 w-4 ${profilesLoading ? "animate-spin" : ""}`} />}
                    label="Refresh profiles"
                    onClick={() => void loadProfiles()}
                  />
                )}
              </div>
            </div>
          </div>

          {notice ? (
            <div className={`mx-6 mt-5 rounded-2xl border px-4 py-3 text-sm ${toneClasses(notice.tone)}`}>
              <div className="flex items-start gap-3">
                {notice.tone === "error" ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                ) : notice.tone === "success" ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <Shield className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span>{notice.message}</span>
              </div>
            </div>
          ) : null}

          {mode === "electron" ? (
            <div className="flex min-h-0 flex-1 flex-col px-6 py-5">
              <div className="grid gap-4 lg:grid-cols-3">
                <MetricCard
                  detail={selectedWindow ? shortenUrl(selectedWindow.url) : "Choose a managed session from the left rail."}
                  label="Target host"
                  value={selectedWindow ? formatHost(selectedWindow.url) : "No target"}
                />
                <MetricCard
                  detail={selectedWindow ? `Window #${selectedWindow.id}` : "Bounds become editable after selection."}
                  label="Window bounds"
                  value={selectedWindow ? formatBounds(selectedWindow.bounds) : "—"}
                />
                <MetricCard
                  detail="Used by preview + watch view."
                  label="Capture profile"
                  value={`${quality}% · ${Math.round(scale * 100)}%`}
                />
              </div>

              <div className="mt-5 flex min-h-0 flex-1 flex-col rounded-[28px] border border-white/8 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.06),transparent_40%),rgba(8,13,18,0.92)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                {selectedWindow ? (
                  <>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                        <span className="rounded-full border border-white/8 px-2 py-1 font-mono text-slate-300">#{selectedWindow.id}</span>
                        <span>{selectedWindow.bounds.width}×{selectedWindow.bounds.height}</span>
                        <span>Click preview to send a CDP click. Keyboard input forwards unless a local form is focused.</span>
                      </div>
                      <ActionButton
                        disabled={!selectedWindow}
                        icon={<Copy className="h-4 w-4" />}
                        label="Copy watch link"
                        onClick={() => void handleCopyWatchLink()}
                      />
                    </div>

                    <div className="relative flex min-h-[440px] flex-1 items-center justify-center overflow-hidden rounded-[24px] border border-white/8 bg-black/40">
                      <img
                        alt="Managed window preview"
                        className="max-h-full max-w-full cursor-crosshair rounded-[18px] object-contain shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
                        draggable={false}
                        onClick={(event) => void handlePreviewClick(event)}
                        onDragStart={(event) => event.preventDefault()}
                        ref={imgRef}
                      />
                      {previewLoading ? (
                        <div className="absolute right-4 top-4 rounded-full border border-white/10 bg-black/55 px-3 py-1.5 text-xs text-slate-300 backdrop-blur">
                          Refreshing preview…
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <div className="flex min-h-[520px] flex-1 flex-col items-center justify-center rounded-[24px] border border-dashed border-white/10 bg-black/20 px-8 text-center">
                    <Monitor className="h-10 w-10 text-slate-500" />
                    <h3 className="mt-6 text-xl font-semibold text-white">Select a window or launch one</h3>
                    <p className="mt-3 max-w-xl text-sm leading-6 text-slate-400">
                      The start page now treats the preview as the primary workspace. Open a known target from Quick launch or pick an
                      existing session from the left rail.
                    </p>
                    <div className="mt-8 flex flex-wrap justify-center gap-2">
                      {QUICK_LAUNCH_TARGETS.map((target) => (
                        <Fragment key={target.label}>
                          <ActionButton
                            icon={<ArrowUpRight className="h-4 w-4" />}
                            label={target.label}
                            onClick={() => void handleOpenWindow(target.url)}
                            tone="primary"
                          />
                        </Fragment>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-5 px-6 py-5">
              <div className="grid gap-4 lg:grid-cols-3">
                <MetricCard
                  detail="Process state as reported by the worker."
                  label="Lifecycle"
                  value={selectedProfile ? chromeStatusLabel : "No profile"}
                />
                <MetricCard
                  detail="Remote debugger endpoint."
                  label="Debugger port"
                  value={selectedProfile?.port != null ? String(selectedProfile.port) : "—"}
                />
                <MetricCard
                  detail="Configuration attached to the selected profile."
                  label="Proxy"
                  value={selectedProfile?.proxy ? "Enabled" : "Disabled"}
                />
              </div>

              <div className="grid flex-1 gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
                <section className="rounded-[28px] border border-white/8 bg-black/20 p-6">
                  <SectionTitle
                    detail="Core lifecycle actions stay visible here. Deeper configuration lives in the inspector."
                    eyebrow="Overview"
                    title={selectedProfile ? `Profile account_${selectedProfile.accountIdx}` : "No profile selected"}
                  />

                  {selectedProfile ? (
                    <>
                      <div className="mt-6 rounded-2xl border border-white/8 bg-white/[0.03] p-5">
                        <div className="text-sm font-medium text-white">{selectedProfile.gmail || "No mailbox label"}</div>
                        <div className="mt-1 font-mono text-xs text-slate-500">{selectedProfile.profileKey}</div>
                        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                          <span className="rounded-full border border-white/8 px-2 py-1">port {selectedProfile.port ?? "—"}</span>
                          <span className="rounded-full border border-white/8 px-2 py-1">{selectedProfile.proxy ? "Proxy configured" : "No proxy"}</span>
                          <span className="rounded-full border border-white/8 px-2 py-1">{chromeStatusLabel}</span>
                        </div>
                      </div>

                      <div className="mt-6 flex flex-wrap gap-2">
                        <ActionButton
                          disabled={Boolean(profileAction)}
                          icon={<ArrowUpRight className="h-4 w-4" />}
                          label={profileAction === "open" ? "Opening…" : "Open"}
                          onClick={() => void handleProfileAction("open")}
                          tone="primary"
                        />
                        <ActionButton
                          disabled={Boolean(profileAction)}
                          icon={<RotateCcw className="h-4 w-4" />}
                          label={profileAction === "restart" ? "Restarting…" : "Restart"}
                          onClick={() => void handleProfileAction("restart")}
                        />
                        <ActionButton
                          disabled={Boolean(profileAction)}
                          icon={<Square className="h-4 w-4" />}
                          label={profileAction === "stop" ? "Stopping…" : "Stop"}
                          onClick={() => void handleProfileAction("stop")}
                          tone="danger"
                        />
                      </div>
                    </>
                  ) : (
                    <div className="mt-6 rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-8 text-center text-sm text-slate-400">
                      Pick a Chrome profile from the left rail to manage it.
                    </div>
                  )}
                </section>

                <section className="rounded-[28px] border border-white/8 bg-black/20 p-6">
                  <SectionTitle
                    detail="This space keeps operator notes visible instead of burying them in a debug-only panel."
                    eyebrow="Guidance"
                    title="Operational notes"
                  />

                  <div className="mt-6 space-y-4">
                    <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-white">
                        <Gauge className="h-4 w-4 text-[var(--accent)]" />
                        Launch discipline
                      </div>
                      <p className="mt-2 text-sm leading-6 text-slate-400">
                        Keep the main workspace focused on the selected profile. Use the inspector for proxy changes so the primary
                        content never turns into a settings dump.
                      </p>
                    </div>

                    <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-white">
                        <Shield className="h-4 w-4 text-[var(--accent)]" />
                        Why this layout
                      </div>
                      <p className="mt-2 text-sm leading-6 text-slate-400">
                        The original page mixed login, launch, window selection, CDP debugging, and long-form controls in one surface.
                        This rewrite makes the operator’s current target obvious first, and the advanced tooling contextual second.
                      </p>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          )}
        </main>

        <aside className="panel-surface mt-4 flex flex-col gap-5 xl:mt-0">
          <SectionTitle
            detail={mode === "electron" ? "Advanced tooling stays contextual here." : "Profile configuration is isolated here."}
            eyebrow="Inspector"
            title={mode === "electron" ? "Window controls" : "Profile controls"}
          />

          {mode === "electron" ? (
            <>
              <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  <LayoutGrid className="h-4 w-4 text-[var(--accent)]" />
                  Session summary
                </div>
                <div className="mt-4 space-y-3 text-sm text-slate-300">
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Window</div>
                    <div className="mt-1">{selectedWindow ? selectedWindow.title || `Window #${selectedWindow.id}` : "No selection"}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-500">URL</div>
                    <div className="mt-1 break-all text-slate-400">{selectedWindow?.url || "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Bounds</div>
                    <div className="mt-1">{selectedWindow ? formatBounds(selectedWindow.bounds) : "—"}</div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  <SlidersHorizontal className="h-4 w-4 text-[var(--accent)]" />
                  Capture profile
                </div>
                <div className="mt-4 space-y-4">
                  <RangeField
                    label="Watch refresh cadence"
                    max={5000}
                    min={200}
                    onChange={setWatchInterval}
                    step={100}
                    value={watchInterval}
                    valueLabel={`${(watchInterval / 1000).toFixed(1)} s`}
                  />
                  <RangeField
                    label="JPEG quality"
                    max={100}
                    min={10}
                    onChange={setQuality}
                    step={5}
                    value={quality}
                    valueLabel={`${quality}%`}
                  />
                  <RangeField
                    label="Scale"
                    max={1}
                    min={0.2}
                    onChange={setScale}
                    step={0.02}
                    value={scale}
                    valueLabel={`${Math.round(scale * 100)}%`}
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-white/8 bg-black/20 p-4" data-local-input="true">
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  <Monitor className="h-4 w-4 text-[var(--accent)]" />
                  Bounds editor
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  {[
                    { key: "x", label: "X" },
                    { key: "y", label: "Y" },
                    { key: "w", label: "Width" },
                    { key: "h", label: "Height" },
                  ].map((field) => (
                    <label className="space-y-2" key={field.key}>
                      <span className="text-xs uppercase tracking-[0.18em] text-slate-500">{field.label}</span>
                      <input
                        className="w-full rounded-xl border border-white/8 bg-white/[0.04] px-3 py-2 font-mono text-sm text-white outline-none transition focus:border-[color:var(--accent)]/60 focus:bg-white/[0.07]"
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
                <div className="mt-4">
                  <ActionButton
                    disabled={!selectedWindow || boundsSaving}
                    icon={<RefreshCw className={`h-4 w-4 ${boundsSaving ? "animate-spin" : ""}`} />}
                    label={boundsSaving ? "Applying…" : "Apply bounds"}
                    onClick={() => void handleApplyBounds()}
                    tone="primary"
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  <ScanSearch className="h-4 w-4 text-[var(--accent)]" />
                  Page tools
                </div>
                <div className="mt-4 space-y-4">
                  <RangeField
                    label="Snapshot depth"
                    max={100}
                    min={5}
                    onChange={setMaxElements}
                    step={5}
                    value={maxElements}
                    valueLabel={`${maxElements} elements`}
                  />

                  <label className="flex items-center justify-between gap-4 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2" data-local-input="true">
                    <div>
                      <div className="text-sm font-medium text-white">Highlight overlays</div>
                      <div className="text-xs text-slate-500">Overlay hit targets in the structured snapshot.</div>
                    </div>
                    <input
                      checked={showOverlays}
                      className="h-4 w-4 accent-[var(--accent)]"
                      onChange={(event) => setShowOverlays(event.target.checked)}
                      type="checkbox"
                    />
                  </label>

                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      disabled={!selectedWindow || Boolean(windowAction)}
                      icon={<RotateCcw className="h-4 w-4" />}
                      label={windowAction === "reload" ? "Reloading…" : "Reload page"}
                      onClick={() => void handleReloadPage()}
                    />
                    <ActionButton
                      disabled={!selectedWindow || snapshotLoading}
                      icon={<ScanSearch className={`h-4 w-4 ${snapshotLoading ? "animate-spin" : ""}`} />}
                      label={snapshotLoading ? "Capturing…" : "Structured snapshot"}
                      onClick={() => void handleSnapshotCapture()}
                    />
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-rose-500/18 bg-rose-500/[0.06] p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-rose-100">
                  <AlertTriangle className="h-4 w-4" />
                  Destructive actions
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <ActionButton
                    disabled={!selectedWindow || Boolean(windowAction)}
                    icon={<X className="h-4 w-4" />}
                    label={windowAction === "close" ? "Closing…" : "Close selected"}
                    onClick={() => void handleCloseWindow()}
                    tone="danger"
                  />
                  <ActionButton
                    disabled={!windows.length || Boolean(windowAction)}
                    icon={<Trash2 className="h-4 w-4" />}
                    label={windowAction === "close-all" ? "Closing all…" : "Close all"}
                    onClick={() => void handleCloseAllWindows()}
                    tone="danger"
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  <Globe className="h-4 w-4 text-[var(--accent)]" />
                  Selected profile
                </div>
                <div className="mt-4 space-y-3 text-sm text-slate-300">
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Identity</div>
                    <div className="mt-1">{selectedProfile ? `account_${selectedProfile.accountIdx}` : "No selection"}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Mailbox</div>
                    <div className="mt-1 break-all text-slate-400">{selectedProfile?.gmail || "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Debugger port</div>
                    <div className="mt-1">{selectedProfile?.port ?? "—"}</div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-white/8 bg-black/20 p-4" data-local-input="true">
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  <Link2 className="h-4 w-4 text-[var(--accent)]" />
                  Proxy configuration
                </div>
                <div className="mt-4 space-y-3">
                  <textarea
                    className="min-h-[108px] w-full rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-3 font-mono text-sm text-white outline-none transition focus:border-[color:var(--accent)]/60 focus:bg-white/[0.07]"
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
                  <div className="text-xs leading-5 text-slate-500">
                    Leave empty to disable the proxy. Save without restart when you want to stage the config first.
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      disabled={!selectedProfile || Boolean(profileAction)}
                      icon={<Shield className="h-4 w-4" />}
                      label={profileAction === "proxy-save" ? "Saving…" : "Save"}
                      onClick={() => void handleSaveProxy(false)}
                    />
                    <ActionButton
                      disabled={!selectedProfile || Boolean(profileAction)}
                      icon={<RotateCcw className="h-4 w-4" />}
                      label={profileAction === "proxy-restart" ? "Saving + restarting…" : "Save + restart"}
                      onClick={() => void handleSaveProxy(true)}
                      tone="primary"
                    />
                    <ActionButton
                      disabled={!selectedProfile || Boolean(profileAction)}
                      icon={<Trash2 className="h-4 w-4" />}
                      label="Clear"
                      onClick={() => {
                        if (!selectedProfile) return;
                        setProxyDrafts((current) => ({ ...current, [selectedProfile.accountIdx]: "" }));
                      }}
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </aside>
      </div>

      {snapshotDialogText ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/72 p-4 backdrop-blur-sm">
          <div className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#0c1418] shadow-[0_24px_120px_rgba(0,0,0,0.55)]">
            <div className="flex items-center justify-between border-b border-white/8 px-5 py-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Snapshot output</div>
                <div className="mt-1 text-lg font-semibold text-white">Structured webpage snapshot</div>
              </div>
              <button
                className="rounded-xl border border-white/8 bg-white/[0.04] p-2 text-slate-300 transition hover:border-white/16 hover:bg-white/[0.08]"
                onClick={() => setSnapshotDialogText(null)}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-auto p-5">
              <pre className="whitespace-pre-wrap break-words rounded-2xl border border-white/8 bg-black/20 p-4 text-xs leading-6 text-slate-200">
                {snapshotDialogText}
              </pre>
            </div>
          </div>
        </div>
      ) : null}

      {clickPulse ? (
        <div className="pointer-events-none fixed z-50" style={{ left: clickPulse.x, top: clickPulse.y }}>
          <div className="relative -translate-x-1/2 -translate-y-1/2">
            <div className="h-10 w-10 animate-ping rounded-full border-2 border-[var(--accent)] bg-[color:var(--accent)]/25" />
            <div className="absolute inset-0 rounded-full border-2 border-[var(--accent)] bg-[color:var(--accent)]/35" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
