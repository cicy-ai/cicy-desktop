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
  const [opMsg, setOpMsg] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [latest, setLatest] = useState(null); // newest cicy-code on the registry
  const menuWrap = useRef(null);

  // Look up the newest cicy-code once so we surface 更新 only when one actually
  // exists (no nagging when current). Renderer-side via cloud.fetch — main
  // proxies it, dodging CORS; no extra IPC needed.
  useEffect(() => {
    if (!local || !window.cicy?.cloud?.fetch) return;
    let alive = true;
    window.cicy.cloud
      .fetch("https://registry.npmmirror.com/cicy-code/latest")
      .then((r) => { if (alive && r?.ok) { try { setLatest(JSON.parse(r.body)?.version || null); } catch {} } })
      .catch(() => {});
    return () => { alive = false; };
  }, [local]);

  const updateAvailable = !!(local && latest && team.version && cmpVer(latest, team.version) > 0);
  // Custom (deeplink-added, non-local) nodes can be removed from the desktop —
  // it just drops them from cicyDesktopNodes; re-addable via deeplink. The
  // local sidecar isn't deletable here. So the ⋯ menu shows for a local card
  // with lifecycle, OR a custom card with just 删除.
  const isCustom = !local && !!window.cicy?.localTeams?.remove;
  const showMenu = (local && (running || updateAvailable)) || isCustom;

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

  const runOp = async (kind, fn, doneText) => {
    setMenuOpen(false);
    if (busy) return;
    setBusy(kind); setOpMsg("");
    try {
      const r = await fn();
      setOpMsg(r?.ok
        ? (r.warning ? `${doneText}（${r.warning}）` : doneText)
        : (tr("sidecar.failed", "操作失败") + (r?.error ? `: ${r.error}` : "")));
    } catch (err) {
      setOpMsg(tr("sidecar.failed", "操作失败") + `: ${err?.message || err}`);
    } finally {
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
      setBusy("start"); setOpMsg("");
      const r = await window.cicy.sidecar.start().catch((e) => ({ ok: false, error: e?.message || String(e) }));
      setBusy(""); onRefresh?.();
      if (!r?.ok || r?.warning) { // didn't come up — surface it, don't open a dead link
        setOpMsg(tr("sidecar.startFailed", "启动失败") + (r?.error ? `: ${r.error}` : r?.warning ? `: ${r.warning}` : ""));
        return;
      }
    }
    onOpen(); // open regardless of health — the window/page handles the rest
  };
  const openLabel = running
    ? tr("localTeams.open", "打开")
    : local
      ? tr("localTeams.startOpen", "启动并打开") // only the local sidecar can be started from here
      : tr("localTeams.open", "打开");           // custom/remote: 探活-only, just open
  return (
    <div data-id="LocalTeamCard" className={`bcard bcard--local${tone === "ok" ? " bcard--online" : ""}`}>
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
          {updateAvailable && (
            <span
              className="bcard__chip bcard__chip--new"
              data-id="LocalTeamCard-newbadge"
              title={`${tr("sidecar.updateTo", "更新到")} v${latest}`}
            >
              {tr("sidecar.newVersion", "新版")} v{latest}
            </span>
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
        {busy === "start" ? <Spinner /> : <ArrowIcon />}
        <span>{openLabel}</span>
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

