import { useEffect, useRef, useState } from "react";
import { Eye, Monitor, RefreshCw } from "lucide-react";
import { getSnapshotUrl } from "../lib/client";

export default function WatchView({ winId }: { winId: number }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;

    async function tick() {
      const interval = Number(localStorage.getItem("ELECTRON_MCP_INTERVAL") || "1200");
      const quality = Number(localStorage.getItem("ELECTRON_MCP_QUALITY") || "72");
      const scale = Number(localStorage.getItem("ELECTRON_MCP_SCALE") || "0.58");

      try {
        const response = await fetch(getSnapshotUrl(winId, quality, scale));
        if (!response.ok) {
          throw new Error(`Snapshot request failed with ${response.status}`);
        }

        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);

        if (disposed) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
        }
        objectUrlRef.current = objectUrl;

        if (imgRef.current) {
          imgRef.current.src = objectUrl;
        }

        setError("");
        setIsLoading(false);

        timerRef.current = window.setTimeout(() => {
          if (!disposed) {
            void tick();
          }
        }, interval);
      } catch (snapshotError) {
        setError(snapshotError instanceof Error ? snapshotError.message : "Failed to load live preview.");
        setIsLoading(false);
        timerRef.current = window.setTimeout(() => {
          if (!disposed) {
            void tick();
          }
        }, 2000);
      }
    }

    void tick();

    return () => {
      disposed = true;
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [winId]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] p-4 text-slate-100" data-id="watch-root">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_left,rgba(55,124,110,0.24),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(191,160,91,0.12),transparent_24%)]" />
      <div className="relative flex h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#091116]/92 shadow-[0_32px_120px_rgba(0,0,0,0.42)]" data-id="watch-shell">
        <div className="flex items-center justify-between border-b border-white/8 px-5 py-4" data-id="watch-header">
          <div data-id="watch-title-group">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400" data-id="watch-kicker">Live watch</div>
            <div className="mt-1 flex items-center gap-2 text-lg font-semibold text-white" data-id="watch-title">
              <Eye className="h-4 w-4 text-[var(--accent)]" />
              Window #{winId}
            </div>
          </div>
          <div className="rounded-full border border-white/8 bg-white/[0.04] px-3 py-1 text-xs text-slate-400" data-id="watch-badge">
            Auto-refresh from saved capture settings
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/35" data-id="watch-viewport">
          <img alt={`Live watch for window ${winId}`} className="max-h-full max-w-full object-contain" data-id="watch-image" ref={imgRef} />

          {isLoading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#091116]/75 text-slate-300" data-id="watch-loading">
              <RefreshCw className="h-5 w-5 animate-spin text-[var(--accent)]" />
              <div className="text-sm">Loading live preview…</div>
            </div>
          ) : null}

          {error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#091116]/82 px-6 text-center" data-id="watch-error">
              <Monitor className="h-8 w-8 text-rose-300" />
              <div className="max-w-lg text-sm leading-6 text-rose-100">{error}</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
