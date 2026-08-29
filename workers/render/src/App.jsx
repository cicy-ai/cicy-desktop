// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import "./App.css";
import { TERMS_VERSION, termsForDisplay } from "./termsText";
import { mdToHtml } from "./mdLite";
import { buildCustomTeamEditPatch } from "./custom-team-edit";

// i18n bridge exposed by homepage-preload (window.cicyI18n.t, locale from
// app.getLocale()). Returns the localized string, or `fallback` when the key
// is missing or we're running outside Electron.
const tr = (key, fallback, params) => {
  // 支持 {{name}} 插值:第三参是 { name: ... }。i18n 没命中时也对 fallback 插值。
  const interp = (s) => (params && typeof s === "string"
    ? s.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (params[k] != null ? String(params[k]) : m))
    : s);
  try {
    const v = window.cicyI18n?.t?.(key, params);
    return interp(v && v !== key ? v : fallback);
  } catch { return interp(fallback); }
};

const TOKEN_KEY = "cicy_token";
const ACCESS_TOKEN_KEY = "cicy_access_token";
const USER_ID_KEY = "cicy_user_id";
// 未登录直接进入(离线/访客):只用本地能力(自定义团队、本地 Docker 团队),云端功能等登录。
const GUEST_KEY = "cicy_guest";
const CLOUD_BASE = "https://cicy-ai.com";

// cicy-ai 云端页面(我的钱包/团队帐单/新加团队)统一开在 **profile 1** 的
// app 内标签里(profile 1 走 proxy),不再用系统外部浏览器。URL 保持 CLEAN —— 不带任何
// token(钱包/团队账单 URL 不要带 token,连一次性票据 ?t 也不要)。dash 用
// profile 1 自己的 cicy-ai.com 会话鉴权;没登录会跳 /login 再回来。`query` 是 /dash 之后
// 的部分,如 "/wallet" / "?team=14"。
const CLOUD_PROFILE = 1; // cicy-ai 云端页面用的 profile(走 proxy)
async function openCloudPage(query) {
  const url = `${CLOUD_BASE}/dash${query}`;
  try {
    if (window.cicy?.tabs?.openIn) { await window.cicy.tabs.openIn(CLOUD_PROFILE, url, "cicy-ai"); return; }
    window.cicy?.shell?.openExternal?.(url); // 兜底:旧 preload 没有 openIn 时仍走系统浏览器
  } catch { try { window.cicy?.shell?.openExternal?.(url); } catch {} }
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
  open({ teamId, fromVer, toVer, onRetry, title, kind } = {}) {
    drawerState = {
      teamId, title: title || null, fromVer: fromVer || null, toVer: toVer || null,
      kind: kind || "sidecar",   // "sidecar"(cicy-code 更新,有 stepper) | "app"(应用自更新,显进度条)
      status: "running",   // running | ready | done | error
      phase: "download",   // download | swap | done
      progress: null,      // app 自更新下载进度 {percent,transferred,total,bytesPerSec,etaSec}
      onInstall: null,     // app 自更新:下载完后「安装」回调
      logs: [],
      onRetry: onRetry || null,
      lastAt: Date.now(),
    };
    emitDrawer();
  },
  // app 自更新:更新下载进度条(不刷 log)。
  setProgress(p) {
    if (!drawerState) return;
    drawerState = { ...drawerState, status: "running", progress: p || drawerState.progress, lastAt: Date.now() };
    emitDrawer();
  },
  // app 自更新:下载完成,待用户点「安装」。
  ready({ onInstall, message } = {}) {
    if (!drawerState) return;
    const line = { id: ++drawerLogSeq, t: clockHHMMSS(), phase: "done", status: "done", message: message || tr("updateBanner.readyDrawer", "下载完成,点「安装」重启更新") };
    drawerState = { ...drawerState, status: "ready", phase: "done", progress: { ...(drawerState.progress || {}), percent: 100 }, onInstall: onInstall || null, minimized: false, logs: [...drawerState.logs, line], lastAt: Date.now() };
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
    const line = { id: ++drawerLogSeq, t: clockHHMMSS(), phase: "done", status, message: message || (ok ? tr("updateDrawer.done", "更新完成") : tr("updateDrawer.failed", "更新失败")) };
    drawerState = { ...drawerState, status, phase: "done", minimized: false, logs: [...drawerState.logs, line], lastAt: Date.now() };
    emitDrawer();
  },
  close() { drawerState = null; emitDrawer(); },
};
const DRAWER_PHASE_KEYS = ["download", "swap", "done"];
// 渲染期取 label(模块加载时 i18n 桥可能还没就绪 → 必须运行时算,否则非中文用户看到中文)。
const drawerPhaseLabel = (k) => ({
  download: tr("updateDrawer.phaseDownload", "下载"),
  swap: tr("updateDrawer.phaseSwap", "切换"),
  done: tr("updateDrawer.phaseDone", "完成"),
}[k] || k);
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
  const phaseIdx = DRAWER_PHASE_KEYS.findIndex((k) => k === st.phase);
  if (st.minimized) {
    return (
      <button type="button" className={`drawer-min drawer-min--${st.status}`} data-id="UpdateDrawer-restore" onClick={() => updateDrawer.restore()}>
        <span className="drawer-min__spark">{running ? <Spinner /> : st.status === "done" ? "✓" : st.status === "reboot" ? "⟳" : "!"}</span>
        <span className="drawer-min__label">{st.title || tr("updateDrawer.title", "更新 cicy-code")}{st.toVer ? ` · v${st.toVer}` : ""}</span>
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
              <div className="drawer__h">{st.title || tr("updateDrawer.title", "更新 cicy-code")}</div>
              <div className="drawer__sub">{st.fromVer ? `v${st.fromVer}` : tr("updateDrawer.current", "当前")} → {st.toVer ? `v${st.toVer}` : tr("updateDrawer.latest", "最新版")}</div>
            </div>
          </div>
          <div className="drawer__headbtns">
            <button type="button" className="drawer__x" data-id="UpdateDrawer-min" title={tr("updateDrawer.minimize", "最小化")} onClick={() => updateDrawer.minimize()} aria-label="minimize">‒</button>
          </div>
        </div>

        {st.kind !== "app" && (
        <div className="drawer__steps" data-id="UpdateDrawer-steps">
          {DRAWER_PHASE_KEYS.map((k, i) => {
            const label = drawerPhaseLabel(k);
            const done = st.status === "done" || i < phaseIdx;
            const active = i === phaseIdx && running;
            const err = st.status === "error" && i === phaseIdx;
            return (
              <div key={k} className={`drawer__step${active ? " is-active" : ""}${done ? " is-done" : ""}${err ? " is-error" : ""}`}>
                <span className="drawer__step-dot">{done ? "✓" : err ? "!" : i + 1}</span>
                <span className="drawer__step-label">{label}</span>
                {i < DRAWER_PHASE_KEYS.length - 1 && <span className="drawer__step-bar" />}
              </div>
            );
          })}
        </div>
        )}

        {/* app 自更新:醒目下载进度条(像 Docker 安装那样)*/}
        {st.progress && (() => {
          const pr = st.progress, mb = (b) => (b ? (b / 1048576).toFixed(1) : "0");
          return (
            <div className="drawer__dl" data-id="UpdateDrawer-dl">
              <div className="drawer__dl-head">
                <span className="drawer__dl-pct">{pr.percent || 0}%</span>
                <span className="drawer__dl-stats">
                  {pr.total ? `${mb(pr.transferred)} / ${mb(pr.total)} MB` : `${mb(pr.transferred)} MB`}
                  {pr.bytesPerSec ? ` · ${mb(pr.bytesPerSec)} MB/s` : ""}
                  {pr.etaSec ? ` · ${tr("updateBanner.eta", "剩 {{s}}s", { s: pr.etaSec })}` : ""}
                </span>
              </div>
              <div className="drawer__dl-track"><span className="drawer__dl-fill" style={{ width: `${pr.percent || 0}%` }} /></div>
            </div>
          );
        })()}

        <div className="drawer__log" data-id="UpdateDrawer-log" ref={logRef}>
          {st.logs.length === 0
            ? <div className="drawer__log-empty">{tr("updateDrawer.preparing", "准备中…")}</div>
            : st.logs.map((l) => (
              <div key={l.id} className="drawer__line" data-status={l.status}>
                <span className="drawer__t">{l.t}</span>
                <span className={`drawer__badge drawer__badge--${l.phase}`}>{drawerPhaseLabel(l.phase)}</span>
                <span className="drawer__linemsg">{l.message}</span>
              </div>
            ))}
        </div>

        {stuck && running && (
          <div className="drawer__hint" data-id="UpdateDrawer-stuck">
            {tr("updateDrawer.stuckHint", "正在等待新版本就绪，耗时比平常久。可以放到后台继续，完成或失败都会提示。")}
          </div>
        )}

        <div className="drawer__foot">
          {running ? (
            <>
              <span className="drawer__foot-status">{st.kind === "app" ? tr("updateBanner.downloading", "正在下载更新") + "…" : tr("updateDrawer.inProgress", "更新进行中…")}</span>
            </>
          ) : st.status === "ready" ? (
            <>
              <span className="drawer__foot-status is-done">{tr("updateBanner.readyShort", "下载完成")}</span>
              <button type="button" className="drawer__btn is-accent" data-id="UpdateDrawer-install" onClick={() => st.onInstall && st.onInstall()}>{tr("updateBanner.installBtn", "立即安装")}</button>
              <button type="button" className="drawer__btn" data-id="UpdateDrawer-later" onClick={() => updateDrawer.close()}>{tr("updateBanner.later", "稍后")}</button>
            </>
          ) : st.status === "error" ? (
            <>
              <span className="drawer__foot-status is-error">{tr("updateDrawer.failed", "更新失败")}</span>
              {st.onRetry && <button type="button" className="drawer__btn is-accent" data-id="UpdateDrawer-retry" onClick={() => st.onRetry()}>{tr("common.retry", "重试")}</button>}
              <button type="button" className="drawer__btn" data-id="UpdateDrawer-dismiss" onClick={() => updateDrawer.close()}>{tr("common.close", "关闭")}</button>
            </>
          ) : (
            <>
              <span className="drawer__foot-status is-done">{tr("updateDrawer.updatedLatest", "已更新到最新")}</span>
              <button type="button" className="drawer__btn is-accent" data-id="UpdateDrawer-finish" onClick={() => updateDrawer.close()}>{tr("common.done", "完成")}</button>
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

  // 全局兜底:任何 bootstrap/安装/修复进度(docker:app-progress)都让 drawer 可见 —— 不管是
  // 卡片按钮、程序触发、还是 renderer 重连后主进程还在跑。原则:后台不出日志 = 耍流氓。
  // 只接管「没人开 drawer」的情况(source==="auto"):某个 run*() 自己开的(source==="op")由它
  // 自己 push,这里不插手避免重复。"open" phase 是打开失败报告流,自管,跳过。
  useEffect(() => {
    if (!window.cicy?.docker?.onAppProgress) return;
    const unsub = window.cicy.docker.onAppProgress((ev) => {
      if (!ev || ev.phase === "open") return;
      if (!dockerDrawerState) dockerDrawer.open({ source: "auto" });
      if (dockerDrawerState?.source !== "auto") return; // 某 run*() 拥有 → 它 push,别重复
      if (ev.phase === "done" && (ev.status === "done" || ev.status === "reboot")) {
        dockerDrawer.finish({ ok: ev.status === "done", status: ev.status === "reboot" ? "reboot" : undefined, message: ev.message });
      } else if (ev.status === "error") {
        dockerDrawer.finish({ ok: false, message: ev.message });
      } else {
        dockerDrawer.push(ev);
      }
    });
    return () => { try { unsub && unsub(); } catch {} };
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
  // 访客模式:跳过登录进入主界面(本地功能可用)。登录成功即退出访客态。
  // 主页不要求登录:没有 token 就是访客,本地/自定义团队全部可用;登录卡已移除
  // (LOGIN_UI=false)。已有 token 的老用户照常显示云端团队。
  const LOGIN_UI = false;
  const [guest, setGuest] = useState(true);
  const enterGuest = () => setGuest(true);
  const leaveGuest = () => setGuest(true);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false); // login 请求在途:按钮 disable+loading,防重复点击,出错恢复
  const [loginUrl, setLoginUrl] = useState(""); // shown as a manual fallback when the browser doesn't auto-open
  // Email magic-link device-poll login (cross-device: the link works on a phone).
  const [email, setEmail] = useState("");
  const [emailSent, setEmailSent] = useState(false); // true once the link email is sent → "等待点击" state
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
  // 通用头像映射 { id: dataUrl } —— 本地/Docker/云端团队都按 id 取头像(云端团队不在
  // teams.json,所以单独拉一份映射,给所有卡片 + 打开 tab 时透传 avatar 用)。
  const [avatars, setAvatars] = useState({});
  const fetchAvatars = useCallback(async () => {
    try { const m = await window.cicy?.localTeams?.avatars?.(); setAvatars(m && typeof m === "object" ? m : {}); } catch {}
  }, []);
  // 「新加团队」下拉 + 自定义团队 modal: 点按钮出两个选项——自定义(本 modal 输 url/title)
  // 或私有云(跳云端团队中心)。自定义走 localTeams.add({base_url,name,api_token})。
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customTitle, setCustomTitle] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customBusy, setCustomBusy] = useState(false);
  const [customErr, setCustomErr] = useState("");
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
          setProfileError(tr("auth.sessionExpired", "会话已过期,正在重新登录…"));
          try { await window.cicy.auth.loginStart(); } catch {}
        }
        return;
      }
      // /api/teams drives the cloud team grid. On a transient failure (network /
      // 5xx) degrade SILENTLY: keep whatever teams we already have and let the
      // background sync retry — do NOT throw. 不把报错显示给用户,后台重试。
      // (Throwing here painted the homepage with a red "/api/teams …" error.)
      if (teamsRes?.ok) {
        const teamsBody = JSON.parse(teamsRes.body || "{}"); // bare: { teams: [...] }
        setTeams(Array.isArray(teamsBody?.teams) ? teamsBody.teams : []);
      } else {
        setTeams((t) => (t === null ? [] : t)); // 非 ok:首次加载也要 resolve,skeleton 才收场
      }
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
      // 不把报错显示给用户 —— 一个瞬时的云端/网络失败不该让首页飘红;后台
      // refreshCloudTeams 会按周期静默重试。清掉任何残留的错误态。
      setProfileError("");
      setTeams((t) => (t === null ? [] : t)); // 首次加载失败也让 teams resolve → skeleton 收场
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

  // 云端团队改名:PATCH /api/teams/<id> {title}(cicy-cloud-v1 handleTeamByID,
  // owner-only,bump title_version)。成功后重拉 teams 让新名字落地。让私有云卡也能
  // 改名,和本地/Docker 卡一致——区别是这个改的是云端、会同步到所有设备。
  const renameCloudTeam = useCallback(async (id, title) => {
    const at = bearerRef.current;
    const next = String(title || "").trim();
    if (!at || !window.cicy?.cloud?.fetch || !next) return { ok: false, error: "no session / empty" };
    try {
      const r = await window.cicy.cloud.fetch(`${CLOUD_BASE}/api/teams/${id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      if (r?.ok) { await refreshCloudTeams(); return { ok: true }; }
      return { ok: false, error: `${r?.status || "?"} ${r?.error || ""}` };
    } catch (e) { return { ok: false, error: e.message }; }
  }, [refreshCloudTeams]);

  // 改私有云的访问地址(host_url)—— 和改名同源,走云端 PATCH /api/teams/<id> {host_url}。
  // 成功后重拉云端团队,卡片地址即时更新(私有云可以改 url)。
  const updateCloudTeamUrl = useCallback(async (id, hostUrl) => {
    const at = bearerRef.current;
    const next = String(hostUrl || "").trim();
    if (!at || !window.cicy?.cloud?.fetch || !next) return { ok: false, error: "no session / empty" };
    try { new URL(next); } catch { return { ok: false, error: "地址格式不对(需 http(s)://…)" }; }
    try {
      // 云端 PATCH 收的是 **hostUrl(驼峰)**,虽然 GET /api/teams 返回的是 host_url(下划线)——
      // 实测过:host_url 会被忽略(400 nothing_to_update),hostUrl 才真正改(200)。
      const r = await window.cicy.cloud.fetch(`${CLOUD_BASE}/api/teams/${id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
        body: JSON.stringify({ hostUrl: next }),
      });
      if (r?.ok) { await refreshCloudTeams(); return { ok: true }; }
      return { ok: false, error: `${r?.status || "?"} ${r?.error || ""}` };
    } catch (e) { return { ok: false, error: e.message }; }
  }, [refreshCloudTeams]);

  // 删除私有云团队:确认后走云端 DELETE /api/teams/{id},成功后重拉云端列表 + toast。
  const deleteCloudTeam = useCallback(async (team) => {
    const at = bearerRef.current;
    if (!at || !window.cicy?.cloud?.fetch) { toast.show({ message: tr("common.noAuth", "未登录"), status: "error", ttl: 5000 }); return; }
    try {
      const r = await window.cicy.cloud.fetch(`${CLOUD_BASE}/api/teams/${team.id}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${at}` },
      });
      if (r?.ok || r?.status === 200 || r?.status === 204) {
        toast.show({ message: tr("teamCard.deleted", "团队已删除"), status: "done", ttl: 3000 });
        await refreshCloudTeams();
      } else {
        toast.show({ message: `${tr("teamCard.deleteFailed", "删除失败")}: ${r?.status || "?"} ${r?.error || ""}`, status: "error", ttl: 7000 });
      }
    } catch (e) { toast.show({ message: `${tr("teamCard.deleteFailed", "删除失败")}: ${e.message}`, status: "error", ttl: 7000 }); }
  }, [refreshCloudTeams]);

  // First profile fetch on mount. The cloud console endpoints (/api/user/self,
  // /api/teams) authenticate the owner-bound LOGIN token (the sk-xxx from the
  // /cb callback) — NOT the console access_token (the cloud never mints one;
  // sending it 401s). Prefer the login token; fall back to access_token only if
  // somehow that's all we have.
  useEffect(() => {
    const bearer = token || accessToken;
    if (bearer) fetchProfile(bearer, userId);
    // 没登录:teams 不会有 fetchProfile 去 resolve,直接置空 —— 否则 teams 恒 null →
    // firstLoading(localTeams===null || teams===null)永真 → 团队/Hub 区一直转 skeleton。
    else setTeams((t) => (t === null ? [] : t));
  }, [token, accessToken, userId, fetchProfile]);

  // Local teams: probe on mount (independent of cloud login — local team
  // discovery doesn't require a token). Fast-poll every 3s for the first
  // 30s so we catch cicy-code coming online shortly after desktop launch,
  // then settle to 30s.
  const fetchLocalTeams = useCallback(async () => {
    if (!window.cicy?.localTeams?.list) return;
    setLocalTeamsLoading(true);
    try {
      // 把**当前登录账号**(渲染层持久化的权威 userId)传给 main 的 list() —— 让它按这个账号
      // backfill 老团队归属 + 过滤,而不是让 main 自己去 global.json 猜(可能 stale/空 → 漏过滤)。
      const list = await window.cicy.localTeams.list({ refresh: true, uid: safeGet(USER_ID_KEY) || "" });
      setLocalTeams(Array.isArray(list) ? list : []);
    } catch {
      setLocalTeams([]);
    } finally {
      setLocalTeamsLoading(false);
      setLocalTeamsFetched(true);
    }
  }, []);
  // 自定义团队:输 url(必填)+ title + 可选 token → localTeams.add(upsert by base_url)。
  // 成功后关 modal、刷新、切到「自定义」tab。出错就地显示、可重试,按钮全程 disable+loading。
  async function submitCustom() {
    if (customBusy) return;
    const url = customUrl.trim();
    if (!url) { setCustomErr(tr("teams.urlRequired", "请输入地址 URL")); return; }
    try { new URL(url); } catch { setCustomErr(tr("teams.badUrl", "URL 无效(需含 http(s)://)")); return; }
    setCustomErr(""); setCustomBusy(true);
    try {
      const r = await window.cicy.localTeams.add({ base_url: url, name: customTitle.trim(), failIfExists: true });
      if (!r || r.ok === false) { setCustomErr(r?.error === "exists" ? tr("teams.urlExists", "该地址已存在") : humanError(r?.error || "add failed")); return; }
      // 先刷新列表(loading 全程覆盖到新卡出现),成功后再关 modal —— 否则关了之后到卡片
      // 刷出来之间那段没 loading。
      await fetchLocalTeams();
      setCustomTitle(""); setCustomUrl(""); setCustomOpen(false);
    } catch (e) {
      setCustomErr(humanError(e?.message || String(e)));
    } finally {
      setCustomBusy(false);
    }
  }
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
    // 3s 对账 = 每分钟几十个新 TCP 连接(每个团队一个云端请求),Windows 上 TIME_WAIT 堆到上万把
    // 动态端口耗尽(实测 15165 个 TIME_WAIT → 连 127.0.0.1:8008 都 EADDRINUSE)。改 30s/120s,
    // 切回可见/聚焦仍立即对账一次。
    const VISIBLE_MS = 30_000;
    const HIDDEN_MS = 120_000;

    // 一发对账:本地 title 拉进 teams.json + 刷新本地列表 + 重拉云端团队(私有云
    // host_url/名字/状态的同步)。三件事并行。
    const reconcile = async () => {
      try { await window.cicy?.localTeams?.syncCloud?.(); } catch {}
      await Promise.all([fetchLocalTeams(), refreshCloudTeams(), fetchAvatars()]);
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
      setEmailSent(false); // either flow completing clears the email "等待点击" state
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
        try { localStorage.removeItem(GUEST_KEY); } catch {}
        if (payload.accessToken) {
          try { localStorage.setItem(ACCESS_TOKEN_KEY, payload.accessToken); } catch {}
          setAccessToken(payload.accessToken);
        }
        if (payload.userId) {
          try { localStorage.setItem(USER_ID_KEY, String(payload.userId)); } catch {}
          setUserId(String(payload.userId));
        }
        setError("");
        setWelcome(payload.reused ? tr("auth.welcomeBack", "已恢复你之前的登录") : tr("auth.loginSuccess", "登录成功"));
        setTimeout(() => setWelcome(""), 3000);
      }
    });
  }, []);

  async function handleLogin() {
    if (loginBusy || loggingIn) return; // 防重复点击
    if (!window.cicy?.auth?.loginStart) {
      setError("auth bridge missing");
      return;
    }
    setError("");
    setLoginBusy(true); // 按钮 disable + loading
    try {
      const r = await window.cicy.auth.loginStart();
      if (!r?.ok) { setError(humanError(r?.error || "login start failed")); return; } // 出错:loginBusy 在 finally 恢复
      setLoginUrl(r.url || "");
      setLoggingIn(true); // 成功才切到"等待浏览器"视图
    } catch (e) {
      setError(humanError(e?.message || String(e)));
    } finally {
      setLoginBusy(false); // 无论成败都恢复(成功后视图已切走;失败/异常则按钮可再点)
    }
  }

  // Email magic-link device-poll login. Sends the link, then waits for the user
  // to click it on ANY device (the desktop polls the cloud) — fixes the loopback's
  // "clicked on my phone → desktop hangs" problem.
  async function handleEmailLogin() {
    if (loginBusy) return; // 防重复点击(连点会发多封邮件)
    if (!window.cicy?.auth?.emailLoginStart) {
      setError("auth bridge missing");
      return;
    }
    const addr = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
      setError(tr("auth.badEmail", "请输入有效的邮箱地址"));
      return;
    }
    setError("");
    setLoginBusy(true); // 按钮 disable + loading
    try {
      const r = await window.cicy.auth.emailLoginStart(addr);
      if (!r?.ok) { setError(humanError(r?.error || "email login failed")); return; }
      setEmailSent(true);
    } catch (e) {
      setError(humanError(e?.message || String(e)));
    } finally {
      setLoginBusy(false); // 出错恢复,可重试
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
          <div className="spinner-row"><Spinner /><span>{tr("auth.restoring", "正在恢复登录…")}</span></div>
        </div>
      </div>
    );
  }

  // Not logged in yet → centered login card (unless the user chose to continue
  // as a guest: local-only features, login available from the header).
  if (LOGIN_UI && !token && !guest) {
    return (
      <div className="shell">
        <div className="glow" aria-hidden />
        <div className="card">
          <Brand />
          {!loggingIn && !emailSent && (
            <>
              <p className="tagline">{tr("auth.tagline", "登录以同步你的团队、配置与 AI 助手")}</p>
              {/* Email magic-link is the PRIMARY login: it's cross-device safe (the
                  link works when clicked on a phone). The browser/loopback login is
                  demoted to a secondary option below — its link 302s to 127.0.0.1 and
                  only completes on the SAME machine, so a phone click breaks it. */}
              <label className="login-label" data-id="EmailLoginLabel" htmlFor="cicy-email-login">
                {tr("auth.emailLabel", "输入邮箱,用邮件链接登录")}
              </label>
              <input
                id="cicy-email-login"
                type="email"
                className="login-email-input"
                data-id="EmailLoginInput"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleEmailLogin(); }}
                placeholder={tr("auth.emailPlaceholder", "you@example.com")}
                autoComplete="email"
                spellCheck={false}
                autoFocus
              />
              <button className="btn-primary" data-id="EmailLoginSubmit" onClick={handleEmailLogin} disabled={loginBusy}>
                {loginBusy
                  ? <><Spinner /><span>{tr("auth.sending", "发送中…")}</span></>
                  : <><span>{tr("auth.emailLogin", "发送登录链接")}</span><ArrowIcon /></>}
              </button>
              <p className="hint">{tr("auth.emailHint", "手机上点邮件里的链接,也能登录这台电脑")}</p>
              <div className="login-divider" data-id="LoginDivider"><span>{tr("auth.or", "或")}</span></div>
              <button className="btn-ghost" data-id="BrowserLoginBtn" onClick={handleLogin} disabled={loginBusy}>
                {loginBusy ? tr("auth.opening", "打开中…") : tr("auth.browserLogin", "用浏览器登录(Google / SSO,仅同一台电脑)")}
              </button>
              {/* 不登录也能用本地能力:自定义团队(连已有 cicy-code 地址)、本地 Docker 团队。 */}
              <button type="button" className="btn-ghost" data-id="SkipLoginBtn" onClick={enterGuest} disabled={loginBusy}
                style={{ marginTop: 8, opacity: .85 }}>
                {tr("auth.skipLogin", "先不登录，添加自定义团队")}
              </button>
              <p className="hint" data-id="SkipLoginHint">{tr("auth.skipLoginHint", "不登录只能使用本地功能；云端团队、账单等需登录后使用")}</p>
            </>
          )}
          {emailSent && (
            <>
              <p className="tagline" data-id="EmailSentTagline">{tr("auth.emailSentTagline", "登录邮件已发送")}</p>
              <p className="hint" data-id="EmailSentHint" style={{ textAlign: "center" }}>
                {tr("auth.emailSentHint", "到邮箱打开链接即可（手机、电脑都行），这里会自动登录。")}
                <br />{email}
              </p>
              <div className="spinner-row">
                <Spinner />
                <span>{tr("auth.emailWaiting", "等待确认…")}</span>
              </div>
              <button className="btn-ghost" data-id="EmailSentCancel" onClick={() => {
                window.cicy?.auth?.emailLoginCancel?.();
                setEmailSent(false);
              }}>{tr("auth.cancel", "取消")}</button>
            </>
          )}
          {loggingIn && (
            <>
              <p className="tagline">{tr("auth.waitingTagline", "已在浏览器打开登录页，等待你完成…")}</p>
              <div className="spinner-row">
                <Spinner />
                <span>{tr("auth.waitingCallback", "等待回调")}</span>
              </div>
              {loginUrl && (
                <div className="login-fallback" data-id="LoginUrlFallback" style={{ marginTop: 10, textAlign: "center" }}>
                  <p className="hint" style={{ marginBottom: 6 }}>{tr("auth.browserNotOpened", "浏览器没自动打开?")}</p>
                  <button className="btn-ghost" data-id="LoginUrlFallback-open"
                    onClick={() => { try { window.cicy?.shell?.openExternal?.(loginUrl); } catch {} }}>{tr("auth.openManually", "手动打开登录页")}</button>
                  <button className="btn-ghost" data-id="LoginUrlFallback-copy"
                    onClick={() => { try { navigator.clipboard?.writeText(loginUrl); setWelcome(tr("auth.linkCopied", "链接已复制,粘到浏览器打开")); setTimeout(() => setWelcome(""), 2500); } catch {} }}>{tr("auth.copyLink", "复制链接")}</button>
                  <p className="hint" data-id="LoginUrlFallback-url" style={{ wordBreak: "break-all", marginTop: 6, fontSize: 11, opacity: 0.7, userSelect: "text" }}>{loginUrl}</p>
                </div>
              )}
              <button className="btn-ghost" onClick={() => {
                window.cicy?.auth?.loginCancel?.();
                setLoggingIn(false);
                setLoginUrl("");
              }}>{tr("auth.cancel", "取消")}</button>
            </>
          )}
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    );
  }

  // Logged in: unified tabs + cards grid on the left, full-height webview
  // drawer on the right.
  // The Docker-版 cicy-code on :8008 has its own dedicated <DockerCard> (right of
  // the local card), so pull it out of the generic node list — else it'd ALSO
  // render as a 自定义 card (the bootstrap registers it as a team for the
  // token-injected 打开/刷新 flow).
  const dockerTeam = (localTeams || []).find((t) => isDockerApp(t.base_url)) || null;
  // Docker 现在是个普通云端 team(POST /api/teams,kind=cloud),title/改名与其它团队
  // 完全同一套:按 cloud_team_id 在 teams(refreshCloudTeams 周期刷新)里找到它的云端
  // team → 读 title(云端→本地自动同步,同节奏)、改名走 renameCloudTeam(PATCH)。
  const dockerCloudTeam = (dockerTeam && dockerTeam.cloud_team_id)
    ? (teams || []).find((t) => String(t.teamId || t.id) === String(dockerTeam.cloud_team_id))
    : null;
  // Map a cloud_team_id → the team's short non-guessable URL code (from /api/teams),
  // used for the 账单 deeplink so the URL isn't an enumerable sequential id.
  const cloudCodeFor = (cloudTeamId) => {
    if (!cloudTeamId) return null;
    const ct = (teams || []).find((t) => String(t.teamId || t.id) === String(cloudTeamId));
    return (ct && ct.code) || null;
  };
  // Split the cicyDesktopNodes list into 本地 (the localhost:8008 sidecar the
  // desktop owns — full lifecycle) vs 自定义 (deeplink-added nodes, usually
  // remote — probe-only, no restart/stop/update, just 打开).
  const localList  = (localTeams || []).filter((t) => isLocalSidecar(t.base_url));
  const customList = (localTeams || []).filter((t) => !isLocalSidecar(t.base_url) && !isDockerApp(t.base_url));
  // Windows 的本地团队是 Docker :8008(dockerTeam,单独 <DockerCard> 渲染,不在 localList),
  // 所以「本地」计数要把它算上 —— 否则 Windows 明明有 1 个本地却显示 0。dockerTeam 只在 Windows
  // 有值(isDockerApp win32-only),mac/linux 恒 null,不影响。
  const localCount = localList.length + (dockerTeam ? 1 : 0);
  const customCount = customList.length;
  // /api/teams returns ALL of this owner's teams — including kind=local ones
  // (this device's AND other devices'). On the desktop the 云端 tab must show
  // ONLY cloud teams; local teams come from the local store (localList) and
  // cross-device local aggregation belongs to the web dash, not here.
  // 不展示「共享」团队(共享 = 非私有云 且 非个人)。只留 私有云 / 个人。
  const cloudList = (teams || []).filter((t) => !t.is_local && t.kind !== "local"
    && (t.kind === "private" || t.team_kind === "personal"));
  const cloudCount = cloudList.length;
  const showLocal = tab === "all" || tab === "local";
  const showCustom = tab === "all" || tab === "custom";
  const showCloud = tab === "all" || tab === "cloud";
  // 首次打开:本地或云端团队任一还没拉到(为 null)→ grid 显示 skeleton 占位卡,直到两边都
  // resolve(出错也 resolve 成 []),再显示真实内容 —— 避免一个先回来另一个还空的露馅。
  const firstLoading = localTeams === null || teams === null;

  return (
    <div className="shell shell--app">
      <div className="glow glow--app" aria-hidden />
      <div className="shell__left">
      <Header me={me} welcome={welcome} onLogout={handleLogout}
        guest={!token && guest} onLogin={leaveGuest}
        mitmTeam={localList.length > 0 ? localList[0] : null} />
      <UpdateBanner />
      <main className="main">
        {/* 整行:左边 tab 药丸,右边「新加团队」顶到行尾 */}
        <div className="app__tabsrow">
          <div className="app__tabs">
            {[
              { k: "all",    label: tr("teamFilter.all", "全部"),   n: localCount + customCount + cloudCount },
              { k: "local",  label: tr("teamFilter.local", "本地"),   n: localCount },
              { k: "cloud",  label: tr("teamFilter.cloud", "私有云"), n: cloudCount },
              { k: "custom", label: tr("teamFilter.custom", "自定义"), n: customCount },
            ].filter(({ k }) => k !== "cloud" || token).map(({ k, label, n }) => (
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
          {/* 行尾:新加团队 → 直接去云端团队中心添加(私有云)。自定义入口已删。 */}
          <div data-id="AddTeamWrap" style={{ position: "relative" }}>
            <button
              type="button"
              data-id="AddTeamButton"
              className="app__add-team"
              title={tr("teams.addHint", "添加团队")}
              onClick={() => setAddMenuOpen((v) => !v)}
            >
              + {tr("teams.add", "新加团队")}
            </button>
            {addMenuOpen && (
              <>
                <div onClick={() => setAddMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                <div data-id="AddTeamMenu" role="menu" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 41, minWidth: 240, background: "var(--card, #1b1d22)", border: "1px solid var(--border, #2c2f36)", borderRadius: 10, boxShadow: "0 10px 30px rgba(0,0,0,.45)", overflow: "hidden" }}>
                  <button type="button" data-id="AddTeamMenu-custom" className="bcard__menu-item" style={{ display: "block", width: "100%", textAlign: "left", padding: "11px 14px", border: "none", background: "transparent", cursor: "pointer", color: "inherit" }}
                    onClick={() => { setAddMenuOpen(false); setCustomErr(""); setCustomOpen(true); }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{tr("teams.addCustom", "自定义团队")}</div>
                    <div style={{ fontSize: 11, opacity: .6, marginTop: 2 }}>{tr("teams.addCustomSub", "手动输入地址和名称(只存本地)")}</div>
                  </button>
                  {token && (
                  <button type="button" data-id="AddTeamMenu-private" className="bcard__menu-item" style={{ display: "block", width: "100%", textAlign: "left", padding: "11px 14px", border: "none", borderTop: "1px solid var(--border, #2c2f36)", background: "transparent", cursor: "pointer", color: "inherit" }}
                    onClick={() => { setAddMenuOpen(false); openCloudPage("?tab=private"); }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{tr("teams.addPrivate", "私有云团队")}</div>
                    <div style={{ fontSize: 11, opacity: .6, marginTop: 2 }}>{tr("teams.addPrivateSub", "去云端团队中心添加")}</div>
                  </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* 自定义团队 modal:输 名称 + 地址 URL + 可选 token → localTeams.add */}
        {customOpen && (
          <div data-id="CustomTeamModal" style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.5)" }}
            onMouseDown={(e) => { if (!customBusy && e.target === e.currentTarget) setCustomOpen(false); }}>
            <div onClick={(e) => e.stopPropagation()} style={{ width: 400, maxWidth: "92vw", background: "var(--card, #1b1d22)", border: "1px solid var(--border, #2c2f36)", borderRadius: 14, padding: 22, boxShadow: "0 20px 60px rgba(0,0,0,.5)" }}>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{tr("teams.customTitle", "添加自定义团队")}</div>
              <div style={{ fontSize: 12, opacity: .6, marginBottom: 16 }}>{tr("teams.customSub", "连接到一个已有的 cicy-code 地址")}</div>

              <label style={{ display: "block", fontSize: 12, opacity: .75, marginBottom: 6 }}>{tr("teams.customNameLabel", "名称")}</label>
              <input data-id="CustomTeamModal-title" className="login-email-input" style={{ width: "100%", marginBottom: 14 }}
                value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} placeholder={tr("teams.customNamePlaceholder", "我的团队")} spellCheck={false} autoFocus />

              <label style={{ display: "block", fontSize: 12, opacity: .75, marginBottom: 6 }}>{tr("teams.customUrlLabel", "地址 URL")}</label>
              <input data-id="CustomTeamModal-url" className="login-email-input" style={{ width: "100%", marginBottom: 6 }}
                value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} placeholder="https://example.com:8008" spellCheck={false}
                onKeyDown={(e) => { if (e.key === "Enter") submitCustom(); }} />

              {customErr && <div className="error" style={{ marginTop: 10 }}>{customErr}</div>}

              <div className="modal-actions">
                <button type="button" className="btn-ghost" data-id="CustomTeamModal-cancel" disabled={customBusy} onClick={() => setCustomOpen(false)}>{tr("common.cancel", "取消")}</button>
                <button type="button" className="btn-primary" data-id="CustomTeamModal-submit" disabled={customBusy} onClick={submitCustom}>
                  {customBusy ? tr("teams.adding", "添加中…") : tr("teams.addAction", "添加")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Docker 安装卡已下线 : Windows 走原生 cicy-code.exe --helper,不再用 Docker。 */}
        {/* HTTPS 审计 tip(MitmConsentCard)已移入右上角用户菜单(user-chip 下拉)。 */}

        {profileError && (
          <div className="error" style={{ marginBottom: 12 }}>
            {tr("common.cloud", "云端")}: {profileError}
            <button className="btn-ghost" style={{ marginLeft: 8 }} onClick={() => fetchProfile(token || accessToken, userId)}>
              {tr("common.retry", "重试")}
            </button>
          </div>
        )}

        <div className="app__grid">
          {firstLoading && [0, 1, 2].map((i) => <SkeletonCard key={"skc" + i} />)}
          {!firstLoading && showLocal && localList.map((t) => (
            <LocalTeamCard key={"local:" + t.id} team={t} cloudCode={cloudCodeFor(t.cloud_team_id)} onOpen={() => openLocalTeam(t.id)} onRename={renameLocalTeam} onRefresh={fetchLocalTeams} />
          ))}
          {/* native :8008 退役 —— 不再有"本地团队 正在启动"占位卡(native 已删,
              :8008 永远不会起来,占位会一直转)。cicy-code 用下面的 Docker 卡(:8008)。 */}
          {!firstLoading && showLocal && (
            <DockerCard
              dockerTeam={dockerTeam}
              onOpen={async () => {
                // Always open via the live-token path: re-reads the container's
                // own api_token and refuses to open a tokenless/host-token page
                // (必须拿到 token 才能打开,否则被卡在登录页).
                try {
                  const r = await window.cicy?.docker?.appOpen?.();
                  if (!r?.ok) toast.show({ id: "docker-open", status: "error", ttl: 6000, message: tr("docker.openNoToken", "服务还没就绪,稍等几秒再点「打开」(或用卡片菜单「重启」)。") });
                } catch (e) { console.warn("[DockerCard] open", e); }
              }}
              cloudTitle={dockerCloudTeam?.title}
              cloudCode={dockerCloudTeam?.code}
              onRename={dockerTeam?.cloud_team_id ? ((title) => renameCloudTeam(dockerTeam.cloud_team_id, title)) : undefined}
              onRefresh={fetchLocalTeams}
            />
          )}
          {!firstLoading && showCustom && customList.map((t) => (
            <LocalTeamCard key={"custom:" + t.id} team={t} cloudCode={cloudCodeFor(t.cloud_team_id)} onOpen={() => openLocalTeam(t.id)} onRename={renameLocalTeam} onRefresh={fetchLocalTeams} />
          ))}
          {!firstLoading && showCloud && cloudList.map((t) => (
            <TeamCard
              key={"cloud:" + t.id}
              team={t}
              onOpen={() => {
                // private:开 host_url(自托管地址);历史 cloud:开 workspace_url。
                // Open as a TAB in the current profile (like the local card), NOT
                // the system browser.
                const url = t.kind === "private" ? t.host_url : (t.workspace_url || t.workspace_direct_url);
                if (url) window.cicy?.tabs?.open?.(url, t.name || t.title || "", avatars[t.id] || "", true, t.id);
              }}
              avatar={avatars[t.id] || ""}
              onAvatar={fetchAvatars}
              onRename={renameCloudTeam}
              onEditUrl={updateCloudTeamUrl}
              onDelete={deleteCloudTeam}
            />
          ))}
        </div>

        {!profileLoading && !profileError && teams && teams.length === 0 && !localTeams?.length && (
          <div className="empty" style={{ marginTop: 14 }}>
            {tr("teams.emptyHint", "还没有团队 — 安装本地 cicy-code 起一个本地 team，或在云端创建。")}
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
    <div style={S.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-id="TrustedSitesModal">
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
    <div style={S.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-id="AuditLogModal">
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

function Header({ me, welcome, onLogout, mitmTeam, guest = false, onLogin }) {
  const name = me?.display_name || me?.username || "…";
  const initials = (name || "?").slice(0, 1).toUpperCase();
  const [open, setOpen] = useState(false);
  // 账号版本档位(个人版/团队版/企业版)—— 账号级,来自 tunnelStatus()=GET /api/gateway/tunnels
  // 的 tier 字段(personal|team|enterprise)。~分钟级刷新以反映升/降档。
  const [tier, setTier] = useState("");
  useEffect(() => {
    if (!window.cicy?.sidecar?.tunnelStatus) return;
    let stop = false;
    const load = () => window.cicy.sidecar.tunnelStatus().then((r) => {
      if (stop || !r?.ok) return;
      // 优先用云端 tier;老后端(v2.2.72 前)没这字段 → 按 w-10122 规则从 tunnel_limit 推:
      // 0→personal / N>0→team / -1→enterprise。
      let tv = r.tier;
      if (!tv) {
        const lim = Number(r.tunnelLimit ?? r.tunnel_limit);
        if (Number.isFinite(lim)) tv = lim < 0 ? "enterprise" : lim > 0 ? "team" : "personal";
      }
      if (tv) setTier(String(tv));
    }).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  const [trustOpen, setTrustOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [checkingUpd, setCheckingUpd] = useState(false);
  const [appVer, setAppVer] = useState("");
  const wrap = useRef(null);
  // cicy-desktop's own version, shown at the very bottom of this menu.
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
  const copyEmail = async () => {
    const email = String(me?.email || "").trim();
    if (!email) return;
    try {
      if (window.cicy?.clipboard?.write) await window.cicy.clipboard.write(email);
      else await navigator.clipboard.writeText(email);
      setOpen(false);
      toast.show({ message: tr("userMenu.emailCopied", "邮箱已复制"), status: "done", ttl: 2500 });
    } catch {
      toast.show({ message: tr("userMenu.emailCopyFailed", "邮箱复制失败"), status: "error", ttl: 3500 });
    }
  };
  // 主动检查更新:有新版 → updater 广播 → 顶部 banner 出现;最新/出错 → toast 反馈。
  const checkUpdate = async () => {
    setOpen(false); setCheckingUpd(true);
    toast.show({ id: "app-update", message: tr("updateBanner.checking", "正在检查更新…"), status: "running" });
    try {
      const s = await window.cicy?.app?.checkUpdate?.();
      if (s?.status === "available") toast.show({ id: "app-update", message: tr("updateBanner.available", "发现新版本 v{{v}}", { v: s.version }), status: "done", ttl: 4000 });
      else if (s?.status === "up-to-date") toast.show({ id: "app-update", message: tr("updateBanner.upToDate", "已是最新版本 v{{v}}", { v: s.version || s.current }), status: "done", ttl: 3000 });
      else toast.show({ id: "app-update", message: tr("updateBanner.error", "更新失败") + (s?.error ? `:${s.error}` : ""), status: "error", ttl: 5000 });
    } catch (e) { toast.show({ id: "app-update", message: e.message, status: "error", ttl: 5000 }); }
    finally { setCheckingUpd(false); }
  };
  // 用户版本徽章(个人版/团队版/企业版)—— tier 来自 tunnelStatus()。规范值映射,未知原样,空不渲染。
  const planTxt = (() => {
    const raw = String(tier || "").toLowerCase().trim();
    if (!raw) return "";
    const map = { personal: tr("plan.personal", "个人版"), team: tr("plan.team", "团队版"), enterprise: tr("plan.enterprise", "企业版") };
    return map[raw] || raw;
  })();
  return (
    <>
    <header className="topbar">
      {/* logo 移到 tab-shell 的「我的团队」标签(CICY_LOGO),topbar 不再重复显示品牌 */}
      <div className="user-chip" data-id="UserChip" ref={wrap}>
        {welcome && <span className="welcome">{welcome}</span>}
        {/* 账号版本徽标 —— user-chip 行内的独立元素(不写进 avatar 按钮,点它不展开菜单),
            靠 user-chip 的 inline-flex 排在头像左边 */}
        {planTxt && (
          <span data-id="UserChip-plan" className="plan-badge" title={tr("plan.hint", "当前账号版本")}
            style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.6, padding: "2px 9px", borderRadius: 999, whiteSpace: "nowrap", background: "var(--accent-soft, rgba(120,140,255,.16))", color: "var(--accent, #9db0ff)" }}>
            {planTxt}
          </span>
        )}
        {guest ? (
          // 访客:同样的头像下拉(受信任站点/审计/协议/检查更新都不依赖登录),
          // 菜单里用「登录」替代「退出」;账号相关项(邮箱/钱包)不显示。
          <button type="button" data-id="UserChip-trigger" className={`user-chip__trigger${open ? " is-open" : ""}`}
            onClick={() => setOpen((v) => !v)}>
            <div className="avatar" style={{ background: "var(--border, #2c2f36)", color: "var(--muted, #8b8b92)" }}>?</div>
            <span className="user-name">{tr("auth.localName", "本机")}</span>
            <span className="user-chip__caret" aria-hidden>▾</span>
          </button>
        ) : !me ? (
          // 首次打开:profile 还没拉到 → avatar/名字用 skeleton 占位
          <div className="user-chip__trigger user-chip__trigger--skel" data-id="UserChip-skeleton" aria-hidden>
            <div className="skel skel--avatar" />
            <div className="skel skel--name" />
          </div>
        ) : (
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
        )}
        {open && (
          <div className="user-chip__menu" data-id="UserChip-menu" role="menu">
            {!guest && me?.email && (
              <button type="button" data-id="UserChip-email-copy" className="user-chip__menu-item" title={tr("userMenu.copyEmail", "点击复制邮箱")} onClick={copyEmail}
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {me.email}
              </button>
            )}
            <button type="button" data-id="UserChip-trusted-sites" className="user-chip__menu-item" onClick={() => { setOpen(false); setTrustOpen(true); }}>
              {tr("trustedSites.menu", "受信任站点")}
            </button>
            <button type="button" data-id="UserChip-audit-log" className="user-chip__menu-item" onClick={() => { setOpen(false); setAuditOpen(true); }}>
              {tr("audit.menu", "审计日志")}
            </button>
            <button type="button" data-id="UserChip-terms" className="user-chip__menu-item" onClick={() => { setOpen(false); setTermsOpen(true); }}>
              {tr("firstRunTerms.menu", "用户协议")}
            </button>
            <button type="button" data-id="UserChip-check-update" className="user-chip__menu-item" disabled={checkingUpd} onClick={checkUpdate}>
              {checkingUpd ? tr("updateBanner.checkingShort", "检查中…") : tr("updateBanner.checkBtn", "检查更新")}
            </button>
            {/* HTTPS 审计入口暂时隐藏 */}
            {false && mitmTeam && (
              <div className="user-chip__menu-mitm" data-id="UserChip-mitm" onClick={(e) => e.stopPropagation()}>
                <MitmConsentCard team={mitmTeam} variant="menu" />
              </div>
            )}
            <div className="user-chip__menu-sep" aria-hidden />
            {!guest && (
              <button type="button" data-id="UserChip-logout" className="user-chip__menu-item is-danger" onClick={() => { setOpen(false); onLogout(); }}>
                {tr("userMenu.logout", "退出")}
              </button>
            )}
            <div className="user-chip__menu-version" data-id="UserChip-version">
              CiCy Desktop {appVer ? `v${appVer}` : "…"}
            </div>
          </div>
        )}
      </div>
    </header>
    {/* 这些 modal 必须渲染在 .topbar 之外:.topbar 有 backdrop-filter,会成为
        position:fixed 的包含块,放在里面会让 modal 被限制在顶栏区域(位置不对)。 */}
    {trustOpen && <TrustedSitesModal onClose={() => setTrustOpen(false)} />}
    {auditOpen && <AuditLogModal onClose={() => setAuditOpen(false)} />}
    {termsOpen && <FirstRunTermsGate onClose={() => setTermsOpen(false)} />}
    </>
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
  const [busy, setBusy] = useState(false);
  const locale = (window.cicyI18n?.locale || "en").startsWith("zh") ? "zh-CN" : "en";
  const t = (k, fb) => tr(`firstRunTerms.${k}`, fb);
  const review = !!onClose; // opened from the avatar menu to re-read — not the blocking first-run gate
  const html = useMemo(() => mdToHtml(termsForDisplay(locale)), [locale]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) setScrolledEnd(true);
  };
  // Short content that never scrolls → unlock immediately.
  const bodyRef = useRef(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 24) setScrolledEnd(true);
  }, []);

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
          <div className="terms-md" data-id="FirstRunTermsGate-md" dangerouslySetInnerHTML={{ __html: html }} />
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
  // card, no portal pill. Used inside the user menu (tip 要和 menu 风格统一).
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
  open({ onRetry, kind, source } = {}) {
    // kind: "install"(默认,安装/升级,带 4 段 stepper)| "open"(打开失败报告,纯日志+hint,无 stepper)
    // source: "op"(默认,某个 run* 函数开的,它自己订阅 push)| "auto"(全局兜底监听开的,
    //   用于程序触发/renderer 重连后还在跑的 bootstrap —— 全局监听负责 push,保证后台不静默)
    dockerDrawerState = { status: "running", phase: "install-docker", kind: kind || "install", source: source || "op", logs: [], bars: {}, minimized: false, onRetry: onRetry || null, lastAt: Date.now() };
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
    // scroll-spam (下载不要输出滚动/日志太多).
    if (isDl && (hasPct || ev.dest || ev.url)) {
      const prev = dockerDrawerState.bars?.[phase] || {};
      const progress = hasPct ? ev.progress : (ev.status === "skip" || ev.status === "done") ? 100 : prev.progress;
      next.bars = { ...dockerDrawerState.bars, [phase]: { progress, received: ev.received ?? prev.received, total: ev.total ?? prev.total, url: ev.url || prev.url, dest: ev.dest || prev.dest } };
    }
    // Log only milestone events — never the per-% running download ticks.
    const isRunningTick = ev.status === "running" && hasPct && isDl;
    if (!isRunningTick) {
      // 去重:两条订阅(全局兜底 + 某 run*() 自己的)偶发对同一事件各 push 一次 → 日志重复。
      // 末行 phase/status/message 完全相同则跳过(兜底,不影响正常重复行很少的场景)。
      const last = dockerDrawerState.logs[dockerDrawerState.logs.length - 1];
      const st = ev.status || "running";
      const msg = ev.message || "";
      if (!(last && last.phase === phase && last.status === st && last.message === msg)) {
        const line = { id: ++dockerDrawerLogSeq, t: clockHHMMSS(), phase, status: st, message: msg };
        next.logs = [...dockerDrawerState.logs, line];
      }
    }
    dockerDrawerState = next;
    emitDockerDrawer();
  },
  finish({ ok, message, status } = {}) {
    if (!dockerDrawerState) return;
    // 幂等:已经进了终态就别再 finish(否则 bootstrap emit / runBootstrap 收尾 /
    // checkStatus 自愈 三条路径各写一遍「已就绪」→ 重复日志)。只第一个终态生效。
    if (dockerDrawerState.status !== "running") return;
    // status can be forced (e.g. "reboot" — not a failure, just needs a restart).
    const st = status || (ok ? "done" : "error");
    // On FAILURE keep the phase where it actually broke, so the "!" lands on the
    // failing step (e.g. 启动服务) and earlier steps stay ✓. Only success/reboot
    // advance to the 完成 step — a step literally named "完成" showing 安装失败 is
    // nonsense (bug: "为什么安装失败了,还完成").
    const phase = st === "error" ? dockerDrawerState.phase : "done";
    const line = { id: ++dockerDrawerLogSeq, t: clockHHMMSS(), phase, status: st, message: message || (ok ? "完成" : "失败") };
    // Pop back open on finish so the user sees the result even if minimized.
    dockerDrawerState = { ...dockerDrawerState, status: st, phase, minimized: false, logs: [...dockerDrawerState.logs, line], lastAt: Date.now() };
    emitDockerDrawer();
  },
  close() { dockerDrawerState = null; emitDockerDrawer(); },
};
const DOCKER_PHASES = [["install-docker", "准备环境"], ["image", "下载运行环境"], ["container", "启动服务"], ["done", "完成"]];
const DOCKER_BADGE = { "install-docker": "准备", image: "下载", container: "启动", health: "启动", done: "完成", open: "打开" };
const DOCKER_DL_LABEL = { "install-docker": "Docker Desktop", image: "基础镜像" };
function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}
// One fixed (non-scrolling) progress bar per download (Docker Desktop / image),
// showing the source URL + % + bytes (下载做进度条、显示地址、不要滚动).
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
  const isOpen = st.kind === "open"; // 打开失败报告:无安装 stepper、标题/失败标签用「打开」
  const phaseIdx = DOCKER_PHASES.findIndex(([k]) => k === st.phase);
  const dlBars = isOpen ? [] : ["install-docker", "image"].filter((k) => st.bars?.[k]);
  const drawerTitle = isOpen ? tr("docker.openTitle", "打开 Docker 团队") : tr("docker.setupTitle", "安装 Docker cicy-code");
  // Minimized → a floating restore chip (op keeps running in the background).
  if (st.minimized) {
    const pcts = dlBars.map((k) => st.bars[k]?.progress).filter(Number.isFinite);
    const overall = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;
    return (
      <button type="button" className={`drawer-min drawer-min--${st.status}`} data-id="DockerDrawer-restore" onClick={() => dockerDrawer.restore()}>
        <span className="drawer-min__spark">{running ? <Spinner /> : st.status === "done" ? "✓" : st.status === "reboot" ? "⟳" : "!"}</span>
        <span className="drawer-min__label">{drawerTitle}{overall != null ? ` · ${overall}%` : ""}</span>
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
              <div className="drawer__h">{drawerTitle}</div>
              <div className="drawer__sub">127.0.0.1:8008</div>
            </div>
          </div>
          <div className="drawer__headbtns">
            <button type="button" className="drawer__x" data-id="DockerDrawer-min" title={tr("common.minimize", "最小化")} onClick={() => dockerDrawer.minimize()} aria-label="minimize">‒</button>
          </div>
        </div>

        {!isOpen && <div className="drawer__steps" data-id="DockerDrawer-steps">
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
        </div>}

        {dlBars.length > 0 && (
          <div className="drawer__dlbars" data-id="DockerDrawer-dlbars">
            {dlBars.map((k) => <DownloadBar key={k} phaseKey={k} bar={st.bars[k]} />)}
          </div>
        )}

        {/* Prominent "what's happening NOW" line — so a download bar at 100% is
            never mistaken for the whole flow being done (bug). */}
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
                <span className={`drawer__badge drawer__badge--${l.phase}`}>{tr(`dockerBadge.${l.phase}`, DOCKER_BADGE[l.phase] || l.phase)}</span>
                <span className="drawer__linemsg">{l.message}</span>
              </div>
            ))}
        </div>

        <div className="drawer__foot">
          {running ? (
            <>
              <span className="drawer__foot-status">{isOpen ? tr("docker.opening", "打开中…") : tr("docker.installing2", "安装进行中…")}</span>
            </>
          ) : st.status === "reboot" ? (
            <>
              <span className="drawer__foot-status is-reboot">{tr("docker.rebootAuto", "需重启 Windows（90 秒后自动重启，登录后自动继续）")}</span>
              <button type="button" className="drawer__btn is-accent" data-id="DockerDrawer-reboot-now" onClick={() => window.cicy?.docker?.rebootNow?.()}>{tr("docker.rebootNow", "立即重启")}</button>
              <button type="button" className="drawer__btn" data-id="DockerDrawer-reboot-cancel" onClick={() => { window.cicy?.docker?.rebootCancel?.(); dockerDrawer.close(); }}>{tr("docker.rebootCancel", "取消自动重启")}</button>
            </>
          ) : st.status === "error" ? (
            <>
              <span className="drawer__foot-status is-error">{isOpen ? tr("docker.openFailed", "打开失败") : tr("docker.failed", "安装失败")}</span>
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
// in Docker on :8008, alongside the native local daemon (:8008). If Docker
// Desktop is missing, the install flow downloads its installer to the user's
// Desktop and runs it, streaming progress through the drawer above.
function DockerCard({ dockerTeam, cloudTitle, cloudCode, onOpen, onRename, onRefresh }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState("");   // "" | bootstrap | restart | stop | upgrade | probe
  const [menuOpen, setMenuOpen] = useState(false);
  const [doodOpen, setDoodOpen] = useState(false); // 容器内使用 Docker(DooD)modal(卡片层,菜单外)
  const [confirmRecreate, setConfirmRecreate] = useState(false); // 重建容器 in-app 确认弹窗(不用 native confirm)
  const [portsOpen, setPortsOpen] = useState(false);   // 端口设置 modal
  const [portList, setPortList] = useState([]);         // 编辑中的额外端口(字符串数组,便于输入)
  const [portsBusy, setPortsBusy] = useState(false);
  const [portsErr, setPortsErr] = useState("");
  // Inline rename (mirrors LocalTeamCard): double-click the title to edit.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // 标题 = 云端 team 的 title(和其它团队同一套;refreshCloudTeams 周期刷新 → 自动跟随
   // 云端改名)。还没建好云端 team 时回退 "Docker 团队"。
  const displayName = cloudTitle || "Docker 团队";
  const startEdit = (e) => { e?.stopPropagation?.(); setDraft(displayName); setEditing(true); };
  const commitName = async () => {
    setEditing(false);
    const next = String(draft || "").trim();
    if (!next || next === displayName || !onRename) return;
    try { await onRename(next); onRefresh?.(); } catch {}  // onRename 走 renameCloudTeam(PATCH)
  };
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const kebabRef = useRef(null);
  const menuRef = useRef(null);
  const MENU_W = 184;
  const DOCKER_BLUE = "#2496ed";

  const checkStatus = useCallback(async () => {
    try {
      const s = await window.cicy?.docker?.appStatus?.();
      setStatus(s);
      // 自愈卡死的设置抽屉:容器已健康(running)说明 setup 实际已完成,但抽屉可能还停在
      // 「进行中」—— 网络失败重试后,follower 跟随的 bootstrap promise 迟迟不 resolve、又收
      // 不到 docker:app-progress 完成事件,抽屉就一直转(用户看到的「正在跟随同一进度」假死)。
      // 这里检测到容器起来了就直接把抽屉收成「完成」,不再死等 promise。
      // kind!=="open":只自愈安装抽屉;「打开」抽屉(失败报告)绝不被「已就绪」劫持。
      // **只自愈真正卡住的抽屉**(>10s 没收到任何进度事件):否则会误杀正在进行的「更新/
      // 重启 cicy-code」——它们是 in-place 操作,容器全程 healthy,点更新瞬间 busy 变化触发
      // 一次 checkStatus 就会把还在跑的抽屉提前收成「完成」,用户点完成关掉、命令却还在跑、
      // 卡片卡在「处理中」(实测 bug)。活跃流式的抽屉 lastAt 是新的,不动它。
      const stale = Date.now() - (dockerDrawerState?.lastAt || 0) > 30000;
      if (s?.running && dockerDrawerState && dockerDrawerState.status === "running" && dockerDrawerState.kind !== "open" && stale) {
        dockerDrawer.finish({ ok: true, message: "Docker cicy-code 已就绪" });
      }
    } catch (e) { console.warn("[DockerCard]", e); }
  }, []);

  // Poll so the card reflects reality even when Docker changes outside the app
  // (user installs Docker / the engine comes up after a reboot / a container
  // starts). Pause polling while an op is running (the op refreshes itself).
  useEffect(() => {
    checkStatus();
    const id = setInterval(() => { if (!busy) checkStatus(); }, 12000);
    return () => clearInterval(id);
  }, [checkStatus, busy]);

  // 端口设置(定义在 checkStatus 之后:savePorts 依赖它,放前面会 TDZ 崩首页)。
  const openPorts = useCallback(async () => {
    setMenuOpen(false); setPortsErr("");
    try { const r = await window.cicy?.docker?.getPorts?.(); setPortList((r?.ports || []).map(String)); }
    catch { setPortList([]); }
    setPortsOpen(true);
  }, []);
  const savePorts = useCallback(async () => {
    // 校验:1-65535、≠8008、去重、忽略空行。
    const seen = new Set(); const out = [];
    for (const raw of portList) {
      const s = String(raw).trim(); if (!s) continue;
      const p = Number(s);
      if (!Number.isInteger(p) || p < 1 || p > 65535 || p === 8008 || seen.has(p)) { setPortsErr(tr("docker.ports.invalid", "有端口无效(1-65535,不能是 8008,不能重复)")); return; }
      seen.add(p); out.push(p);
    }
    setPortsErr(""); setPortsBusy(true); setPortsOpen(false);
    setBusy("recreate");
    dockerDrawer.open({ onRetry: savePorts });
    const unsub = window.cicy?.docker?.onAppProgress?.((ev) => dockerDrawer.push(ev));
    try {
      const r = await window.cicy?.docker?.setPorts?.(out);
      dockerDrawer.finish({ ok: !!r?.ok, message: r?.ok ? tr("docker.ports.save", "保存并重建") + " ✅" : (r?.error || tr("docker.opFailed", "操作失败")) });
      if (r?.ok) { try { const s = await window.cicy?.docker?.appRedetect?.(); if (s) setStatus(s); } catch {} }
    } catch (e) {
      dockerDrawer.finish({ ok: false, message: e.message });
    } finally {
      try { unsub && unsub(); } catch {}
      setPortsBusy(false); setBusy(""); checkStatus();
    }
  }, [portList, checkStatus]);

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

  // 修复 WSL(WSL 死锁时):重启 LxssManager;若深度死锁(杀不动)→ 提示重启电脑(重启后
  // bootstrap 自动重置坏 distro)。全程走抽屉显示进度。
  const repairWsl = useCallback(async () => {
    setBusy("repair");
    dockerDrawer.open({ onRetry: repairWsl });
    const unsub = window.cicy?.docker?.onAppProgress?.((ev) => dockerDrawer.push(ev));
    try {
      const r = await window.cicy?.docker?.appRepairWsl?.();
      if (r?.needsReboot) {
        dockerDrawer.finish({ status: "reboot", message: tr("docker.wslNeedReboot", "WSL 服务卡死,请【重启 Windows】;重启后打开 CiCy 会自动修复(旧数据已改名备份,不删)。") });
      } else if (r?.ok) {
        dockerDrawer.finish({ ok: true, message: tr("docker.wslRepaired", "WSL 已修复 ✅") });
        onRefresh?.();
      } else {
        dockerDrawer.finish({ ok: false, message: r?.error || tr("docker.repairFailed", "修复失败") });
      }
    } catch (e) {
      dockerDrawer.finish({ ok: false, message: e.message });
    } finally {
      try { unsub && unsub(); } catch {}
      setBusy(""); checkStatus();
    }
  }, [checkStatus, onRefresh]);

  // Upgrade: re-pull the R2 image + recreate the container — also through the
  // drawer so the user sees the pull/import/restart log (升级要能看日志).
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
      if (r?.ok) {
        onRefresh?.();
        // update() 返回时 :8008 已健康(waitUntil probeHealth)。立刻:① reload 已打开的
        // docker tab(reloadIgnoringCache,拿新版 SPA)② 强制重探,卡片版本马上更新(不等
        // 60s reconcile / 缓存)。
        try { window.cicy?.tabs?.reloadIfOpen?.("http://127.0.0.1:8008", tr("docker.teamTab", "Docker 团队")); } catch {}
        try { const s = await window.cicy?.docker?.appRedetect?.(); if (s) setStatus(s); } catch {}
      }
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

  // 「授权容器访问 Mac」(仅 macOS,不挂 docker):把容器公钥写进 Mac 的 authorized_keys +
  // 容器里写 ssh config 的 `mac` 别名,之后容器内 `ssh mac` 即可访问 Mac 主机跑命令。
  const authorizeHostSsh = useCallback(async () => {
    setMenuOpen(false); setBusy("authssh");
    toast.show({ id: "docker-op", message: tr("docker.authorizingHost", "授权容器访问 Mac(配置 SSH)…"), status: "running" });
    try {
      const r = await window.cicy.docker.appAuthorizeHostSsh();
      if (r?.ok) toast.show({ id: "docker-op", message: r.verified ? tr("docker.authorizedHostOk", "已授权:容器内 `ssh mac` 可访问 Mac ✅") : tr("docker.authorizedHostPartial", "公钥已写入 Mac(未验证成功,可在容器内手动 `ssh mac` 试)"), status: r.verified ? "done" : "error", ttl: 5000 });
      else toast.show({ id: "docker-op", message: (r?.error || tr("docker.opFailed", "操作失败")), status: "error", ttl: 6000 });
    } catch (e) {
      toast.show({ id: "docker-op", message: e.message, status: "error", ttl: 6000 });
    } finally { setBusy(""); checkStatus(); }
  }, [checkStatus]);

  // Chrome 代理已无开关:docker 装好后宿主 mihomo 自动起(后端始终开启、bootstrap 预下载二进制)。

  // Render on Windows (WSL2) only. (2026-06 回调): macOS 改回 native cicy-code(:8008),
  // 不再有 Docker 卡 —— mac 的本地团队走 LocalTeamCard。window.cicy.platform is sync.
  const platform = window.cicy?.platform || status?.platform;
  if (platform !== "win32") return null;

  // Distinct states (状态分清楚):
  //   running       — :8008 container healthy → 打开
  //   dockerRunning — engine up, no container → 启动 (build/start container)
  //   installed     — Docker on disk but engine down → 启动 Docker
  //   else          — not installed → 下载安装
  // 有 live status 就信它;status 还没加载到(null)才用 dockerTeam 快照兜底。
  // 否则 teams.json 里陈旧的 status:"running" 会盖过「容器其实已停/:8008 down」的真实
  // 状态 → 卡片显示死「打开」(点了必失败)。真相单一,以 live 探测为准。
  const running = status ? !!status.running : (dockerTeam?.status === "running");
  const dockerRunning = !!status?.dockerRunning;
  const installed = !!status?.installed;
  // unknown = the status probe couldn't reach WSL (stuck / still booting after a
  // reboot). Do NOT fall through to 「下载安装」— that lies (it IS installed, WSL
  // just didn't answer). Show a retry state so the user re-probes, not reinstalls.
  const unknown = !!status?.unknown && !running && !dockerRunning && !installed;
  // WSL 被孤儿化::8008 看着健康(可能只是 wslhost 僵尸攥着端口),但 distro 已从 WSL
  // 消失 → token 读不到、打不开。所以 wslUnmanaged 不再是「可打开」,而是「需修复」:
  // CTA 走「修复 WSL」自动重装(bootstrap 会杀僵尸端口 + wsl --shutdown + 重新 import)。
  const wslUnmanaged = !!status?.wslUnmanaged;
  const wslWedged = !!status?.wslWedged; // WSL 死锁(LxssManager StopPending,所有 wsl 命令 hang)
  const realRunning = running && !wslUnmanaged; // 真能打开 = 健康 且 WSL 没孤儿化
  const tone = realRunning ? "ok" : (wslWedged || wslUnmanaged || dockerRunning || installed || unknown) ? "warn" : "off";
  const isBusy = !!busy;
  const stateText = wslWedged
    ? tr("docker.wslWedged", "WSL 卡死 · 点「修复 WSL」")
    : wslUnmanaged
    ? tr("docker.wslBrokenRepair", "WSL 管理异常 · 点「修复 WSL」重装")
    : running
    ? tr("docker.running", "运行中")
    : dockerRunning
      ? tr("docker.notRunning", "未启动 · 点「启动」")
      : installed
        ? tr("docker.engineDown", "Docker 未运行 · 点启动")
        : unknown
          ? tr("docker.wslUnresponsive", "WSL 未响应 · 点「重试检测」")
          : tr("docker.notInstalled", "Docker Desktop 未安装");

  const ctaLabel = busy === "open"
    ? tr("docker.opening", "打开中…")
    : busy === "probe"
    ? tr("docker.probing", "检测中…")
    : isBusy
    ? tr("docker.working", "处理中…")
    : realRunning
      ? tr("localTeams.open", "打开")
      : (wslWedged || wslUnmanaged)
        ? tr("docker.repairWsl", "修复 WSL")
      : dockerRunning
        ? tr("docker.start", "启动")
        : installed
          ? tr("docker.startDocker", "启动 Docker")
          : unknown
            ? tr("docker.retryProbe", "重试检测")
            : tr("docker.install", "下载安装");

  const onCta = async () => {
    if (isBusy) return;
    // WSL 死锁 → 走「修复 WSL」(重启 LxssManager;不行则提示重启电脑 + 重启后自动重置坏 distro)。
    if (wslWedged) { repairWsl(); return; }
    // WSL 孤儿化 → 走「修复」(bootstrap 杀僵尸端口 + wsl --shutdown + 重新 import),不进打开。
    if (wslUnmanaged) { runBootstrap(); return; }
    if (realRunning) {
      // 打开很慢 → 先探这个 :8008 tab 开过没。开过(openedWc 里有它的
      // webContentsId)就**直接 active 秒切**,不再拿 token / 注册 team(那是慢的根)。
      try {
        const r = await window.cicy?.tabs?.activateIfOpen?.("http://127.0.0.1:8008");
        if (r?.active) return;
      } catch {}
      // 没开过 → 走慢路径(读容器 token 最多 ~50s)。进行中只显示 CTA 的「打开中…」spinner
      // (不复用安装 stepper,免得看着像全绿其实在重试)。成功=静默秒开;失败=才开 drawer,
      // 一次性回放全部命令/输出/错误日志 + 可排查 hint + 重试,直接定格在红色失败态。
      setBusy("open");
      let res = null;
      try { res = await window.cicy?.docker?.appOpen?.(); }
      catch (e) { res = { ok: false, hint: e?.message || tr("docker.openFailed", "打开失败"), log: [] }; }
      setBusy("");
      if (res && res.ok === false) {
        dockerDrawer.open({ onRetry: onCta, kind: "open" });
        (res.log || []).forEach((l) => dockerDrawer.push(l));
        dockerDrawer.finish({ ok: false, message: res.hint || res.error || tr("docker.openFailed", "打开失败") });
      }
      return;
    }
    // 「重试检测」: FORCE a fresh WSL probe (checkStatus only re-read the cache, so
    // clicking did nothing — the「点了没反应」bug). Show a spinner so the click always
    // gives feedback; if WSL is STILL stuck after a real probe, say so clearly.
    if (unknown) {
      setBusy("probe");
      try {
        const s = await (window.cicy?.docker?.appRedetect?.() ?? window.cicy?.docker?.appStatus?.());
        if (s) setStatus(s);
        if (s?.unknown) toast.show({ id: "docker-probe", status: "error", message: tr("docker.wslStillStuck", "WSL 仍无响应 —— 多半要重启 Windows 后再试"), ttl: 6000 });
      } catch (e) { toast.show({ id: "docker-probe", status: "error", message: tr("docker.probeFailed", "检测失败,请重试"), ttl: 5000 }); }
      finally { setBusy(""); }
      return;
    }
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
                {/* cicy-code 操作(容器内的 cicy-code:更新 / 重启 / 停止)*/}
                <button type="button" data-id="DockerCard-update" className="bcard__menu-item is-accent" onClick={runUpdate}>
                  {tr("docker.update", "更新 cicy-code")}
                </button>
                <button type="button" data-id="DockerCard-restart" className="bcard__menu-item"
                  onClick={() => runOp("restart", () => window.cicy.docker.appRestart(), tr("docker.restarted", "已重启 cicy-code"))}>
                  {tr("docker.restart", "重启 cicy-code")}
                </button>
                <button type="button" data-id="DockerCard-stop" className="bcard__menu-item is-danger"
                  onClick={() => runOp("stop", () => window.cicy.docker.appStop(), tr("docker.stopped", "已停止 cicy-code"))}>
                  {tr("docker.stop", "停止 cicy-code")}
                </button>
                {/* 常用 */}
                <button type="button" data-id="DockerCard-reload" className="bcard__menu-item"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); window.cicy?.tabs?.reloadIfOpen?.("http://127.0.0.1:8008", "Docker 团队"); }}>
                  {tr("docker.reloadWindow", "刷新窗口")}
                </button>
                <button type="button" data-id="DockerCard-open-dir" className="bcard__menu-item"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); window.cicy?.docker?.openDir?.(); }}>
                  {tr("docker.openWslDir", "打开 WSL 目录")}
                </button>
                <button type="button" data-id="DockerCard-open-projects" className="bcard__menu-item"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); window.cicy?.docker?.openDir?.("projects"); }}>
                  {tr("docker.openProjectsDir", "打开项目目录")}
                </button>
                <button type="button" data-id="DockerCard-dood" className="bcard__menu-item"
                  title={tr("dood.hint", "把宿主 Docker + docker 客户端挂进容器,容器内 agent 能直接跑 docker(切换会重建容器,秒生效、无需下载)")}
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setDoodOpen(true); }}>
                  {tr("dood.menu", "容器内使用 Docker")}
                </button>
                {/* 分隔线:下面是操作整个 Docker 容器的(授权访问 Mac / 重启 Docker / 重建 Docker)*/}
                <div className="bcard__menu-sep" data-id="DockerCard-menu-sep" role="separator" aria-hidden />
                {/* 仅 macOS:授权容器经 SSH 访问 Mac 主机(host.docker.internal),不挂 docker */}
                {platform === "darwin" && (
                  <button type="button" data-id="DockerCard-authorize-host-ssh" className="bcard__menu-item"
                    title={tr("docker.authorizeHostHint", "把容器公钥加到 Mac 的 authorized_keys,容器内 `ssh mac` 即可访问本机")}
                    onClick={authorizeHostSsh}>
                    {tr("docker.authorizeHost", "授权容器访问 Mac")}
                  </button>
                )}
                {/* Chrome 代理已无开关:docker 装好后宿主 mihomo 自动起(始终开启),不再手动切换 */}
                <button type="button" data-id="DockerCard-docker-restart" className="bcard__menu-item"
                  onClick={() => runOp("restart", () => window.cicy.docker.appDockerRestart(), tr("docker.dockerRestarted", "已重启 Docker 容器"))}>
                  {tr("docker.dockerRestart", "重启 Docker")}
                </button>
                <button type="button" data-id="DockerCard-ports" className="bcard__menu-item"
                  onClick={(e) => { e.stopPropagation(); openPorts(); }}>
                  {tr("docker.ports.menu", "端口设置")}
                </button>
                <button type="button" data-id="DockerCard-recreate" className="bcard__menu-item is-danger"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setConfirmRecreate(true); }}>
                  {tr("docker.recreate", "重建 Docker")}
                </button>
              </div>,
              document.body
            )}
          </div>
        )}
      </div>
      <div className="bcard__body">
        {/* 8008 现在有独立云端 team(cloud_team_id 是它自己的,不再和 8008 串),所以
            标题可改名:本地节点名 + 云端 PATCH 双写(onRename 在父组件处理)。 */}
        <div style={{ height: 28, display: "flex", alignItems: "center", gap: 8 }}>
          <TeamAvatar size={24} avatar={dockerTeam?.avatar} name={displayName} teamId={dockerTeam?.id} onChanged={onRefresh} />
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
              style={{ flex: 1, width: "100%", font: "inherit", fontWeight: 600, padding: "2px 6px", border: "1px solid #3b82f6", borderRadius: 6, background: "#0d1117", color: "#e6edf3", boxSizing: "border-box" }}
            />
          ) : (
            <h3 className="bcard__name" title={onRename ? tr("localTeams.renameHint", "点名字或 ✎ 改名") : displayName} style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, margin: 0 }} onDoubleClick={onRename ? startEdit : undefined}>
              <span onClick={onRename ? startEdit : undefined} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: onRename ? "text" : "default" }}>{displayName}</span>
              {onRename && (
                <button type="button" data-id="DockerCard-rename-btn" title={tr("localTeams.rename", "重命名")} onClick={startEdit} style={{ flex: "none", cursor: "pointer", border: "none", background: "transparent", color: "#8b949e", fontSize: 13, padding: 0, lineHeight: 1 }}>✎</button>
              )}
            </h3>
          )}
        </div>
        <div className="bcard__meta">
          <span className="bcard__chip">Docker</span>
          {status?.version && <span className="bcard__ver" data-id="DockerCard-ver" style={{ marginLeft: 8, fontSize: 11, opacity: 0.6 }}>v{status.version}</span>}
        </div>
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
      <DoodModal open={doodOpen} onClose={() => setDoodOpen(false)} toastId="docker-op" />
      {confirmRecreate && createPortal(
        <div data-id="DockerCard-recreate-modal"
          style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmRecreate(false); }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 360, maxWidth: "90vw", background: "#161b22", border: "1px solid #30363d", borderRadius: 12, padding: "20px 22px", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 16, color: "#e6edf3" }}>{tr("docker.recreate", "重建 Docker")}</h3>
            <p style={{ margin: "0 0 18px", fontSize: 13, lineHeight: 1.6, color: "#9aa4b2" }}>
              {tr("docker.recreateConfirm", "会删除当前容器并重新创建(volume 数据保留),用于切换为独立 team 的网关 key。确定重建?")}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button type="button" data-id="DockerCard-recreate-cancel"
                onClick={() => setConfirmRecreate(false)}
                style={{ padding: "7px 16px", borderRadius: 8, border: "1px solid #30363d", background: "transparent", color: "#c9d1d9", cursor: "pointer", fontSize: 13 }}>
                {tr("common.cancel", "取消")}
              </button>
              <button type="button" data-id="DockerCard-recreate-confirm"
                onClick={() => { setConfirmRecreate(false); runOp("restart", () => window.cicy.docker.appRecreate(), tr("docker.recreated", "已重建 Docker 容器")); }}
                style={{ padding: "7px 16px", borderRadius: 8, border: "none", background: "#da3633", color: "white", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                {tr("docker.recreateOk", "确定重建")}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {portsOpen && createPortal(
        <div data-id="DockerCard-ports-modal"
          style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setPortsOpen(false); }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 420, maxWidth: "92vw", background: "#161b22", border: "1px solid #30363d", borderRadius: 12, padding: "20px 22px", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16, color: "#e6edf3" }}>{tr("docker.ports.title", "端口设置")}</h3>
            <p style={{ margin: "0 0 14px", fontSize: 12.5, lineHeight: 1.6, color: "#9aa4b2" }}>{tr("docker.ports.sub", "除 :8008 外,额外发布、可从 Windows 直达容器内服务的端口")}</p>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", marginBottom: 10, borderRadius: 8, background: "#0d1117", border: "1px solid #21262d", color: "#7d8590", fontSize: 13 }}>
              🔒 {tr("docker.ports.mainFixed", ":8008 · cicy-code(固定)")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 220, overflowY: "auto" }}>
              {portList.length === 0 && (
                <div style={{ fontSize: 12.5, color: "#6e7681", padding: "4px 2px" }}>{tr("docker.ports.none", "暂无额外端口")}</div>
              )}
              {portList.map((p, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input data-id={`DockerCard-port-input-${i}`} type="text" inputMode="numeric" value={p}
                    placeholder={tr("docker.ports.ph", "端口号 1-65535")}
                    onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, ""); setPortList((list) => list.map((x, j) => j === i ? v : x)); setPortsErr(""); }}
                    style={{ flex: 1, padding: "7px 10px", borderRadius: 8, border: "1px solid #30363d", background: "#0d1117", color: "#e6edf3", fontSize: 13, fontFamily: "var(--mono)" }} />
                  <button type="button" data-id={`DockerCard-port-remove-${i}`} title={tr("docker.ports.remove", "移除")}
                    onClick={() => { setPortList((list) => list.filter((_, j) => j !== i)); setPortsErr(""); }}
                    style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #30363d", background: "transparent", color: "#da3633", cursor: "pointer", fontSize: 14 }}>✕</button>
                </div>
              ))}
            </div>
            <button type="button" data-id="DockerCard-port-add"
              onClick={() => setPortList((list) => [...list, ""])}
              style={{ marginTop: 10, padding: "7px 12px", borderRadius: 8, border: "1px dashed #30363d", background: "transparent", color: "#58a6ff", cursor: "pointer", fontSize: 13, width: "100%" }}>
              {tr("docker.ports.add", "+ 添加端口")}
            </button>
            {portsErr && <div style={{ marginTop: 10, fontSize: 12.5, color: "#f85149" }}>{portsErr}</div>}
            <p style={{ margin: "12px 0 16px", fontSize: 11.5, lineHeight: 1.5, color: "#6e7681" }}>{tr("docker.ports.hint", "保存会重建容器(volume 数据保留),会有短暂中断")}</p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button type="button" data-id="DockerCard-ports-cancel" disabled={portsBusy}
                onClick={() => setPortsOpen(false)}
                style={{ padding: "7px 16px", borderRadius: 8, border: "1px solid #30363d", background: "transparent", color: "#c9d1d9", cursor: "pointer", fontSize: 13 }}>
                {tr("docker.ports.cancel", "取消")}
              </button>
              <button type="button" data-id="DockerCard-ports-save" disabled={portsBusy}
                onClick={savePorts}
                style={{ padding: "7px 16px", borderRadius: 8, border: "none", background: "#238636", color: "white", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                {portsBusy ? tr("docker.ports.saving", "保存中…") : tr("docker.ports.save", "保存并重建")}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function LocalTeamCard({ team, cloudCode, onOpen, onRename, onRefresh }) {
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
  const [busy, setBusy] = useState("");   // "" | start | restart | update | stop | lan
  const [menuOpen, setMenuOpen] = useState(false);
  // 局域网访问开关: cicy-code --public 状态。仅本地团队;初始从 sidecar.getPublic() 读。
  const [lanOn, setLanOn] = useState(false);
  useEffect(() => {
    if (!local || !window.cicy?.sidecar?.getPublic) return;
    window.cicy.sidecar.getPublic().then((r) => setLanOn(!!r?.public)).catch(() => {});
  }, [local]);
  // cicy-code 版本统一从 sidecar.versions() 一处拿("拿版本就一个方法")。
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
  // 自定义团队改 URL modal
  const [editingUrl, setEditingUrl] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlErr, setUrlErr] = useState("");

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

  // 自定义团队标题 + URL 一次保存。标题是用户自定义字段,绝不从 URL 自动生成。
  const commitUrl = async () => {
    if (urlBusy) return;
    const built = buildCustomTeamEditPatch({ title: titleDraft, url: urlDraft });
    if (!built.ok) { setUrlErr(tr("teams.titleRequired", "请输入自定义标题")); return; }
    if (!built.patch.base_url) { setUrlErr(tr("teams.urlRequired", "请输入地址 URL")); return; }
    try { new URL(built.patch.base_url); } catch { setUrlErr(tr("teams.badUrl", "URL 无效(需含 http(s)://)")); return; }
    if (built.patch.name === (team.name || "") && built.patch.base_url === (team.base_url || "")) { setEditingUrl(false); return; }
    setUrlErr(""); setUrlBusy(true);
    try {
      const r = await (window.cicy?.localTeams?.update?.(team.id, built.patch));
      if (r?.ok) { setEditingUrl(false); onRefresh?.(); }
      else setUrlErr(humanError(r?.error || "update failed"));
    } catch (e) { setUrlErr(humanError(e?.message || String(e))); }
    setUrlBusy(false);
  };
  const handleRemove = async () => {
    if (busy) return;
    setConfirmDel(false); setBusy("remove");
    const toastId = "op-" + Date.now();
    toast.show({ id: toastId, message: tr("localTeams.removing", "删除中…"), status: "running" });
    try {
      const r = await window.cicy?.localTeams?.remove?.(team.id);
      if (r?.ok) toast.show({ id: toastId, message: tr("localTeams.removed", "已删除"), status: "done", ttl: 3000 });
      else toast.show({ id: toastId, message: tr("localTeams.removeFailed", "删除失败") + (r?.error ? ": " + r.error : ""), status: "error", ttl: 7000 });
    } catch (e) { toast.show({ id: toastId, message: tr("localTeams.removeFailed", "删除失败") + ": " + (e?.message || e), status: "error", ttl: 7000 }); }
    setBusy(""); onRefresh?.();
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
  const BUSY_LABEL = { start: tr("busy.start", "启动中…"), restart: tr("busy.restart", "重启中…"), update: tr("busy.update", "更新中…"), stop: tr("busy.stop", "停止中…") };

  // 打开 flow (spec): start the LOCAL daemon if it's down (with a 启动中…
  // toast), then open. The window itself is opened by openTeam() in main, which
  // (1) reuses an already-open window for this team (list_windows check first),
  // and (2) for a local team, TCP-探活 until :8008 actually answers before
  // creating the window — so we never pop a blank page that needs a manual
  // reload. (/api/health is NOT used — it's unreliable mid-boot; the gate is a
  // raw TCP probe.) Remote/custom teams just open and show their own UI.
  // 启动本地 cicy-code,带**安装进度抽屉**(首次要装 Node + cicy-code 自己 brew 装
  // tmux 依赖,几分钟,必须让用户看见执行什么命令/卡在哪/出什么错,且能重试)。
  // sidecar:start 会流式 emit:Node 下载命令 + npx cicy-code + brew 装依赖的日志逐行推过来。
  const runStartFlow = async () => {
    setBusy("start");
    updateDrawer.open({ teamId: team.id, title: tr("sidecar.startTitle", "启动 cicy-code"), onRetry: runStartFlow });
    updateDrawer.push({ phase: "download", status: "running", message: tr("sidecar.starting", "启动 cicy-code(首次需安装 Node + 依赖,日志见下)…") });
    const unsub = window.cicy?.sidecar?.onOpProgress?.((ev) => updateDrawer.push(ev));
    let r;
    try { r = await window.cicy.sidecar.start(); } catch (e) { r = { ok: false, error: e?.message || String(e) }; }
    try { unsub?.(); } catch {}
    setBusy(""); onRefresh?.();
    if (!r?.ok || r?.warning) {
      updateDrawer.finish({ ok: false, message: tr("sidecar.startFailed", "启动失败") + (r?.error ? `: ${r.error}` : r?.warning ? `: ${r.warning}` : "") });
      return false;
    }
    updateDrawer.finish({ ok: true, message: tr("sidecar.startedOk", "cicy-code 已就绪") });
    return true;
  };
  const handleOpen = async () => {
    if (busy) return;
    if (!running && local && window.cicy?.sidecar?.start) {
      const ok = await runStartFlow();
      if (!ok) return; // 没起来 — 抽屉里有日志 + 重试,不开死链
    }
    onOpen(); // openTeam() gates on list_windows + TCP liveness before showing
  };
  const openLabel = running
    ? tr("localTeams.open", "打开")
    : local
      ? tr("localTeams.startOpen", "启动并打开") // only the local sidecar can be started from here
      : tr("localTeams.open", "打开");           // custom/remote: 探活-only, just open
  return (
    <>
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
                {/* 刷新窗口:所有团队卡通用(本地/自定义)——不依赖 running(自定义节点
                    status 常非 running)。reloadIfOpen 没开 tab 自动不操作,所以总能显示。*/}
                {team.base_url && (
                  <button
                    type="button"
                    data-id="LocalTeamCard-reload"
                    className="bcard__menu-item"
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(false); window.cicy?.tabs?.reloadIfOpen?.(team.base_url, team.name); }}
                  >
                    {tr("localTeams.reloadWindow", "刷新窗口")}
                  </button>
                )}
                {local && !running && (
                  <button
                    type="button"
                    data-id="LocalTeamCard-start"
                    className="bcard__menu-item is-accent"
                    onClick={() => runOp("start", () => window.cicy.sidecar.start(), tr("sidecar.started", "已启动"))}
                  >
                    {tr("sidecar.start", "启动")}
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
                    {/* 局域网访问紧挨「帐单」上方(放在 stop 之后)。 */}
                    <button
                      type="button"
                      data-id="LocalTeamCard-lan"
                      className="bcard__menu-item"
                      title={tr("sidecar.lanHint", "开启后同局域网设备可用本机 IP 访问(api_token 仍校验);切换会自动重启 cicy-code")}
                      disabled={busy === "lan"}
                      onClick={async () => {
                        if (busy) return;
                        const next = !lanOn;
                        setMenuOpen(false); setBusy("lan"); setLanOn(next);
                        toast.show({ id: opToastId, message: next ? tr("sidecar.lanEnabling", "开启局域网访问,重启中…") : tr("sidecar.lanDisabling", "关闭局域网访问,重启中…"), status: "running", progress: undefined });
                        try {
                          const r = await window.cicy.sidecar.setPublic(next);
                          if (r?.ok) toast.show({ id: opToastId, message: next ? tr("sidecar.lanOn", "已开启局域网访问") : tr("sidecar.lanOff", "已关闭局域网访问"), status: "done", ttl: 3000 });
                          else toast.show({ id: opToastId, message: tr("sidecar.lanFailed", "设置失败") + (r?.error ? `: ${r.error}` : ""), status: "error", ttl: 7000 });
                        } catch (e) { toast.show({ id: opToastId, message: tr("sidecar.lanFailed", "设置失败") + `: ${e?.message || e}`, status: "error", ttl: 7000 }); }
                        try { const g = await window.cicy.sidecar.getPublic(); setLanOn(!!g?.public); } catch {}
                        setBusy(""); onRefresh?.();
                      }}
                    >
                      {tr("sidecar.lanAccess", "局域网访问")} · {lanOn ? tr("common.on", "开") : tr("common.off", "关")}
                    </button>
                  </>
                )}
                {isCustom && (
                  <>
                    <button type="button" data-id="LocalTeamCard-edit-url" className="bcard__menu-item"
                      onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setEditingUrl(true); setTitleDraft(team.name || ""); setUrlDraft(team.base_url || ""); setUrlErr(""); }}>
                      {tr("teamCard.editUrl", "更改访问地址")}
                    </button>
                    <button type="button" data-id="LocalTeamCard-remove"
                      className="bcard__menu-item is-danger"
                      onClick={() => { setMenuOpen(false); setConfirmDel(true); }}>
                      {tr("localTeams.remove", "删除")}
                    </button>
                  </>
                )}
                {(runningVer || team.version) && (
                  <div data-id="LocalTeamCard-version" className="bcard__menu-item" style={{ cursor: "default", color: "#8b949e", fontSize: 12 }}>
                    {tr("localTeams.version", "版本")} v{runningVer || team.version}
                  </div>
                )}
              </div>,
              document.body
            )}
          </div>
        )}
      </div>
      <div className="bcard__body">
        {/* 固定高度容器:h3 与 input 同高,切换不引起卡片位移 */}
        <div style={{ height: 28, display: "flex", alignItems: "center", gap: 8 }}>
        <TeamAvatar size={24} avatar={team?.avatar} name={team?.name} teamId={team?.id} onChanged={onRefresh} />
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
            style={{ flex: 1, width: "100%", font: "inherit", fontWeight: 600, padding: "2px 6px", border: "1px solid #3b82f6", borderRadius: 6, background: "#0d1117", color: "#e6edf3", boxSizing: "border-box" }}
          />
        ) : (
          <h3 className="bcard__name" title={tr("localTeams.renameHint", "点名字或 ✎ 改名")} style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, margin: 0 }} onDoubleClick={startEdit}>
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
        </div>
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
    {editingUrl && createPortal(
      <div data-id="LocalTeamCard-url-modal"
        style={{ position: "fixed", inset: 0, zIndex: 65, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.5)" }}
        onMouseDown={(e) => { if (!urlBusy && e.target === e.currentTarget) setEditingUrl(false); }}>
        <div onClick={(e) => e.stopPropagation()}
          style={{ width: 400, maxWidth: "92vw", background: "var(--card, #1b1d22)", border: "1px solid var(--border, #2c2f36)", borderRadius: 14, padding: 22, boxShadow: "0 20px 60px rgba(0,0,0,.5)" }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>{tr("teamCard.editCustom", "编辑自定义团队")}</div>
          <label style={{ display: "block", fontSize: 12, opacity: .75, marginBottom: 6 }}>{tr("teams.customNameLabel", "自定义标题")}</label>
          <input data-id="LocalTeamCard-title-input" autoFocus className="login-email-input" style={{ width: "100%", marginBottom: 14 }}
            value={titleDraft} placeholder={tr("teams.customNamePlaceholder", "我的团队")} spellCheck={false}
            disabled={urlBusy}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === "Enter") { e.preventDefault(); commitUrl(); } else if (e.key === "Escape") setEditingUrl(false); }} />
          <label style={{ display: "block", fontSize: 12, opacity: .75, marginBottom: 6 }}>{tr("teams.customUrlLabel", "地址 URL")}</label>
          <textarea data-id="LocalTeamCard-url-input" rows={3} className="login-email-input" style={{ width: "100%", resize: "vertical", lineHeight: 1.5, fontFamily: "var(--mono)" }}
            value={urlDraft} placeholder="https://example.com:8008" spellCheck={false}
            disabled={urlBusy}
            onChange={(e) => setUrlDraft(e.target.value.replace(/[\r\n]+/g, ""))}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === "Enter") { e.preventDefault(); commitUrl(); } else if (e.key === "Escape") setEditingUrl(false); }} />
          {urlErr && <div className="error" style={{ marginTop: 8, fontSize: 12 }}>{urlErr}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" disabled={urlBusy} onClick={() => setEditingUrl(false)}>{tr("common.cancel", "取消")}</button>
            <button type="button" className="btn-primary" data-id="LocalTeamCard-url-save" disabled={urlBusy} onClick={commitUrl}>{urlBusy ? tr("common.saving", "保存中…") : tr("common.save", "保存")}</button>
          </div>
        </div>
      </div>,
      document.body,
    )}
    <ConfirmModal open={confirmDel}
      title={tr("localTeams.deleteTitle", "删除团队")}
      message={tr("localTeams.deleteMsg", "确定删除「{{name}}」?此操作不可撤销。", { name: team.name })}
      confirmLabel={tr("common.delete", "删除")} danger
      onConfirm={handleRemove}
      onCancel={() => setConfirmDel(false)}
    />
    </>
  );
}

// True only for the daemon the desktop actually owns — localhost on the
// sidecar port (8008). Remote nodes / other ports can't be started from here.
// native cicy-code 本机 sidecar = localhost:8008,**只在 mac/linux**(main.js 里 native
// 仅非 Windows 启动)。Windows 上没有 native、8008 被 Docker-版占用(见 isDockerApp),所以
// Windows 上 8008 不算 native —— 否则同一个 8008 docker team 会既进 localList 又进 DockerCard,
// 渲染出两张卡(且 local 那张不带 live token,打开卡登录页)。两个判定按平台互斥。
function isLocalSidecar(baseUrl) {
  try {
    if (window.cicy?.platform === "win32") return false; // Windows 无 native:8008 归 docker
    const p = new URL(baseUrl);
    const local = p.hostname === "127.0.0.1" || p.hostname === "localhost" || p.hostname === "::1";
    return local && (p.port === "8008" || p.port === "");
  } catch { return false; }
}

// The Docker-版 cicy-code instance — localhost:8008, **只在 Windows**。Owned by
// <DockerCard>, so it's filtered out of the generic node lists.
function isDockerApp(baseUrl) {
  try {
    if (window.cicy?.platform !== "win32") return false; // docker-版只在 Windows
    const p = new URL(baseUrl);
    const local = p.hostname === "127.0.0.1" || p.hostname === "localhost" || p.hostname === "::1";
    return local && p.port === "8008";
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
  running:       { tone: "ok",   label: "running",    cta: tr("localStatus.open", "打开") },
  stopped:       { tone: "off",  label: "stopped",    cta: tr("localStatus.notRunning", "未运行") },
  auth_error:    { tone: "warn", label: "auth error", cta: tr("localStatus.tokenInvalid", "Token 失效") },
  misconfigured: { tone: "err",  label: "bad config", cta: tr("localStatus.badUrl", "URL 错误") },
  error:         { tone: "err",  label: "error",      cta: tr("localStatus.error", "异常") },
};

// 共享确认弹窗:所有删除统一走这里,不再内联两段式。createPortal 到 body,不受卡片层叠限制。
function ConfirmModal({ open, title, message, confirmLabel, danger, onConfirm, onCancel }) {
  if (!open) return null;
  return createPortal(
    <div data-id="ConfirmModal"
      style={{ position: "fixed", inset: 0, zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.5)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 360, maxWidth: "92vw", background: "var(--card, #1b1d22)", border: "1px solid var(--border, #2c2f36)", borderRadius: 14, padding: 22, boxShadow: "0 20px 60px rgba(0,0,0,.5)" }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{title}</div>
        {message && <div style={{ fontSize: 13, opacity: .7, marginBottom: 16 }}>{message}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>{tr("common.cancel", "取消")}</button>
          <button type="button" className="btn-primary" data-id="ConfirmModal-ok"
            style={danger ? { background: "#dc2626", borderColor: "#dc2626" } : {}}
            onClick={onConfirm}>{confirmLabel || tr("common.confirm", "确认")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// 私有云 / (历史)云端团队卡片。产品方向变更(w-10032):公有云不做了,主打 private
// (用户自托管,数据不出企业)。private 字段:{name,kind:"private",status,apiKey,
// gatewayUrl,host_url,titleVersion,deviceId:""}。卡片展示名字+host_url,点开可看/复制 apiKey。
function TeamCard({ team, onOpen, onRename, onEditUrl, onDelete, avatar, onAvatar }) {
  const isPrivate = team.kind === "private";
  const statusOk = team.status === "active";
  const serverName = team.name || team.title || "—";
  // Inline rename(和本地/Docker 卡一致):双击标题改名 → onRename 走云端 PATCH。
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingName, setPendingName] = useState(null);
  const name = pendingName != null ? pendingName : serverName;
  useEffect(() => { if (pendingName != null && serverName === pendingName) setPendingName(null); }, [serverName, pendingName]);
  const startEdit = (e) => { e?.stopPropagation?.(); setDraft(name === "—" ? "" : name); setEditing(true); };
  const commitName = async () => {
    setEditing(false);
    const next = String(draft || "").trim();
    if (!onRename || !next || next === name) return;
    setPendingName(next);
    try { const r = await onRename(team.id, next); if (!r?.ok) setPendingName(null); } catch { setPendingName(null); }
  };
  const hostUrl = team.host_url || "";
  // Inline 改私有云地址(host_url)—— 和改名同样的乐观更新:本地先显示 pendingUrl,云端
  // PATCH 成功后 refreshCloudTeams 把真值同步回来,pendingUrl 清空。
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [pendingUrl, setPendingUrl] = useState(null);
  const displayHostUrl = pendingUrl != null ? pendingUrl : hostUrl;
  useEffect(() => { if (pendingUrl != null && hostUrl === pendingUrl) setPendingUrl(null); }, [hostUrl, pendingUrl]);
  const billTeamId = team.teamId || team.id; // /dash?team=<teamId>(URL 不带 key)
  const kindLabel = isPrivate ? tr("teamKind.private", "私有云") : (team.team_kind === "personal" ? tr("teamKind.personal", "个人") : tr("teamKind.shared", "共享"));
  const openUrl = isPrivate ? displayHostUrl : (team.workspace_url || team.workspace_direct_url);
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
  // 刷新窗口:三卡完全同一逻辑——tabs.reloadIfOpen 按 URL 找开着的 tab 就 reload,
  // 没开就不操作(不偷偷开新窗)。
  const doReload = (e) => { e?.stopPropagation?.(); if (!hasUrl) return; setMenuOpen(false); window.cicy?.tabs?.reloadIfOpen?.(openUrl, name); };
  // 删除确认弹窗:私有云 team 删除必须确认,走 ConfirmModal。
  const [confirmDel, setConfirmDel] = useState(false);
  const startEditUrl = () => { setUrlDraft(hostUrl); setEditingUrl(true); setMenuOpen(false); };
  const commitUrl = async () => {
    setEditingUrl(false);
    const next = String(urlDraft || "").trim();
    if (!onEditUrl || !next || next === hostUrl) return;
    setPendingUrl(next);
    try { const r = await onEditUrl(team.id, next); if (!r?.ok) setPendingUrl(null); } catch { setPendingUrl(null); }
  };
  // 私有云卡片不展示 api key(安全)。key 只在云端 dash / 注入 global.json 用。
  return (
    <>
    <div data-id="TeamCard" className={`bcard bcard--cloud${statusOk ? " bcard--online" : ""}`}>
      <div className="bcard__accent" />
      <div className="bcard__top">
        <div className="bcard__pill">
          <span className="bcard__dot" data-tone={statusOk ? "ok" : "off"} />
          <GlobeIcon />
        </div>
        <div className="bcard__top-right">
          {team.is_trial && <span className="bcard__badge">trial</span>}
          {(hasUrl || billTeamId != null || (isPrivate && onEditUrl)) && (
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
                  {isPrivate && onEditUrl && (
                    <button type="button" data-id="TeamCard-edit-url" className="bcard__menu-item"
                      onClick={(e) => { e.stopPropagation(); startEditUrl(); }}>
                      {hostUrl ? tr("teamCard.editUrl", "更改访问地址") : tr("teamCard.setUrl", "填写访问地址")}
                    </button>
                  )}
                  {isPrivate && onDelete && (
                    <button type="button" data-id="TeamCard-delete" className="bcard__menu-item is-danger"
                      onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setConfirmDel(true); }}>
                      {tr("teamCard.delete", "删除")}
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
        {/* 固定高度容器:h3 与 input 同高,切换不引起位移 */}
        <div style={{ height: 28, display: "flex", alignItems: "center", gap: 8 }}>
        <TeamAvatar size={24} avatar={avatar} name={team?.name || team?.title} teamId={team?.id} onChanged={onAvatar} />
        {editing ? (
          <input
            data-id="TeamCard-rename-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={commitName}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === "Enter") commitName(); else if (e.key === "Escape") setEditing(false); }}
            style={{ flex: 1, width: "100%", font: "inherit", fontWeight: 600, padding: "2px 6px", border: "1px solid #3b82f6", borderRadius: 6, background: "#0d1117", color: "#e6edf3", boxSizing: "border-box" }}
          />
        ) : (
          <h3 className="bcard__name" title={onRename ? tr("localTeams.renameHint", "点名字或 ✎ 改名") : name} style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, margin: 0 }} onDoubleClick={onRename ? startEdit : undefined}>
            <span onClick={onRename ? startEdit : undefined} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: onRename ? "text" : "default" }}>{name}</span>
            {onRename && (
              <button type="button" data-id="TeamCard-rename-btn" title={tr("localTeams.rename", "重命名")} onClick={startEdit} style={{ flex: "none", cursor: "pointer", border: "none", background: "transparent", color: "#8b949e", fontSize: 13, padding: 0, lineHeight: 1 }}>✎</button>
            )}
          </h3>
        )}
        </div>
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
    {editingUrl && createPortal(
      <div data-id="TeamCard-url-modal"
        style={{ position: "fixed", inset: 0, zIndex: 65, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.5)" }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) setEditingUrl(false); }}>
        <div onClick={(e) => e.stopPropagation()}
          style={{ width: 400, maxWidth: "92vw", background: "var(--card, #1b1d22)", border: "1px solid var(--border, #2c2f36)", borderRadius: 14, padding: 22, boxShadow: "0 20px 60px rgba(0,0,0,.5)" }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{hostUrl ? tr("teamCard.editUrl", "更改访问地址") : tr("teamCard.setUrl", "填写访问地址")}</div>
          <div style={{ fontSize: 12, opacity: .6, marginBottom: 16 }}>{name}</div>
          <textarea data-id="TeamCard-url-input" autoFocus rows={3} className="login-email-input" style={{ width: "100%", resize: "vertical", lineHeight: 1.5, fontFamily: "var(--mono)" }}
            value={urlDraft} placeholder="https://你的私有云地址:端口" spellCheck={false}
            onChange={(e) => setUrlDraft(e.target.value.replace(/[\r\n]+/g, ""))}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === "Enter") { e.preventDefault(); commitUrl(); } else if (e.key === "Escape") setEditingUrl(false); }} />
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={() => setEditingUrl(false)}>{tr("common.cancel", "取消")}</button>
            <button type="button" className="btn-primary" data-id="TeamCard-url-save" onClick={commitUrl}>{tr("common.save", "保存")}</button>
          </div>
        </div>
      </div>,
      document.body,
    )}
    <ConfirmModal open={confirmDel}
      title={tr("localTeams.deleteTitle", "删除团队")}
      message={tr("localTeams.deleteMsg", "确定删除「{{name}}」?此操作不可撤销。", { name })}
      confirmLabel={tr("common.delete", "删除")} danger
      onConfirm={async () => { setConfirmDel(false); if (onDelete) await onDelete(team); }}
      onCancel={() => setConfirmDel(false)}
    />
    </>
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
        <div className="brand-sub">{tr("app.brandSub", "团队 AI 协作工作台")}</div>
      </div>
    </div>
  );
}

// app 自更新 banner = 入口条:只在「发现新版本」时出现「vX [下载更新]」。点下载后
// 走 updateDrawer(像 Docker 安装那样的抽屉:醒目进度条 + 速度/剩余 + 安装按钮)。
function UpdateBanner() {
  const [st, setSt] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [autoUpd, setAutoUpd] = useState(false); // 「以后自动更新到最新版」(存 global.json,设备级)
  const active = useRef(false); // 用户已点下载 → 后续状态喂给 drawer
  const toggleAuto = (on) => {
    setAutoUpd(on);
    window.cicy?.app?.setAutoUpdate?.(on).catch(() => {});
  };
  useEffect(() => {
    let alive = true;
    window.cicy?.app?.updateState?.().then((s) => { if (alive) setSt(s); }).catch(() => {});
    window.cicy?.app?.getAutoUpdate?.().then((v) => { if (alive) setAutoUpd(v === true); }).catch(() => {});
    const unsub = window.cicy?.app?.onUpdateState?.((s) => {
      setSt(s);
      if (typeof s?.autoUpdate === "boolean") setAutoUpd(s.autoUpdate);
      // 主进程自动更新(开关已开):没人点过下载,自己开抽屉显示进度。
      if (s?.auto && !active.current && (s.status === "downloading" || s.status === "ready")) {
        active.current = true;
        setDismissed(true);
        updateDrawer.open({ kind: "app", title: tr("updateBanner.drawerTitle", "应用更新"), fromVer: s.current, toVer: s.version, onRetry: () => window.cicy?.app?.downloadUpdate?.() });
        updateDrawer.push({ phase: "download", status: "running", message: tr("updateBanner.autoDl", "已开启自动更新,正在下载安装包…") });
      }
      if (!active.current) return;
      if (s.status === "downloading") updateDrawer.setProgress(s.progress || {});
      else if (s.status === "ready") updateDrawer.ready({ onInstall: () => window.cicy?.app?.installUpdate?.() });
      else if (s.status === "error") { updateDrawer.finish({ ok: false, message: s.error || tr("updateBanner.error", "更新失败") }); active.current = false; }
    });
    return () => { alive = false; try { unsub && unsub(); } catch {} };
  }, []);
  const status = st?.status;
  useEffect(() => { setDismissed(false); }, [status]);
  // 点「下载更新」→ 开抽屉,把下载/安装放进去(进度条/速度/剩余/安装,像 Docker 安装)。
  const startDownload = () => {
    active.current = true;
    setDismissed(true); // 关弹窗,交给抽屉显示进度
    updateDrawer.open({ kind: "app", title: tr("updateBanner.drawerTitle", "应用更新"), fromVer: st?.current, toVer: st?.version, onRetry: startDownload });
    updateDrawer.push({ phase: "download", status: "running", message: tr("updateBanner.startDl", "开始下载安装包…") });
    updateDrawer.setProgress({ percent: 0 });
    window.cicy?.app?.downloadUpdate?.();
  };
  if (status !== "available" || dismissed) return null; // 仅做入口;下载/安装在抽屉里
  // 强提示:居中模态弹窗(比 banner 醒目),点遮罩/「稍后」可关,下次启动/再检测到再弹。
  return createPortal(
    <div data-id="UpdateBanner"
      style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) setDismissed(true); }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 380, maxWidth: "90vw", background: "#161b22", border: "1px solid #30363d", borderRadius: 14, padding: "24px 24px 20px", boxShadow: "0 20px 60px rgba(0,0,0,0.55)", textAlign: "center" }}>
        <div style={{ fontSize: 34, lineHeight: 1, marginBottom: 12 }} aria-hidden>🚀</div>
        <h3 style={{ margin: "0 0 8px", fontSize: 17, color: "#e6edf3" }} data-id="UpdateBanner-text">{tr("updateBanner.available", "发现新版本 v{{v}}", { v: st.version })}</h3>
        <p style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.6, color: "#9aa4b2" }}>{tr("updateBanner.modalSub", "建议尽快更新到最新版本")}</p>
        <label data-id="UpdateBanner-auto" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, margin: "0 0 18px", fontSize: 12.5, color: "#c9d1d9", cursor: "pointer", userSelect: "none" }}>
          <input type="checkbox" checked={autoUpd} onChange={(e) => toggleAuto(e.target.checked)} style={{ accentColor: "#238636", width: 15, height: 15, margin: 0, cursor: "pointer" }} />
          {tr("updateBanner.autoNext", "以后发现新版本自动更新，不再询问")}
        </label>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button type="button" data-id="UpdateBanner-later" onClick={() => setDismissed(true)}
            style={{ flex: 1, padding: "9px 16px", borderRadius: 9, border: "1px solid #30363d", background: "transparent", color: "#c9d1d9", cursor: "pointer", fontSize: 14 }}>
            {tr("updateBanner.later", "稍后")}
          </button>
          <button type="button" data-id="UpdateBanner-download" onClick={startDownload}
            style={{ flex: 1, padding: "9px 16px", borderRadius: 9, border: "none", background: "#238636", color: "white", cursor: "pointer", fontSize: 14, fontWeight: 600 }}>
            {tr("updateBanner.updateNow", "立即更新")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
// 首次加载的团队卡占位骨架(与 .bcard 大致同形:头像圈 + 两行标题 + CTA 条)。
function SkeletonCard() {
  return (
    <div className="bcard bcard--skeleton" data-id="SkeletonCard" aria-hidden>
      <div className="bcard__accent" style={{ background: "rgba(255,255,255,.08)", opacity: 1 }} />
      {/* 对齐真实卡片:顶部 pill + kebab */}
      <div className="bcard__top">
        <div className="skel" style={{ width: 84, height: 26, borderRadius: 999 }} />
        <div className="skel" style={{ width: 22, height: 22, borderRadius: 6 }} />
      </div>
      {/* body:方头像(24)+ 名字行,下面 meta chip;flex:1 把 CTA 顶到底 */}
      <div style={{ flex: 1, minHeight: 0, marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="skel" style={{ width: 24, height: 24, borderRadius: 6, flex: "0 0 auto" }} />
          <div className="skel skel--line" style={{ width: "55%" }} />
        </div>
        <div className="skel" style={{ width: 60, height: 18, borderRadius: 6, marginTop: 12 }} />
      </div>
      <div className="skel skel--cta" style={{ marginTop: 0 }} />
    </div>
  );
}
// 团队头像:有自定义图(data URL)就显示图,否则「团队名首字母 + 按名 hash 的稳定底色」
// 圆角块。teamId 存在时点击可上传(resize 在主进程做,见 local-teams.setAvatar)。
// 同一份用于卡片头像 + tab icon(tab 那边在 tab-shell.html faviconNode 用 t.avatar)。
// Avatar 底色:一组**明显区分**的离散色板,而不是连续色相(连续色相会落到糊在一起
// 的邻近色,如 289° 紫 vs 314° 洋红)。12 个拉开 ≥24° 的色相 + 交替明度,不同 team 一眼
// 可分,白字始终清晰。key 必须 String —— 云端 teamId 是数字(71),数字没 .length,循环
// 不跑 → 恒 0 → 全同色。
const AVATAR_PALETTE = [
  "hsl(2 68% 48%)", "hsl(26 72% 46%)", "hsl(45 70% 42%)", "hsl(96 55% 38%)",
  "hsl(140 58% 40%)", "hsl(168 62% 36%)", "hsl(192 70% 42%)", "hsl(210 72% 50%)",
  "hsl(232 62% 56%)", "hsl(266 55% 55%)", "hsl(292 58% 50%)", "hsl(324 66% 50%)",
];
function hashStr(s) { s = String(s == null ? "" : s); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100003; return h; }
function avatarBg(key) { return AVATAR_PALETTE[hashStr(key) % AVATAR_PALETTE.length]; }
// 容器内使用 Docker(Docker-outside-of-Docker)modal —— 单 checkbox,像 CftModal 一样渲染在
// 卡片层(菜单外)。开启 → sidecar.setDood → 重建容器挂 docker.sock + 把 docker CLI 装进容器
// 持久卷,下载进度实时显示在弹窗里。DockerCard(Windows 容器)用。
function DoodModal({ open, onClose, toastId = "dood-op" }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [on, setOn] = useState(false);
  const [line, setLine] = useState("");
  useEffect(() => {
    if (!open || !window.cicy?.sidecar?.getDood) return;
    setErr(""); setLine("");
    window.cicy.sidecar.getDood().then((r) => setOn(!!r?.dood)).catch(() => {});
  }, [open]);
  // 把重建/下载进度实时显示在弹窗(installDockerCli 的每行输出经 op-progress 推来)
  useEffect(() => {
    if (!open || !busy || !window.cicy?.sidecar?.onOpProgress) return;
    return window.cicy.sidecar.onOpProgress((ev) => { if (ev?.message) setLine(String(ev.message)); });
  }, [open, busy]);
  const save = async () => {
    if (busy) return;
    setBusy(true); setErr(""); setLine("");
    toast.show({ id: toastId, message: on ? tr("dood.applying", "开启容器 Docker 访问,重建容器中…") : tr("dood.disabling", "关闭中…"), status: "running", progress: undefined });
    try {
      const r = await window.cicy.sidecar.setDood(on);
      if (r?.ok) {
        onClose && onClose();
        toast.show({ id: toastId, message: on ? tr("dood.onDone", "容器 Docker 访问已开启") : tr("dood.offDone", "容器 Docker 访问已关闭"), status: "done", ttl: 4000 });
      } else {
        setErr(r?.error || tr("dood.failed", "设置失败"));
        toast.show({ id: toastId, message: tr("dood.failed", "设置失败") + (r?.error ? `: ${r.error}` : ""), status: "error", ttl: 6000 });
      }
    } catch (e) { setErr(e?.message || String(e)); toast.show({ id: toastId, message: tr("dood.failed", "设置失败") + `: ${e?.message || e}`, status: "error", ttl: 6000 }); }
    finally { setBusy(false); }
  };
  const setOpenX = (v) => { if (!v) onClose && onClose(); };
  if (!open) return null;
  return (
    <>
      {createPortal(
        <div data-id="dood-modal"
          style={{ position: "fixed", inset: 0, zIndex: 66, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.5)" }}
          onMouseDown={(e) => { if (!busy && e.target === e.currentTarget) setOpenX(false); }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 440, maxWidth: "92vw", background: "var(--card, #1b1d22)", border: "1px solid var(--border, #2c2f36)", borderRadius: 14, padding: 22, boxShadow: "0 20px 60px rgba(0,0,0,.5)" }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{tr("dood.title", "容器内使用 Docker")}</div>
            <div style={{ fontSize: 12, opacity: .6, marginBottom: 16 }}>{tr("dood.subtitle", "把宿主 Docker + docker 客户端挂进容器,容器内 agent 就能直接跑 docker(秒生效,无需下载)")}</div>
            <label data-id="dood-toggle-row" style={{ display: "flex", alignItems: "center", gap: 10, cursor: busy ? "default" : "pointer", marginBottom: 12 }}>
              <input type="checkbox" data-id="dood-toggle" checked={on} disabled={busy}
                onChange={(e) => setOn(e.target.checked)} />
              <span style={{ fontSize: 14, fontWeight: 600 }}>{tr("dood.enable", "允许容器内使用 Docker")}</span>
            </label>
            {busy && line && <div data-id="dood-progress" style={{ fontSize: 11, opacity: .7, fontFamily: "var(--mono)", wordBreak: "break-all", margin: "0 0 8px", maxHeight: 60, overflow: "hidden" }}>{line}</div>}
            {err && <div className="error" style={{ marginTop: 8, fontSize: 12 }}>{err}</div>}
            <div className="modal-actions">
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => setOpenX(false)}>{tr("common.cancel", "取消")}</button>
              <button type="button" className="btn-primary" data-id="dood-save" disabled={busy} onClick={save}>{busy ? tr("common.saving", "保存中…") : tr("common.save", "保存")}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
function TeamAvatar({ avatar, name, teamId, onChanged, size = 34 }) {
  const fileRef = useRef(null);
  const initial = ((name || "?").trim()[0] || "?").toUpperCase();
  // 底色按**唯一的 teamId** 算(默认名都本地化成同一个「Local team」,按名字会同色)。
  const bg = avatarBg(teamId || name || "");
  const pick = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const r = new FileReader();
    r.onload = async () => { try { await window.cicy?.localTeams?.setAvatar?.(teamId, r.result); onChanged && onChanged(); } catch (_) {} };
    r.readAsDataURL(f);
  };
  return (
    <div data-id="TeamAvatar" className="team-avatar"
      title={teamId ? tr("teamCard.changeAvatar", "点击更换头像") : ""}
      onClick={teamId ? (e) => { e.stopPropagation(); fileRef.current && fileRef.current.click(); } : undefined}
      style={{ width: size, height: size, borderRadius: 9, flex: "none", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", cursor: teamId ? "pointer" : "default", background: avatar ? "#0d1117" : bg, color: "#fff", fontWeight: 700, fontSize: Math.round(size * 0.42), userSelect: "none" }}>
      {avatar ? <img src={avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : initial}
      {teamId && <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={pick} />}
    </div>
  );
}
function BrandGlyph() {
  // CiCy outline mark. Rendered white because it sits on the brand chip's
  // blue→violet gradient square.
  return (
    <svg width="22" height="22" viewBox="0 0 96 96" fill="none">
      <path d="M48 11L39.5 33.3L16 29.5L31 48L16 66.5L39.5 62.7L48 85L56.5 62.7L80 66.5L65 48L80 29.5L56.5 33.3Z"
        stroke="white" strokeWidth="10" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx="48" cy="48" r="6" fill="white" />
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
