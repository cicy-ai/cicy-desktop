import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import "./App.css";
import { TERMS_VERSION, TERMS_FULL } from "./termsText";

// i18n bridge exposed by homepage-preload (window.cicyI18n.t, locale from
// app.getLocale()). Returns the localized string, or `fallback` when the key
// is missing or we're running outside Electron.
const tr = (key, fallback) => {
  try { const v = window.cicyI18n?.t?.(key); return v && v !== key ? v : fallback; }
  catch { return fallback; }
};

const TOKEN_KEY = "cicy_token";
const ACCESS_TOKEN_KEY = "cicy_access_token";
const USER_ID_KEY = "cicy_user_id";
const CLOUD_BASE = "https://cicy-ai.com";

// ── Toast: lightweight global notifications (bottom-right). Pub/sub store so
// any component can push without prop-drilling — one <ToastHost/> at the shell
// root renders them. Used for 更新/启动/重启 progress + result so feedback floats
// over the UI instead of being buried inside a card. show() upserts by id, so a
// long-running op keeps ONE toast and just streams message/progress into it.
const toastListeners = new Set();
let toastSeq = 0;
let toastItems = [];
const toastTimers = new Map();
function emitToasts() { toastListeners.forEach((l) => l(toastItems)); }
const toast = {
  show(opts = {}) {
    const id = opts.id || `t${++toastSeq}`;
    const prev = toastItems.find((t) => t.id === id);
    const next = { id, status: "running", ...prev, ...opts };
    toastItems = prev ? toastItems.map((t) => (t.id === id ? next : t)) : [...toastItems, next];
    emitToasts();
    const old = toastTimers.get(id);
    if (old) { clearTimeout(old); toastTimers.delete(id); }
    if (opts.ttl) toastTimers.set(id, setTimeout(() => toast.dismiss(id), opts.ttl));
    return id;
  },
  dismiss(id) {
    toastItems = toastItems.filter((t) => t.id !== id);
    const tm = toastTimers.get(id);
    if (tm) { clearTimeout(tm); toastTimers.delete(id); }
    emitToasts();
  },
};
function ToastHost() {
  const [items, setItems] = useState(toastItems);
  useEffect(() => { toastListeners.add(setItems); return () => { toastListeners.delete(setItems); }; }, []);
  if (!items.length) return null;
  return (
    <div className="toast-host" data-id="ToastHost">
      {items.map((t) => (
        <div key={t.id} className="toast" data-id={`Toast-${t.id}`} data-status={t.status || "running"}>
          <button type="button" className="toast__x" data-id="Toast-dismiss" onClick={() => toast.dismiss(t.id)} aria-label="dismiss">×</button>
          <span className="toast__msg">
            {t.message}{Number.isFinite(t.progress) ? ` ${t.progress}%` : ""}
          </span>
          {Number.isFinite(t.progress) && (
            <span className="toast__bar"><span style={{ width: `${Math.min(100, t.progress)}%` }} /></span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Update drawer: a bottom sheet that streams the live update log (下载→切换→
// 完成), surfaces the exact step it's on, and offers 重试 when it fails — so a
// stuck/slow update is legible and recoverable instead of a frozen "更新中…".
// The sidecar update op emits {phase,status,message} on 'sidecar:op-progress';
// runOp tees those into this store. Single global instance, mounted at shell root.
const drawerListeners = new Set();
let drawerLogSeq = 0;
let drawerState = null; // null = closed
function emitDrawer() { drawerListeners.forEach((l) => l(drawerState)); }
function clockHHMMSS() { const d = new Date(); return d.toTimeString().slice(0, 8); }
const updateDrawer = {
  open({ teamId, fromVer, toVer, onRetry } = {}) {
    drawerState = {
      teamId, fromVer: fromVer || null, toVer: toVer || null,
      status: "running",   // running | done | error
      phase: "download",   // download | swap | done
      logs: [],
      onRetry: onRetry || null,
      lastAt: Date.now(),
    };
    emitDrawer();
  },
  push(ev = {}) {
    if (!drawerState) return;
    const line = { id: ++drawerLogSeq, t: clockHHMMSS(), phase: ev.phase || drawerState.phase, status: ev.status || "running", message: ev.message || "" };
    drawerState = {
      ...drawerState,
      phase: ev.phase || drawerState.phase,
      toVer: ev.toVer || drawerState.toVer,
      logs: [...drawerState.logs, line],
      lastAt: Date.now(),
    };
    emitDrawer();
  },
  finish({ ok, message } = {}) {
    if (!drawerState) return;
    const status = ok ? "done" : "error";
    const line = { id: ++drawerLogSeq, t: clockHHMMSS(), phase: "done", status, message: message || (ok ? "更新完成" : "更新失败") };
    drawerState = { ...drawerState, status, phase: "done", logs: [...drawerState.logs, line], lastAt: Date.now() };
    emitDrawer();
  },
  close() { drawerState = null; emitDrawer(); },
};
const DRAWER_PHASES = [["download", "下载"], ["swap", "切换"], ["done", "完成"]];
function UpdateDrawerHost() {
  const [st, setSt] = useState(drawerState);
  useEffect(() => { drawerListeners.add(setSt); return () => { drawerListeners.delete(setSt); }; }, []);
  const logRef = useRef(null);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [st?.logs?.length]);
  // Stuck detector: running but no new log line for 25s → the verify/probe wait
  // is taking long; nudge the user (they can keep it in the background).
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!st || st.status !== "running") { setStuck(false); return; }
    const id = setInterval(() => setStuck(Date.now() - (st.lastAt || 0) > 25000), 3000);
    return () => clearInterval(id);
  }, [st?.lastAt, st?.status]);

  if (!st) return null;
  const running = st.status === "running";
  const phaseIdx = DRAWER_PHASES.findIndex(([k]) => k === st.phase);
  return (
    <div className="drawer-scrim" data-id="UpdateDrawer-scrim" onClick={() => { if (!running) updateDrawer.close(); }}>
      <div className="drawer" data-id="UpdateDrawer" data-status={st.status} onClick={(e) => e.stopPropagation()}>
        <div className="drawer__head">
          <div className="drawer__title">
            <span className={`drawer__spark drawer__spark--${st.status}`}>
              {running ? <Spinner /> : st.status === "done" ? "✓" : "!"}
            </span>
            <div>
              <div className="drawer__h">更新 cicy-code</div>
              <div className="drawer__sub">{st.fromVer ? `v${st.fromVer}` : "当前"} → {st.toVer ? `v${st.toVer}` : "最新版"}</div>
            </div>
          </div>
          <button type="button" className="drawer__x" data-id="UpdateDrawer-close" disabled={running} title={running ? "更新进行中" : "关闭"} onClick={() => updateDrawer.close()} aria-label="close">×</button>
        </div>

        <div className="drawer__steps" data-id="UpdateDrawer-steps">
          {DRAWER_PHASES.map(([k, label], i) => {
            const done = st.status === "done" || i < phaseIdx;
            const active = i === phaseIdx && running;
            const err = st.status === "error" && i === phaseIdx;
            return (
              <div key={k} className={`drawer__step${active ? " is-active" : ""}${done ? " is-done" : ""}${err ? " is-error" : ""}`}>
                <span className="drawer__step-dot">{done ? "✓" : err ? "!" : i + 1}</span>
                <span className="drawer__step-label">{label}</span>
                {i < DRAWER_PHASES.length - 1 && <span className="drawer__step-bar" />}
              </div>
            );
          })}
        </div>

        <div className="drawer__log" data-id="UpdateDrawer-log" ref={logRef}>
          {st.logs.length === 0
            ? <div className="drawer__log-empty">准备中…</div>
            : st.logs.map((l) => (
              <div key={l.id} className="drawer__line" data-status={l.status}>
                <span className="drawer__t">{l.t}</span>
                <span className={`drawer__badge drawer__badge--${l.phase}`}>{({ download: "下载", swap: "切换", done: "完成" })[l.phase] || l.phase}</span>
                <span className="drawer__linemsg">{l.message}</span>
              </div>
            ))}
        </div>

        {stuck && running && (
          <div className="drawer__hint" data-id="UpdateDrawer-stuck">
            正在等待新版本就绪，耗时比平常久。可以放到后台继续，完成或失败都会提示。
          </div>
        )}

        <div className="drawer__foot">
          {running ? (
            <>
              <span className="drawer__foot-status">更新进行中…</span>
              <button type="button" className="drawer__btn" data-id="UpdateDrawer-background" onClick={() => updateDrawer.close()}>在后台继续</button>
            </>
          ) : st.status === "error" ? (
            <>
              <span className="drawer__foot-status is-error">更新失败</span>
              {st.onRetry && <button type="button" className="drawer__btn is-accent" data-id="UpdateDrawer-retry" onClick={() => st.onRetry()}>重试</button>}
              <button type="button" className="drawer__btn" data-id="UpdateDrawer-dismiss" onClick={() => updateDrawer.close()}>关闭</button>
            </>
          ) : (
            <>
              <span className="drawer__foot-status is-done">已更新到最新</span>
              <button type="button" className="drawer__btn is-accent" data-id="UpdateDrawer-finish" onClick={() => updateDrawer.close()}>完成</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  // First-run terms gate (合规第一道整体同意) — blocks the whole UI until
  // accepted. undefined = checking, false = must show gate, true = past it.
  // Distinct from the MITM CA opt-in; accepting terms never enables audit.
  const [termsOk, setTermsOk] = useState(undefined);
  useEffect(() => {
    if (!window.cicy?.terms?.status) { setTermsOk(true); return; } // no bridge (dev) → don't block
    window.cicy.terms.status(TERMS_VERSION)
      .then((r) => setTermsOk(!!r?.accepted))
      .catch(() => setTermsOk(true));
  }, []);

  // sk-xxx (LLM API). Used by /v1/chat/completions etc.
  const [token, setToken] = useState(() => safeGet(TOKEN_KEY));
  // Console-API bearer. Used by /api/user/self, /api/teams, etc.
  const [accessToken, setAccessToken] = useState(() => safeGet(ACCESS_TOKEN_KEY));
  // Required as `New-Api-User: <id>` header on every console-API call —
  // middleware.UserAuth() rejects requests without it.
  const [userId, setUserId] = useState(() => safeGet(USER_ID_KEY));
  // True while we ask main for a durably-saved login (origin-independent).
  // Prevents the login card from flashing on every launch before restore.
  const [authRestoring, setAuthRestoring] = useState(() => !safeGet(TOKEN_KEY));
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState("");
  const [welcome, setWelcome] = useState("");
  // Fetched after login: { id, display_name, username, email, ... }
  const [me, setMe] = useState(null);
  // Fetched after login: [{ id, title, team_kind, status, workspace_url, ... }]
  const [teams, setTeams] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState("");
  // Local teams discovered from ~/cicy-ai/global.json (main-process probe).
  const [localTeams, setLocalTeams] = useState(null);
  const [localTeamsLoading, setLocalTeamsLoading] = useState(false);
  // localTeamsFetched: true after the first probe completes (even if empty).
  // Used to distinguish "not yet probed" (unknown) from "probed and empty"
  // (cloud-only) in localHelperState below.
  const [localTeamsFetched, setLocalTeamsFetched] = useState(false);
  // Tab state for the team grid: "all" | "local" | "cloud".
  const [tab, setTab] = useState("all");

  // Pull /api/user/self + /api/teams in parallel using the access_token.
  // Goes through window.cicy.cloud.fetch — main does the actual request,
  // so we sidestep CORS (vite-dev localhost:8173 / file:// origins are
  // not on cicy-ai.com's allowlist).
  const fetchProfile = useCallback(async (at, uid) => {
    if (!at) return;
    if (!window.cicy?.cloud?.fetch) {
      setProfileError("cloud fetch bridge missing");
      return;
    }
    setProfileLoading(true);
    setProfileError("");
    const headers = { Authorization: `Bearer ${at}` };
    if (uid) headers["New-Api-User"] = String(uid);
    try {
      const [selfRes, teamsRes] = await Promise.all([
        window.cicy.cloud.fetch(`${CLOUD_BASE}/api/user/self`, { headers }),
        window.cicy.cloud.fetch(`${CLOUD_BASE}/api/teams`,     { headers }),
      ]);
      if (!selfRes?.ok)  throw new Error(`/api/user/self ${selfRes?.status || "?"} ${selfRes?.error || ""}`);
      if (!teamsRes?.ok) throw new Error(`/api/teams ${teamsRes?.status || "?"} ${teamsRes?.error || ""}`);
      // /api/user/self is wrapped: { success, message, data }
      // /api/teams is bare: { teams: [...] }
      const selfBody  = JSON.parse(selfRes.body || "{}");
      const teamsBody = JSON.parse(teamsRes.body || "{}");
      if (selfBody?.success === false) throw new Error(selfBody.message || "self failed");
      setMe(selfBody?.data || null);
      setTeams(Array.isArray(teamsBody?.teams) ? teamsBody.teams : []);
    } catch (e) {
      setProfileError(e.message || String(e));
    } finally {
      setProfileLoading(false);
    }
  }, []);

  // First profile fetch on mount if we already have an access_token.
  useEffect(() => {
    if (accessToken) fetchProfile(accessToken, userId);
  }, [accessToken, userId, fetchProfile]);

  // Local teams: probe on mount (independent of cloud login — local team
  // discovery doesn't require a token). Fast-poll every 3s for the first
  // 30s so we catch cicy-code coming online shortly after desktop launch,
  // then settle to 30s.
  const fetchLocalTeams = useCallback(async () => {
    if (!window.cicy?.localTeams?.list) return;
    setLocalTeamsLoading(true);
    try {
      const list = await window.cicy.localTeams.list({ refresh: true });
      setLocalTeams(Array.isArray(list) ? list : []);
    } catch {
      setLocalTeams([]);
    } finally {
      setLocalTeamsLoading(false);
      setLocalTeamsFetched(true);
    }
  }, []);
  // Rename a local team: persist via localTeams.update then refresh the list.
  // Empty name falls back to 未命名 (mirrors local-teams.addTeam default).
  const renameLocalTeam = useCallback(async (id, name) => {
    if (!window.cicy?.localTeams?.update) return;
    try {
      await window.cicy.localTeams.update(id, { name: String(name || "").trim() || tr("localTeams.unnamed", "未命名") });
    } catch {}
    await fetchLocalTeams();
  }, [fetchLocalTeams]);
  useEffect(() => {
    let fastTimer;
    let slowTimer;
    let elapsed = 0;
    const FAST_MS = 3_000;
    const FAST_WINDOW_MS = 30_000;
    const SLOW_MS = 30_000;

    const tick = async () => {
      await fetchLocalTeams();
      elapsed += FAST_MS;
      if (elapsed < FAST_WINDOW_MS) {
        fastTimer = setTimeout(tick, FAST_MS);
      } else {
        slowTimer = setInterval(fetchLocalTeams, SLOW_MS);
      }
    };
    tick();
    return () => { clearTimeout(fastTimer); clearInterval(slowTimer); };
  }, [fetchLocalTeams]);

  // Webview relay — the Team Helper <webview> calls window.cicy.localTeams.add(...)
  // inside the webview, that hops main → here. We run the actual IPC, refresh
  // UI right away, and reply with the result so the webview's await resolves.
  useEffect(() => {
    if (!window.cicy?.localTeams?.onWebviewRelay) return;
    const unsub = window.cicy.localTeams.onWebviewRelay(async ({ reqId, msg }) => {
      let result = { ok: false, error: "unknown relay type" };
      try {
        if (msg?.type === "localTeams:add") {
          result = await window.cicy.localTeams.add(msg.spec || {});
        } else if (msg?.type === "localTeams:remove") {
          result = await window.cicy.localTeams.remove(msg.id);
        } else if (msg?.type === "localTeams:update") {
          result = await window.cicy.localTeams.update(msg.id, msg.patch || {});
        } else if (msg?.type === "localTeams:upgrade") {
          result = await window.cicy.localTeams.upgrade(msg.id);
        } else if (msg?.type === "localTeams:list") {
          result = { ok: true, teams: await window.cicy.localTeams.list({ refresh: true }) };
        }
        // (sidecar:install / sidecar:checkLatest removed — cicy-code is now
        // installed via `npx cicy-code` by the sidecar, no in-app downloader.)
        // Force-refresh the team list so the new/removed/upgraded card
        // shows up before the next 30 s poll.
        fetchLocalTeams();
      } catch (e) {
        result = { ok: false, error: e?.message || String(e) };
      }
      try { window.cicy.localTeams.replyWebviewRelay(reqId, result); } catch {}
    });
    return () => { try { unsub?.(); } catch {} };
  }, [fetchLocalTeams]);

  const openLocalTeam = useCallback(async (teamId) => {
    if (!window.cicy?.localTeams?.open) return;
    try { await window.cicy.localTeams.open(teamId); } catch {}
  }, []);

  // (USER_CONTEXT push retired — cicy-code 2.1.7's --helper mode fires the
  // open-protocol trigger server-side from watchHelperOpencodeReadyAndKick,
  // gated on BOTH opencode-ready AND a connected web-* chat client. That
  // eliminates the race we used to paper over with a 6 s renderer-side
  // timeout, and stops the "刷屏" double-greet whenever the webview's
  // did-finish-load fired more than once per session. Language detection now
  // happens INSIDE the agent via `agent-webpage exec-js navigator.language`
  // against the same client — see AGENTS.md.)

  // Restore login from the main-process durable store when THIS origin's
  // localStorage has none. The homepage origin drifts (file:// / the team
  // domain / an IP:port), and localStorage is origin-scoped, so without this a
  // token saved under a previous origin would force a needless re-login. Main
  // persists the login origin-independently (global.json); we adopt it here so
  // "logged in once" stays valid until an explicit logout.
  useEffect(() => {
    if (safeGet(TOKEN_KEY)) { setAuthRestoring(false); return; }
    if (!window.cicy?.auth?.getSaved) { setAuthRestoring(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const saved = await window.cicy.auth.getSaved();
        if (cancelled) return;
        if (saved?.token) {
          try { localStorage.setItem(TOKEN_KEY, saved.token); } catch {}
          setToken(saved.token);
          if (saved.accessToken) {
            try { localStorage.setItem(ACCESS_TOKEN_KEY, saved.accessToken); } catch {}
            setAccessToken(saved.accessToken);
          }
          if (saved.userId) {
            try { localStorage.setItem(USER_ID_KEY, String(saved.userId)); } catch {}
            setUserId(String(saved.userId));
          }
        }
      } catch {}
      finally { if (!cancelled) setAuthRestoring(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  // auth:complete from main.
  useEffect(() => {
    if (!window.cicy?.auth?.onComplete) return;
    return window.cicy.auth.onComplete((payload) => {
      setLoggingIn(false);
      if (payload?.error) {
        setError(humanError(payload.error));
        return;
      }
      if (payload?.token) {
        try { localStorage.setItem(TOKEN_KEY, payload.token); } catch {}
        setToken(payload.token);
        if (payload.accessToken) {
          try { localStorage.setItem(ACCESS_TOKEN_KEY, payload.accessToken); } catch {}
          setAccessToken(payload.accessToken);
        }
        if (payload.userId) {
          try { localStorage.setItem(USER_ID_KEY, String(payload.userId)); } catch {}
          setUserId(String(payload.userId));
        }
        setError("");
        setWelcome(payload.reused ? "已恢复你之前的登录" : "登录成功");
        setTimeout(() => setWelcome(""), 3000);
      }
    });
  }, []);

  async function handleLogin() {
    if (!window.cicy?.auth?.loginStart) {
      setError("auth bridge missing");
      return;
    }
    setError("");
    setLoggingIn(true);
    const r = await window.cicy.auth.loginStart();
    if (!r?.ok) {
      setLoggingIn(false);
      setError(humanError(r?.error || "login start failed"));
    }
  }

  function handleLogout() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(ACCESS_TOKEN_KEY);
      localStorage.removeItem(USER_ID_KEY);
    } catch {}
    // Clear the durable main-process store too — explicit logout is the ONLY
    // path that should invalidate the persisted login.
    try { window.cicy?.auth?.logout?.(); } catch {}
    setToken(null);
    setAccessToken(null);
    setUserId(null);
    setMe(null);
    setTeams(null);
    setError("");
    setProfileError("");
  }

  // First-run terms gate takes precedence over everything (even login) —
  // accepting the terms is a precondition to using the software at all.
  if (termsOk === undefined) {
    return (
      <div className="shell" data-id="TermsCheckingSplash">
        <div className="glow" aria-hidden />
        <div className="card"><Brand /><div className="spinner-row"><Spinner /></div></div>
      </div>
    );
  }
  if (!termsOk) {
    return <FirstRunTermsGate onAgree={() => setTermsOk(true)} />;
  }

  // Still checking the durable store — show a minimal splash, not the login
  // card, so we never flash "please log in" before restore completes.
  if (!token && authRestoring) {
    return (
      <div className="shell" data-id="AuthRestoringSplash">
        <div className="glow" aria-hidden />
        <div className="card">
          <Brand />
          <div className="spinner-row"><Spinner /><span>正在恢复登录…</span></div>
        </div>
      </div>
    );
  }

  // Not logged in yet → centered login card.
  if (!token) {
    return (
      <div className="shell">
        <div className="glow" aria-hidden />
        <div className="card">
          <Brand />
          {!loggingIn && (
            <>
              <p className="tagline">登录以同步你的团队、配置与 AI 助手</p>
              <button className="btn-primary" onClick={handleLogin}>
                <span>使用浏览器登录</span>
                <ArrowIcon />
              </button>
              <p className="hint">点击后会自动打开浏览器</p>
            </>
          )}
          {loggingIn && (
            <>
              <p className="tagline">已在浏览器打开登录页，等待你完成…</p>
              <div className="spinner-row">
                <Spinner />
                <span>等待回调</span>
              </div>
              <button className="btn-ghost" onClick={() => {
                window.cicy?.auth?.loginCancel?.();
                setLoggingIn(false);
              }}>取消</button>
            </>
          )}
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    );
  }

  // Logged in: unified tabs + cards grid on the left, full-height webview
  // drawer on the right.
  // Split the cicyDesktopNodes list into 本地 (the localhost:8008 sidecar the
  // desktop owns — full lifecycle) vs 自定义 (deeplink-added nodes, usually
  // remote — probe-only, no restart/stop/update, just 打开).
  const localList  = (localTeams || []).filter((t) => isLocalSidecar(t.base_url));
  const customList = (localTeams || []).filter((t) => !isLocalSidecar(t.base_url));
  const localCount = localList.length;
  const customCount = customList.length;
  const cloudCount = (teams || []).length;
  const showLocal = tab === "all" || tab === "local";
  const showCustom = tab === "all" || tab === "custom";
  const showCloud = tab === "all" || tab === "cloud";

  return (
    <div className="shell shell--app">
      <div className="glow glow--app" aria-hidden />
      <div className="shell__left">
      <Header me={me} welcome={welcome} onLogout={handleLogout} />
      <main className="main">
        <div className="app__tabs">
          {[
            { k: "all",    label: "全部",   n: localCount + customCount + cloudCount },
            { k: "local",  label: "本地",   n: localCount },
            { k: "cloud",  label: "云端",   n: cloudCount },
            { k: "custom", label: "自定义", n: customCount },
          ].map(({ k, label, n }) => (
            <button
              key={k}
              type="button"
              className={`app__tab ${tab === k ? "is-active" : ""}`}
              onClick={() => setTab(k)}
            >
              {label}
              <span className="app__tab-count">{n}</span>
            </button>
          ))}
        </div>

        {/* Docker 安装卡已下线 (主人令): Windows 走原生 cicy-code.exe --helper,不再用 Docker。 */}
        {showLocal && localList.length > 0 && <MitmConsentCard team={localList[0]} />}

        {profileError && (
          <div className="error" style={{ marginBottom: 12 }}>
            云端: {profileError}
            <button className="btn-ghost" style={{ marginLeft: 8 }} onClick={() => fetchProfile(accessToken, userId)}>
              重试
            </button>
          </div>
        )}

        <div className="app__grid">
          {showLocal && localList.map((t) => (
            <LocalTeamCard key={"local:" + t.id} team={t} onOpen={() => openLocalTeam(t.id)} onRename={renameLocalTeam} onRefresh={fetchLocalTeams} />
          ))}
          {showCustom && customList.map((t) => (
            <LocalTeamCard key={"custom:" + t.id} team={t} onOpen={() => openLocalTeam(t.id)} onRename={renameLocalTeam} onRefresh={fetchLocalTeams} />
          ))}
          {showCloud && teams && teams.map((t) => (
            <TeamCard
              key={"cloud:" + t.id}
              team={t}
              onOpen={() => {
                const url = t.workspace_url || t.workspace_direct_url;
                if (url) window.cicy?.shell?.openExternal?.(url);
              }}
            />
          ))}
          {showLocal && (
            <button type="button" className="add-card" onClick={() => {
              alert("装本地 cicy-code（npx cicy-code / docker run）后会自动出现，或在云端创建团队。");
            }}>
              <span className="add-card__plus">+</span>
              <span className="add-card__label">新建本地团队</span>
            </button>
          )}
        </div>

        {!profileLoading && !profileError && teams && teams.length === 0 && !localTeams?.length && (
          <div className="empty" style={{ marginTop: 14 }}>
            还没有团队 — 安装本地 cicy-code 起一个本地 team，或在云端创建。
          </div>
        )}
      </main>
      </div>{/* /.shell__left */}
      <ToastHost />
      <UpdateDrawerHost />
    </div>
  );
}

function Header({ me, welcome, onLogout }) {
  const name = me?.display_name || me?.username || "…";
  const initials = (name || "?").slice(0, 1).toUpperCase();
  return (
    <header className="topbar">
      <div className="brand-mini">
        <div className="brand-mark sm"><BrandGlyph /></div>
        <span className="brand-name">CiCy Desktop</span>
      </div>
      <div className="user-chip">
        {welcome && <span className="welcome">{welcome}</span>}
        <div className="avatar">{initials}</div>
        <span className="user-name">{name}</span>
        <button className="btn-ghost sm" onClick={onLogout}>退出</button>
      </div>
    </header>
  );
}

function Section({ title, subtitle, icon, children }) {
  return (
    <section className="section">
      <div className="section-head">
        {icon && <span className="section-icon">{icon}</span>}
        <h2>{title}</h2>
        {subtitle && <span className="section-sub">· {subtitle}</span>}
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

// Windows-only: when the local team needs Docker and it isn't ready, this card
// drives the one-click bootstrap (install Docker → load image → start container
// → wait health). Each step shows pending/running/skip/done/error + download %.
// Idempotent + resumable on the backend, so 重试 picks up where it left off.
const DOCKER_STEPS = [
  { key: "install-docker", label: "安装 Docker" },
  { key: "image",          label: "拉取基础镜像" },
  { key: "container",      label: "启动 cicy-code" },
  { key: "health",         label: "本地团队就绪" },
];

// 首启门控:整体条款的第一道同意。未同意不进主界面;读到底部才解锁"同意"。
// 与 MitmConsentCard(HTTPS 审计第二道同意)完全独立 —— 同意条款 ≠ 开启审计。
function FirstRunTermsGate({ onAgree }) {
  const [scrolledEnd, setScrolledEnd] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const locale = (window.cicyI18n?.locale || "en").startsWith("zh") ? "zh-CN" : "en";
  const t = (k, fb) => tr(`firstRunTerms.${k}`, fb);
  const summaries = [1, 2, 3, 4, 5, 6].map((i) => t(`summary${i}`, ""));

  const onScroll = (e) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) setScrolledEnd(true);
  };
  // Short content that never scrolls → unlock immediately.
  const bodyRef = useRef(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 24) setScrolledEnd(true);
  }, [showFull]);

  const agree = async () => {
    if (busy || !scrolledEnd) return;
    setBusy(true);
    try { await window.cicy?.terms?.agree?.(TERMS_VERSION); onAgree?.(); }
    catch { onAgree?.(); } // never trap the user; main also persists
  };
  const decline = () => { try { window.cicy?.terms?.decline?.(); } catch {} };

  return (
    <div className="shell terms-gate" data-id="FirstRunTermsGate">
      <div className="glow" aria-hidden />
      <div className="terms-gate__panel">
        <h1 className="terms-gate__title" data-id="FirstRunTermsGate-title">{t("title", "用户协议与授权说明")}</h1>
        <p className="terms-gate__subtitle">{t("subtitle", "使用 CiCy Desktop 前,请阅读并同意以下条款")}</p>

        <div className="terms-gate__body" ref={bodyRef} onScroll={onScroll} data-id="FirstRunTermsGate-body">
          <h2 className="terms-gate__h2">{t("summaryTitle", "一眼看懂")}</h2>
          <ol className="terms-gate__summary">
            {summaries.filter(Boolean).map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          {!showFull ? (
            <button className="terms-gate__viewfull" data-id="FirstRunTermsGate-viewfull"
              onClick={() => setShowFull(true)}>{t("viewFull", "查看完整条款")}</button>
          ) : (
            <pre className="terms-gate__fulltext" data-id="FirstRunTermsGate-fulltext">{TERMS_FULL[locale] || TERMS_FULL.en}</pre>
          )}
        </div>

        {!scrolledEnd && <div className="terms-gate__scrollhint" data-id="FirstRunTermsGate-scrollhint">{t("scrollHint", "请阅读至底部以继续")}</div>}
        <div className="terms-gate__actions">
          <button data-id="FirstRunTermsGate-decline" className="terms-gate__btn terms-gate__btn--ghost" onClick={decline}>
            {t("decline", "不同意并退出")}
          </button>
          <button data-id="FirstRunTermsGate-agree" className="terms-gate__btn" disabled={!scrolledEnd || busy}
            title={!scrolledEnd ? t("mustAgree", "未同意则无法使用本软件。") : ""} onClick={agree}>
            {t("agree", "同意并继续")}
          </button>
        </div>
      </div>
    </div>
  );
}

// HTTPS 审计 CA 授权卡片 (合规 opt-in)。绝不首启静默装根证书 (Superfish 红线) —
// 用户在此显式同意后,才由 cicy-code 写入系统根信任库。三态:未授权 / 已授权(可撤销) /
// 处理中。同意走 POST /api/mitm/consent;need_elevation 回退 exec 自提权 install-ca。
function MitmConsentCard({ team }) {
  const [status, setStatus] = useState(undefined); // undefined=loading, null=endpoint absent, {generated,trusted,consent}
  const [busy, setBusy] = useState("");            // "" | enable | disable
  const [error, setError] = useState("");

  const base = (team?.base_url || "").replace(/\/$/, "");
  const token = team?.api_token || "";

  const caFetch = useCallback(async (path, opts = {}) => {
    if (!window.cicy?.cloud?.fetch) throw new Error("bridge missing");
    const r = await window.cicy.cloud.fetch(`${base}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    let json = null; try { json = JSON.parse(r.body); } catch {}
    return { ok: r.ok, status: r.status, json };
  }, [base, token]);

  const refresh = useCallback(async () => {
    try {
      const r = await caFetch("/api/mitm/ca-status");
      // 404 / not-ok → endpoint not present (older cicy-code) → hide card.
      setStatus(r.ok && r.json ? r.json : null);
    } catch { setStatus(null); }
  }, [caFetch]);
  useEffect(() => { if (base && token) refresh(); }, [base, token, refresh]);

  // Hide until we know the CA exists. No CA generated (MITM off) → nothing to consent to.
  if (status === undefined) return null;          // still loading
  if (!status || !status.generated) return null;  // endpoint absent or no CA

  const enable = async () => {
    if (busy) return;
    setBusy("enable"); setError("");
    try {
      const r = await caFetch("/api/mitm/consent", { method: "POST", body: JSON.stringify({ enable: true }) });
      // Any "I lack privilege to write the trust store" answer → elevate. Older
      // daemons (esp. macOS) return the raw keychain error instead of the tidy
      // "need_elevation" code, so match those too rather than dumping a scary
      // "security add-trusted-cert: Write permissions error" on the user.
      const elevText = `${r.json?.error || ""} ${r.json?.detail || ""}`;
      const needsElevation = r.json?.error === "need_elevation"
        || (!r.ok && r.status === 403)
        || /need_elevation|add-trusted-cert|write permission|SecCertificate|not permitted|requires admin|administrator/i.test(elevText);
      if (r.ok && r.json?.ok && r.json?.trusted) { await refresh(); }
      else if (needsElevation) {
        // fall back to the self-elevating CLI (OS prompt = the second consent)
        const ex = await window.cicy?.mitm?.caExec?.("install");
        if (ex?.ok) await refresh();
        else setError(/cancel/i.test(ex?.stderr || "") ? tr("mitmConsent.errorAdminDenied", "未获得管理员授权,已取消。") : (ex?.stderr || tr("mitmConsent.errorTitle", "提权失败,请从管理员控制台运行")));
      } else {
        setError(r.json?.error || `失败 (HTTP ${r.status})`);
      }
    } catch (e) { setError(String(e?.message || e)); }
    finally { setBusy(""); }
  };

  const disable = async () => {
    if (busy) return;
    setBusy("disable"); setError("");
    try {
      const r = await caFetch("/api/mitm/consent", { method: "POST", body: JSON.stringify({ enable: false }) });
      if (r.ok && r.json?.ok) await refresh();
      else {
        const ex = await window.cicy?.mitm?.caExec?.("uninstall");
        if (ex?.ok) await refresh(); else setError(ex?.stderr || r.json?.error || "撤销失败");
      }
    } catch (e) { setError(String(e?.message || e)); }
    finally { setBusy(""); }
  };

  const granted = status.consent && status.trusted;
  const partial = status.consent && !status.trusted; // consented but not (re)installed
  const t = (k, fb) => tr(`mitmConsent.${k}`, fb);

  // 已启用是稳态状态,不是决策 — 收成一个低调的小 pill(一行 + "关闭"),把显眼的
  // 大卡片只留给首次"同意"那一下,不在首页常驻一个大块。
  if (granted || busy === "disable") {
    // Portal to <body> so the fixed pill sits in the ROOT stacking context and
    // paints above the topbar (otherwise it's trapped in the content stack and the
    // 顶栏 user chip covers it).
    return createPortal(
      <div data-id="MitmConsentCard" className="mitm-pill" title={t("grantedDesc", "HTTPS 审计已开启,仅对 CiCy 启动的 AI 工具生效;随时可关闭。")}>
        <span className="mitm-pill__dot" data-busy={busy ? "1" : "0"} />
        <span className="mitm-pill__text" data-id="MitmConsentCard-title">
          {busy === "disable" ? t("processingRevoke", "正在关闭…") : t("statePillOn", "HTTPS 审计已开启")}
        </span>
        {!busy && (
          <button type="button" data-id="MitmConsentCard-revoke" className="mitm-pill__off"
            onClick={() => { if (window.confirm(t("revokeConfirm", "撤销后将停止解密审计并清除同意标记。确定?"))) disable(); }}>
            {t("turnOff", "关闭")}
          </button>
        )}
      </div>,
      document.body
    );
  }

  return (
    <div data-id="MitmConsentCard" className={`mitm-card${granted ? " mitm-card--on" : ""}`}>
      <div className="mitm-card__head">
        <span className="mitm-card__dot" data-state={granted ? "on" : partial ? "warn" : "off"} />
        <span className="mitm-card__title" data-id="MitmConsentCard-title">
          {busy ? t("stateProcessingTitle", "处理中…")
            : granted ? t("stateGrantedTitle", "已启用")
            : `${t("cardTitle", "HTTPS 流量本地审计")}${partial ? " — " + t("retry", "重试") : ""}`}
        </span>
      </div>
      <p className="mitm-card__desc" data-id="MitmConsentCard-desc">
        {granted ? t("grantedDesc", "HTTPS 审计已开启,仅对 CiCy 启动的 AI 工具(claude / codex 等)生效;随时可关闭。") : t("body", "启用后,CiCy 启动的 AI 工具(claude / codex 等)访问 AI 厂商(Claude / OpenAI / DeepSeek / Gemini)的 HTTPS 流量将被本地审计解密,数据留本地,随时可关闭。")}
        {!granted && <>
          <br /><span className="mitm-card__note">{t("adminNote", "通过环境变量对 CiCy 启动的 AI 工具生效,不修改系统、无需管理员授权。")}</span>
          <br /><span className="mitm-card__sub">{t("scopeNote", "仅解密上述 AI 厂商域名,其余一切流量不被解密、不被读取。")}</span>
        </>}
      </p>
      {error && <div className="mitm-card__error" data-id="MitmConsentCard-error">{t("errorTitle", "操作失败")}: {error}</div>}
      <div className="mitm-card__actions">
        {granted ? (
          <button data-id="MitmConsentCard-revoke" className="mitm-card__btn mitm-card__btn--ghost"
            disabled={!!busy} onClick={() => { if (window.confirm(t("revokeConfirm", "撤销后将停止解密审计并清除同意标记。确定?"))) disable(); }}>
            {busy === "disable" ? t("processingRevoke", "正在关闭…") : t("revoke", "撤销")}
          </button>
        ) : (
          <button data-id="MitmConsentCard-enable" className="mitm-card__btn"
            disabled={!!busy} onClick={enable}>
            {busy === "enable" ? t("processingEnable", "正在启用…") : partial ? t("retry", "重试") : t("enable", "同意并启用")}
          </button>
        )}
      </div>
    </div>
  );
}

function DockerSetup({ onReady }) {
  const [status, setStatus] = useState(null);  // {platform, installed, imagePresent, running}
  const [phases, setPhases] = useState({});    // key -> { status, message, progress }
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.cicy?.docker?.status) return;
    try { setStatus(await window.cicy.docker.status()); } catch {}
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // Only relevant on Windows while the local daemon isn't up yet.
  if (!status || status.platform !== "win32" || status.running) return null;

  const run = async () => {
    if (busy) return;
    setBusy(true);
    const unsub = window.cicy.docker.onProgress((ev) => {
      if (ev && ev.phase) setPhases((p) => ({ ...p, [ev.phase]: ev }));
    });
    try {
      const r = await window.cicy.docker.bootstrap();
      if (r?.ok) onReady?.();
    } catch {}
    finally { try { unsub?.(); } catch {} setBusy(false); refresh(); }
  };

  const started = Object.keys(phases).length > 0;

  return (
    <div data-id="DockerSetup" className="docker-setup">
      <div className="docker-setup__head">
        <span className="docker-setup__title">本机团队需要 Docker</span>
        <span className="docker-setup__sub">
          Windows 上 cicy-code 跑在 Docker(Linux 容器)里。一键装好并启动,或先用云端/已添加的团队。
        </span>
      </div>
      <div className="docker-setup__steps">
        {DOCKER_STEPS.map(({ key, label }) => {
          const ph = phases[key];
          const st = ph?.status || "pending";
          return (
            <div key={key} data-id={`DockerSetup-step-${key}`} className={`docker-step is-${st}`}>
              <span className="docker-step__dot" aria-hidden />
              <span className="docker-step__label">{label}</span>
              {ph?.message && <span className="docker-step__msg" title={ph.message}>{ph.message}</span>}
              {st === "running" && typeof ph?.progress === "number" && (
                <span className="docker-step__pct">{ph.progress}%</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="docker-setup__actions">
        <button type="button" data-id="DockerSetup-run" className="btn-primary" disabled={busy} onClick={run}>
          {busy ? tr("docker.working", "处理中…") : started ? tr("docker.retry", "重试") : tr("docker.run", "一键安装并启动")}
        </button>
        <button
          type="button"
          data-id="DockerSetup-manual"
          className="btn-ghost"
          onClick={() => window.cicy?.shell?.openExternal?.("https://www.docker.com/products/docker-desktop/")}
        >
          {tr("docker.manual", "手动装 Docker")}
        </button>
      </div>
    </div>
  );
}

function LocalTeamCard({ team, onOpen, onRename, onRefresh }) {
  const statusInfo = LOCAL_STATUS[team.status] || LOCAL_STATUS.error;
  const tone = statusInfo.tone;
  // Inline rename: double-click the name or click ✎ → edit → Enter/blur saves.
  // All local teams are renamable via window.cicy.localTeams.update(id,{name}).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(team.name || "");
  const startEdit = (e) => { e.stopPropagation(); setDraft(team.name || ""); setEditing(true); };
  const commit = async () => {
    setEditing(false);
    const next = String(draft || "").trim();
    if (onRename && next && next !== team.name) await onRename(team.id, next);
  };

  // Lifecycle (启动 / 重启 / 更新 / 停止) acts on the daemon the desktop OWNS —
  // localhost on the sidecar port (:8008). A remote node or a non-8008 port
  // can't be controlled from here (sidecar.* would hit the wrong, local :8008),
  // so those cards get 打开 only — no ⋯ menu, no update prompt. 打开 stays the
  // one primary action; maintenance lives in the ⋯ menu.
  const hasBridge = !!window.cicy?.sidecar?.restart;
  const local = hasBridge && isLocalSidecar(team.base_url);
  const running = team.status === "running";
  const [busy, setBusy] = useState("");   // "" | start | restart | update | stop
  const [menuOpen, setMenuOpen] = useState(false);
  const [latest, setLatest] = useState(null); // newest cicy-code on the registry
  const [checking, setChecking] = useState(false);
  const [upToDateMsg, setUpToDateMsg] = useState(""); // transient "已是最新 vX"
  const menuWrap = useRef(null);

  // Fetch the newest cicy-code from the registry and compare. Auto-runs once on
  // mount (passive — only surfaces 更新 when behind, no nagging when current).
  // The ⋯ menu's 检查更新 calls it with manual=true to echo "已是最新" when current.
  // Renderer-side via cloud.fetch — main proxies it, dodging CORS; no extra IPC.
  const checkUpdate = useCallback(async (manual = false) => {
    if (!local || !window.cicy?.cloud?.fetch) return;
    if (manual) { setChecking(true); setUpToDateMsg(""); }
    try {
      const r = await window.cicy.cloud.fetch("https://registry.npmmirror.com/cicy-code/latest");
      if (r?.ok) {
        const v = JSON.parse(r.body)?.version || null;
        setLatest(v);
        if (manual && v) {
          const behind = team.version && cmpVer(v, team.version) > 0;
          if (!behind) {
            setUpToDateMsg(`${tr("sidecar.upToDate", "已是最新")} v${team.version || v}`);
            setTimeout(() => setUpToDateMsg(""), 2500);
          }
        }
      }
    } catch { /* offline / registry hiccup — leave latest as-is */ }
    finally { if (manual) setChecking(false); }
  }, [local, team.version]);

  useEffect(() => { checkUpdate(false); }, [checkUpdate]);

  const updateAvailable = !!(local && latest && team.version && cmpVer(latest, team.version) > 0);
  // Custom (deeplink-added, non-local) nodes can be removed from the desktop —
  // it just drops them from cicyDesktopNodes; re-addable via deeplink. The
  // local sidecar isn't deletable here. So the ⋯ menu shows for a local card
  // with lifecycle, OR a custom card with just 删除.
  const isCustom = !local && !!window.cicy?.localTeams?.remove;
  // Local always gets the ⋯ menu (so 检查更新 is always reachable, even stopped);
  // custom gets it for 删除.
  const showMenu = local || isCustom;

  // Two-click delete guard, reset whenever the menu closes.
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e) => { if (menuWrap.current && !menuWrap.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  useEffect(() => { if (!menuOpen) setConfirmDel(false); }, [menuOpen]);

  const handleRemove = async () => {
    if (!confirmDel) { setConfirmDel(true); return; } // first click arms it
    setMenuOpen(false); setConfirmDel(false);
    if (busy) return;
    setBusy("remove");
    try { await window.cicy?.localTeams?.remove?.(team.id); } catch {}
    setBusy("");
    onRefresh?.();
  };

  // One toast per card-op, keyed by team — progress streams into it, the final
  // result replaces the message and auto-dismisses. Feedback floats over the UI
  // (toast), NOT inside the card; the card's only busy hint is the CTA spinner.
  const opToastId = `sidecar-op:${team.id}`;
  const runOp = async (kind, fn, doneText) => {
    setMenuOpen(false);
    if (busy) return;
    setBusy(kind);
    // 更新 gets its own drawer (live log + 阶段 + 重试); other ops use the toast.
    const isUpdate = kind === "update";
    let unsub = null;
    if (isUpdate) {
      updateDrawer.open({ teamId: team.id, fromVer: team.version, toVer: latest, onRetry: () => runOp("update", fn, doneText) });
      if (window.cicy?.sidecar?.onOpProgress) {
        unsub = window.cicy.sidecar.onOpProgress((ev) => { if (ev?.op === "update") updateDrawer.push(ev); });
      }
    } else {
      toast.show({ id: opToastId, message: BUSY_LABEL[kind] || `${kind}…`, status: "running", progress: undefined });
    }
    try {
      const r = await fn();
      const ok = !!r?.ok;
      const okMsg = r?.warning ? `${doneText}（${r.warning}）` : doneText;
      const errMsg = tr("sidecar.failed", "操作失败") + (r?.error ? `: ${r.error}` : "");
      if (isUpdate) {
        updateDrawer.finish({ ok, message: ok ? okMsg : errMsg });
      } else {
        toast.show({ id: opToastId, message: ok ? okMsg : errMsg, progress: undefined, status: ok ? "done" : "error", ttl: ok ? 4000 : 8000 });
      }
    } catch (err) {
      const m = tr("sidecar.failed", "操作失败") + `: ${err?.message || err}`;
      if (isUpdate) updateDrawer.finish({ ok: false, message: m });
      else toast.show({ id: opToastId, message: m, progress: undefined, status: "error", ttl: 8000 });
    } finally {
      try { unsub && unsub(); } catch {}
      setBusy("");
      onRefresh?.(); // re-probe so the status dot/chip catches up
    }
  };
  const BUSY_LABEL = { start: "启动中…", restart: "重启中…", update: "更新中…", stop: "停止中…" };

  // 打开 is NEVER gated on /api/health — openTeam() in main doesn't check it,
  // it just opens the window. health is an indicator, not a gate. When the
  // LOCAL daemon is down we start it first; remote/other-port teams just open
  // and let the loaded page show its own connecting/login/error UI.
  const handleOpen = async () => {
    if (busy) return;
    if (!running && local && window.cicy?.sidecar?.start) {
      setBusy("start");
      toast.show({ id: opToastId, message: BUSY_LABEL.start, status: "running", progress: undefined });
      const r = await window.cicy.sidecar.start().catch((e) => ({ ok: false, error: e?.message || String(e) }));
      setBusy(""); onRefresh?.();
      if (!r?.ok || r?.warning) { // didn't come up — surface it, don't open a dead link
        toast.show({ id: opToastId, message: tr("sidecar.startFailed", "启动失败") + (r?.error ? `: ${r.error}` : r?.warning ? `: ${r.warning}` : ""), status: "error", ttl: 8000 });
        return;
      }
      toast.dismiss(opToastId); // came up — no lingering toast, the window opens
    }
    onOpen(); // open regardless of health — the window/page handles the rest
  };
  const openLabel = running
    ? tr("localTeams.open", "打开")
    : local
      ? tr("localTeams.startOpen", "启动并打开") // only the local sidecar can be started from here
      : tr("localTeams.open", "打开");           // custom/remote: 探活-only, just open
  return (
    <div data-id="LocalTeamCard" className={`bcard ${local ? "bcard--local" : "bcard--custom"}${tone === "ok" ? " bcard--online" : ""}`}>
      <div className="bcard__accent" />
      <div className="bcard__top">
        <div className="bcard__pill">
          <span className="bcard__dot" data-tone={tone} />
          <LaptopIcon />
        </div>
        {showMenu && (
          <div className="bcard__menuwrap" ref={menuWrap} onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              data-id="LocalTeamCard-menu-btn"
              className={`bcard__kebab${updateAvailable ? " has-dot" : ""}`}
              title={local ? tr("localTeams.manage", "管理本地 cicy-code") : tr("localTeams.more", "更多")}
              disabled={!!busy}
              onClick={() => setMenuOpen((v) => !v)}
            >
              {busy ? <Spinner /> : <KebabIcon />}
            </button>
            {menuOpen && (
              <div className="bcard__menu" data-id="LocalTeamCard-menu" role="menu">
                {updateAvailable && (
                  <button
                    type="button"
                    data-id="LocalTeamCard-update"
                    className="bcard__menu-item is-accent"
                    onClick={() => runOp("update", () => window.cicy.sidecar.update(), tr("sidecar.updated", "已更新到最新"))}
                  >
                    {tr("sidecar.updateTo", "更新到")} v{latest}
                  </button>
                )}
                {local && running && (
                  <>
                    <button
                      type="button"
                      data-id="LocalTeamCard-reload"
                      className="bcard__menu-item"
                      onClick={() => runOp("reload", async () => {
                        const r = await window.cicy.localTeams.reload(team.id);
                        // not open yet → open it (still a "refresh" of the team)
                        return (!r?.ok && r?.error === "no_open_window") ? window.cicy.localTeams.open(team.id) : r;
                      }, tr("localTeams.reloaded", "已刷新窗口"))}
                    >
                      {tr("localTeams.reloadWindow", "刷新窗口")}
                    </button>
                    <button
                      type="button"
                      data-id="LocalTeamCard-restart"
                      className="bcard__menu-item"
                      onClick={() => runOp("restart", () => window.cicy.sidecar.restart(), tr("sidecar.restarted", "已重启"))}
                    >
                      {tr("sidecar.restart", "重启")}
                    </button>
                    <button
                      type="button"
                      data-id="LocalTeamCard-stop"
                      className="bcard__menu-item is-danger"
                      onClick={() => runOp("stop", () => window.cicy.sidecar.stop(), tr("sidecar.stoppedDone", "已停止"))}
                    >
                      {tr("sidecar.stop", "停止")}
                    </button>
                  </>
                )}
                {local && (
                  <button
                    type="button"
                    data-id="LocalTeamCard-check-update"
                    className="bcard__menu-item"
                    disabled={checking}
                    onClick={(e) => { e.stopPropagation(); checkUpdate(true); }}
                  >
                    {checking
                      ? tr("sidecar.checking2", "检查中…")
                      : (upToDateMsg || tr("sidecar.checkUpdate", "检查更新"))}
                  </button>
                )}
                {isCustom && (
                  <button
                    type="button"
                    data-id="LocalTeamCard-remove"
                    className="bcard__menu-item is-danger"
                    onClick={handleRemove}
                  >
                    {confirmDel ? tr("localTeams.removeConfirm", "确认删除？") : tr("localTeams.remove", "删除")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="bcard__body">
        {editing ? (
          <input
            data-id="LocalTeamCard-rename-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") setEditing(false); }}
            style={{ width: "100%", font: "inherit", fontWeight: 600, padding: "2px 6px", border: "1px solid #3b82f6", borderRadius: 6, background: "#0d1117", color: "#e6edf3", boxSizing: "border-box" }}
          />
        ) : (
          <h3 className="bcard__name" title={tr("localTeams.renameHint", "双击或点 ✎ 改名")} style={{ display: "flex", alignItems: "center", gap: 6 }} onDoubleClick={startEdit}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{team.name}</span>
            <button
              type="button"
              data-id="LocalTeamCard-rename-btn"
              title={tr("localTeams.rename", "重命名")}
              onClick={startEdit}
              style={{ flex: "none", cursor: "pointer", border: "none", background: "transparent", color: "#8b949e", fontSize: 13, padding: 0, lineHeight: 1 }}
            >✎</button>
          </h3>
        )}
        <div className="bcard__host">
          {team.base_url || "—"}
        </div>
        <div className="bcard__meta">
          {team.version && (
            <span className="bcard__ver" data-id="LocalTeamCard-version">v{team.version}</span>
          )}
        </div>
      </div>
      <button
        type="button"
        className="bcard__cta"
        data-id="LocalTeamCard-open"
        disabled={!!busy || !team.base_url}
        onClick={handleOpen}
      >
        {busy && busy !== "stop" ? <Spinner /> : <ArrowIcon />}
        <span>{busy ? (BUSY_LABEL[busy] || openLabel) : openLabel}</span>
      </button>
    </div>
  );
}

// True only for the daemon the desktop actually owns — localhost on the
// sidecar port (8008). Remote nodes / other ports can't be started from here.
function isLocalSidecar(baseUrl) {
  try {
    const p = new URL(baseUrl);
    const local = p.hostname === "127.0.0.1" || p.hostname === "localhost" || p.hostname === "::1";
    return local && (p.port === "8008" || p.port === "");
  } catch { return false; }
}

// Compare dotted versions: >0 if a newer than b, <0 older, 0 equal.
function cmpVer(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const LOCAL_STATUS = {
  running:       { tone: "ok",   label: "running",    cta: "打开" },
  stopped:       { tone: "off",  label: "stopped",    cta: "未运行" },
  auth_error:    { tone: "warn", label: "auth error", cta: "Token 失效" },
  misconfigured: { tone: "err",  label: "bad config", cta: "URL 错误" },
  error:         { tone: "err",  label: "error",      cta: "异常" },
};

function TeamCard({ team, onOpen }) {
  const kindLabel = team.team_kind === "personal" ? "个人" : "共享";
  const statusOk = team.status === "active";
  const hasUrl = !!(team.workspace_url || team.workspace_direct_url);
  return (
    <div className={`bcard bcard--cloud${statusOk ? " bcard--online" : ""}`}>
      <div className="bcard__accent" />
      <div className="bcard__top">
        <div className="bcard__pill">
          <span className="bcard__dot" data-tone={statusOk ? "ok" : "off"} />
          <GlobeIcon />
        </div>
        {team.is_trial && <span className="bcard__badge">trial</span>}
      </div>
      <div className="bcard__body">
        <h3 className="bcard__name" title={team.title}>{team.title}</h3>
        <div className="bcard__host">
          {team.runtime_region || team.region || "—"}
        </div>
        <div className="bcard__meta">
          <span className="bcard__chip">{kindLabel}</span>
          {team.membership_status && team.membership_status !== "active" && (
            <span className="bcard__chip">{team.membership_status}</span>
          )}
        </div>
      </div>
      <button
        type="button"
        className="bcard__cta"
        onClick={onOpen}
        disabled={!hasUrl}
      >
        <ArrowIcon />
        <span>{hasUrl ? "打开" : "无 URL"}</span>
      </button>
    </div>
  );
}

function Loading({ text }) {
  return (
    <div className="spinner-row" style={{ padding: "12px 0" }}>
      <Spinner /><span>{text}</span>
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark"><BrandGlyph /></div>
      <div className="brand-text">
        <div className="brand-name">CiCy Desktop</div>
        <div className="brand-sub">团队 AI 协作工作台</div>
      </div>
    </div>
  );
}

function BrandGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3.5-7.1" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}
function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}
function Spinner() {
  return (
    <svg className="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M21 12a9 9 0 1 1-6.2-8.55" />
    </svg>
  );
}
function LaptopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <line x1="2" y1="20" x2="22" y2="20" />
    </svg>
  );
}
function KebabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="12" cy="5" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
    </svg>
  );
}
function GlobeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function safeGet(k) {
  try { return localStorage.getItem(k) || null; } catch { return null; }
}

function humanError(s) {
  if (!s) return "";
  if (/timeout/i.test(s))         return "登录超时，请重新点击 Login。";
  if (/state/i.test(s))           return "校验失败，请重新登录。";
  if (/no token/i.test(s))        return "登录未完成，请重试。";
  if (/bridge missing/i.test(s))  return "无法连接到登录服务（preload 未就绪）。";
  return s;
}

