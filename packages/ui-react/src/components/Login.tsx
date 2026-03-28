import { useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, Loader2, Server, ShieldCheck } from "lucide-react";
import { getEndpoint, requestJson, setEndpoint, setToken } from "../lib/client";

interface LoginProps {
  onLogin: () => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [token, setTokenInput] = useState("");
  const [endpoint, setEndpointInput] = useState(getEndpoint());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleLogin(event: FormEvent) {
    event.preventDefault();

    if (!endpoint.trim()) {
      setError("Endpoint is required.");
      return;
    }

    if (!token.trim()) {
      setError("Access token is required.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      setEndpoint(endpoint.trim());
      setToken(token.trim());
      await requestJson("/rpc/ping", {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      onLogin();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Connection failed.");
      localStorage.removeItem("ELECTRON_MCP_TOKEN");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)] px-4 py-10 text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_left,rgba(55,124,110,0.28),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(191,160,91,0.18),transparent_24%)]" />

      <div className="relative grid w-full max-w-5xl overflow-hidden rounded-[32px] border border-white/10 bg-[#091116]/92 shadow-[0_32px_120px_rgba(0,0,0,0.45)] lg:grid-cols-[1.05fr_0.95fr]">
        <section className="border-b border-white/8 p-8 lg:border-b-0 lg:border-r lg:p-10">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-300">
            <ShieldCheck className="h-3.5 w-3.5 text-[var(--accent)]" />
            CiCy Desktop
          </div>

          <h1 className="mt-8 max-w-lg text-4xl font-semibold tracking-tight text-white">Operator-grade start page for desktop automation.</h1>
          <p className="mt-4 max-w-xl text-sm leading-7 text-slate-400">
            Connect once, then work from a cleaner control surface that keeps the current target obvious and the low-level tools nearby
            instead of everywhere.
          </p>

          <div className="mt-10 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="text-sm font-medium text-white">Electron windows</div>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                Preview, focus, resize, click, reload, snapshot, and watch active browser sessions.
              </p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="text-sm font-medium text-white">Chrome profiles</div>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                Keep lifecycle and proxy management available without turning the main view into a debug dump.
              </p>
            </div>
          </div>
        </section>

        <section className="p-8 lg:p-10">
          <div className="mb-8">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04]">
              <KeyRound className="h-6 w-6 text-[var(--accent)]" />
            </div>
            <h2 className="mt-6 text-2xl font-semibold text-white">Connect to a worker</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              If this page was opened from the worker directly, only the access token usually needs to change.
            </p>
          </div>

          <form className="space-y-5" onSubmit={(event) => void handleLogin(event)}>
            <label className="block space-y-2" data-local-input="true">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">API endpoint</span>
              <div className="relative">
                <Server className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  autoComplete="off"
                  className="w-full rounded-2xl border border-white/8 bg-white/[0.04] py-3 pl-11 pr-4 text-sm text-white outline-none transition focus:border-[color:var(--accent)]/60 focus:bg-white/[0.07]"
                  onChange={(event) => setEndpointInput(event.target.value)}
                  placeholder="https://g-electron.cicy.de5.net"
                  type="text"
                  value={endpoint}
                />
              </div>
            </label>

            <label className="block space-y-2" data-local-input="true">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Access token</span>
              <input
                autoComplete="off"
                className="w-full rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none transition focus:border-[color:var(--accent)]/60 focus:bg-white/[0.07]"
                onChange={(event) => setTokenInput(event.target.value)}
                placeholder="eyJhbGciOi..."
                type="password"
                value={token}
              />
            </label>

            {error ? (
              <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</div>
            ) : null}

            <button
              className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={loading}
              type="submit"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              {loading ? "Connecting…" : "Enter console"}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
