import { useEffect, useState, useRef, MouseEvent } from 'react';
import { getSnapshotUrl, rpc, rpcJson, getToken } from '../lib/client';
import { 
  RefreshCw, X, Monitor, Settings, 
  RotateCcw, Plus, Layout, Maximize2, 
  ChevronRight, ChevronLeft, Trash2, ExternalLink,
  Search, Sliders, Check, AlertCircle, Terminal, Wifi
} from 'lucide-react';

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
  onLogout: () => void;
  initialMode?: 'chrome' | 'electron';
}

export default function Dashboard({ onLogout, initialMode = 'chrome' }: DashboardProps) {
  const [mode, setMode] = useState<'chrome' | 'electron'>(initialMode);

  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [profiles, setProfiles] = useState<ChromeProfile[]>([]);
  const [selectedWinId, setSelectedWinId] = useState<number | null>(null);
  const [selectedAccountIdx, setSelectedAccountIdx] = useState<number | null>(null);
  const [proxyDrafts, setProxyDrafts] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  
  // Capture settings
  const [interval, setIntervalMs] = useState(1000);
  const [quality, setQuality] = useState(80);
  const [scale, setScale] = useState(0.5);

  // Bounds inputs
  const [bounds, setBounds] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [applyingBounds, setApplyingBounds] = useState(false);
  const [boundsFeedback, setBoundsFeedback] = useState<{ msg: string; error: boolean } | null>(null);

  // Webpage snapshot settings
  const [maxElements, setMaxElements] = useState(20);
  const [showOverlays, setShowOverlays] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotDialogText, setSnapshotDialogText] = useState<string | null>(null);

  const imgRef = useRef<HTMLImageElement>(null);
  const [clickPos, setClickPos] = useState<{x: number, y: number} | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pingTime, setPingTime] = useState<number | null>(null);

  // Keyboard input handler
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (!selectedWinId || e.ctrlKey || e.altKey || e.metaKey) return;
      
      const key = e.key;
      if (key.length !== 1 && !['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) {
        return;
      }

      try {
        const codeMap: Record<string, string> = {
          'Enter': 'Return', 'Backspace': 'Backspace', 'Tab': 'Tab', 'Escape': 'Escape',
          'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
          'Delete': 'Delete', 'Insert': 'Insert', 'Home': 'Home', 'End': 'End',
          'PageUp': 'PageUp', 'PageDown': 'PageDown'
        };
        
        const keyCode = codeMap[key] || (key.length === 1 ? key.toUpperCase() : key);
        
        await rpc('control_electron_WebContents', {
          win_id: selectedWinId,
          code: `webContents.sendInputEvent({type: 'keyDown', keyCode: '${keyCode}', key: '${key}'})`
        });
        
        if (key === 'Enter' || key === 'Tab' || key === 'Backspace') {
          await rpc('control_electron_WebContents', {
            win_id: selectedWinId,
            code: `webContents.sendInputEvent({type: 'keyUp', keyCode: '${keyCode}', key: '${key}'})`
          });
        }
      } catch (err) {
        console.error('Key send failed:', err);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedWinId]);

  // Ping to measure network latency
  useEffect(() => {
    const ping = async () => {
      const start = Date.now();
      try {
        await rpc('ping', {});
        setPingTime(Date.now() - start);
      } catch {
        setPingTime(null);
      }
    };
    ping();
    const interval = setInterval(ping, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadProfiles = async () => {
    try {
      const token = getToken();
      const res = await fetch(`${window.location.origin}/api/chrome/profiles`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) throw new Error('Unauthorized');
      const data = await res.json();
      const list = Array.isArray(data?.profiles) ? data.profiles : [];
      setProfiles(list);
    } catch (e) {
      // ignore
    }
  };

  // Load windows/profiles on mount
  useEffect(() => {
    // Only fetch what we need initially; still keep both available for fast switching.
    loadWindows();
    loadProfiles();
    const savedWin = localStorage.getItem('ELECTRON_MCP_SELECTED_WIN');
    if (savedWin) setSelectedWinId(parseInt(savedWin));
    
    const savedInterval = localStorage.getItem('ELECTRON_MCP_INTERVAL');
    if (savedInterval) setIntervalMs(parseInt(savedInterval));

    const savedQuality = localStorage.getItem('ELECTRON_MCP_QUALITY');
    if (savedQuality) setQuality(parseInt(savedQuality));

    const savedScale = localStorage.getItem('ELECTRON_MCP_SCALE');
    if (savedScale) setScale(parseFloat(savedScale));


    const savedControls = localStorage.getItem('CONTROLS_VISIBLE');
    if (savedControls) setControlsOpen(savedControls !== 'false');
  }, []);

  // Update bounds state when selected window changes
  useEffect(() => {
    if (selectedWinId) {
      const win = windows.find(w => w.id === selectedWinId);
      if (win) {
        setBounds({
          x: win.bounds.x,
          y: win.bounds.y,
          w: win.bounds.width,
          h: win.bounds.height
        });
        // Focus window
        rpc('control_electron_BrowserWindow', { win_id: selectedWinId, code: 'win.focus()' }).catch(() => {});
      }
      localStorage.setItem('ELECTRON_MCP_SELECTED_WIN', selectedWinId.toString());
      if (mode === 'electron') {
        refreshPreview(selectedWinId);
      }
    }
  }, [selectedWinId, windows]);

  const refreshPreview = async (winId: number) => {
    if (!imgRef.current) return;
    setPreviewLoading(true);
    try {
      const url = getSnapshotUrl(winId, quality, scale);
      const res = await fetch(url);
      if (!res.ok) return;
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);

      const oldUrl = imgRef.current.getAttribute('data-object-url');
      if (oldUrl) URL.revokeObjectURL(oldUrl);

      imgRef.current.src = objectUrl;
      imgRef.current.setAttribute('data-object-url', objectUrl);
    } catch (e) {
      console.error('Preview refresh error', e);
    } finally {
      setPreviewLoading(false);
    }
  };

  // No auto-capture loop on the dashboard. Preview is manual/on-demand.

  const loadWindows = async () => {
    setLoading(true);
    try {
      const data = await rpcJson<WindowInfo[]>('get_windows');
      setWindows(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const postProfile = async (accountIdx: number, action: 'open' | 'restart' | 'stop', body: any = {}) => {
    try {
      const token = getToken();
      await fetch(`${window.location.origin}/api/chrome/profiles/${accountIdx}/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body || {}),
      });
    } finally {
      loadProfiles();
    }
  };

  const saveProfileProxy = async (accountIdx: number, restart = false) => {
    const token = getToken();
    const proxy = proxyDrafts[accountIdx] || '';
    await fetch(`${window.location.origin}/api/chrome/profiles/${accountIdx}/proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        enabled: !!proxy,
        proxy,
        restart,
      }),
    });
    await loadProfiles();
  };

  const handleOpenWindow = async (url: string, accountIdx: number = 0) => {
    try {
      const wins = await rpcJson<WindowInfo[]>('get_windows');
      const allWindows = Array.isArray(wins) ? wins : [];
      const existing = allWindows.find(w => w.url && w.url.includes(new URL(url).hostname));
      
      if (existing) {
        await rpc('control_electron_BrowserWindow', { win_id: existing.id, code: 'win.focus()' });
        setSelectedWinId(existing.id);
      } else {
        await rpc('open_window', { 
          url, 
          accountIdx,
          reuseWindow: false,
          options: { width: 1200, height: 800 }
        });
        loadWindows();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleCloseAll = async () => {
    if (!confirm('Close all windows?')) return;
    try {
      const wins = await rpcJson<WindowInfo[]>('get_windows');
      await Promise.all((Array.isArray(wins) ? wins : []).map(w => rpc('close_window', { win_id: w.id })));
      setSelectedWinId(null);
      loadWindows();
    } catch (e) {
      console.error(e);
    }
  };

  const handleApplyBounds = async () => {
    if (!selectedWinId) return;
    setApplyingBounds(true);
    setBoundsFeedback(null);
    try {
      const res = await rpc('set_window_bounds', {
        win_id: selectedWinId,
        x: bounds.x,
        y: bounds.y,
        width: bounds.w,
        height: bounds.h
      });
      const data = await res.json();
      const isErr = data.result?.isError;
      const msg = isErr ? (data.result?.content?.[0]?.text || 'Error') : 'Applied successfully';
      setBoundsFeedback({ msg, error: !!isErr });
      loadWindows();
    } catch (e: any) {
      setBoundsFeedback({ msg: e.message, error: true });
    } finally {
      setApplyingBounds(false);
    }
  };

  const handleReloadPage = async () => {
    if (!selectedWinId) return;
    await rpc('control_electron_BrowserWindow', { win_id: selectedWinId, code: 'win.reload()' });
  };

  const handleCloseWindow = async () => {
    if (!selectedWinId) return;
    if (!confirm(`Close window #${selectedWinId}?`)) return;
    await rpc('close_window', { win_id: selectedWinId });
    setSelectedWinId(null);
    loadWindows();
  };

  const handleWebpageSnapshot = async () => {
    if (!selectedWinId) return;
    setSnapshotLoading(true);
    setSnapshotDialogText(null);
    try {
      const res = await rpc('webpage_snapshot', {
        win_id: selectedWinId,
        max_elements: maxElements,
        include_screenshot: true,
        show_overlays: showOverlays
      });
      const data = await res.json();
      let text = '';
      if (data.result?.content?.[0]?.text) {
        try {
          const parsed = JSON.parse(data.result.content[0].text);
          text = parsed?.elements?.[0]?.text || JSON.stringify(parsed, null, 2);
        } catch {
          text = data.result.content[0].text;
        }
      } else {
        text = JSON.stringify(data, null, 2);
      }
      setSnapshotDialogText(text || 'No data returned');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to get snapshot';
      setSnapshotDialogText(`Error: ${msg}`);
    } finally {
      setSnapshotLoading(false);
    }
  };

  const handleImageClick = async (e: MouseEvent<HTMLImageElement>) => {
    if (!selectedWinId || !imgRef.current) return;

    const rect = imgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Show click position
    setClickPos({ x: e.clientX, y: e.clientY });
    setTimeout(() => setClickPos(null), 800);

    // Calculate relative coordinates (0.0 to 1.0)
    const rx = x / rect.width;
    const ry = y / rect.height;

    // Get window bounds to calculate absolute coordinates
    const win = windows.find(w => w.id === selectedWinId);
    if (!win) return;

    // Calculate absolute coordinates in the window
    const absoluteX = Math.round(rx * win.bounds.width);
    const absoluteY = Math.round(ry * win.bounds.height);

    console.log(`Click: ${absoluteX}, ${absoluteY} (Window: ${win.bounds.width}x${win.bounds.height})`);

    try {
      await rpc('cdp_click', {
        win_id: selectedWinId,
        x: absoluteX,
        y: absoluteY,
        button: 'left'
      });
    } catch (err) {
      console.error('Click failed:', err);
    }
  };

  useEffect(() => {
    // Pick a default profile once profiles are loaded
    if (selectedAccountIdx == null && profiles.length) {
      setSelectedAccountIdx(profiles[0].accountIdx);
    }
    setProxyDrafts((prev) => {
      const next = { ...prev };
      for (const p of profiles) {
        if (next[p.accountIdx] === undefined) next[p.accountIdx] = p.proxy || '';
      }
      return next;
    });
  }, [profiles, selectedAccountIdx]);

  const selectedWindow = windows.find(w => w.id === selectedWinId);
  const selectedProfile = profiles.find(p => p.accountIdx === selectedAccountIdx) || null;

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 overflow-hidden font-sans selection:bg-indigo-500/30">
      
      {/* Left Sidebar - Window List */}
      <aside className={`${sidebarOpen ? 'w-72' : 'w-0'} bg-zinc-900 border-r border-zinc-800 flex flex-col transition-all duration-300 overflow-hidden shrink-0`}>
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between shrink-0 h-16">
          <h2 className="font-semibold text-sm tracking-tight flex items-center gap-2.5 text-zinc-100">
            <div className="p-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
              <Layout className="w-4 h-4 text-indigo-500" />
            </div>
            {mode === 'electron' ? 'Electron Windows' : 'Chrome Profiles'}
          </h2>
          <button 
            onClick={mode === 'electron' ? loadWindows : loadProfiles}
            disabled={loading}
            className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-3 space-y-6">
          {mode === 'electron' && windows.length === 0 && !loading && (
             <div className="flex flex-col items-center justify-center h-40 text-zinc-500 gap-3">
               <Monitor className="w-8 h-8 opacity-20" />
               <span className="text-xs">No active windows</span>
             </div>
          )}

          {mode === 'electron' ? (
          <div className="space-y-1">
            {windows.map(w => (
            <button
              key={w.id}
              onClick={() => {
                setSelectedWinId(w.id);
                localStorage.setItem('ELECTRON_MCP_SELECTED_WIN', w.id.toString());
                refreshPreview(w.id);
              }}
              className={`w-full text-left px-3 py-3 rounded-xl text-sm transition-all group relative border ${
                selectedWinId === w.id 
                  ? 'bg-zinc-800 border-zinc-700 text-white shadow-sm' 
                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200 border-transparent hover:border-zinc-800'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="font-medium truncate pr-2">{w.title || 'Untitled Window'}</div>
                {selectedWinId === w.id && (
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)] shrink-0" />
                )}
              </div>
              <div className="flex items-center gap-2 text-[10px] text-zinc-500 font-mono mt-1">
                <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800">#{w.id}</span>
                <span>{w.bounds.width}×{w.bounds.height}</span>
                <span className="text-zinc-600">@</span>
                <span>{w.bounds.x},{w.bounds.y}</span>
              </div>
            </button>
          ))}
          </div>
          ) : (
          <div className="space-y-2">
            {profiles.length === 0 ? (
              <div className="text-[11px] text-zinc-600 px-1">No profiles</div>
            ) : (
              <div className="space-y-1">
                {profiles.map((p) => {
                  const running = !!p?.liveStatus?.isRunning;
                  const selected = selectedAccountIdx === p.accountIdx;
                  return (
                    <button
                      type="button"
                      key={p.profileKey}
                      onClick={() => setSelectedAccountIdx(p.accountIdx)}
                      className={`w-full text-left p-3 rounded-xl border transition-colors ${selected ? 'border-indigo-500/30 bg-indigo-500/10' : running ? 'border-emerald-500/20 bg-emerald-500/5 hover:bg-emerald-500/10' : 'border-zinc-800 bg-zinc-900/40 hover:bg-zinc-800/40'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-zinc-200 truncate">
                            account_{p.accountIdx}
                            <span className={`ml-2 inline-block w-1.5 h-1.5 rounded-full ${running ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                          </div>
                          <div className="text-[10px] text-zinc-500 font-mono truncate">{p.gmail || '—'}</div>
                          <div className="text-[10px] text-zinc-600 font-mono truncate">
                            port: {p.port ?? '—'} {p.proxy ? `| proxy: on` : '| proxy: off'}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          )}
        </div>

        <div className="p-4 border-t border-zinc-800 bg-zinc-900/50 space-y-3 shrink-0">
          {mode === 'electron' && (
            <>
              <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider px-1">Quick Launch</div>
              <div className="grid grid-cols-2 gap-2">
                 <button onClick={() => handleOpenWindow('https://chatgpt.com')} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium transition-colors">
                   <ExternalLink className="w-3 h-3 text-emerald-500" /> ChatGPT
                 </button>
                 <button onClick={() => handleOpenWindow('https://gemini.google.com')} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium transition-colors">
                   <ExternalLink className="w-3 h-3 text-blue-500" /> Gemini
                 </button>
                 <button onClick={() => handleOpenWindow('https://aistudio.google.com')} className="col-span-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium transition-colors">
                   <ExternalLink className="w-3 h-3 text-purple-500" /> AI Studio
                 </button>
              </div>
            </>
          )}
          <div className="pt-2 border-t border-zinc-800 text-center">
            <span className="text-[10px] text-zinc-600 font-mono">v1.0.0</span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-zinc-950 relative">
        {/* Header Toolbar */}
        <header className="h-16 border-b border-zinc-800 bg-zinc-900/50 flex items-center justify-between px-6 shrink-0 backdrop-blur-sm z-10">
           <div className="flex items-center gap-4">
             <button 
               onClick={() => setSidebarOpen(!sidebarOpen)}
               className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
             >
               {sidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
             </button>
             
             <div className="h-6 w-px bg-zinc-800" />

             {mode === 'electron' ? (
              selectedWindow ? (
                <div>
                  <h1 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                    {selectedWindow.title || 'Untitled Window'}
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">
                      #{selectedWindow.id}
                    </span>
                  </h1>
                  <div className="text-xs text-zinc-500 truncate max-w-md">{selectedWindow.url}</div>
                </div>
              ) : (
                <div className="text-sm text-zinc-500">No window selected</div>
              )
             ) : (
              <div>
                <h1 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                  Chrome Profiles
                  {selectedProfile && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">
                      account_{selectedProfile.accountIdx}
                    </span>
                  )}
                </h1>
                <div className="text-xs text-zinc-500 truncate max-w-md">Manage profiles, proxy, lifecycle</div>
              </div>
             )}
           </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => window.location.assign('/console/chrome')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${mode === 'chrome' ? 'bg-indigo-500/20 text-indigo-200 border-indigo-500/30' : 'bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:text-zinc-200'}`}
              >
                Chrome Console
              </button>
              <button
                onClick={() => window.location.assign('/console/electron')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${mode === 'electron' ? 'bg-indigo-500/20 text-indigo-200 border-indigo-500/30' : 'bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:text-zinc-200'}`}
              >
                Electron Console
              </button>
              <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-zinc-800/50 border border-zinc-700/50 text-xs">
                <Wifi className={`w-3.5 h-3.5 ${pingTime ? 'text-emerald-400' : 'text-red-400'}`} />
                <span className={`font-mono ${pingTime ? 'text-zinc-300' : 'text-red-400'}`}>
                  {pingTime ? `${pingTime}ms` : '--'}
                </span>
              </div>

              <button
                onClick={() => selectedWinId && refreshPreview(selectedWinId)}
                disabled={!selectedWinId || previewLoading}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border bg-zinc-800 text-zinc-200 border-zinc-700 hover:bg-zinc-700 disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${previewLoading ? 'animate-spin' : ''}`} />
                Refresh Preview
              </button>

              <button
                onClick={() => {
                  const newVal = !controlsOpen;
                  setControlsOpen(newVal);
                  localStorage.setItem('CONTROLS_VISIBLE', String(newVal));
                }}
                className={`p-2 rounded-lg transition-colors border ${
                  controlsOpen 
                    ? 'bg-zinc-800 text-zinc-100 border-zinc-700' 
                    : 'text-zinc-400 border-transparent hover:bg-zinc-800'
                }`}
              >
                <Sliders className="w-4 h-4" />
              </button>
            </div>
        </header>

        {/* Main Panel */}
        <div className="flex-1 overflow-hidden relative flex items-center justify-center bg-zinc-950">
           {/* Grid Pattern Background */}
           <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ 
             backgroundImage: 'radial-gradient(#fff 1px, transparent 1px)', 
             backgroundSize: '24px 24px' 
           }} />
           
            {mode === 'electron' ? (
              selectedWinId ? (
               <div className="relative z-0 max-w-full max-h-full p-8 flex items-center justify-center">
                  <img 
                    ref={imgRef} 
                    onClick={handleImageClick}
                    onDragStart={(e) => e.preventDefault()}
                    draggable={false}
                    alt="Preview" 
                    className="max-w-full max-h-full object-contain shadow-2xl shadow-black rounded-lg ring-1 ring-zinc-800 bg-zinc-900 cursor-crosshair select-none" 
                  />
                  {clickPos && (
                    <div 
                      className="fixed pointer-events-none z-50"
                      style={{ left: clickPos.x, top: clickPos.y }}
                    >
                      <div className="relative -translate-x-1/2 -translate-y-1/2">
                        <div className="w-8 h-8 rounded-full bg-indigo-500/30 border-2 border-indigo-400 animate-ping" />
                        <div className="absolute inset-0 w-8 h-8 rounded-full bg-indigo-500/50 border-2 border-indigo-400" />
                      </div>
                    </div>
                  )}
               </div>
              ) : (
                <div className="flex flex-col items-center gap-4 text-zinc-600 relative z-0">
                  <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
                    <Monitor className="w-8 h-8 opacity-50" />
                  </div>
                  <p className="text-sm font-medium">Select a window to preview</p>
                </div>
              )
            ) : (
              <div className="w-full max-w-3xl p-8">
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-zinc-100">Profile</div>
                      <div className="text-xs text-zinc-500 font-mono mt-1">
                        {selectedProfile ? `account_${selectedProfile.accountIdx} | ${selectedProfile.gmail || '—'}` : 'Select a profile'}
                      </div>
                    </div>
                    {selectedProfile && (
                      <div className="flex items-center gap-2">
                        <button onClick={() => postProfile(selectedProfile.accountIdx, 'open')} className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium">Open</button>
                        <button onClick={() => postProfile(selectedProfile.accountIdx, 'restart')} className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium">Restart</button>
                        <button onClick={() => postProfile(selectedProfile.accountIdx, 'stop')} className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium">Stop</button>
                      </div>
                    )}
                  </div>

                  <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
                      <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Debugger</div>
                      <div className="mt-2 text-sm text-zinc-200 font-mono">port: {selectedProfile?.port ?? '—'}</div>
                    </div>
                    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
                      <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Proxy (config)</div>

                      {selectedProfile ? (
                        <>
                          <input
                            value={proxyDrafts[selectedProfile.accountIdx] ?? ''}
                            onChange={(e) =>
                              setProxyDrafts((prev) => ({
                                ...prev,
                                [selectedProfile.accountIdx]: e.target.value,
                              }))
                            }
                            placeholder="socks5://127.0.0.1:1080 (empty = off)"
                            className="mt-2 w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-200 placeholder:text-zinc-600"
                          />

                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              onClick={() => saveProfileProxy(selectedProfile.accountIdx, false)}
                              className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => saveProfileProxy(selectedProfile.accountIdx, true)}
                              className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 border border-indigo-500/30 text-xs font-medium text-white"
                            >
                              Save + Restart
                            </button>
                            <button
                              onClick={() =>
                                setProxyDrafts((prev) => ({
                                  ...prev,
                                  [selectedProfile.accountIdx]: '',
                                }))
                              }
                              className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium"
                            >
                              Clear
                            </button>
                          </div>

                          <div className="mt-3 text-[11px] text-zinc-500">
                            Tip: proxy changes apply on restart (A).
                          </div>
                        </>
                      ) : (
                        <div className="mt-2 text-xs text-zinc-500">Select a profile</div>
                      )}
                    </div>
                  </div>

                  <div className="mt-6 text-[11px] text-zinc-500">
                    下一步：我会把“平台登录状态（ChatGPT/Gmail/GitHub/Cloudflare/Outlook/Apple）”挂在这里。
                  </div>
                </div>
              </div>
            )}
        </div>
      </main>

      {/* Right Sidebar - Controls (Electron only) */}
      {mode === 'electron' && (
      <aside className={`${controlsOpen ? 'w-80' : 'w-0'} bg-zinc-900 border-l border-zinc-800 flex flex-col transition-all duration-300 overflow-hidden shrink-0`}>
         <div className="p-4 border-b border-zinc-800 h-16 flex items-center shrink-0">
           <h2 className="font-semibold text-sm tracking-tight flex items-center gap-2 text-zinc-100">
             <Settings className="w-4 h-4 text-zinc-400" />
             Controls
           </h2>
         </div>

         {selectedWinId ? (
           <div className="flex-1 overflow-y-auto p-5 space-y-8">
             
             {/* Capture Settings */}
             <div className="space-y-4">
               <div className="flex items-center justify-between">
                 <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Capture Settings</h3>
               </div>
               
               <div className="space-y-4">
                 <div className="space-y-2">
                   <div className="flex justify-between text-xs">
                     <span className="text-zinc-400">Interval</span>
                     <span className="text-zinc-200 font-mono">{(interval / 1000).toFixed(1)}s</span>
                   </div>
                   <input 
                      type="range" min="200" max="5000" step="100" 
                      value={interval} 
                      onChange={(e) => {
                        const v = parseInt(e.target.value);
                        setIntervalMs(v);
                        localStorage.setItem('ELECTRON_MCP_INTERVAL', String(v));
                      }}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                    />
                 </div>

                 <div className="space-y-2">
                   <div className="flex justify-between text-xs">
                     <span className="text-zinc-400">Quality</span>
                     <span className="text-zinc-200 font-mono">{quality}%</span>
                   </div>
                   <input 
                      type="range" min="10" max="100" step="5" 
                      value={quality} 
                      onChange={(e) => {
                        const v = parseInt(e.target.value);
                        setQuality(v);
                        localStorage.setItem('ELECTRON_MCP_QUALITY', String(v));
                      }}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                    />
                 </div>

                 <div className="space-y-2">
                   <div className="flex justify-between text-xs">
                     <span className="text-zinc-400">Scale</span>
                     <span className="text-zinc-200 font-mono">{Math.round(scale * 100)}%</span>
                   </div>
                   <input 
                      type="range" min="0.1" max="1" step="0.1" 
                      value={scale} 
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        setScale(v);
                        localStorage.setItem('ELECTRON_MCP_SCALE', String(v));
                      }}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                    />
                 </div>
               </div>
             </div>

             <div className="h-px bg-zinc-800" />

             {/* Bounds */}
             <div className="space-y-4">
               <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Window Bounds</h3>
               <div className="grid grid-cols-2 gap-3">
                  {['x', 'y', 'w', 'h'].map((key) => (
                    <div key={key} className="space-y-1.5">
                      <label className="text-[10px] font-medium text-zinc-500 uppercase">{key === 'w' ? 'Width' : key === 'h' ? 'Height' : key}</label>
                      <div className="relative">
                        <input 
                          type="number" 
                          value={bounds[key as keyof typeof bounds]} 
                          onChange={(e) => setBounds({...bounds, [key]: parseInt(e.target.value) || 0})}
                          className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-mono focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all" 
                        />
                      </div>
                    </div>
                  ))}
               </div>
               
               <button 
                  onClick={handleApplyBounds}
                  disabled={applyingBounds}
                  className="w-full py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 transition-all flex items-center justify-center gap-2"
                >
                  {applyingBounds ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  {applyingBounds ? 'Applying...' : 'Apply Bounds'}
                </button>
                
                {boundsFeedback && (
                  <div className={`text-xs flex items-center gap-2 p-2 rounded-lg ${boundsFeedback.error ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                    {boundsFeedback.error ? <AlertCircle className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
                    {boundsFeedback.msg}
                  </div>
                )}
             </div>

             <div className="h-px bg-zinc-800" />

             {/* Actions */}
             <div className="space-y-3">
               <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Actions</h3>
               <button onClick={handleReloadPage} className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium shadow-lg shadow-indigo-500/20 transition-all flex items-center justify-center gap-2">
                  <RotateCcw className="w-3.5 h-3.5" /> Reload Page
               </button>
               <button onClick={handleCloseWindow} className="w-full py-2.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 text-xs font-medium transition-all flex items-center justify-center gap-2">
                  <X className="w-3.5 h-3.5" /> Close Window
               </button>
             </div>

             <div className="h-px bg-zinc-800" />
             
              <div className="space-y-3">
                 <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Danger Zone</h3>
                 <button onClick={handleCloseAll} className="w-full py-2.5 rounded-lg border border-zinc-800 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 text-xs font-medium transition-all flex items-center justify-center gap-2">
                   <Trash2 className="w-3.5 h-3.5" /> Close All Windows
                 </button>
              </div>

              <div className="h-px bg-zinc-800" />

              {/* Webpage Snapshot */}
              <div className="space-y-3">
                <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Webpage Snapshot</h3>
                
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-400">Max Elements</span>
                    <span className="text-zinc-200 font-mono">{maxElements}</span>
                  </div>
                  <input 
                    type="range" min="5" max="100" step="5" 
                    value={maxElements} 
                    onChange={(e) => setMaxElements(parseInt(e.target.value))}
                    className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  />
                </div>

                <label className="flex items-center justify-between text-xs cursor-pointer">
                  <span className="text-zinc-400">Show Overlays</span>
                  <div className={`w-9 h-5 rounded-full transition-colors ${showOverlays ? 'bg-indigo-500' : 'bg-zinc-700'}`}>
                    <input 
                      type="checkbox" 
                      checked={showOverlays}
                      onChange={(e) => setShowOverlays(e.target.checked)}
                      className="sr-only"
                    />
                    <div className={`w-4 h-4 bg-white rounded-full shadow transform transition-transform ${showOverlays ? 'translate-x-4.5' : 'translate-x-0.5'} mt-0.5`} />
                  </div>
                </label>

                <button 
                  onClick={handleWebpageSnapshot}
                  disabled={snapshotLoading || !selectedWinId}
                  className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium shadow-lg shadow-indigo-500/20 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {snapshotLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                  {snapshotLoading ? 'Loading...' : 'Get Snapshot'}
                </button>
              </div>

           </div>
         ) : (
           <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 p-8 text-center">
             <Settings className="w-10 h-10 opacity-20 mb-3" />
             <p className="text-sm">Select a window to view controls</p>
           </div>
         )}
      </aside>
      )}

      {/* Snapshot Dialog (Electron only) */}
      {mode === 'electron' && snapshotDialogText && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="w-full max-w-2xl max-h-[80vh] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-100">Webpage Snapshot</h3>
              <button 
                onClick={() => setSnapshotDialogText(null)}
                className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 max-h-[50vh]">
              <pre className="text-xs text-zinc-300 font-mono whitespace-pre-wrap max-h-full">{snapshotDialogText}</pre>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
