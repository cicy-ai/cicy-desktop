import { useState, FormEvent } from 'react';
import { rpc, setToken, setEndpoint, getEndpoint } from '../lib/client';
import { KeyRound, Loader2, ArrowRight, Server } from 'lucide-react';

interface LoginProps {
  onLogin: () => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [token, setTokenInput] = useState('');
  const [endpoint, setEndpointInput] = useState(getEndpoint());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setError('Token is required');
      return;
    }
    if (!endpoint.trim()) {
      setError('Endpoint is required');
      return;
    }
    setError('');
    setLoading(true);

    try {
      setToken(token);
      setEndpoint(endpoint);
      const res = await rpc('ping', {});
      if (res.ok) {
        onLogin();
      } else {
        setError('Invalid authentication token');
        localStorage.removeItem('ELECTRON_MCP_TOKEN');
        localStorage.removeItem('ELECTRON_MCP_ENDPOINT');
      }
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : 'Connection failed';
      setError(message);
      localStorage.removeItem('ELECTRON_MCP_TOKEN');
      localStorage.removeItem('ELECTRON_MCP_ENDPOINT');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-950 text-zinc-100 selection:bg-indigo-500/30">
      <div className="w-full max-w-md p-8">
        <div className="mb-10 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-zinc-900 border border-zinc-800 mb-6 shadow-xl shadow-black/40 ring-1 ring-white/5">
            <KeyRound className="w-7 h-7 text-indigo-500" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Welcome Back</h1>
          <p className="text-zinc-400 mt-3 text-sm leading-relaxed">
            Enter your access token to connect to the<br />Electron Window Monitor.
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-5">
          <div className="space-y-2">
            <label htmlFor="endpoint" className="text-xs font-semibold text-zinc-500 uppercase tracking-wider ml-1">
              API Endpoint
            </label>
            <div className="relative group">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-600">
                <Server className="w-4 h-4" />
              </div>
              <input
                id="endpoint"
                type="text"
                value={endpoint}
                onChange={(e) => setEndpointInput(e.target.value)}
                placeholder="https://g-electron.cicy.de5.net"
                className="w-full pl-11 pr-4 py-3.5 rounded-xl bg-zinc-900/50 border border-zinc-800 text-zinc-100 placeholder:text-zinc-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-sm"
                autoComplete="off"
              />
              <div className="absolute inset-0 rounded-xl ring-1 ring-white/5 pointer-events-none" />
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="token" className="text-xs font-semibold text-zinc-500 uppercase tracking-wider ml-1">
              Access Token
            </label>
            <div className="relative group">
              <input
                id="token"
                type="password"
                value={token}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="eyJhbGciOi..."
                className="w-full px-4 py-3.5 rounded-xl bg-zinc-900/50 border border-zinc-800 text-zinc-100 placeholder:text-zinc-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-sm"
                autoComplete="off"
              />
              <div className="absolute inset-0 rounded-xl ring-1 ring-white/5 pointer-events-none" />
            </div>
          </div>

          {error && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-3 animate-in fade-in slide-in-from-top-1">
              <div className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium shadow-lg shadow-indigo-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 group relative overflow-hidden"
          >
            <div className="absolute inset-0 bg-gradient-to-t from-black/10 to-transparent pointer-events-none" />
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <>
                Connect
                <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
              </>
            )}
          </button>
        </form>
        
        <div className="mt-10 text-center">
           <p className="text-xs text-zinc-600 font-medium">Electron Window Monitor &copy; 2026</p>
        </div>
      </div>
    </div>
  );
}
