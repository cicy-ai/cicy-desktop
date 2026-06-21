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

// Open a cloud dash page with a CLEAN URL — no token of any kind in the address
// (主人: 钱包/账单/团队账单 URL 不要带 token,连一次性票据 ?t 也不要). The dash
// authenticates via the browser's own cicy-ai.com session; if not logged in it
// bounces through /login and returns. `query` is the part after /dash,
// e.g. "?view=wallet" or "?team=14".
async function openCloudPage(query) {
  try { window.cicy?.shell?.openExternal?.(`${CLOUD_BASE}/dash${query}`); } catch {}
}

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
  minimize() { if (drawerState) { drawerState = { ...drawerState, minimized: true }; emitDrawer(); } },
  restore() { if (drawerState) { drawerState = { ...drawerState, minimized: false }; emitDrawer(); } },
  finish({ ok, message } = {}) {
    if (!drawerState) return;
    const status = ok ? "done" : "error";
    const line = { id: ++drawerLogSeq, t: clockHHMMSS(), phase: "done", status, message: message || (ok ? "更新完成" : "更新失败") };
    drawerState = { ...drawerState, status, phase: "done", minimized: false, logs: [...drawerState.logs, line], lastAt: Date.now() };
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
  if (st.minimized) {
    return (
      <button type="button" className={`drawer-min drawer-min--${st.status}`} data-id="UpdateDrawer-restore" onClick={() => updateDrawer.restore()}>
        <span className="drawer-min__spark">{running ? <Spinner /> : st.status === "done" ? "✓" : st.status === "reboot" ? "⟳" : "!"}</span>
        <span className="drawer-min__label">更新 cicy-code{st.toVer ? ` · v${st.toVer}` : ""}</span>
      </button>
    );
  }
  return (
    <div className="drawer-scrim" data-id="UpdateDrawer-scrim" onClick={() => running ? updateDrawer.minimize() : updateDrawer.close()}>
      <div className="drawer" data-id="UpdateDrawer" data-status={st.status} onClick={(e) => e.stopPropagation()}>
        <div className="drawer__head">
          <div className="drawer__title">
            <span className={`drawer__spark drawer__spark--${st.status}`}>
              {running ? <Spinner /> : st.status === "done" ? "✓" : st.status === "reboot" ? "⟳" : "!"}
            </span>
            <div>
              <div className="drawer__h">更新 cicy-code</div>
              <div className="drawer__sub">{st.fromVer ? `v${st.fromVer}` : "当前"} → {st.toVer ? `v${st.toVer}` : "最新版"}</div>
            </div>
          </div>
          <div className="drawer__headbtns">
            <button type="button" className="drawer__x" data-id="UpdateDrawer-min" title="最小化" onClick={() => updateDrawer.minimize()} aria-label="minimize">‒</button>
          </div>
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

  // Tag <html> with the platform + fullscreen state so CSS can reserve the
  // macOS hiddenInset traffic-light gutter (the topbar's padding-left:84px rule
  // is gated on [data-platform="darwin"][data-fullscreen="0"]). Without this the
  // red/yellow/green buttons overlap the brand — the reported misalignment.
  useEffect(() => {
    const root = document.documentElement;
    try { root.setAttribute("data-platform", window.cicy?.platform || "linux"); } catch {}
    root.setAttribute("data-fullscreen", "0");
    let off;
    try {
      off = window.cicy?.window?.onFullscreen?.((fs) => root.setAttribute("data-fullscreen", fs ? "1" : "0"));
    } catch {}
    return () => { try { off && off(); } catch {} };
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
  // Guards the auto re-login so a dead session (/api/teams 401) triggers the
  // magic-link flow ONCE instead of looping. Reset when a fresh login lands.
  const reauthing = useRef(false);
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
    // Cloud uses its own per-user session token (sk-sess-, from /cb) as the
    // SOLE Bearer for every console call. No New-Api-User header and no
    // access_token — those were the old new-api convention, dropped when owner
    // moved cloud to self-built identity (authM resolves owner from the session).
    const headers = { Authorization: `Bearer ${at}` };
    try {
      const [selfRes, teamsRes] = await Promise.all([
        window.cicy.cloud.fetch(`${CLOUD_BASE}/api/user/self`, { headers }),
        window.cicy.cloud.fetch(`${CLOUD_BASE}/api/teams`,     { headers }),
      ]);
      // Session DEAD (cloud invalidated the sk-sess token) → /api/teams 401. The
      // "永久登录" red line forbids re-prompting on mere restart/expiry, but a
      // GENUINE 401 means the session is gone — the only recovery is a fresh
      // login. Trigger the magic-link ONCE (guarded) instead of retrying forever.
      if (teamsRes?.status === 401) {
        if (!reauthing.current && window.cicy?.auth?.loginStart) {
          reauthing.current = true;
          setProfileError("会话已过期,正在重新登录…");
          try { await window.cicy.auth.loginStart(); } catch {}
        }
        return;
      }
      // /api/teams drives the team grid — it is the ONLY critical call here.
      if (!teamsRes?.ok) throw new Error(`/api/teams ${teamsRes?.status || "?"} ${teamsRes?.error || ""}`);
      // /api/teams is bare: { teams: [...] }
      const teamsBody = JSON.parse(teamsRes.body || "{}");
      setTeams(Array.isArray(teamsBody?.teams) ? teamsBody.teams : []);
      // /api/user/self is best-effort: it only fills the profile display name.
      // A 404 / failure here must NOT block login or the team list (the cloud
      // endpoint can lag) — degrade to a null profile instead of throwing.
      // /api/user/self is wrapped: { success, message, data }
      if (selfRes?.ok) {
        try {
          const selfBody = JSON.parse(selfRes.body || "{}");
          setMe(selfBody?.success === false ? null : (selfBody?.data || null));
        } catch { setMe(null); }
      } else {
        setMe(null);
      }
    } catch (e) {
      setProfileError(e.message || String(e));
    } finally {
      setProfileLoading(false);
    }
  }, []);

  // 私有云/云端团队信息持续同步:/api/teams 原本只在登录/挂载拉一次,所以 dash 上改了
  // 私有云的 host_url / 名字 / 状态,桌面看不到。用 ref 持有当前 bearer,挂到对账循环里
  // 按窗口可见性周期重拉(轻量:只 setTeams,不动 loading/self,不在 401 时清空列表)。
  const bearerRef = useRef("");
  useEffect(() => { bearerRef.current = token || accessToken || ""; }, [token, accessToken]);
  const refreshCloudTeams = useCallback(async () => {
    const at = bearerRef.current;
    if (!at || !window.cicy?.cloud?.fetch) return;
    try {
      const r = await window.cicy.cloud.fetch(`${CLOUD_BASE}/api/teams`, { headers: { Authorization: `Bearer ${at}` } });
      if (r?.ok) { const b = JSON.parse(r.body || "{}"); if (Array.isArray(b?.teams)) setTeams(b.teams); }
    } catch {}
  }, []);

  // First profile fetch on mount. The cloud console endpoints (/api/user/self,
  // /api/teams) authenticate the owner-bound LOGIN token (the sk-xxx from the
  // /cb callback) — NOT the console access_token (the cloud never mints one;
  // sending it 401s). Prefer the login token; fall back to access_token only if
  // somehow that's all we have.
  useEffect(() => {
    const bearer = token || accessToken;
    if (bearer) fetchProfile(bearer, userId);
  }, [token, accessToken, userId, fetchProfile]);

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
    if (!window.cicy?.localTeams?.update) return { ok: false, error: "no_bridge" };
    let r;
    try {
      r = await window.cicy.localTeams.update(id, { name: String(name || "").trim() || tr("localTeams.unnamed", "未命名") });
    } catch (e) { r = { ok: false, error: e?.message || String(e) }; }
    await fetchLocalTeams();   // 对账:props 追上后清乐观名
    return r || { ok: false, error: "no_result" };
  }, [fetchLocalTeams]);
  // 自适应对账:窗口可见时 ~3s 拉一次云端 title(远端/dash 改名秒级可见),隐藏时
  // 退避到 30s 只刷新本地(云端对账交给 main 进程 30s 兜底);切回可见/聚焦立即对账。
  useEffect(() => {
    let timer;
    let stopped = false;
    const VISIBLE_MS = 3_000;
    const HIDDEN_MS = 30_000;

    // 一发对账:本地 title 拉进 teams.json + 刷新本地列表 + 重拉云端团队(私有云
    // host_url/名字/状态的同步)。三件事并行。
    const reconcile = async () => {
      try { await window.cicy?.localTeams?.syncCloud?.(); } catch {}
      await Promise.all([fetchLocalTeams(), refreshCloudTeams()]);
    };

    const schedule = () => {
      if (stopped) return;
      const visible = document.visibilityState === "visible";
      timer = setTimeout(async () => {
        if (document.visibilityState === "visible") await reconcile();
        else await fetchLocalTeams();           // 隐藏:只刷新本地,不打云端
        schedule();
      }, visible ? VISIBLE_MS : HIDDEN_MS);
    };

    reconcile();        // 挂载即来一发
    schedule();

    // 切回可见/聚焦 → 立即对账(dash 改完名点回桌面秒同步)
    const onWake = () => { if (document.visibilityState === "visible") reconcile(); };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);

    return () => {
      stopped = true; clearTimeout(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [fetchLocalTeams, refreshCloudTeams]);

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
        // Fresh session landed — clear the dead-session re-auth guard + message
        // so a future 401 can re-trigger recovery.
        reauthing.current = false;
        setProfileError("");
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
  // The Docker-版 cicy-code on :8009 has its own dedicated <DockerCard> (right of
  // the local card), so pull it out of the generic node list — else it'd ALSO
  // render as a 自定义 card (the bootstrap registers it as a team for the
  // token-injected 打开/刷新 flow).
  const dockerTeam = (localTeams || []).find((t) => isDockerApp(t.base_url)) || null;
  // Split the cicyDesktopNodes list into 本地 (the localhost:8008 sidecar the
  // desktop owns — full lifecycle) vs 自定义 (deeplink-added nodes, usually
  // remote — probe-only, no restart/stop/update, just 打开).
  const localList  = (localTeams || []).filter((t) => isLocalSidecar(t.base_url));
  const customList = (localTeams || []).filter((t) => !isLocalSidecar(t.base_url) && !isDockerApp(t.base_url));
  const localCount = localList.length;
  const customCount = customList.length;
  // /api/teams returns ALL of this owner's teams — including kind=local ones
  // (this device's AND other devices'). On the desktop the 云端 tab must show
  // ONLY cloud teams; local teams come from the local store (localList) and
  // cross-device local aggregation belongs to the web dash, not here.
  const cloudList = (teams || []).filter((t) => !t.is_local && t.kind !== "local");
  const cloudCount = cloudList.length;
  const showLocal = tab === "all" || tab === "local";
  const showCustom = tab === "all" || tab === "custom";
  const showCloud = tab === "all" || tab === "cloud";

  return (
    <div className="shell shell--app">
      <div className="glow glow--app" aria-hidden />
      <div className="shell__left">
      <Header me={me} welcome={welcome} onLogout={handleLogout}
        mitmTeam={localList.length > 0 ? localList[0] : null} />
      <main className="main">
        {/* 整行:左边 tab 药丸,右边「新加团队」顶到行尾 */}
        <div className="app__tabsrow">
          <div className="app__tabs">
            {[
              { k: "all",    label: "全部",   n: localCount + customCount + cloudCount },
              { k: "local",  label: "本地",   n: localCount },
              { k: "cloud",  label: "私有云", n: cloudCount },
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
          {/* 行尾:新加团队 → 跳浏览器到云端 dash 私有云页 */}
          <button
            type="button"
            data-id="AddTeamButton"
            className="app__add-team"
            title={tr("teams.addHint", "在云端新建私有云团队")}
            onClick={() => openCloudPage("?tab=private")}
          >
            + {tr("teams.add", "新加团队")}
          </button>
        </div>

        {/* Docker 安装卡已下线 (主人令): Windows 走原生 cicy-code.exe --helper,不再用 Docker。 */}
        {/* HTTPS 审计 tip(MitmConsentCard)已移入右上角用户菜单(user-chip 下拉)。 */}

        {profileError && (
          <div className="error" style={{ marginBottom: 12 }}>
            云端: {profileError}
            <button className="btn-ghost" style={{ marginLeft: 8 }} onClick={() => fetchProfile(token || accessToken, userId)}>
              重试
            </button>
          </div>
        )}

        <div className="app__grid">
          {showLocal && localList.map((t) => (
            <LocalTeamCard key={"local:" + t.id} team={t} onOpen={() => openLocalTeam(t.id)} onRename={renameLocalTeam} onRefresh={fetchLocalTeams} />
          ))}
          {/* 占位卡 (主人: "本地团队没有占位"): a fresh install starts the sidecar
              and main auto-registers 本地团队 once :8008 answers — until that
              lands, hold its spot so the 本地 tab is never blank. The slow
              localTeams poll swaps this for the real card automatically. */}
          {showLocal && localList.length === 0 && (
            <div data-id="LocalTeamPlaceholder" className="bcard bcard--local">
              <div className="bcard__accent" />
              <div className="bcard__top">
                <div className="bcard__pill">
                  <span className="bcard__dot" data-tone="warn" />
                  <LaptopIcon />
                </div>
              </div>
              <div className="bcard__body">
                <h3 className="bcard__name">本地团队</h3>
                <div className="bcard__host">http://127.0.0.1:8008</div>
                <div className="bcard__meta" />
              </div>
              <button type="button" className="bcard__cta" disabled>
                <Spinner />
                <span>{localTeamsFetched ? "正在启动，就绪后自动加入…" : "检测中…"}</span>
              </button>
            </div>
          )}
          {showLocal && (
            <DockerCard
              dockerTeam={dockerTeam}
              onOpen={async () => {
                // Always open via the live-token path: re-reads the container's
                // own api_token and refuses to open a tokenless/host-token page
                // (主人: 必须拿到 token 才能打开,否则被卡在登录页).
                try {
                  const r = await window.cicy?.docker?.appOpen?.();
                  if (!r?.ok) window.alert("拿不到容器 token,无法打开 :8009。请确认服务已就绪(或用卡片菜单「重启」)后再试。");
                } catch (e) { console.warn("[DockerCard] open", e); }
              }}
              onRename={renameLocalTeam}
              onRefresh={fetchLocalTeams}
            />
          )}
          {showCustom && customList.map((t) => (
            <LocalTeamCard key={"custom:" + t.id} team={t} onOpen={() => openLocalTeam(t.id)} onRename={renameLocalTeam} onRefresh={fetchLocalTeams} />
          ))}
          {showCloud && cloudList.map((t) => (
            <TeamCard
              key={"cloud:" + t.id}
              team={t}
              onOpen={() => {
                // private:开 host_url(自托管地址);历史 cloud:开 workspace_url。
                // Open as a TAB in the current profile (like the local card), NOT
                // the system browser.
                const url = t.kind === "private" ? t.host_url : (t.workspace_url || t.workspace_direct_url);
                if (url) window.cicy?.tabs?.open?.(url, t.name || t.title || "");
              }}
            />
          ))}
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
      <DockerInstallDrawerHost />
    </div>
  );
}

// Chrome-style "site settings" for the trusted-origins allowlist: which sites may
// receive the electronRPC bridge in profile 0 (= run commands on this machine).
// Backed by window.cicy.trustedOrigins.{list,add,remove}; built-ins (localhost)
// are greyed + non-removable; the default list is just the built-ins. Inline
// styles keep it self-contained (no dependency on App.css classes).
function TrustedSitesModal({ onClose }) {
  const [rows, setRows] = useState(null);   // [{host, builtin}] | null(loading)
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const api = (typeof window !== "undefined" && window.cicy && window.cicy.trustedOrigins) || null;

  const load = useCallback(async () => {
    try { setRows((api && (await api.list())) || []); } catch { setRows([]); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const doAdd = async () => {
    const v = input.trim();
    if (!v || busy || !api) return;
    setBusy(true); setErr("");
    try {
      const r = await api.add(v);
      if (r && r.ok === false) setErr(r.error || tr("trustedSites.addFailed", "添加失败"));
      else { setInput(""); setRows((r && r.origins) || (await api.list())); }
    } catch (e) { setErr(String((e && e.message) || e)); }
    finally { setBusy(false); }
  };
  const doRemove = async (host) => {
    if (busy || !api) return;
    setBusy(true); setErr("");
    try {
      const r = await api.remove(host);
      if (r && r.ok === false) setErr(r.error || tr("trustedSites.removeFailed", "删除失败"));
      else setRows((r && r.origins) || (await api.list()));
    } catch (e) { setErr(String((e && e.message) || e)); }
    finally { setBusy(false); }
  };

  const S = {
    overlay: { position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.62)", backdropFilter: "blur(3px)" },
    card: { width: 560, maxWidth: "94vw", maxHeight: "82vh", display: "flex", flexDirection: "column", background: "#101012", border: "1px solid rgba(255,255,255,.09)", borderRadius: 16, boxShadow: "0 24px 64px rgba(0,0,0,.55)", overflow: "hidden", color: "#e4e4e7" },
    head: { display: "flex", alignItems: "center", gap: 8, padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,.06)" },
    title: { margin: 0, fontSize: 15, fontWeight: 600, flex: 1 },
    x: { background: "transparent", border: "none", color: "#a1a1aa", fontSize: 16, cursor: "pointer", lineHeight: 1, padding: 4 },
    warn: { margin: "14px 16px 0", padding: "10px 12px", fontSize: 12.5, lineHeight: 1.55, color: "#fca5a5", background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.25)", borderRadius: 10 },
    addRow: { display: "flex", gap: 8, padding: "12px 16px 4px" },
    input: { flex: 1, minWidth: 0, background: "#161618", border: "1px solid rgba(255,255,255,.1)", borderRadius: 9, padding: "9px 11px", color: "#e4e4e7", fontSize: 13, outline: "none" },
    addBtn: { background: "rgba(255,255,255,.1)", border: "none", borderRadius: 9, padding: "0 16px", color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer" },
    err: { margin: "6px 16px 0", fontSize: 12, color: "#fca5a5" },
    listWrap: { margin: "10px 16px 16px", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, overflow: "auto", flex: 1, minHeight: 80 },
    row: { display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderTop: "1px solid rgba(255,255,255,.05)" },
    host: (b) => ({ flex: 1, fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", fontSize: 13, color: b ? "#71717a" : "#e4e4e7", wordBreak: "break-all" }),
    tag: { fontSize: 11, color: "#71717a", background: "rgba(255,255,255,.05)", borderRadius: 6, padding: "2px 7px" },
    rm: { background: "transparent", border: "none", color: "#a1a1aa", fontSize: 12, cursor: "pointer", padding: "3px 6px", borderRadius: 6 },
    muted: { padding: "16px", textAlign: "center", color: "#71717a", fontSize: 12.5 },
  };

  return createPortal(
    <div style={S.overlay} onClick={onClose} data-id="TrustedSitesModal">
      <div style={S.card} onClick={(e) => e.stopPropagation()}>
        <div style={S.head}>
          <h2 style={S.title}>{tr("trustedSites.title", "受信任站点")}</h2>
          <button type="button" style={S.x} onClick={onClose} aria-label="close">✕</button>
        </div>
        <div style={S.warn}>
          {tr("trustedSites.warn", "⚠ 列表中的站点可以在你的电脑上执行命令(exec)。只添加你完全信任的地址。")}
        </div>
        <div style={S.addRow}>
          <input
            data-id="trusted-sites-input"
            style={S.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doAdd(); }}
            placeholder={tr("trustedSites.placeholder", "添加站点，如 app.cicy-ai.com 或 my-cloud.example.org")}
          />
          <button type="button" data-id="trusted-sites-add" style={{ ...S.addBtn, opacity: busy || !input.trim() ? 0.5 : 1 }} onClick={doAdd} disabled={busy || !input.trim()}>
            {tr("trustedSites.add", "添加")}
          </button>
        </div>
        {err && <div style={S.err}>{err}</div>}
        <div style={S.listWrap}>
          {rows === null ? (
            <div style={S.muted}>{tr("trustedSites.loading", "加载中…")}</div>
          ) : rows.length === 0 ? (
            <div style={S.muted}>{tr("trustedSites.empty", "暂无")}</div>
          ) : (
            rows.map((r) => (
              <div key={r.host} style={S.row} data-id="trusted-sites-row">
                <span style={S.host(r.builtin)}>{r.host}</span>
                {r.builtin ? (
                  <span style={S.tag}>{tr("trustedSites.builtin", "系统")}</span>
                ) : (
                  <button type="button" style={S.rm} onClick={() => doRemove(r.host)} disabled={busy}>
                    {tr("trustedSites.remove", "删除")}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Read-only viewer for the RPC audit log (~/cicy-ai/db/rpc-audit.log): every
// electronRPC call + every authorization decision (incl. temporary 本次允许 / 允许
// 一次) + allowlist edit. Backed by window.cicy.rpcAudit.tail(); newest-first,
// refreshable. Review-only — there is no mutation path.
function AuditLogModal({ onClose }) {
  const [entries, setEntries] = useState(null); // [] | null(loading)
  const [err, setErr] = useState("");
  const [logPath, setLogPath] = useState("");
  const [busy, setBusy] = useState(false);
  const api = (typeof window !== "undefined" && window.cicy && window.cicy.rpcAudit) || null;

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const r = api && (await api.tail(400));
      if (!r || r.ok === false) { setErr((r && r.error) || tr("audit.loadFailed", "读取失败")); setEntries([]); }
      else { setEntries(r.entries || []); setLogPath(r.path || ""); }
    } catch (e) { setErr(String((e && e.message) || e)); setEntries([]); }
    finally { setBusy(false); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const [filter, setFilter] = useState("all"); // all | rpc | auth
  const [query, setQuery] = useState("");

  const fmtTime = (ts) => { try { return new Date(ts).toLocaleString(); } catch { return ts || ""; } };
  const badge = (e) => {
    if (e.kind === "auth") {
      const deny = /deny/.test(e.decision || "");
      return { text: e.decision || "auth", color: deny ? "#fca5a5" : "#86efac", bg: deny ? "rgba(239,68,68,.14)" : "rgba(34,197,94,.14)" };
    }
    if (e.kind === "rpc") {
      const ok = e.ok !== false && !e.error;
      return { text: ok ? "ok" : "err", color: ok ? "#86efac" : "#fca5a5", bg: ok ? "rgba(34,197,94,.14)" : "rgba(239,68,68,.14)" };
    }
    return { text: e.kind || "log", color: "#a1a1aa", bg: "rgba(255,255,255,.06)" };
  };
  const opText = (e) => {
    if (e.kind === "auth") return `${e.gate || ""}${e.decision ? " · " + e.decision : ""}`;
    if (e.kind === "rpc") return `${e.tool || ""}${e.dangerous ? " ⚠" : ""}`;
    return e.kind || "";
  };
  const detailText = (e) => e.error || e.args || (e.kind === "rpc" ? e.channel : "") || "";

  const all = entries || [];
  const q = query.trim().toLowerCase();
  const view = all.filter((e) => {
    if (filter !== "all" && e.kind !== filter) return false;
    if (!q) return true;
    return [e.origin, e.host, e.tool, e.gate, e.decision, e.channel, e.args, e.error, e.kind]
      .filter(Boolean).join(" ").toLowerCase().includes(q);
  });

  const COLS = "186px 104px minmax(160px,1.1fr) minmax(150px,1.1fr) minmax(220px,1.8fr)";
  const S = {
    overlay: { position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.66)", backdropFilter: "blur(4px)" },
    card: { width: "96vw", height: "92vh", maxWidth: 1480, display: "flex", flexDirection: "column", background: "#0d0d0f", border: "1px solid rgba(255,255,255,.09)", borderRadius: 18, boxShadow: "0 32px 80px rgba(0,0,0,.6)", overflow: "hidden", color: "#e4e4e7" },
    head: { display: "flex", alignItems: "center", gap: 14, padding: "20px 24px", borderBottom: "1px solid rgba(255,255,255,.07)" },
    titleWrap: { flex: 1, minWidth: 0 },
    title: { margin: 0, fontSize: 21, fontWeight: 650, letterSpacing: .2 },
    subtitle: { margin: "3px 0 0", fontSize: 12.5, color: "#71717a", fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", wordBreak: "break-all" },
    count: { fontSize: 12.5, color: "#a1a1aa", whiteSpace: "nowrap" },
    refresh: { background: "rgba(255,255,255,.1)", border: "none", borderRadius: 9, padding: "9px 16px", color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer" },
    x: { background: "transparent", border: "none", color: "#a1a1aa", fontSize: 20, cursor: "pointer", lineHeight: 1, padding: 6 },
    toolbar: { display: "flex", alignItems: "center", gap: 10, padding: "14px 24px", borderBottom: "1px solid rgba(255,255,255,.05)" },
    chips: { display: "flex", gap: 6 },
    chip: (on) => ({ background: on ? "rgba(255,255,255,.14)" : "transparent", border: "1px solid rgba(255,255,255,.12)", borderRadius: 999, padding: "6px 16px", color: on ? "#fff" : "#a1a1aa", fontSize: 13, cursor: "pointer" }),
    search: { flex: 1, minWidth: 0, background: "#161618", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: "10px 14px", color: "#e4e4e7", fontSize: 13.5, outline: "none" },
    err: { margin: "10px 24px 0", fontSize: 12.5, color: "#fca5a5" },
    tableWrap: { flex: 1, overflow: "auto", margin: "0" },
    theadRow: { position: "sticky", top: 0, zIndex: 1, display: "grid", gridTemplateColumns: COLS, gap: 16, padding: "12px 24px", background: "#141417", borderBottom: "1px solid rgba(255,255,255,.08)", fontSize: 11.5, letterSpacing: .6, textTransform: "uppercase", color: "#71717a", fontWeight: 600 },
    row: { display: "grid", gridTemplateColumns: COLS, gap: 16, padding: "13px 24px", borderBottom: "1px solid rgba(255,255,255,.045)", alignItems: "center" },
    time: { fontSize: 12.5, color: "#a1a1aa", fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", whiteSpace: "nowrap" },
    badge: (b) => ({ justifySelf: "start", fontSize: 11.5, color: b.color, background: b.bg, borderRadius: 7, padding: "3px 10px", whiteSpace: "nowrap", fontWeight: 500 }),
    cell: { fontSize: 13, color: "#d4d4d8", fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", wordBreak: "break-all" },
    detail: { fontSize: 12.5, color: "#8b8b93", wordBreak: "break-all" },
    muted: { padding: "60px 24px", textAlign: "center", color: "#71717a", fontSize: 14 },
  };
  const Th = (t) => <div>{t}</div>;

  return createPortal(
    <div style={S.overlay} onClick={onClose} data-id="AuditLogModal">
      <div style={S.card} onClick={(e) => e.stopPropagation()}>
        <div style={S.head}>
          <div style={S.titleWrap}>
            <h2 style={S.title}>{tr("audit.title", "审计日志")}</h2>
            {logPath && <p style={S.subtitle}>{logPath}</p>}
          </div>
          <span style={S.count}>{tr("audit.count", "共")} {view.length}{filter !== "all" || q ? ` / ${all.length}` : ""}</span>
          <button type="button" data-id="audit-refresh" style={{ ...S.refresh, opacity: busy ? 0.5 : 1 }} onClick={load} disabled={busy}>
            {tr("audit.refresh", "刷新")}
          </button>
          <button type="button" style={S.x} onClick={onClose} aria-label="close">✕</button>
        </div>
        <div style={S.toolbar}>
          <div style={S.chips}>
            <button type="button" style={S.chip(filter === "all")} onClick={() => setFilter("all")}>{tr("audit.all", "全部")}</button>
            <button type="button" style={S.chip(filter === "rpc")} onClick={() => setFilter("rpc")}>{tr("audit.rpc", "RPC 调用")}</button>
            <button type="button" style={S.chip(filter === "auth")} onClick={() => setFilter("auth")}>{tr("audit.auth", "授权决定")}</button>
          </div>
          <input
            data-id="audit-search"
            style={S.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr("audit.search", "搜索来源 / 工具 / 命令…")}
          />
        </div>
        {err && <div style={S.err}>{err}</div>}
        <div style={S.tableWrap}>
          <div style={S.theadRow}>
            {Th(tr("audit.colTime", "时间"))}
            {Th(tr("audit.colType", "类型"))}
            {Th(tr("audit.colSource", "来源"))}
            {Th(tr("audit.colOp", "操作"))}
            {Th(tr("audit.colDetail", "详情"))}
          </div>
          {entries === null ? (
            <div style={S.muted}>{tr("audit.loading", "加载中…")}</div>
          ) : view.length === 0 ? (
            <div style={S.muted}>{all.length === 0 ? tr("audit.empty", "暂无审计记录") : tr("audit.noMatch", "无匹配记录")}</div>
          ) : (
            view.map((e, i) => {
              const b = badge(e);
              return (
                <div key={i} style={S.row} data-id="audit-row">
                  <span style={S.time}>{fmtTime(e.ts)}</span>
                  <span style={S.badge(b)}>{b.text}</span>
                  <span style={S.cell}>{e.origin || e.host || "—"}</span>
                  <span style={S.cell}>{opText(e) || "—"}</span>
                  <span style={S.detail}>{detailText(e) || "—"}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Header({ me, welcome, onLogout, mitmTeam }) {
  const name = me?.display_name || me?.username || "…";
  const initials = (name || "?").slice(0, 1).toUpperCase();
  const [open, setOpen] = useState(false);
  const [trustOpen, setTrustOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [appVer, setAppVer] = useState("");
  const wrap = useRef(null);
  // cicy-desktop's own version, shown at the very bottom of this menu (主人).
  // app.getVersion() returns { desktop, cicyCodeRef, electron, node } — pick the
  // desktop version string (was rendering as [object Object]).
  useEffect(() => {
    let alive = true;
    window.cicy?.app?.getVersion?.().then((v) => {
      if (!alive) return;
      setAppVer(typeof v === "string" ? v : String(v?.desktop || ""));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // Click-outside closes the dropdown (mirrors LocalTeamCard's ⋯ menu).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  // Cloud dash pages: query-param routed, opened via a one-time handoff ticket
  // (no long-term token in the URL — see openCloudPage).
  const goDash = (query) => { openCloudPage(query); setOpen(false); };
  return (
    <header className="topbar">
      <div className="brand-mini">
        <div className="brand-mark sm"><BrandGlyph /></div>
        <span className="brand-name">CiCy Desktop</span>
      </div>
      <div className="user-chip" data-id="UserChip" ref={wrap}>
        {welcome && <span className="welcome">{welcome}</span>}
        <button
          type="button"
          data-id="UserChip-trigger"
          className={`user-chip__trigger${open ? " is-open" : ""}`}
          onClick={() => setOpen((v) => !v)}
        >
          <div className="avatar">{initials}</div>
          <span className="user-name">{name}</span>
          <span className="user-chip__caret" aria-hidden>▾</span>
        </button>
        {open && (
          <div className="user-chip__menu" data-id="UserChip-menu" role="menu">
            <button type="button" data-id="UserChip-wallet" className="user-chip__menu-item" onClick={() => goDash("?view=wallet")}>
              我的钱包
            </button>
            <button type="button" data-id="UserChip-billing" className="user-chip__menu-item" onClick={() => goDash("?view=usage")}>
              我的账单
            </button>
            <button type="button" data-id="UserChip-trusted-sites" className="user-chip__menu-item" onClick={() => { setOpen(false); setTrustOpen(true); }}>
              {tr("trustedSites.menu", "受信任站点")}
            </button>
            <button type="button" data-id="UserChip-audit-log" className="user-chip__menu-item" onClick={() => { setOpen(false); setAuditOpen(true); }}>
              {tr("audit.menu", "审计日志")}
            </button>
            <button type="button" data-id="UserChip-terms" className="user-chip__menu-item" onClick={() => { setOpen(false); setTermsOpen(true); }}>
              {tr("firstRunTerms.menu", "用户协议")}
            </button>
            {mitmTeam && (
              <div className="user-chip__menu-mitm" data-id="UserChip-mitm" onClick={(e) => e.stopPropagation()}>
                <MitmConsentCard team={mitmTeam} variant="menu" />
              </div>
            )}
            <div className="user-chip__menu-sep" aria-hidden />
            <button type="button" data-id="UserChip-logout" className="user-chip__menu-item is-danger" onClick={() => { setOpen(false); onLogout(); }}>
              退出
            </button>
            <div className="user-chip__menu-version" data-id="UserChip-version">
              CiCy Desktop {appVer ? `v${appVer}` : "…"}
            </div>
          </div>
        )}
      </div>
      {trustOpen && <TrustedSitesModal onClose={() => setTrustOpen(false)} />}
      {auditOpen && <AuditLogModal onClose={() => setAuditOpen(false)} />}
      {termsOpen && <FirstRunTermsGate onClose={() => setTermsOpen(false)} />}
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
function FirstRunTermsGate({ onAgree, onClose }) {
  const [scrolledEnd, setScrolledEnd] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const locale = (window.cicyI18n?.locale || "en").startsWith("zh") ? "zh-CN" : "en";
  const t = (k, fb) => tr(`firstRunTerms.${k}`, fb);
  const review = !!onClose; // opened from the avatar menu to re-read — not the blocking first-run gate
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
    <div
      className={review ? "terms-gate terms-gate--review" : "shell terms-gate"}
      data-id="FirstRunTermsGate"
      style={review ? { position: "fixed", inset: 0, zIndex: 1000, background: "rgba(8,9,14,.72)", backdropFilter: "blur(4px)" } : undefined}
      onClick={review ? (e) => { if (e.target === e.currentTarget) onClose(); } : undefined}
    >
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

        {review ? (
          <div className="terms-gate__actions">
            <button data-id="FirstRunTermsGate-close" className="terms-gate__btn" onClick={onClose}>
              {t("close", "关闭")}
            </button>
          </div>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}

// HTTPS 审计 CA 授权卡片 (合规 opt-in)。绝不首启静默装根证书 (Superfish 红线) —
// 用户在此显式同意后,才由 cicy-code 写入系统根信任库。三态:未授权 / 已授权(可撤销) /
// 处理中。同意走 POST /api/mitm/consent;need_elevation 回退 exec 自提权 install-ca。
function MitmConsentCard({ team, variant }) {
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

  // Menu variant: a single flat row matching the user-chip dropdown items —
  // label + state dot on the left, a quiet on/off toggle on the right. No big
  // card, no portal pill. Used inside the user menu (主人: tip 要和 menu 风格统一).
  if (variant === "menu") {
    const toggle = (e) => {
      e?.stopPropagation?.();
      if (busy) return;
      if (granted) { if (window.confirm(t("revokeConfirm", "撤销后将停止解密审计并清除同意标记。确定?"))) disable(); }
      else enable();
    };
    return (
      <div className="user-chip__mitm" data-id="MitmConsentCard">
        <div className="user-chip__menu-item user-chip__mitm-row"
          title={t("scopeNote", "仅解密 AI 厂商域名,数据留本地,随时可关闭。")}>
          <span className="user-chip__mitm-label">{t("rowLabel", "HTTPS 审计")}</span>
          <button type="button" role="switch" aria-checked={granted ? "true" : "false"}
            data-id="MitmConsentCard-toggle"
            className={`mini-switch${granted ? " is-on" : ""}${busy ? " is-busy" : ""}`}
            disabled={!!busy} onClick={toggle}>
            <span className="mini-switch__knob" />
          </button>
        </div>
        {partial && !busy && <div className="user-chip__mitm-note" data-id="MitmConsentCard-note">{t("partialNote", "已同意但未安装,点开关重试")}</div>}
        {error && <div className="user-chip__mitm-err" data-id="MitmConsentCard-error">{error}</div>}
      </div>
    );
  }

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

// ── Docker install drawer: streams the Docker-版 cicy-code setup (装 Docker→
// 加载镜像→启动容器→就绪), mirroring the cicy-code 升级 drawer. The bootstrap
// emits {phase,status,message,progress} on 'docker:app-progress'; the card tees
// those here via dockerDrawer.push. Single global instance at shell root.
const dockerDrawerListeners = new Set();
let dockerDrawerLogSeq = 0;
let dockerDrawerState = null; // null = closed
function emitDockerDrawer() { dockerDrawerListeners.forEach((l) => l(dockerDrawerState)); }
const dockerDrawer = {
  open({ onRetry } = {}) {
    dockerDrawerState = { status: "running", phase: "install-docker", logs: [], bars: {}, minimized: false, onRetry: onRetry || null, lastAt: Date.now() };
    emitDockerDrawer();
  },
  minimize() { if (dockerDrawerState) { dockerDrawerState = { ...dockerDrawerState, minimized: true }; emitDockerDrawer(); } },
  restore() { if (dockerDrawerState) { dockerDrawerState = { ...dockerDrawerState, minimized: false }; emitDockerDrawer(); } },
  push(ev = {}) {
    if (!dockerDrawerState) return;
    const phase = ev.phase === "health" ? "container" : (ev.phase || dockerDrawerState.phase);
    const next = { ...dockerDrawerState, phase, lastAt: Date.now() };
    const hasPct = Number.isFinite(ev.progress);
    const isDl = phase === "install-docker" || phase === "image";
    // Any download-related event (running %, skip, done — they carry url/dest)
    // drives a per-phase PROGRESS BAR, not a log line, so the log doesn't
    // scroll-spam (主人: 下载不要输出滚动/日志太多).
    if (isDl && (hasPct || ev.dest || ev.url)) {
      const prev = dockerDrawerState.bars?.[phase] || {};
      const progress = hasPct ? ev.progress : (ev.status === "skip" || ev.status === "done") ? 100 : prev.progress;
      next.bars = { ...dockerDrawerState.bars, [phase]: { progress, received: ev.received ?? prev.received, total: ev.total ?? prev.total, url: ev.url || prev.url, dest: ev.dest || prev.dest } };
    }
    // Log only milestone events — never the per-% running download ticks.
    const isRunningTick = ev.status === "running" && hasPct && isDl;
    if (!isRunningTick) {
      const line = { id: ++dockerDrawerLogSeq, t: clockHHMMSS(), phase, status: ev.status || "running", message: ev.message || "" };
      next.logs = [...dockerDrawerState.logs, line];
    }
    dockerDrawerState = next;
    emitDockerDrawer();
  },
  finish({ ok, message, status } = {}) {
    if (!dockerDrawerState) return;
    // status can be forced (e.g. "reboot" — not a failure, just needs a restart).
    const st = status || (ok ? "done" : "error");
    // On FAILURE keep the phase where it actually broke, so the "!" lands on the
    // failing step (e.g. 启动服务) and earlier steps stay ✓. Only success/reboot
    // advance to the 完成 step — a step literally named "完成" showing 安装失败 is
    // nonsense (主人 bug: "为什么安装失败了,还完成").
    const phase = st === "error" ? dockerDrawerState.phase : "done";
    const line = { id: ++dockerDrawerLogSeq, t: clockHHMMSS(), phase, status: st, message: message || (ok ? "完成" : "失败") };
    // Pop back open on finish so the user sees the result even if minimized.
    dockerDrawerState = { ...dockerDrawerState, status: st, phase, minimized: false, logs: [...dockerDrawerState.logs, line], lastAt: Date.now() };
    emitDockerDrawer();
  },
  close() { dockerDrawerState = null; emitDockerDrawer(); },
};
const DOCKER_PHASES = [["install-docker", "准备环境"], ["image", "下载运行环境"], ["container", "启动服务"], ["done", "完成"]];
const DOCKER_BADGE = { "install-docker": "准备", image: "下载", container: "启动", health: "启动", done: "完成" };
const DOCKER_DL_LABEL = { "install-docker": "Docker Desktop", image: "基础镜像" };
function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}
// One fixed (non-scrolling) progress bar per download (Docker Desktop / image),
// showing the source URL + % + bytes (主人: 下载做进度条、显示地址、不要滚动).
function DownloadBar({ phaseKey, bar }) {
  const pct = Number.isFinite(bar?.progress) ? Math.max(0, Math.min(100, bar.progress)) : 0;
  const done = pct >= 100;
  return (
    <div className="dlbar" data-id={`DockerDrawer-dlbar-${phaseKey}`}>
      <div className="dlbar__head">
        <span className="dlbar__name">{DOCKER_DL_LABEL[phaseKey] || phaseKey}</span>
        <span className="dlbar__pct">{pct}%{bar?.total ? ` · ${fmtBytes(bar.received)} / ${fmtBytes(bar.total)}` : ""}</span>
      </div>
      <div className="dlbar__track"><div className={`dlbar__fill${done ? " is-done" : ""}`} style={{ width: `${pct}%` }} /></div>
      {bar?.url && <div className="dlbar__url" title={bar.url}><span className="dlbar__urlk">源</span> {bar.url}</div>}
      {bar?.dest && <div className="dlbar__url" title={bar.dest}><span className="dlbar__urlk">存</span> {bar.dest}</div>}
    </div>
  );
}
function DockerInstallDrawerHost() {
  const [st, setSt] = useState(dockerDrawerState);
  useEffect(() => { dockerDrawerListeners.add(setSt); return () => { dockerDrawerListeners.delete(setSt); }; }, []);
  const logRef = useRef(null);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [st?.logs?.length]);
  if (!st) return null;
  const running = st.status === "running";
  const phaseIdx = DOCKER_PHASES.findIndex(([k]) => k === st.phase);
  const dlBars = ["install-docker", "image"].filter((k) => st.bars?.[k]);
  // Minimized → a floating restore chip (op keeps running in the background).
  if (st.minimized) {
    const pcts = dlBars.map((k) => st.bars[k]?.progress).filter(Number.isFinite);
    const overall = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;
    return (
      <button type="button" className={`drawer-min drawer-min--${st.status}`} data-id="DockerDrawer-restore" onClick={() => dockerDrawer.restore()}>
        <span className="drawer-min__spark">{running ? <Spinner /> : st.status === "done" ? "✓" : st.status === "reboot" ? "⟳" : "!"}</span>
        <span className="drawer-min__label">{tr("docker.setupTitle", "安装 Docker cicy-code")}{overall != null ? ` · ${overall}%` : ""}</span>
      </button>
    );
  }
  return (
    <div className="drawer-scrim" data-id="DockerDrawer-scrim" onClick={() => running ? dockerDrawer.minimize() : dockerDrawer.close()}>
      <div className="drawer" data-id="DockerDrawer" data-status={st.status} onClick={(e) => e.stopPropagation()}>
        <div className="drawer__head">
          <div className="drawer__title">
            <span className={`drawer__spark drawer__spark--${st.status}`}>
              {running ? <Spinner /> : st.status === "done" ? "✓" : st.status === "reboot" ? "⟳" : "!"}
            </span>
            <div>
              <div className="drawer__h">{tr("docker.setupTitle", "安装 Docker cicy-code")}</div>
              <div className="drawer__sub">127.0.0.1:8009</div>
            </div>
          </div>
          <div className="drawer__headbtns">
            <button type="button" className="drawer__x" data-id="DockerDrawer-min" title={tr("common.minimize", "最小化")} onClick={() => dockerDrawer.minimize()} aria-label="minimize">‒</button>
          </div>
        </div>

        <div className="drawer__steps" data-id="DockerDrawer-steps">
          {DOCKER_PHASES.map(([k, label], i) => {
            const done = st.status === "done" || (phaseIdx >= 0 && i < phaseIdx);
            const active = i === phaseIdx && running;
            const err = st.status === "error" && i === phaseIdx;
            return (
              <div key={k} className={`drawer__step${active ? " is-active" : ""}${done ? " is-done" : ""}${err ? " is-error" : ""}`}>
                <span className="drawer__step-dot">{done ? "✓" : err ? "!" : i + 1}</span>
                <span className="drawer__step-label">{label}</span>
                {i < DOCKER_PHASES.length - 1 && <span className="drawer__step-bar" />}
              </div>
            );
          })}
        </div>

        {dlBars.length > 0 && (
          <div className="drawer__dlbars" data-id="DockerDrawer-dlbars">
            {dlBars.map((k) => <DownloadBar key={k} phaseKey={k} bar={st.bars[k]} />)}
          </div>
        )}

        {/* Prominent "what's happening NOW" line — so a download bar at 100% is
            never mistaken for the whole flow being done (主人 bug). */}
        {running && st.logs.length > 0 && (
          <div className="drawer__now" data-id="DockerDrawer-now">
            <Spinner /><span>{st.logs[st.logs.length - 1].message}</span>
          </div>
        )}

        <div className="drawer__log drawer__log--scroll" data-id="DockerDrawer-log" ref={logRef}>
          {st.logs.length === 0
            ? <div className="drawer__log-empty">{tr("docker.preparing", "准备中…")}</div>
            : st.logs.map((l) => (
              <div key={l.id} className="drawer__line" data-status={l.status}>
                <span className="drawer__t">{l.t}</span>
                <span className={`drawer__badge drawer__badge--${l.phase}`}>{DOCKER_BADGE[l.phase] || l.phase}</span>
                <span className="drawer__linemsg">{l.message}</span>
              </div>
            ))}
        </div>

        <div className="drawer__foot">
          {running ? (
            <>
              <span className="drawer__foot-status">{tr("docker.installing2", "安装进行中…")}</span>
            </>
          ) : st.status === "reboot" ? (
            <>
              <span className="drawer__foot-status is-reboot">{tr("docker.rebootShort", "需重启 Windows")}</span>
              {st.onRetry && <button type="button" className="drawer__btn is-accent" data-id="DockerDrawer-retry" onClick={() => st.onRetry()}>{tr("common.retry", "重试")}</button>}
              <button type="button" className="drawer__btn" data-id="DockerDrawer-dismiss" onClick={() => dockerDrawer.close()}>{tr("common.close", "关闭")}</button>
            </>
          ) : st.status === "error" ? (
            <>
              <span className="drawer__foot-status is-error">{tr("docker.failed", "安装失败")}</span>
              {st.onRetry && <button type="button" className="drawer__btn is-accent" data-id="DockerDrawer-retry" onClick={() => st.onRetry()}>{tr("common.retry", "重试")}</button>}
              <button type="button" className="drawer__btn" data-id="DockerDrawer-dismiss" onClick={() => dockerDrawer.close()}>{tr("common.close", "关闭")}</button>
            </>
          ) : (
            <>
              <span className="drawer__foot-status is-done">{tr("docker.ready", "已就绪")}</span>
              <button type="button" className="drawer__btn is-accent" data-id="DockerDrawer-finish" onClick={() => dockerDrawer.close()}>{tr("common.done", "完成")}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Docker-版 cicy-code card (Windows only): a SECOND cicy-code instance running
// in Docker on :8009, alongside the native local daemon (:8008). If Docker
// Desktop is missing, the install flow downloads its installer to the user's
// Desktop and runs it (主人指令), streaming progress through the drawer above.
function DockerCard({ dockerTeam, onOpen, onRename, onRefresh }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState("");   // "" | bootstrap | restart | stop | upgrade
  const [menuOpen, setMenuOpen] = useState(false);
  // Inline rename (mirrors LocalTeamCard): double-click the title to edit.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const displayName = dockerTeam?.name || tr("docker.title", "Docker 团队");
  const startEdit = (e) => { e?.stopPropagation?.(); setDraft(displayName); setEditing(true); };
  const commitName = async () => {
    setEditing(false);
    const next = String(draft || "").trim();
    if (!next || next === displayName || !dockerTeam?.id || !onRename) return;
    try { await onRename(dockerTeam.id, next); onRefresh?.(); } catch {}
  };
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const kebabRef = useRef(null);
  const menuRef = useRef(null);
  const MENU_W = 184;
  const DOCKER_BLUE = "#2496ed";

  const checkStatus = useCallback(async () => {
    try { setStatus(await window.cicy?.docker?.appStatus?.()); }
    catch (e) { console.warn("[DockerCard]", e); }
  }, []);

  // Poll so the card reflects reality even when Docker changes outside the app
  // (user installs Docker / the engine comes up after a reboot / a container
  // starts). Pause polling while an op is running (the op refreshes itself).
  useEffect(() => {
    checkStatus();
    const id = setInterval(() => { if (!busy) checkStatus(); }, 12000);
    return () => clearInterval(id);
  }, [checkStatus, busy]);

  // Close the ⋯ menu on outside-click / Esc (mirrors LocalTeamCard).
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e) => {
      if (kebabRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setMenuOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [menuOpen]);

  const toggleMenu = () => {
    if (!menuOpen && kebabRef.current) {
      const r = kebabRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
      setMenuPos({ top: Math.round(r.bottom + 4), left: Math.round(left) });
    }
    setMenuOpen((v) => !v);
  };

  // Install / start: streams through the drawer modal (logs + progress + retry).
  const runBootstrap = useCallback(async () => {
    setBusy("bootstrap");
    dockerDrawer.open({ onRetry: runBootstrap });
    const unsub = window.cicy?.docker?.onAppProgress?.((ev) => dockerDrawer.push(ev));
    try {
      const r = await window.cicy?.docker?.appBootstrap?.();
      if (r?.reason === "installer_launched") {
        dockerDrawer.finish({ status: "reboot", message: tr("docker.installerLaunched", "已打开 Docker 安装程序——请完成安装（会装 WSL2、可能需重启），装好后点「重试」") });
      } else if (r?.reason === "wsl_reboot_required") {
        dockerDrawer.finish({ status: "reboot", message: tr("docker.rebootNeeded", "WSL2 已安装，请【重启 Windows】后回来点「重试」继续") });
      } else {
        dockerDrawer.finish({ ok: !!r?.ok, message: r?.ok ? tr("docker.ready", "Docker cicy-code 已就绪") : (r?.error || tr("docker.failed", "安装失败")) });
      }
      if (r?.ok) onRefresh?.();
    } catch (e) {
      dockerDrawer.finish({ ok: false, message: e.message });
    } finally {
      try { unsub && unsub(); } catch {}
      setBusy(""); checkStatus();
    }
  }, [checkStatus, onRefresh]);

  // Upgrade: re-pull the R2 image + recreate the container — also through the
  // drawer so the user sees the pull/import/restart log (主人: 升级要能看日志).
  const runUpgrade = useCallback(async () => {
    setMenuOpen(false); setBusy("upgrade");
    dockerDrawer.open({ onRetry: runUpgrade });
    const unsub = window.cicy?.docker?.onAppProgress?.((ev) => dockerDrawer.push(ev));
    try {
      const r = await window.cicy?.docker?.appUpgrade?.();
      if (r?.reason === "wsl_reboot_required") {
        dockerDrawer.finish({ status: "reboot", message: tr("docker.rebootNeeded", "WSL2 已安装，请【重启 Windows】后回来点「重试」继续") });
      } else {
        dockerDrawer.finish({ ok: !!r?.ok, message: r?.ok ? tr("docker.upgraded", "已升级到最新") : (r?.error || tr("docker.upgradeFailed", "升级失败")) });
      }
      if (r?.ok) onRefresh?.();
    } catch (e) {
      dockerDrawer.finish({ ok: false, message: e.message });
    } finally {
      try { unsub && unsub(); } catch {}
      setBusy(""); checkStatus();
    }
  }, [checkStatus, onRefresh]);

  // Update cicy-code (in-place: pull latest + supervisorctl restart). Drawer so
  // the user sees the npm pull + restart log.
  const runUpdate = useCallback(async () => {
    setMenuOpen(false); setBusy("update");
    dockerDrawer.open({ onRetry: runUpdate });
    const unsub = window.cicy?.docker?.onAppProgress?.((ev) => dockerDrawer.push(ev));
    try {
      const r = await window.cicy?.docker?.appUpdate?.();
      dockerDrawer.finish({ ok: !!r?.ok, message: r?.ok ? tr("docker.updated", "cicy-code 已更新到最新") : (r?.error || tr("docker.updateFailed", "更新失败")) });
      if (r?.ok) onRefresh?.();
    } catch (e) {
      dockerDrawer.finish({ ok: false, message: e.message });
    } finally {
      try { unsub && unsub(); } catch {}
      setBusy(""); checkStatus();
    }
  }, [checkStatus, onRefresh]);

  // Restart / stop: quick lifecycle ops with a toast (no full drawer needed).
  const runOp = useCallback(async (op, fn, okMsg) => {
    setMenuOpen(false); setBusy(op);
    toast.show({ id: "docker-op", message: tr(`docker.${op}ing`, op === "restart" ? "重启中…" : op === "reload" ? "刷新中…" : "停止中…"), status: "running" });
    try {
      const r = await fn();
      if (r?.ok) toast.show({ id: "docker-op", message: okMsg, status: "done", ttl: 2500 });
      else toast.show({ id: "docker-op", message: (r?.error || tr("docker.opFailed", "操作失败")), status: "error", ttl: 6000 });
    } catch (e) {
      toast.show({ id: "docker-op", message: e.message, status: "error", ttl: 6000 });
    } finally { setBusy(""); checkStatus(); }
  }, [checkStatus]);

  // Render only on Windows. window.cicy.platform is sync, so we can decide
  // immediately without waiting on the async appStatus probe.
  const platform = window.cicy?.platform || status?.platform;
  if (platform !== "win32") return null;

  // Distinct states (主人: 状态分清楚):
  //   running       — :8009 container healthy → 打开
  //   dockerRunning — engine up, no container → 启动 (build/start container)
  //   installed     — Docker on disk but engine down → 启动 Docker
  //   else          — not installed → 下载安装
  const running = !!status?.running || dockerTeam?.status === "running";
  const dockerRunning = !!status?.dockerRunning;
  const installed = !!status?.installed;
  const tone = running ? "ok" : (dockerRunning || installed) ? "warn" : "off";
  const isBusy = !!busy;
  const stateText = running
    ? tr("docker.running", "运行中")
    : dockerRunning
      ? tr("docker.notRunning", "未启动 · 点「启动」")
      : installed
        ? tr("docker.engineDown", "Docker 未运行 · 点启动")
        : tr("docker.notInstalled", "Docker Desktop 未安装");

  const ctaLabel = isBusy
    ? tr("docker.working", "处理中…")
    : running
      ? tr("localTeams.open", "打开")
      : dockerRunning
        ? tr("docker.start", "启动")
        : installed
          ? tr("docker.startDocker", "启动 Docker")
          : tr("docker.install", "下载安装");

  const onCta = () => {
    if (isBusy) return;
    if (running) { onOpen?.(dockerTeam?.id); return; }
    runBootstrap();
  };

  // The ⋯ menu (重启 / 停止 / 升级) only makes sense once the container is up.
  const showMenu = running;

  return (
    <div data-id="DockerCard" className={`bcard bcard--docker${running ? " bcard--online" : ""}`}>
      <div className="bcard__accent" style={{ background: DOCKER_BLUE }} />
      <div className="bcard__top">
        <div className="bcard__pill" style={{ color: DOCKER_BLUE }}>
          <span className="bcard__dot" data-tone={tone} />
          <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M21.81 10.25c-.06-.05-.67-.51-1.95-.51-.34 0-.68.03-1.01.09-.25-1.69-1.64-2.51-1.7-2.55l-.34-.2-.22.32a4.5 4.5 0 0 0-.59 1.4c-.23.94-.09 1.83.39 2.59-.58.32-1.51.4-1.7.41H2.62a.61.61 0 0 0-.61.61 9.32 9.32 0 0 0 .57 3.35 4.9 4.9 0 0 0 1.95 2.53c.92.52 2.42.82 4.12.82.77 0 1.54-.07 2.3-.21a9.6 9.6 0 0 0 3-1.09 8.3 8.3 0 0 0 2.05-1.68c.98-1.11 1.56-2.35 1.99-3.45h.17c1.36 0 2.2-.55 2.66-1l.13-.16zM4.7 11.33h1.78a.16.16 0 0 0 .16-.16V9.58a.16.16 0 0 0-.16-.16H4.7a.16.16 0 0 0-.16.16v1.59c0 .09.07.16.16.16m2.46 0h1.78a.16.16 0 0 0 .16-.16V9.58a.16.16 0 0 0-.16-.16H7.16a.16.16 0 0 0-.16.16v1.59c0 .09.07.16.16.16m2.5 0h1.78a.16.16 0 0 0 .16-.16V9.58a.16.16 0 0 0-.16-.16H9.66a.16.16 0 0 0-.16.16v1.59c0 .09.07.16.16.16m2.47 0h1.78a.16.16 0 0 0 .16-.16V9.58a.16.16 0 0 0-.16-.16h-1.78a.16.16 0 0 0-.16.16v1.59c0 .09.07.16.16.16M7.16 9.06h1.78a.16.16 0 0 0 .16-.16V7.31a.16.16 0 0 0-.16-.16H7.16a.16.16 0 0 0-.16.16v1.59c0 .09.07.16.16.16m2.5 0h1.78a.16.16 0 0 0 .16-.16V7.31a.16.16 0 0 0-.16-.16H9.66a.16.16 0 0 0-.16.16v1.59c0 .09.07.16.16.16m2.47 0h1.78a.16.16 0 0 0 .16-.16V7.31a.16.16 0 0 0-.16-.16h-1.78a.16.16 0 0 0-.16.16v1.59c0 .09.07.16.16.16" />
          </svg>
        </div>
        {showMenu && (
          <div className="bcard__menuwrap" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              ref={kebabRef}
              data-id="DockerCard-menu-btn"
              className="bcard__kebab"
              title={tr("docker.manage", "管理 Docker cicy-code")}
              disabled={isBusy}
              onClick={toggleMenu}
            >
              {isBusy ? <Spinner /> : <KebabIcon />}
            </button>
            {menuOpen && createPortal(
              <div className="bcard__menu bcard__menu--portal" data-id="DockerCard-menu" role="menu"
                ref={menuRef}
                style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: MENU_W }}
                onClick={(e) => e.stopPropagation()}>
                <button type="button" data-id="DockerCard-addr" className="bcard__menu-item"
                  title={tr("localTeams.copyAddr", "点击复制地址")}
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); try { navigator.clipboard.writeText("http://127.0.0.1:8009"); } catch {} }}>
                  127.0.0.1:8009
                </button>
                <button type="button" data-id="DockerCard-update" className="bcard__menu-item is-accent" onClick={runUpdate}>
                  {tr("docker.update", "更新")}
                </button>
                <button type="button" data-id="DockerCard-reload" className="bcard__menu-item"
                  onClick={() => runOp("reload", async () => {
                    // 像本地卡:开着才刷,没开就提示——绝不偷偷开新标签。Page.reload 保留
                    // localStorage 里的 token,所以刷新后仍是登录态。
                    const r = await window.cicy.localTeams.reload(dockerTeam?.id);
                    if (!r?.ok && r?.error === "no_open_window") return { ok: false, error: tr("localTeams.windowNotOpen", "窗口未打开,请先点「打开」") };
                    return r;
                  }, tr("localTeams.reloaded", "已刷新窗口"))}>
                  {tr("docker.reloadWindow", "刷新窗口")}
                </button>
                <button type="button" data-id="DockerCard-restart" className="bcard__menu-item"
                  onClick={() => runOp("restart", () => window.cicy.docker.appRestart(), tr("docker.restarted", "已重启 cicy-code"))}>
                  {tr("docker.restart", "重启")}
                </button>
                <button type="button" data-id="DockerCard-stop" className="bcard__menu-item is-danger"
                  onClick={() => runOp("stop", () => window.cicy.docker.appStop(), tr("docker.stopped", "已停止 cicy-code"))}>
                  {tr("docker.stop", "停止")}
                </button>
                <button type="button" data-id="DockerCard-billing" className="bcard__menu-item"
                  onClick={() => { setMenuOpen(false); openCloudPage(dockerTeam?.cloud_team_id ? `?team=${encodeURIComponent(dockerTeam.cloud_team_id)}` : "?view=usage"); }}>
                  {tr("docker.billing", "帐单")}
                </button>
              </div>,
              document.body
            )}
          </div>
        )}
      </div>
      <div className="bcard__body">
        {editing ? (
          <input
            data-id="DockerCard-rename-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={commitName}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === "Enter") commitName(); else if (e.key === "Escape") setEditing(false); }}
            style={{ width: "100%", font: "inherit", fontWeight: 600, padding: "2px 6px", border: "1px solid #3b82f6", borderRadius: 6, background: "#0d1117", color: "#e6edf3", boxSizing: "border-box" }}
          />
        ) : (
          <h3 className="bcard__name" title={tr("localTeams.renameHint", "点名字或双击改名")} onDoubleClick={startEdit} style={{ cursor: "text" }}>{displayName}</h3>
        )}
        <div className="bcard__meta"><span className="bcard__chip">Docker</span></div>
      </div>
      <button
        type="button"
        className="bcard__cta"
        data-id="DockerCard-cta"
        disabled={isBusy}
        onClick={onCta}
        style={!running ? { background: DOCKER_BLUE, color: "white" } : undefined}
      >
        {isBusy ? <Spinner /> : <ArrowIcon />}
        <span>{ctaLabel}</span>
      </button>
    </div>
  );
}

function LocalTeamCard({ team, onOpen, onRename, onRefresh }) {
  const statusInfo = LOCAL_STATUS[team.status] || LOCAL_STATUS.error;
  const tone = statusInfo.tone;
  // Inline rename — 产品级:点名字即编辑、乐观更新、行内"保存中/已保存"、失败回滚。
  // 显示名 = pendingName(乐观,保存中暂显)?? team.name(props,后台对账后更新)。
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(team.name || "");
  const [pendingName, setPendingName] = useState(null);     // 乐观名;props 追上后清
  const [saveState, setSaveState] = useState("");            // "" | saving | saved | error
  const displayName = pendingName != null ? pendingName : team.name;
  // props 追上乐观名 → 清 pending(两者相等,无闪烁)
  useEffect(() => { if (pendingName != null && team.name === pendingName) setPendingName(null); }, [team.name, pendingName]);
  const startEdit = (e) => { e?.stopPropagation?.(); setDraft(displayName || ""); setEditing(true); };
  const commit = async () => {
    setEditing(false);
    const next = String(draft || "").trim();
    if (!onRename || !next || next === displayName) return;
    setPendingName(next);            // 乐观:立即显示新名
    setSaveState("saving");
    let r;
    try { r = await onRename(team.id, next); } catch (e) { r = { ok: false, error: e?.message }; }
    // 落定:让权威值(team.name,onRename 已刷新)接管显示。服务端权威下,本端改名若与
    // 云端并发冲突会被判负,后续 ~3s 对账会把名字换成云端版本——清掉乐观名才不会卡住。
    setPendingName(null);
    if (r && r.ok) {
      setSaveState("saved");
      setTimeout(() => setSaveState((s) => (s === "saved" ? "" : s)), 1500);
    } else {
      setSaveState("");
      toast.show({ message: tr("localTeams.renameFailed", "改名没保存,已恢复"), status: "error", ttl: 4000 });
    }
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
  // cicy-code 版本统一从 sidecar.versions() 一处拿(主人令:"拿版本就一个方法")。
  // running===undefined = 还没查到(用于区分"加载中" vs "停了/拿不到");区别于
  // running===null(查过了但 daemon 没报版本)。latest/installed 同源。
  const [versions, setVersions] = useState({ running: undefined, latest: null, installed: null });
  const latest = versions.latest;
  const runningVer = versions.running;
  const [checking, setChecking] = useState(false);
  const menuWrap = useRef(null);
  const kebabRef = useRef(null);   // ⋯ button — anchor for the portaled menu
  const menuRef = useRef(null);    // portaled menu (lives on document.body)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const MENU_W = 184;
  // The ⋯ menu is rendered in a PORTAL on document.body (not inside .bcard, whose
  // overflow:hidden — needed for the rounded card + glow — would otherwise CLIP
  // the dropdown). Anchor it under the kebab, right-aligned, clamped on-screen.
  const toggleMenu = () => {
    if (!menuOpen && kebabRef.current) {
      const r = kebabRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
      setMenuPos({ top: Math.round(r.bottom + 4), left: Math.round(left) });
    }
    setMenuOpen((v) => !v);
  };

  // 版本统一从 sidecar.versions() 一处拿(running=活着的 /api/health 版本,
  // latest=npm 最新,同源)。Auto-runs once on mount + 每次 daemon 起来(status→
  // running)时重查,这样 cicy-code 刚启动那一拍拿不到版本、之后能自动补上。
  // ⋯ 菜单"检查更新"用 manual=true 给 toast。
  const checkUpdate = useCallback(async (manual = false) => {
    if (!local || !window.cicy?.sidecar?.versions) return;
    if (manual) setChecking(true);
    try {
      const v = await window.cicy.sidecar.versions(); // { running, latest, installed }
      setVersions({ running: v?.running ?? null, latest: v?.latest ?? null, installed: v?.installed ?? null });
      if (manual) {
        if (v?.running && v?.latest && cmpVer(v.latest, v.running) > 0) {
          toast.show({ message: `${tr("sidecar.found", "发现新版本")} v${v.latest}`, status: "done", ttl: 2500 });
        } else if (v?.running) {
          toast.show({ message: `${tr("sidecar.upToDate", "已是最新")} v${v.running}`, status: "done", ttl: 2500 });
        } else {
          // daemon 没在跑 / 没报版本 — 别撒谎说最新,也别误报有更新
          toast.show({ message: tr("sidecar.notRunning", "cicy-code 未运行"), status: "error", ttl: 4000 });
        }
      }
    } catch { if (manual) toast.show({ message: tr("sidecar.checkFailed", "检查更新失败"), status: "error", ttl: 5000 }); }
    finally { if (manual) setChecking(false); }
  }, [local]);

  useEffect(() => { checkUpdate(false); }, [checkUpdate]);
  // daemon 起来后(或重启/更新后 status 翻 running)自动重查一次版本,补上启动早期的空值。
  useEffect(() => { if (running) checkUpdate(false); }, [running, checkUpdate]);

  // 只有在【确知运行版本 runningVer 且确实落后 latest】时才提示更新。runningVer 未知
  // (undefined/null:停了或刚启动还没读到)一律不提示——修掉"版本暂时读不到就误报更新 +
  // 卡片一直转/显示更新"的 bug。NOTE: 这跟"版本落后却不让更新"不冲突:落后是 runningVer
  // 已知且 < latest,照样提示。
  const updateAvailable = !!(local && latest && runningVer && cmpVer(latest, runningVer) > 0);
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
    // The menu is portaled to document.body, so menuWrap no longer contains it —
    // check BOTH the kebab anchor and the portaled menu before closing.
    const onDoc = (e) => {
      if (kebabRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setMenuOpen(false);
    };
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
      updateDrawer.open({ teamId: team.id, fromVer: runningVer, toVer: latest, onRetry: () => runOp("update", fn, doneText) });
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
        // 更新成功 = 新 cicy-code 已切换并启动。若该团队的 :8008 窗口正开着,
        // 直接刷新它,让用户立刻用上新版(没开窗口则 reload 返回 no_open_window,no-op)。
        // ignoreCache:绕过 HTTP 缓存重载,否则可能复用缓存的旧 index.html → 仍跑旧版。
        if (ok) { try { await window.cicy?.localTeams?.reload?.(team.id, { ignoreCache: true }); } catch {} }
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
      // 重启/更新/启动后,daemon 版本可能变了(且 status 可能仍是 running、不会触发
      // 上面那个 effect),所以这里强制重查一次版本,卡片立刻反映真实版本。
      if (kind === "update" || kind === "restart" || kind === "start") checkUpdate(false);
    }
  };
  const BUSY_LABEL = { start: "启动中…", restart: "重启中…", update: "更新中…", stop: "停止中…" };

  // 打开 flow (主人 spec): start the LOCAL daemon if it's down (with a 启动中…
  // toast), then open. The window itself is opened by openTeam() in main, which
  // (1) reuses an already-open window for this team (list_windows check first),
  // and (2) for a local team, TCP-探活 until :8008 actually answers before
  // creating the window — so we never pop a blank page that needs a manual
  // reload. (/api/health is NOT used — it's unreliable mid-boot; the gate is a
  // raw TCP probe.) Remote/custom teams just open and show their own UI.
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
    onOpen(); // openTeam() gates on list_windows + TCP liveness before showing
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
              ref={kebabRef}
              data-id="LocalTeamCard-menu-btn"
              className={`bcard__kebab${updateAvailable ? " has-dot" : ""}`}
              title={local ? tr("localTeams.manage", "管理本地 cicy-code") : tr("localTeams.more", "更多")}
              disabled={!!busy}
              onClick={toggleMenu}
            >
              {busy ? <Spinner /> : <KebabIcon />}
            </button>
            {menuOpen && createPortal(
              <div className="bcard__menu bcard__menu--portal" data-id="LocalTeamCard-menu" role="menu"
                ref={menuRef}
                style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: MENU_W }}
                onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  data-id="LocalTeamCard-addr"
                  className="bcard__menu-item"
                  title={tr("localTeams.copyAddr", "点击复制地址")}
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); try { navigator.clipboard.writeText(team.base_url || ""); } catch {} }}
                >
                  {team.base_url || "—"}{(runningVer || team.version) ? ` · v${runningVer || team.version}` : ""}
                </button>
                {local && (
                  <button
                    type="button"
                    data-id="LocalTeamCard-check-update"
                    className="bcard__menu-item"
                    disabled={checking}
                    onClick={(e) => { e.stopPropagation(); checkUpdate(true); }}
                  >
                    {checking ? tr("sidecar.checking2", "检查中…") : tr("sidecar.checkUpdate", "检查更新")}
                  </button>
                )}
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
                {/* 刷新窗口:所有团队卡通用(local / 自定义 / 共享)——开着才刷,没开提示。*/}
                {running && (
                  <button
                    type="button"
                    data-id="LocalTeamCard-reload"
                    className="bcard__menu-item"
                    onClick={() => runOp("reload", async () => {
                      const r = await window.cicy.localTeams.reload(team.id);
                      // 没开就不刷、也不偷偷开新标签(主人令):明确提示"窗口未打开",
                      // 而不是替用户开一个 tab。开着才真刷(reloadTeam 走标签管理器)。
                      if (!r?.ok && r?.error === "no_open_window") return { ok: false, error: tr("localTeams.windowNotOpen", "窗口未打开,请先点「打开」") };
                      return r;
                    }, tr("localTeams.reloaded", "已刷新窗口"))}
                  >
                    {tr("localTeams.reloadWindow", "刷新窗口")}
                  </button>
                )}
                {local && running && (
                  <>
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
                {team.cloud_team_id && (
                  <button
                    type="button"
                    data-id="LocalTeamCard-billing"
                    className="bcard__menu-item"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                      // Per-team billing (w-10032): /dash?team=<teamId> + handoff
                      // ticket. teamId = the cloud_team_id we stored on name-sync;
                      // no key in the URL — dash fetches it via session.
                      openCloudPage(`?team=${encodeURIComponent(team.cloud_team_id)}`);
                    }}
                  >
                    {tr("localTeams.billing", "账单")}
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
              </div>,
              document.body
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
            onFocus={(e) => e.target.select()}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === "Enter") commit(); else if (e.key === "Escape") setEditing(false); }}
            style={{ width: "100%", font: "inherit", fontWeight: 600, padding: "2px 6px", border: "1px solid #3b82f6", borderRadius: 6, background: "#0d1117", color: "#e6edf3", boxSizing: "border-box" }}
          />
        ) : (
          <h3 className="bcard__name" title={tr("localTeams.renameHint", "点名字或 ✎ 改名")} style={{ display: "flex", alignItems: "center", gap: 6 }} onDoubleClick={startEdit}>
            <span
              data-id="LocalTeamCard-name-text"
              onClick={startEdit}
              style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "text" }}
            >{displayName}</span>
            {/* 行内保存状态:保存中 spinner / 已保存 ✓ */}
            {saveState === "saving" && (
              <span data-id="LocalTeamCard-save-state" title={tr("localTeams.saving", "保存中…")} style={{ flex: "none", display: "inline-flex" }}><Spinner /></span>
            )}
            {saveState === "saved" && (
              <span data-id="LocalTeamCard-save-state" title={tr("localTeams.saved", "已保存")} style={{ flex: "none", color: "#3fb950", fontSize: 13, lineHeight: 1 }}>✓</span>
            )}
            {!saveState && (
              <button
                type="button"
                data-id="LocalTeamCard-rename-btn"
                title={tr("localTeams.rename", "重命名")}
                onClick={startEdit}
                style={{ flex: "none", cursor: "pointer", border: "none", background: "transparent", color: "#8b949e", fontSize: 13, padding: 0, lineHeight: 1 }}
              >✎</button>
            )}
          </h3>
        )}
        <div className="bcard__meta">
          <span className="bcard__chip" data-id="LocalTeamCard-kind">{local ? tr("localTeams.kindLocal", "本地") : tr("localTeams.kindCustom", "自定义")}</span>
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

// The Docker-版 cicy-code instance — localhost:8009. Owned by <DockerCard>, so
// it's filtered out of the generic node lists.
function isDockerApp(baseUrl) {
  try {
    const p = new URL(baseUrl);
    const local = p.hostname === "127.0.0.1" || p.hostname === "localhost" || p.hostname === "::1";
    return local && p.port === "8009";
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

// 私有云 / (历史)云端团队卡片。产品方向变更(w-10032):公有云不做了,主打 private
// (用户自托管,数据不出企业)。private 字段:{name,kind:"private",status,apiKey,
// gatewayUrl,host_url,titleVersion,deviceId:""}。卡片展示名字+host_url,点开可看/复制 apiKey。
function TeamCard({ team, onOpen }) {
  const isPrivate = team.kind === "private";
  const statusOk = team.status === "active";
  const name = team.name || team.title || "—";
  const hostUrl = team.host_url || "";
  const billTeamId = team.teamId || team.id; // /dash?team=<teamId>(URL 不带 key)
  const kindLabel = isPrivate ? "私有云" : (team.team_kind === "personal" ? "个人" : "共享");
  const openUrl = isPrivate ? hostUrl : (team.workspace_url || team.workspace_direct_url);
  const hasUrl = !!openUrl;

  // ⋯ menu (reload) — mirrors LocalTeamCard so EVERY card has a 刷新窗口. Reload
  // re-loads the cloud team's tab in profile 0 (opens it if not yet open).
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const menuWrap = useRef(null);
  const kebabRef = useRef(null);
  const menuRef = useRef(null);
  const MENU_W = 184;
  const toggleMenu = () => {
    if (!menuOpen && kebabRef.current) {
      const r = kebabRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
      setMenuPos({ top: Math.round(r.bottom + 4), left: Math.round(left) });
    }
    setMenuOpen((v) => !v);
  };
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e) => {
      if (kebabRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);
  const doReload = async () => {
    if (!hasUrl || busy) return;
    setBusy(true); setMenuOpen(false);
    // 不开窗(主人令):没开 tab 就提示,不替用户开。
    try {
      const r = await window.cicy?.tabs?.reloadIfOpen?.(openUrl, name);
      if (!r?.ok && r?.error === "no_open_window") window.alert(tr("localTeams.windowNotOpen", "窗口未打开,请先点「打开」"));
    } catch {}
    finally { setBusy(false); }
  };
  // 主人令:私有云卡片不展示 api key(安全)。key 只在云端 dash / 注入 global.json 用。
  return (
    <div data-id="TeamCard" className={`bcard bcard--cloud${statusOk ? " bcard--online" : ""}`}>
      <div className="bcard__accent" />
      <div className="bcard__top">
        <div className="bcard__pill">
          <span className="bcard__dot" data-tone={statusOk ? "ok" : "off"} />
          <GlobeIcon />
        </div>
        <div className="bcard__top-right">
          {team.is_trial && <span className="bcard__badge">trial</span>}
          {(hasUrl || billTeamId != null) && (
            <div className="bcard__menuwrap" ref={menuWrap} onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                ref={kebabRef}
                data-id="TeamCard-menu-btn"
                className="bcard__kebab"
                title={tr("localTeams.more", "更多")}
                disabled={busy}
                onClick={toggleMenu}
              >
                {busy ? <Spinner /> : <KebabIcon />}
              </button>
              {menuOpen && createPortal(
                <div className="bcard__menu bcard__menu--portal" data-id="TeamCard-menu" role="menu"
                  ref={menuRef}
                  style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: MENU_W }}
                  onClick={(e) => e.stopPropagation()}>
                  {hasUrl && (
                    <button type="button" data-id="TeamCard-addr" className="bcard__menu-item"
                      title={tr("localTeams.copyAddr", "点击复制地址")}
                      onClick={(e) => { e.stopPropagation(); setMenuOpen(false); try { navigator.clipboard.writeText(openUrl || hostUrl || ""); } catch {} }}>
                      {isPrivate ? (hostUrl || openUrl) : (openUrl || team.runtime_region || team.region || "—")}
                    </button>
                  )}
                  {hasUrl && (
                    <button type="button" data-id="TeamCard-reload" className="bcard__menu-item" onClick={doReload}>
                      {tr("localTeams.reloadWindow", "刷新窗口")}
                    </button>
                  )}
                  {billTeamId != null && (
                    <button type="button" data-id="TeamCard-billing" className="bcard__menu-item"
                      onClick={(e) => { e.stopPropagation(); setMenuOpen(false); openCloudPage(`?team=${encodeURIComponent(billTeamId)}`); }}>
                      {tr("localTeams.billing", "账单")}
                    </button>
                  )}
                </div>,
                document.body,
              )}
            </div>
          )}
        </div>
      </div>
      <div className="bcard__body">
        <h3 className="bcard__name" title={name}>{name}</h3>
        <div className="bcard__meta">
          <span className="bcard__chip">{kindLabel}</span>
          {!isPrivate && team.membership_status && team.membership_status !== "active" && (
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
        <span>{hasUrl ? tr("localTeams.open", "打开") : (isPrivate ? tr("teamCard.noHost", "未填访问地址") : tr("teamCard.noUrl", "无 URL"))}</span>
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
  // New CiCy mark (六芒星). Rendered white here because it sits on the brand
  // chip's blue→violet gradient square; the full-color gradient version is the
  // app/favicon icon. Path matches build/icon.svg (viewBox 0 0 96 96).
  return (
    <svg width="22" height="22" viewBox="0 0 96 96" fill="none">
      <path d="M48 11L39.5 33.3L16 29.5L31 48L16 66.5L39.5 62.7L48 85L56.5 62.7L80 66.5L65 48L80 29.5L56.5 33.3Z"
        fill="white" stroke="white" strokeWidth="8" strokeLinejoin="round" strokeLinecap="round" />
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

