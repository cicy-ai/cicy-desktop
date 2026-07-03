const { z } = require("zod");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { getChromeRuntimeRegistry } = require("../chrome/runtime-registry");
const {
  DEFAULT_USER_DATA_BASE_ROOT,
  getDefaultDebuggerPort,
  getDefaultUserDataDirRoot,
  getProfileDirectory,
  launchChrome,
  closeChromeProcess,
  bringChromeAppToForeground,
} = require("../chrome/chrome-launcher");
const { isPortOpen } = require("../utils/process-utils");
const { getVersion, getTargets, createTarget, activateTarget, callCdp } = require("../chrome/chrome-cdp-client");
const { resolveChromeDebuggerPort } = require("../chrome/debugger-port-resolver");
const { config } = require("../config");
const profileStore = require("../profiles/profile-store");
const { summarizeCookieLogins } = require("../utils/cookie-logins");
const { probeIpViaSession } = require("../utils/ip-probe");

const PRIVATE_CHROME_JSON = path.join(os.homedir(), "cicy-ai", "db", "chrome.json");
const PRIVATE_CHROME_TMP_DIR = path.join(os.homedir(), "chrome", "_tmp");
const PRIVATE_CHROME_ADD_TEMPLATE_DIR = path.join(os.homedir(), "chrome", "__tmp");
const DEFAULT_ADD_ORG_PATH = "~/Library/Application Support/Google/Chrome/Profile 9";

const injectedChromeProfileSchema = z.object({
  gmail: z.string().optional(),
  rpaDir: z.string().optional(),
  port: z.number().optional(),
  proxy: z.any().optional(),
  platform: z.record(z.any()).optional(),
  orgPath: z.string().nullable().optional(),
});

function expandHome(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

// tildify — collapse the home-dir prefix back to "~" for DISPLAY only.
// The machine has its own user (e.g. /Users/ton); surfacing that absolute path
// is non-portable for other people/agents, so anything shown/returned uses "~".
// NEVER feed a tildified path to Chrome's --user-data-dir or fs (use expandHome).
function tildify(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  const home = os.homedir();
  if (input === home) return "~";
  if (input.startsWith(home + path.sep)) return "~/" + input.slice(home.length + 1);
  return input;
}

// Delegate to the shared normalizer (profile-store) so chrome + electron agree
// on proxy encoding. Accepts string | {enable,url} | {url,enabled}; returns the
// URL string when enabled, else null (the contract chrome-launcher expects).
function normalizePrivateProxy(proxyValue) {
  const p = profileStore.normalizeProxy(proxyValue);
  return p.enabled && p.url ? p.url : null;
}

// All Chrome profiles share the single chrome-profile-1 mihomo listener (20001):
// cicy-mihomo's default config only emits that one listener (profile-2/3 are
// commented out), so a profile pointing at a dead per-profile port (20002…) or
// at no proxy at all can't load pages. Self-heal at launch — empty proxy or a
// local chrome-profile-range port (20000–20099) collapses to 20001; a genuine
// external proxy is left untouched. Non-destructive: only the launch arg is
// rewritten, chrome.json is not.
const SHARED_CHROME_PROXY = "socks5://127.0.0.1:20001";
function canonicalChromeProxy(proxyUrl) {
  if (!proxyUrl) return SHARED_CHROME_PROXY;
  try {
    const u = new URL(proxyUrl);
    const isLocal = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    const port = Number(u.port);
    if (isLocal && port >= 20000 && port <= 20099) return SHARED_CHROME_PROXY;
  } catch {}
  return proxyUrl;
}

function readPrivateChromeConfig() {
  if (!fs.existsSync(PRIVATE_CHROME_JSON)) return {};
  return JSON.parse(fs.readFileSync(PRIVATE_CHROME_JSON, "utf-8"));
}

function writePrivateChromeConfig(nextConfig) {
  const dir = path.dirname(PRIVATE_CHROME_JSON);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // chrome.json now holds per-account passwords + TOTP secrets — keep it
  // owner-only (0600). mode on writeFileSync only applies on create, so chmod
  // explicitly to also tighten a pre-existing world/group-readable file.
  fs.writeFileSync(PRIVATE_CHROME_JSON, JSON.stringify(nextConfig || {}, null, 2), { mode: 0o600 });
  try { fs.chmodSync(PRIVATE_CHROME_JSON, 0o600); } catch {}
}

function listPrivateChromeEntries({ includeHidden = false } = {}) {
  const data = readPrivateChromeConfig();
  const entries = Object.entries(data)
    .filter(([k]) => (includeHidden ? true : !k.startsWith("__")))
    .map(([profileKey, entry]) => {
      const m = /^profile_(\d+)$/.exec(profileKey);
      const accountIdx = m ? Number(m[1]) : null;
      return { profileKey, accountIdx, entry };
    })
    .sort((a, b) => {
      if (typeof a.accountIdx === "number" && typeof b.accountIdx === "number") return a.accountIdx - b.accountIdx;
      if (typeof a.accountIdx === "number") return -1;
      if (typeof b.accountIdx === "number") return 1;
      return a.profileKey.localeCompare(b.profileKey);
    });

  return entries;
}

function getPrivateChromeEntryByAccountIdx(accountIdx) {
  const data = readPrivateChromeConfig();
  const profileKey = `profile_${accountIdx}`;
  const entry = data[profileKey] || null;
  if (!entry) return null;
  return { profileKey, accountIdx, entry };
}

function normalizePrivateChromeEntry(profileKey, accountIdx, entry) {
  const safeEntry = entry && typeof entry === "object" ? entry : {};
  const gmail = typeof safeEntry.gmail === "string" ? safeEntry.gmail : "";
  const orgPath = typeof safeEntry.orgPath === "string" ? safeEntry.orgPath : null;
  const rpaDir = typeof safeEntry.rpaDir === "string" ? safeEntry.rpaDir : null;
  const port = typeof safeEntry.port === "number" ? safeEntry.port : null;
  const proxyUrl = normalizePrivateProxy(safeEntry.proxy);
  const platform = safeEntry.platform && typeof safeEntry.platform === "object" ? safeEntry.platform : {};
  // Free-text note + a service→credentials map for `list profile with <svc>` —
  // written via chrome_set_profile_meta. Each value is {account,password,totp}.
  // Legacy normalization: array → {}; a bare string value → {account:<string>}.
  const note = typeof safeEntry.note === "string" ? safeEntry.note : "";
  const rawAccounts =
    safeEntry.accounts && typeof safeEntry.accounts === "object" && !Array.isArray(safeEntry.accounts)
      ? safeEntry.accounts
      : {};
  const accounts = {};
  for (const [svc, val] of Object.entries(rawAccounts)) {
    if (typeof val === "string") accounts[svc] = { account: val };
    else if (val && typeof val === "object" && !Array.isArray(val)) accounts[svc] = val;
  }

  return {
    profileKey,
    accountIdx,
    gmail,
    orgPath,
    rpaDir,
    port,
    proxy: safeEntry.proxy,
    proxyUrl,
    platform,
    note,
    accounts,
    expanded: {
      orgPath: orgPath ? expandHome(orgPath) : null,
      rpaDir: rpaDir ? expandHome(rpaDir) : null,
    },
  };
}

// resolveGmail derives a profile's Google identity. The `account` CLI / UI now
// records identities in the `accounts` map (accounts.gmail / accounts.google),
// so read from there FIRST and only fall back to the legacy top-level `gmail`
// field (which was only ever set at `add --gmail` time). This is why gmail/login
// info showed empty: it was recorded into accounts.* but everything read the
// top-level gmail field.
function resolveGmail(normalized) {
  const a = (normalized && normalized.accounts) || {};
  return (
    (a.gmail && a.gmail.account) ||
    (a.google && a.google.account) ||
    (normalized && normalized.gmail) ||
    ""
  );
}

function normalizeEffectiveChromeProfile(accountIdx, effectiveChromeProfile) {
  const parsed = injectedChromeProfileSchema.parse(effectiveChromeProfile || {});
  const gmail = typeof parsed.gmail === "string" ? parsed.gmail : "";
  const rpaDir = typeof parsed.rpaDir === "string" ? parsed.rpaDir : null;
  const orgPath = typeof parsed.orgPath === "string" ? parsed.orgPath : null;
  const port = typeof parsed.port === "number" ? parsed.port : null;
  const proxyUrl = normalizePrivateProxy(parsed.proxy);
  const platform = parsed.platform && typeof parsed.platform === "object" ? parsed.platform : {};

  return {
    profileKey: `profile_${accountIdx}`,
    accountIdx,
    gmail,
    orgPath,
    rpaDir,
    port,
    proxy: parsed.proxy,
    proxyUrl,
    platform,
    expanded: {
      orgPath: orgPath ? expandHome(orgPath) : null,
      rpaDir: rpaDir ? expandHome(rpaDir) : null,
    },
  };
}

function ensureRpaProfileInitialized({ templateDir, orgPath, userDataDirRoot }) {
  if (!userDataDirRoot || fs.existsSync(userDataDirRoot)) return;

  const effectiveTemplateDir = templateDir || PRIVATE_CHROME_TMP_DIR;
  if (effectiveTemplateDir && fs.existsSync(effectiveTemplateDir)) {
    fs.cpSync(effectiveTemplateDir, userDataDirRoot, { recursive: true });
  } else {
    fs.mkdirSync(userDataDirRoot, { recursive: true });
  }

  const defaultProfileDir = path.join(userDataDirRoot, "Default");
  const expandedOrgPath = orgPath ? expandHome(orgPath) : null;
  // Best-effort: only copy if the orgPath exists locally on this worker.
  if (!fs.existsSync(defaultProfileDir) && expandedOrgPath && fs.existsSync(expandedOrgPath)) {
    fs.cpSync(expandedOrgPath, defaultProfileDir, { recursive: true });
  }
}

async function probeChromeDebugger(debuggerPort) {
  if (typeof debuggerPort !== "number") {
    return { isRunning: false, debuggerPort };
  }

  const open = await isPortOpen(debuggerPort, "127.0.0.1", 400);
  if (!open) {
    return { isRunning: false, debuggerPort };
  }

  try {
    const version = await getVersion(debuggerPort, "127.0.0.1");
    return {
      isRunning: true,
      debuggerPort,
      version,
      webSocketDebuggerUrl: version?.webSocketDebuggerUrl || null,
    };
  } catch (error) {
    // Align with chrome-rpa.sh: /json/version not reachable => treat as stopped
    return { isRunning: false, debuggerPort, error: error.message };
  }
}

function toToolResult(obj, { isError = false } = {}) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
    ...(isError ? { isError: true } : null),
  };
}

function buildTargetsPreview(targets = []) {
  return targets
    .filter((target) => target.type === "page")
    .slice(0, 3)
    .map((target) => ({ id: target.id, title: target.title, url: target.url }));
}

async function ensurePageTargets({ debuggerPort, url, activateIfRunning, deps = {} }) {
  const getTargetsImpl = deps.getTargets || getTargets;
  const createTargetImpl = deps.createTarget || createTarget;
  const activateTargetImpl = deps.activateTarget || activateTarget;
  let targets = [];
  let activatedTargetId = null;

  try {
    targets = await getTargetsImpl(debuggerPort);
  } catch (_) {
    return { targets, activatedTargetId };
  }

  const pageTargets = targets.filter((target) => target.type === "page");
  const targetUrl = typeof url === "string" && url.length ? url : null;
  // Match normalized, not by raw ===. launchChrome already opened `url` as the
  // startup tab, but Chrome canonicalizes it (adds a trailing slash: passed
  // "https://x.com" loads as "https://x.com/"), so an exact compare misses the
  // tab we just launched → we'd createTarget a duplicate. Normalize a trailing
  // slash on the path + a bare "#" so the existing tab is recognized.
  const normUrl = (u) => {
    if (typeof u !== "string" || !u) return null;
    try {
      const x = new URL(u);
      return (x.origin + x.pathname.replace(/\/+$/, "") + x.search + (x.hash === "#" ? "" : x.hash)).toLowerCase();
    } catch (_) {
      return u.trim().replace(/\/+$/, "").toLowerCase();
    }
  };
  const targetUrlNorm = normUrl(targetUrl);
  const matchingTarget = targetUrlNorm
    ? pageTargets.find((target) => normUrl(target.url) === targetUrlNorm) || null
    : null;

  if (!pageTargets.length) {
    try {
      const createdTarget = await createTargetImpl(debuggerPort, targetUrl || "about:blank");
      activatedTargetId = createdTarget?.id || null;
      if (activateIfRunning && activatedTargetId) {
        await activateTargetImpl(debuggerPort, activatedTargetId);
      }
      targets = await getTargetsImpl(debuggerPort);
      return { targets, activatedTargetId };
    } catch (_) {
      return { targets, activatedTargetId };
    }
  }

  if (targetUrl && !matchingTarget) {
    try {
      const createdTarget = await createTargetImpl(debuggerPort, targetUrl);
      activatedTargetId = createdTarget?.id || null;
      if (activateIfRunning && activatedTargetId) {
        await activateTargetImpl(debuggerPort, activatedTargetId);
      }
      targets = await getTargetsImpl(debuggerPort);
      return { targets, activatedTargetId };
    } catch (_) {
      return { targets, activatedTargetId };
    }
  }

  const targetToActivate = matchingTarget || pageTargets[0] || null;
  if (activateIfRunning && targetToActivate?.id) {
    activatedTargetId = targetToActivate.id;
    try {
      await activateTargetImpl(debuggerPort, targetToActivate.id);
    } catch (_) {}
  }

  return { targets, activatedTargetId };
}

async function launchOrActivateProfile({
  accountIdx,
  url,
  activateIfRunning = true,
  effectiveChromeProfile,
}) {
  const registry = getChromeRuntimeRegistry();
  const profileKey = `profile_${accountIdx}`;

  let normalized;
  let profileSource;
  if (effectiveChromeProfile) {
    normalized = normalizeEffectiveChromeProfile(accountIdx, effectiveChromeProfile);
    profileSource = "master";
  } else {
    const cfg = getPrivateChromeEntryByAccountIdx(accountIdx);
    if (!cfg) {
      throw new Error(
        `Missing chrome profile for profile_${accountIdx}. Use master dispatch or pass effectiveChromeProfile.`
      );
    }
    normalized = normalizePrivateChromeEntry(cfg.profileKey, cfg.accountIdx, cfg.entry);
    profileSource = "local";
  }

  const effectivePort =
    normalized.port ?? getDefaultDebuggerPort(accountIdx, config.chromeDebuggerBasePort);

  if (effectivePort === 9221) {
    throw new Error("Chrome debugger port 9221 is reserved by Electron. Please use another port.");
  }

  const effectiveProxy = canonicalChromeProxy(normalized.proxyUrl);
  const effectiveUserDataDirRoot =
    normalized.expanded.rpaDir ||
    getDefaultUserDataDirRoot(accountIdx, config.chromeUserDataRoot || DEFAULT_USER_DATA_BASE_ROOT);
  // ~-collapsed form for anything returned/stored for display (portable across users)
  const displayUserDataDir = tildify(effectiveUserDataDirRoot);

  // Script parity: if /json/version reachable => activate first page target and return reused
  const liveStatus = await probeChromeDebugger(effectivePort);
  if (liveStatus.isRunning) {
    // Detect a windowless Chrome — debugger up but 0 page targets. It lingers on
    // macOS after its last window is closed; reusing it is unreliable because a
    // CDP-created tab has no browser window and Chrome discards it, leaving the
    // profile stuck at "No inspectable targets". Only trust an explicit empty
    // list (a transient /json/list failure must NOT be read as windowless, or we
    // could kill a Chrome that actually has the user's tabs open).
    let windowless = false;
    try {
      const live = await getTargets(effectivePort);
      windowless = Array.isArray(live) && live.filter((t) => t.type === "page").length === 0;
    } catch (_) {
      windowless = false;
    }

    if (!windowless) {
      const { targets, activatedTargetId } = await ensurePageTargets({
        debuggerPort: effectivePort,
        url,
        activateIfRunning,
      });
      if (activateIfRunning) bringChromeAppToForeground();

      const nextRuntime = registry.upsert(accountIdx, {
        status: "running",
        debuggerPort: effectivePort,
        proxy: effectiveProxy || null,
        userDataDirRoot: displayUserDataDir,
        profileDirectory: getProfileDirectory(accountIdx),
        url: url || null,
        webSocketDebuggerUrl: liveStatus.webSocketDebuggerUrl || null,
        error: null,
      });

      return {
        reused: true,
        activatedTargetId,
        profileKey,
        profileSource,
        accountIdx,
        gmail: normalized.gmail,
        port: effectivePort,
        proxy: effectiveProxy || null,
        userDataDirRoot: displayUserDataDir,
        runtime: nextRuntime,
        liveStatus,
        targetsPreview: buildTargetsPreview(targets),
      };
    }

    // Windowless: tear the lingering process down (release its SingletonLock on
    // the user-data-dir) before falling through to the fresh-launch path, which
    // spawns Chrome with a real, persistent window.
    const lingering = registry.get(accountIdx);
    if (lingering?.pid) {
      closeChromeProcess(lingering.pid);
    } else if (liveStatus.webSocketDebuggerUrl) {
      try {
        await callCdp({
          debuggerPort: effectivePort,
          target: liveStatus.webSocketDebuggerUrl,
          method: "Browser.close",
          params: {},
        });
      } catch (_) {}
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  ensureRpaProfileInitialized({
    templateDir: PRIVATE_CHROME_TMP_DIR,
    orgPath: normalized.orgPath,
    userDataDirRoot: effectiveUserDataDirRoot,
  });

  const existing = registry.get(accountIdx);
  if (existing?.pid) {
    closeChromeProcess(existing.pid);
  }

  registry.upsert(accountIdx, {
    status: "starting",
    pid: null,
    debuggerPort: effectivePort,
    proxy: effectiveProxy || null,
    chromeBinary: config.chromeBinary || null,
    userDataDirRoot: displayUserDataDir,
    profileDirectory: getProfileDirectory(accountIdx),
    url: url || null,
    error: null,
  });

  const launched = await launchChrome({
    accountIdx,
    debuggerPort: effectivePort,
    proxy: effectiveProxy,
    chromeBinary: config.chromeBinary,
    url,
    userDataDirRoot: effectiveUserDataDirRoot,
  });

  const nextRuntime = registry.upsert(accountIdx, {
    status: "running",
    startedAt: new Date().toISOString(),
    pid: launched.pid,
    debuggerPort: launched.debuggerPort,
    proxy: launched.proxy,
    chromeBinary: launched.chromeBinary,
    userDataDirRoot: tildify(launched.userDataDirRoot),
    profileDirectory: launched.profileDirectory,
    url: launched.url,
    webSocketDebuggerUrl: launched.webSocketDebuggerUrl,
    error: null,
  });

  const { targets, activatedTargetId } = await ensurePageTargets({
    debuggerPort: launched.debuggerPort,
    url,
    activateIfRunning: true,
  });

  return {
    reused: false,
    profileKey,
    profileSource,
    accountIdx,
    gmail: normalized.gmail,
    port: effectivePort,
    proxy: effectiveProxy || null,
    userDataDirRoot: displayUserDataDir,
    runtime: nextRuntime,
    activatedTargetId,
    targetsPreview: buildTargetsPreview(targets),
  };
}

function registerChromeTools(registerTool) {
  registerTool(
    "chrome_list_profiles",
    "列出 ~/cicy-ai/db/chrome.json 中全部 Chrome profiles，并附带 runtime + live 状态",
    z.object({
      includeHidden: z.boolean().optional().describe("是否包含 __* 隐藏项（默认 false）"),
    }),
    async ({ includeHidden } = {}) => {
      const registry = getChromeRuntimeRegistry();
      const entries = listPrivateChromeEntries({ includeHidden: !!includeHidden });

      const views = [];
      for (const { profileKey, accountIdx, entry } of entries) {
        const normalized = normalizePrivateChromeEntry(profileKey, accountIdx, entry);
        const port =
          normalized.port ??
          (typeof accountIdx === "number"
            ? getDefaultDebuggerPort(accountIdx, config.chromeDebuggerBasePort)
            : null);

        const liveStatus = await probeChromeDebugger(port);
        const runtime = typeof accountIdx === "number" ? registry.get(accountIdx) : null;

        views.push({
          profileKey,
          accountIdx,
          gmail: resolveGmail(normalized),
          note: normalized.note,
          orgPath: normalized.orgPath,
          rpaDir: normalized.rpaDir,
          port,
          proxy: normalized.proxyUrl,
          proxyRaw: normalized.proxy,
          platform: normalized.platform,
          // The service→credentials map (accounts.gmail / .github / …) — the panel
          // reads identities from here, so it must travel with the list view.
          accounts: normalized.accounts,
          // parity with electron_list_profiles so the panel renders the same row
          ipInfo: profileStore.normalizeIpInfo(entry.ipInfo),
          logins: (Array.isArray(entry.logins) ? entry.logins : []).map(profileStore.normalizeLogin),
          runtime,
          liveStatus,
        });
      }

      return toToolResult({ profiles: views });
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_list_gmails",
    "列出 ~/cicy-ai/db/chrome.json 中全部 profile 的 gmail",
    z.object({
      includeHidden: z.boolean().optional().describe("是否包含 __* 隐藏项（默认 false）"),
    }),
    async ({ includeHidden } = {}) => {
      const entries = listPrivateChromeEntries({ includeHidden: !!includeHidden });
      const gmails = entries
        .map(({ profileKey, accountIdx, entry }) => resolveGmail(normalizePrivateChromeEntry(profileKey, accountIdx, entry)))
        .filter(Boolean);
      return toToolResult({ gmails });
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_list_github_accounts",
    "列出 ~/cicy-ai/db/chrome.json 中全部 profile 的 GitHub 账号信息（platform.github）",
    z.object({
      includeHidden: z.boolean().optional().describe("是否包含 __* 隐藏项（默认 false）"),
    }),
    async ({ includeHidden } = {}) => {
      const entries = listPrivateChromeEntries({ includeHidden: !!includeHidden });
      const accounts = entries.map(({ profileKey, accountIdx, entry }) => {
        const normalized = normalizePrivateChromeEntry(profileKey, accountIdx, entry);
        const gh = normalized.platform?.github || {};
        const ghAcct = (normalized.accounts && normalized.accounts.github) || {};
        return {
          profileKey,
          accountIdx,
          gmail: resolveGmail(normalized),
          email: gh.email || ghAcct.email || "",
          username: gh.username || ghAcct.account || "",
        };
      });
      return toToolResult({ githubAccounts: accounts });
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_list_kiro_accounts",
    "列出 ~/cicy-ai/db/chrome.json 中全部 profile 的 Kiro 绑定状态（platform.kiro）",
    z.object({
      includeHidden: z.boolean().optional().describe("是否包含 __* 隐藏项（默认 false）"),
    }),
    async ({ includeHidden } = {}) => {
      const entries = listPrivateChromeEntries({ includeHidden: !!includeHidden });
      const accounts = entries.map(({ profileKey, accountIdx, entry }) => {
        const normalized = normalizePrivateChromeEntry(profileKey, accountIdx, entry);
        const kiro = normalized.platform?.kiro || {};
        const gmail = kiro.gmail || {};
        const github = kiro.github || {};
        return {
          profileKey,
          accountIdx,
          gmail: normalized.gmail,
          gmailBound: !!gmail.isBinded,
          gmailMonthExpired: !!gmail.monthExpired,
          githubBound: !!github.isBinded,
          githubMonthExpired: !!github.monthExpired,
        };
      });
      return toToolResult({ kiroAccounts: accounts });
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_get_profile",
    "获取指定 accountIdx 的 profile：privateConfig + runtime + liveStatus（脚本心智）",
    z.object({
      accountIdx: z.number().describe("账户索引，映射到 ~/cicy-ai/db/chrome.json 的 profile_<idx>"),
    }),
    async ({ accountIdx }) => {
      const registry = getChromeRuntimeRegistry();
      const cfg = getPrivateChromeEntryByAccountIdx(accountIdx);
      if (!cfg) {
        return toToolResult(
          { error: `Missing chrome.json entry: profile_${accountIdx}` },
          { isError: true }
        );
      }

      const normalized = normalizePrivateChromeEntry(cfg.profileKey, cfg.accountIdx, cfg.entry);
      const port = normalized.port ?? getDefaultDebuggerPort(accountIdx, config.chromeDebuggerBasePort);
      const liveStatus = await probeChromeDebugger(port);

      return toToolResult({
        profileKey: cfg.profileKey,
        accountIdx,
        privateConfig: cfg.entry,
        runtime: registry.get(accountIdx),
        liveStatus,
      });
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_launch_profile",
    "按 chrome-rpa.sh 语义启动或激活指定 accountIdx 对应的 Chrome profile",
    z.object({
      accountIdx: z.number().describe("账户索引"),
      url: z.string().optional().describe("启动时传入的 URL（可选）"),
      activateIfRunning: z
        .boolean()
        .optional()
        .describe("若已运行则激活首个 page target（默认 true）"),
      effectiveChromeProfile: injectedChromeProfileSchema
        .optional()
        .describe("可选：由 master 注入的 profile 配置；worker 本地无需 chrome.json"),
    }),
    async ({ accountIdx, url, activateIfRunning, effectiveChromeProfile } = {}) => {
      try {
        const result = await launchOrActivateProfile({
          accountIdx,
          url,
          activateIfRunning: activateIfRunning !== false,
          effectiveChromeProfile,
        });
        return toToolResult(result);
      } catch (error) {
        return toToolResult({ error: error.message }, { isError: true });
      }
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_add_profile",
    "新增账号（等价于 chrome-rpa.sh add）：从 ~/chrome/__tmp 创建 ~/chrome/profile_N 并写回 ~/cicy-ai/db/chrome.json",
    z.object({
      gmail: z.string().optional().describe("可选：新账号 gmail"),
      orgPath: z.string().optional().describe("可选：orgPath（默认 Profile 9）"),
      launchAfterCreate: z.boolean().optional().describe("创建后是否立刻启动（默认 false）"),
    }),
    async ({ gmail, orgPath, launchAfterCreate } = {}) => {
      const data = readPrivateChromeConfig();
      const nums = Object.keys(data)
        .map((k) => (/^profile_(\d+)$/.exec(k) ? Number(/^profile_(\d+)$/.exec(k)[1]) : null))
        .filter((n) => typeof n === "number");
      const nextNum = nums.length ? Math.max(...nums) + 1 : 1;

      const profileKey = `profile_${nextNum}`;
      const port = 11000 + nextNum;
      const rpaDirTilde = `~/chrome/profile_${nextNum}`;
      const rpaDir = expandHome(rpaDirTilde);

      if (fs.existsSync(rpaDir)) {
        return toToolResult(
          { error: `Target rpaDir already exists: ${rpaDir}` },
          { isError: true }
        );
      }

      const templateDir = fs.existsSync(PRIVATE_CHROME_ADD_TEMPLATE_DIR)
        ? PRIVATE_CHROME_ADD_TEMPLATE_DIR
        : fs.existsSync(PRIVATE_CHROME_TMP_DIR)
          ? PRIVATE_CHROME_TMP_DIR
          : null;

      if (templateDir) {
        fs.cpSync(templateDir, rpaDir, { recursive: true });
      } else {
        fs.mkdirSync(rpaDir, { recursive: true });
      }

      data[profileKey] = {
        gmail: typeof gmail === "string" ? gmail : "",
        orgPath: typeof orgPath === "string" && orgPath.length ? orgPath : DEFAULT_ADD_ORG_PATH,
        rpaDir: rpaDirTilde,
        port,
        // New chrome profiles default to the chrome-profile-1 mihomo listener.
        proxy: "socks5://127.0.0.1:20001",
      };

      writePrivateChromeConfig(data);

      const created = {
        profileKey,
        accountIdx: nextNum,
        privateConfig: data[profileKey],
      };

      if (launchAfterCreate) {
        const launched = await launchOrActivateProfile({ accountIdx: nextNum, activateIfRunning: true });
        return toToolResult({ created, launched });
      }

      return toToolResult({ created });
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_set_profile_proxy",
    "设置 ~/cicy-ai/db/chrome.json 中指定 accountIdx 的 proxy（持久化为 {url,enabled}；下次启动生效）",
    z.object({
      accountIdx: z.number().describe("账户索引"),
      proxy: z.string().optional().describe("代理 URL；留空则清空"),
    }),
    async ({ accountIdx, proxy } = {}) => {
      try {
        const view = profileStore.setProxy("chrome", accountIdx, proxy || "");
        return toToolResult({ success: true, profileKey: `profile_${accountIdx}`, profile: view });
      } catch (e) {
        return toToolResult({ error: e.message }, { isError: true });
      }
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_profile_login_add",
    "记录某 Chrome profile 登录了哪个平台账号（每个平台一条，重复平台覆盖）",
    z.object({
      accountIdx: z.number().describe("账户索引"),
      platform: z.string().describe("平台，如 github / google / x"),
      account: z.string().describe("账号标识，如 alice@x.com"),
    }),
    async ({ accountIdx, platform, account } = {}) => {
      try {
        return toToolResult(profileStore.addLogin("chrome", accountIdx, platform, account));
      } catch (e) {
        return toToolResult({ error: e.message }, { isError: true });
      }
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_profile_login_set",
    "新增/更新某 Chrome profile 的一条登录记录（富字段：地址/名称/用户名/邮箱/手机/2FA/备用邮箱/备注；按名称 name 归并，只覆盖传入的非空字段）",
    z.object({
      accountIdx: z.number().describe("账户索引"),
      name: z.string().describe("名称＝平台/站点名，如 抖音 / Google（归并键）"),
      url: z.string().optional().describe("地址，如 https://www.douyin.com"),
      username: z.string().optional().describe("用户名"),
      email: z.string().optional().describe("邮箱"),
      mobile: z.string().optional().describe("手机号"),
      twofa: z.string().optional().describe("2FA（TOTP 秘钥或说明）"),
      secondEmail: z.string().optional().describe("备用邮箱"),
      note: z.string().optional().describe("备注"),
      loginAt: z.string().optional().describe("登录时间 ISO（不传则首次记录时自动 now）"),
    }),
    async ({ accountIdx, ...login } = {}) => {
      try {
        return toToolResult(profileStore.setLogin("chrome", accountIdx, login));
      } catch (e) {
        return toToolResult({ error: e.message }, { isError: true });
      }
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_profile_login_rm",
    "移除某 Chrome profile 的某平台登录记录",
    z.object({
      accountIdx: z.number().describe("账户索引"),
      platform: z.string().describe("平台"),
    }),
    async ({ accountIdx, platform } = {}) => {
      try {
        return toToolResult(profileStore.removeLogin("chrome", accountIdx, platform));
      } catch (e) {
        return toToolResult({ error: e.message }, { isError: true });
      }
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_profile_logins",
    "列出某 Chrome profile 已记录的平台登录",
    z.object({ accountIdx: z.number().describe("账户索引") }),
    async ({ accountIdx } = {}) => {
      try {
        return toToolResult(profileStore.listLogins("chrome", accountIdx));
      } catch (e) {
        return toToolResult({ error: e.message }, { isError: true });
      }
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_set_profile_meta",
    "设置 ~/cicy-ai/db/chrome.json 中指定 accountIdx 的 note（备注）/ accounts（服务→{account,password,totp} map，用于 list profile with <svc> + 自动 2FA）",
    z.object({
      accountIdx: z.number().describe("账户索引"),
      note: z.string().optional().describe("自由文本备注；省略则不动"),
      accounts: z
        .record(
          z
            .object({
              account: z.string().optional(),
              password: z.string().optional(),
              totp: z.string().optional(),
            })
            .partial()
        )
        .optional()
        .describe(
          "服务→{account,password,totp} map，如 {github:{account:'octocat',password:'..',totp:'BASE32'}}；字段级合并，字段空值删该字段，svc 清空则删该服务；省略则整体不动"
        ),
    }),
    async ({ accountIdx, note, accounts } = {}) => {
      const data = readPrivateChromeConfig();
      const key = `profile_${accountIdx}`;
      if (!data[key]) {
        return toToolResult({ error: `Missing chrome.json entry: ${key}` }, { isError: true });
      }
      const patch = { ...data[key], ...(note !== undefined ? { note: String(note) } : {}) };
      if (accounts !== undefined) {
        // Field-level merge into the existing service→credentials map.
        // Empty field value deletes that field; a service with no fields left
        // is removed entirely. Legacy string value normalizes to {account}.
        const base =
          data[key].accounts && typeof data[key].accounts === "object" && !Array.isArray(data[key].accounts)
            ? data[key].accounts
            : {};
        const next = { ...base };
        for (const [rawSvc, fieldPatch] of Object.entries(accounts)) {
          const svc = String(rawSvc).trim().toLowerCase();
          if (!svc) continue;
          let cur = next[svc];
          if (typeof cur === "string") cur = { account: cur }; // 1.3.0 compat
          cur = cur && typeof cur === "object" && !Array.isArray(cur) ? { ...cur } : {};
          for (const [f, v] of Object.entries(fieldPatch || {})) {
            const val = String(v ?? "").trim();
            if (val === "") delete cur[f];
            else cur[f] = val;
          }
          if (Object.keys(cur).length === 0) delete next[svc];
          else next[svc] = cur;
        }
        patch.accounts = next;
      }
      data[key] = patch;
      writePrivateChromeConfig(data);
      return toToolResult({ success: true, profileKey: key, privateConfig: data[key] });
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_close_profile",
    "关闭指定 accountIdx 对应的真实 Chrome profile 进程",
    z.object({
      accountIdx: z.number().describe("账户索引"),
    }),
    async ({ accountIdx }) => {
      const registry = getChromeRuntimeRegistry();
      const rt = registry.get(accountIdx);

      // Prefer killing by pid if we have it.
      if (rt?.pid) {
        closeChromeProcess(rt.pid);
      } else {
        // Best-effort close by CDP if chrome.json has the port and it's running.
        const cfg = getPrivateChromeEntryByAccountIdx(accountIdx);
        const port = typeof cfg?.entry?.port === "number" ? cfg.entry.port : null;
        const liveStatus = await probeChromeDebugger(port);
        if (liveStatus.isRunning) {
          try {
            await callCdp({ debuggerPort: port, method: "Browser.close", params: {} });
          } catch (_) {}
        }
      }

      const next = registry.markStopped(accountIdx);
      return toToolResult(next);
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_get_targets",
    "获取指定 accountIdx 的当前 targets/tabs 列表（/json/list；优先取 chrome.json 的 port）",
    z.object({
      accountIdx: z.number().describe("账户索引"),
    }),
    async ({ accountIdx }) => {
      const registry = getChromeRuntimeRegistry();
      const cfg = getPrivateChromeEntryByAccountIdx(accountIdx);
      const { debuggerPort: port } = resolveChromeDebuggerPort(accountIdx, {
        registry,
        chromeConfig: cfg ? { [`profile_${accountIdx}`]: cfg.entry } : null,
      });

      if (!port) {
        return toToolResult({ error: `Missing debuggerPort for accountIdx=${accountIdx}` }, { isError: true });
      }

      try {
        const targets = await getTargets(port);
        registry.upsert(accountIdx, {
          status: "running",
          debuggerPort: port,
          lastSeenAt: new Date().toISOString(),
          error: null,
        });
        return toToolResult({ debuggerPort: port, targets });
      } catch (error) {
        registry.upsert(accountIdx, { status: "error", error: error.message, debuggerPort: port });
        return toToolResult({ error: error.message }, { isError: true });
      }
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_cdp_call",
    "对指定 accountIdx 发起任意 CDP method 调用（通过 chrome-remote-interface；优先取 chrome.json 的 port）",
    z.object({
      accountIdx: z.number().describe("账户索引"),
      method: z.string().describe("CDP method，如 Browser.getVersion / Target.getTargets / Page.navigate"),
      params: z.record(z.any()).optional().describe("CDP params（可选）"),
      target: z.string().optional().describe("可选：chrome-remote-interface target selector"),
    }),
    async ({ accountIdx, method, params, target }) => {
      const registry = getChromeRuntimeRegistry();
      const cfg = getPrivateChromeEntryByAccountIdx(accountIdx);
      const { debuggerPort: port } = resolveChromeDebuggerPort(accountIdx, {
        registry,
        chromeConfig: cfg ? { [`profile_${accountIdx}`]: cfg.entry } : null,
      });

      if (!port) {
        return toToolResult({ error: `Missing debuggerPort for accountIdx=${accountIdx}` }, { isError: true });
      }

      try {
        // Browser-level CDP methods (Target.*, Browser.*) must attach to the
        // browser endpoint, not a page target. Without an explicit target, CRI
        // defaults to the first page target and fails with "No inspectable
        // targets" when the profile has 0 page targets — a windowless Chrome
        // lingering after its last window was closed, or Chrome 149 where the
        // HTTP /json/new tab-create endpoint is disabled. Resolve the browser
        // websocket so "add tab" (Target.createTarget) works from any state.
        let effectiveTarget = target;
        if (!effectiveTarget && /^(Target|Browser)\./.test(method)) {
          try {
            const v = await getVersion(port);
            if (v && v.webSocketDebuggerUrl) effectiveTarget = v.webSocketDebuggerUrl;
          } catch (_) {}
        }
        const result = await callCdp({
          debuggerPort: port,
          method,
          params: params || {},
          target: effectiveTarget,
        });
        registry.upsert(accountIdx, {
          status: "running",
          debuggerPort: port,
          lastSeenAt: new Date().toISOString(),
          error: null,
        });
        return toToolResult({ debuggerPort: port, result });
      } catch (error) {
        registry.upsert(accountIdx, { status: "error", error: error.message, debuggerPort: port });
        return toToolResult({ error: error.message }, { isError: true });
      }
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_probe_ip",
    "探测某 Chrome profile 当前出口 IP + 地区(经其配置代理,用临时 Electron session,无需启动 Chrome),写入 config 并盖探测时间;可重复探测",
    z.object({ accountIdx: z.number().describe("账户索引") }),
    async ({ accountIdx }) => {
      try {
        const { session } = require("electron");
        const view = profileStore.getProfile("chrome", accountIdx);
        const rules = profileStore.proxyRules(view && view.proxy);
        const ses = session.fromPartition(`chrome-ipprobe-${accountIdx}`, { cache: false });
        await ses.setProxy({ proxyRules: rules || "direct://" });
        const info = await probeIpViaSession(ses);
        const saved = profileStore.setIpInfo("chrome", accountIdx, info);
        return toToolResult({ accountIdx, backend: "chrome", proxy: rules || null, ipInfo: saved.ipInfo });
      } catch (e) {
        return toToolResult({ error: e.message }, { isError: true });
      }
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_detect_logins",
    "探测指定 Chrome profile 当前 session 登录了哪些站点：读取全部 cookie 按域名归并，标记带会话 cookie 的域名（cookie 在≠一定登录，仅强信号；profile 需在运行）",
    z.object({ accountIdx: z.number().describe("账户索引") }),
    async ({ accountIdx }) => {
      const registry = getChromeRuntimeRegistry();
      const cfg = getPrivateChromeEntryByAccountIdx(accountIdx);
      const { debuggerPort: port } = resolveChromeDebuggerPort(accountIdx, {
        registry,
        chromeConfig: cfg ? { [`profile_${accountIdx}`]: cfg.entry } : null,
      });
      if (!port) {
        return toToolResult(
          { error: `Missing debuggerPort for accountIdx=${accountIdx}（profile 未启动？先 launch）` },
          { isError: true }
        );
      }
      try {
        const { cookies } = await callCdp({ debuggerPort: port, method: "Storage.getCookies", params: {} });
        return toToolResult({ accountIdx, backend: "chrome", ...summarizeCookieLogins(cookies) });
      } catch (error) {
        return toToolResult({ error: error.message }, { isError: true });
      }
    },
    { tag: "Chrome" }
  );
}

module.exports = registerChromeTools;
module.exports.__testables = {
  ensurePageTargets,
};
