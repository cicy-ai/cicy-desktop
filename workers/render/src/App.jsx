import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import "./App.css";

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
const HELPER_WIDTH_KEY = "cicy_helper_width";
// v1 MVP: shared helper container on the cloud VM. All trial users hit
// the same instance — will be replaced by per-user dynamic allocation
// from /api/helper/start once w-10032 ships that endpoint.
const HELPER_URL_BASE = "http://43.99.56.150:8011";
const HELPER_SHARED_TOKEN = "cicy_9170fc02080e5d744cc4e80e423486ca";
// Team Helper pane id — produced by cicy-code --helper=1, which spawns a
// single OpenCode worker on port 6002 (see cicy-code setup.go
// helperModeBuiltinWorker). The SPA uses hash routing #/agent/<session> to
// land directly inside that pane.
const HELPER_PANE_ID = "w-6002:main.0";
const HELPER_AGENT_SESSION = "w-6002";

export default function App() {
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
  // Pick the team that backs the Team Helper drawer. Any running local team
  // whose api_token is populated qualifies — `localTeams.list()` only marks
  // status="running" when /api/health returned 200. Once one exists, the
  // card switches from "30-min cloud trial" to "persistent local helper" and
  // the drawer dials its own w-6002. Null until a real team comes online.
  const localHelperTeam = useMemo(() => {
    return (localTeams || []).find(
      (t) => t && t.status === "running" && t.base_url && t.api_token,
    ) || null;
  }, [localTeams]);
  // localHelperState — four-way. Drives both the Helper card and onStart.
  //
  //   "unknown"       : first list() probe hasn't returned. Don't decide.
  //   "local-ready"   : at least one local team is healthy → use it.
  //   "local-pending" : probe done, no healthy team yet, BUT user has
  //                     local nodes configured (cicy-code starting up,
  //                     wrong token, transient error, …). Wait.
  //   "cloud-only"    : probe done AND no local nodes configured. Always
  //                     show the cloud-trial helper — it's the one that
  //                     walks users through installing Docker + cicy-code
  //                     on Windows, so we need to be able to summon it
  //                     every launch until the install completes (then
  //                     cicyDesktopNodes lands an entry and state flips
  //                     to local-ready / local-pending).
  const hasLocalConfigured = useMemo(() => {
    // Any configured node counts — even "stopped" or "auth_error" — because
    // the user has signaled intent to use a local instance. The only state
    // that means "no local intent" is an empty list.
    return Array.isArray(localTeams) && localTeams.length > 0;
  }, [localTeams]);
  const localHelperState = useMemo(() => {
    if (!localTeamsFetched) return "unknown";
    if (localHelperTeam)    return "local-ready";
    if (hasLocalConfigured) return "local-pending";
    return "cloud-only";
  }, [localTeamsFetched, localHelperTeam, hasLocalConfigured]);
  const localHelperUrl = useMemo(() => {
    if (!localHelperTeam) return null;
    const base = String(localHelperTeam.base_url).replace(/\/$/, "");
    return `${base}/?token=${encodeURIComponent(localHelperTeam.api_token)}#/agent/w-6002`;
  }, [localHelperTeam]);
  const cloudHelperUrl = useMemo(
    () => `${HELPER_URL_BASE}/?token=${encodeURIComponent(HELPER_SHARED_TOKEN)}#/agent/${HELPER_AGENT_SESSION}`,
    [],
  );
  // Tab + helper drawer state (the v1 layout: tabs row over a unified grid,
  // right-edge full-height webview drawer for the team-helper agent).
  const [tab, setTab] = useState("all"); // "all" | "local" | "cloud"
  const [helperWidth, setHelperWidth] = useState(() => {
    const saved = parseInt(safeGet(HELPER_WIDTH_KEY) || "0", 10);
    if (saved > 0) return saved;
    if (typeof window === "undefined") return 560;
    return Math.round(window.innerWidth * 0.42);
  });
  const [helperResizing, setHelperResizing] = useState(false);
  // Drawer is collapsed by default. Opens when the user clicks the "团队
  // 小助手" onboarding card (or any future "summon helper" trigger).
  const [helperOpen, setHelperOpen] = useState(false);
  // Helper-instance URL — null until Phase 4 wires /api/helper/start.
  const [helperUrl, setHelperUrl] = useState(null);
  const helperWebviewRef = useRef(null);
  // Auto-promote: if the drawer is open with a placeholder (helperUrl===null
  // because we were in unknown/local-pending), and the local helper team
  // becomes ready, swap in the local URL. Only when helperUrl is still
  // null — once a webview (cloud or local) is loaded we never silently swap
  // it out from under the user (they may be mid-conversation).
  useEffect(() => {
    if (helperOpen && helperUrl === null && localHelperUrl) {
      setHelperUrl(localHelperUrl);
    }
  }, [helperOpen, helperUrl, localHelperUrl]);
  // Centered modal asking the user to confirm sending "start". Shown each
  // time the drawer opens unless the user picked "不再显示" (persisted in
  // localStorage). Manual fallback for when server-side helper-kick didn't
  // fire (drawer reopened too quickly, opencode dropped the first message).
  const [helperModalShown, setHelperModalShown] = useState(false);
  const [helperModalSuppressed, setHelperModalSuppressed] = useState(
    () => { try { return localStorage.getItem("helper_modal_suppressed") === "1"; } catch { return false; } }
  );
  useEffect(() => {
    // The "start" confirm modal is cloud-trial-specific (it posts to
    // HELPER_URL_BASE/api/tmux/send to kick the cloud opencode). For
    // local-ready (persistent w-6002 already has its intro queue) and
    // unknown/local-pending (no webview yet) it's wrong to show it.
    if (helperOpen && !helperModalSuppressed && localHelperState === "cloud-only") {
      setHelperModalShown(true);
    }
    if (!helperOpen) setHelperModalShown(false);
  }, [helperOpen, helperModalSuppressed, localHelperState]);
  const suppressHelperModal = useCallback(() => {
    try { localStorage.setItem("helper_modal_suppressed", "1"); } catch {}
    setHelperModalSuppressed(true);
    setHelperModalShown(false);
  }, []);
  const [helperSending, setHelperSending] = useState(false);
  const sendHelperStart = useCallback(async () => {
    if (helperSending) return;
    setHelperSending(true);
    try {
      await window.cicy?.cloud?.fetch?.(`${HELPER_URL_BASE}/api/tmux/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${HELPER_SHARED_TOKEN}`,
        },
        body: JSON.stringify({ pane_id: HELPER_PANE_ID, text: "start", submit: true }),
      });
      setHelperModalShown(false);
    } catch {} finally {
      setHelperSending(false);
    }
  }, [helperSending]);
  // (userContextSentRef gone — server-side --helper kick owns the trigger.)

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
          // Hand-off: when the cloud Team Helper registered our new local
          // backend, swap the drawer's webview to that backend's own
          // w-6002 pane after a short pause so the user can read the
          // farewell message first. Heuristic: install_source starts
          // with "helper-".
          if (result?.ok && /^helper(-|$)/.test(msg.spec?.install_source || "") && result?.team?.base_url) {
            const team = result.team;
            setTimeout(() => {
              const tok = team.api_token ? `?token=${encodeURIComponent(team.api_token)}` : "";
              setHelperUrl(`${team.base_url}${tok}#/agent/w-6002`);
            }, 2500);
          }
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

  // Drag-resize the right helper drawer. Mousedown on the 6 px handle
  // attaches window-level listeners so the drag survives the cursor leaving
  // the handle. Webview captures its own mouse events in a child renderer
  // process — without the fullscreen mask the host page loses mousemove
  // the instant the cursor crosses into the webview.
  const startHelperResize = useCallback((ev) => {
    ev.preventDefault();
    setHelperResizing(true);
    const min = 320;
    const onMove = (e) => {
      const w = window.innerWidth - e.clientX;
      const max = window.innerWidth - 320;
      const clamped = Math.max(min, Math.min(max, w));
      setHelperWidth(clamped);
    };
    const onUp = () => {
      setHelperResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // Persist the final width so a relaunch keeps the user's layout.
      try { localStorage.setItem(HELPER_WIDTH_KEY, String(parseInt(getComputedStyle(document.querySelector(".helper-aside") || document.body).getPropertyValue("width") || "0", 10) || 0)); } catch {}
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);
  useEffect(() => {
    try { localStorage.setItem(HELPER_WIDTH_KEY, String(helperWidth)); } catch {}
  }, [helperWidth]);

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
  const localCount = (localTeams || []).length;
  const cloudCount = (teams || []).length;
  const showLocal = tab === "all" || tab === "local";
  const showCloud = tab === "all" || tab === "cloud";

  return (
    <div className="shell shell--app">
      <div className="glow glow--app" aria-hidden />
      <div className="shell__left">
      <Header me={me} welcome={welcome} onLogout={handleLogout} />
      <main className="main">
        <div className="app__tabs">
          {[
            { k: "all",   label: "全部", n: localCount + cloudCount },
            { k: "local", label: "本地", n: localCount },
            { k: "cloud", label: "云端", n: cloudCount },
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

        {profileError && (
          <div className="error" style={{ marginBottom: 12 }}>
            云端: {profileError}
            <button className="btn-ghost" style={{ marginLeft: 8 }} onClick={() => fetchProfile(accessToken, userId)}>
              重试
            </button>
          </div>
        )}

        <div className="app__grid">
          {/* Team Helper card — always rendered. Routing decision is the
              three-way localHelperState (see useMemo above):
                local-ready   → open local team's w-6002 (persistent, no trial cap)
                local-pending → open drawer with placeholder, wait for cicy-code
                                to come up; auto-promote to local URL when it
                                does (effect below).
                unknown       → same as local-pending: never silently fall
                                through to cloud during the launch race.
                cloud-only    → open the 30-min cloud trial. Only here. */}
          <HelperOnboardCard
            state={localHelperState}
            onStart={() => {
              if (localHelperState === "local-ready") {
                setHelperUrl(localHelperUrl);
              } else if (localHelperState === "cloud-only") {
                setHelperUrl(cloudHelperUrl);
              } else {
                // unknown / local-pending — open the drawer but leave
                // helperUrl null so HelperPlaceholder renders. For
                // local-pending the effect below upgrades to localHelperUrl
                // as soon as cicy-code comes up.
                setHelperUrl(null);
              }
              setHelperOpen(true);
            }}
          />

          {showLocal && localTeams && localTeams.map((t) => (
            <LocalTeamCard key={"local:" + t.id} team={t} onOpen={() => openLocalTeam(t.id)} onRename={renameLocalTeam} />
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
              alert("Phase 3 待接：让小助手帮你装 / 自己 docker run cicy-code 后 add");
            }}>
              <span className="add-card__plus">+</span>
              <span className="add-card__label">新建本地团队</span>
            </button>
          )}
        </div>

        {!profileLoading && !profileError && teams && teams.length === 0 && !localTeams?.length && (
          <div className="empty" style={{ marginTop: 14 }}>
            还没有团队 — 让小助手帮你装一个本地 team，或在云端创建。
          </div>
        )}
      </main>
      </div>{/* /.shell__left */}

      {/* Drag mask: during resize, fullscreen invisible div above the webview
          so the host page keeps receiving mousemove (webview is a separate
          renderer process that eats its own mouse events). */}
      {helperResizing && (
        <div
          className="helper-mask"
          style={{ position: "fixed", inset: 0, cursor: "ew-resize", background: "transparent", userSelect: "none", zIndex: 9999 }}
        />
      )}

      {/* 🤖 团队助手 — 通栏右侧抽屉。默认收起，点 onboard card 才开。 */}
      {helperOpen && (
      <aside
        className="helper-aside"
        style={{ width: helperWidth }}
      >
        <div
          onMouseDown={startHelperResize}
          style={{ position: "absolute", left: -3, top: 0, bottom: 0, width: 6, cursor: "ew-resize", zIndex: 1 }}
          title="拖动调整宽度"
        />
        {/* Top bar with close button. Subtle to not steal focus from the
            assistant content below. */}
        <div className="helper-aside__top">
          <span className="helper-aside__title">🤖 团队小助手</span>
          <button
            type="button"
            className="helper-aside__close"
            onClick={() => setHelperOpen(false)}
            aria-label="关闭"
          >×</button>
        </div>
        {helperModalShown && (
          <div
            className="helper-modal__backdrop"
            onClick={() => setHelperModalShown(false)}
          >
            <div
              className="helper-modal"
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="helper-modal__title">让小助手开始工作</div>
              <div className="helper-modal__desc">
                点击「确认发送」会向团队小助手发送 <code>start</code>，
                它会探测您的系统并按需安装本地团队后端。
              </div>
              <div className="helper-modal__actions">
                <button
                  type="button"
                  className="helper-modal__btn helper-modal__btn--ghost"
                  onClick={suppressHelperModal}
                >不再显示</button>
                <button
                  type="button"
                  className="helper-modal__btn"
                  onClick={() => setHelperModalShown(false)}
                >关闭</button>
                <button
                  type="button"
                  className="helper-modal__btn helper-modal__btn--primary"
                  onClick={sendHelperStart}
                  disabled={helperSending}
                >{helperSending ? "发送中…" : "确认发送"}</button>
              </div>
            </div>
          </div>
        )}
        {helperUrl ? (
          <webview
            ref={helperWebviewRef}
            key={helperUrl}
            src={helperUrl}
            {...(window.cicy?.webviewPreloadPath ? { preload: `file://${window.cicy.webviewPreloadPath}` } : {})}
            style={{ flex: 1, border: 0, width: "100%", height: "100%" }}
            allowpopups="true"
          />
        ) : (
          <HelperPlaceholder state={localHelperState} />
        )}
      </aside>
      )}
    </div>
  );
}

function HelperOnboardCard({ onStart, state = "unknown" }) {
  // state: "unknown" | "local-ready" | "local-pending" | "cloud-only"
  //   local-ready   : open helper drawer pointing at local w-6002
  //   local-pending : has local config, cicy-code not healthy yet → wait
  //   unknown       : first probe in flight → behave like local-pending
  //   cloud-only    : no local installed → always-available cloud helper that
  //                   walks the user through installing Docker + cicy-code.
  //                   Shown on every launch until install lands a team in
  //                   cicyDesktopNodes (then state flips to local-ready/-pending).
  const isLocal   = state === "local-ready";
  const isPending = state === "unknown" || state === "local-pending";
  const isCloud   = state === "cloud-only";
  return (
    <div className="bcard bcard--helper">
      <div className="bcard__accent" />
      <div className="bcard__top">
        <div className="bcard__pill bcard__pill--helper">
          <span className="bcard__helper-icon">🤖</span>
          <span>小助手</span>
        </div>
        {isLocal ? (
          <span className="bcard__badge bcard__badge--local">本地常驻</span>
        ) : isPending ? (
          <span className="bcard__badge bcard__badge--local">本地启动中</span>
        ) : (
          <span className="bcard__badge bcard__badge--trial">30 分钟试用</span>
        )}
      </div>
      <div className="bcard__body">
        <h3 className="bcard__name">团队小助手</h3>
        {isLocal ? (
          <p className="bcard__desc">管理本地团队 · 升级 / 加新团队</p>
        ) : isPending ? (
          <p className="bcard__desc">本地小助手准备中，请稍候…</p>
        ) : (
          <>
            <p className="bcard__desc">协助您完成本地私有化团队部署</p>
            <p className="bcard__fineprint">过期后需购买会员</p>
          </>
        )}
      </div>
      <button type="button" className="bcard__cta bcard__cta--helper" onClick={onStart}>
        <span>{isLocal ? "打开助手" : isPending ? "等待本地" : "召唤助手"}</span>
      </button>
    </div>
  );
}

function HelperPlaceholder({ state = "unknown" }) {
  const pending = state === "unknown" || state === "local-pending";
  return (
    <div className="helper-placeholder">
      <div className="helper-placeholder__mark">🤖</div>
      <h3 className="helper-placeholder__title">团队助手</h3>
      {pending ? (
        <p className="helper-placeholder__sub">
          正在等待本地小助手就绪…<br />
          确保 cicy-code 已启动并监听 8008。就绪后会自动连接，无需刷新。
        </p>
      ) : (
        <p className="helper-placeholder__sub">
          点击「召唤助手」会启动 30 分钟试用版小助手，
          引导你装 Docker + cicy-code，帮你跑起第一个本地团队。
        </p>
      )}
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

function LocalTeamCard({ team, onOpen, onRename }) {
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
  return (
    <div data-id="LocalTeamCard" className={`bcard bcard--local${tone === "ok" ? " bcard--online" : ""}`}>
      <div className="bcard__accent" />
      <div className="bcard__top">
        <div className="bcard__pill">
          <span className="bcard__dot" data-tone={tone} />
          <LaptopIcon />
        </div>
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
          <span className="bcard__chip">{statusInfo.label}</span>
          {team.version && <span className="bcard__chip">v{team.version}</span>}
        </div>
      </div>
      <button
        type="button"
        className="bcard__cta"
        onClick={onOpen}
        disabled={team.status !== "running"}
      >
        <ArrowIcon />
        <span>{team.status === "running" ? "打开" : statusInfo.cta}</span>
      </button>
    </div>
  );
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

