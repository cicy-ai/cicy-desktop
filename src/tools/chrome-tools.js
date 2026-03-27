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
} = require("../chrome/chrome-launcher");
const { isPortOpen } = require("../utils/process-utils");
const { getVersion, getTargets, activateTarget, callCdp } = require("../chrome/chrome-cdp-client");
const { config } = require("../config");

const PRIVATE_CHROME_JSON = path.join(os.homedir(), "Private", "chrome.json");
const PRIVATE_CHROME_TMP_DIR = path.join(os.homedir(), "chrome", "_tmp");
const PRIVATE_CHROME_ADD_TEMPLATE_DIR = path.join(os.homedir(), "chrome", "__tmp");
const DEFAULT_ADD_ORG_PATH = "~/Library/Application Support/Google/Chrome/Profile 9";

function expandHome(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function normalizePrivateProxy(proxyValue) {
  if (typeof proxyValue === "string") {
    return proxyValue || null;
  }
  if (proxyValue && typeof proxyValue === "object" && proxyValue.enable && proxyValue.url) {
    return proxyValue.url;
  }
  return null;
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
  fs.writeFileSync(PRIVATE_CHROME_JSON, JSON.stringify(nextConfig || {}, null, 2));
}

function listPrivateChromeEntries({ includeHidden = false } = {}) {
  const data = readPrivateChromeConfig();
  const entries = Object.entries(data)
    .filter(([k]) => (includeHidden ? true : !k.startsWith("__")))
    .map(([profileKey, entry]) => {
      const m = /^account_(\d+)$/.exec(profileKey);
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
  const profileKey = `account_${accountIdx}`;
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
    expanded: {
      orgPath: orgPath ? expandHome(orgPath) : null,
      rpaDir: rpaDir ? expandHome(rpaDir) : null,
    },
  };
}

function ensureRpaProfileInitialized(privateEntry, userDataDirRoot) {
  if (!privateEntry || fs.existsSync(userDataDirRoot)) return;

  if (fs.existsSync(PRIVATE_CHROME_TMP_DIR)) {
    fs.cpSync(PRIVATE_CHROME_TMP_DIR, userDataDirRoot, { recursive: true });
  } else {
    fs.mkdirSync(userDataDirRoot, { recursive: true });
  }

  const orgPath = expandHome(privateEntry.orgPath);
  const defaultProfileDir = path.join(userDataDirRoot, "Default");
  if (!fs.existsSync(defaultProfileDir) && orgPath && fs.existsSync(orgPath)) {
    fs.cpSync(orgPath, defaultProfileDir, { recursive: true });
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

async function launchOrActivateProfile({ accountIdx, url, activateIfRunning = true }) {
  const registry = getChromeRuntimeRegistry();
  const cfg = getPrivateChromeEntryByAccountIdx(accountIdx);
  if (!cfg) {
    throw new Error(`Missing chrome.json entry: account_${accountIdx}`);
  }

  const normalized = normalizePrivateChromeEntry(cfg.profileKey, cfg.accountIdx, cfg.entry);

  const effectivePort =
    normalized.port ?? getDefaultDebuggerPort(accountIdx, config.chromeDebuggerBasePort);

  if (effectivePort === 9221) {
    throw new Error("Chrome debugger port 9221 is reserved by Electron. Please use another port.");
  }

  const effectiveProxy = normalized.proxyUrl;
  const effectiveUserDataDirRoot =
    normalized.expanded.rpaDir ||
    getDefaultUserDataDirRoot(accountIdx, config.chromeUserDataRoot || DEFAULT_USER_DATA_BASE_ROOT);

  // Script parity: if /json/version reachable => activate first page target and return reused
  const liveStatus = await probeChromeDebugger(effectivePort);
  if (liveStatus.isRunning) {
    let targets = [];
    let activatedTargetId = null;

    try {
      targets = await getTargets(effectivePort);
      const firstPage = targets.find((t) => t.type === "page") || null;
      if (activateIfRunning && firstPage?.id) {
        activatedTargetId = firstPage.id;
        await activateTarget(effectivePort, firstPage.id);
      }
    } catch (_) {
      // ignore activation errors, still consider it reused
    }

    const nextRuntime = registry.upsert(accountIdx, {
      status: "running",
      debuggerPort: effectivePort,
      proxy: effectiveProxy || null,
      userDataDirRoot: effectiveUserDataDirRoot,
      profileDirectory: getProfileDirectory(accountIdx),
      url: url || null,
      webSocketDebuggerUrl: liveStatus.webSocketDebuggerUrl || null,
      error: null,
    });

    return {
      reused: true,
      activatedTargetId,
      profileKey: cfg.profileKey,
      accountIdx,
      gmail: normalized.gmail,
      port: effectivePort,
      proxy: effectiveProxy || null,
      userDataDirRoot: effectiveUserDataDirRoot,
      runtime: nextRuntime,
      liveStatus,
      targetsPreview: targets
        .filter((t) => t.type === "page")
        .slice(0, 3)
        .map((t) => ({ id: t.id, title: t.title, url: t.url })),
    };
  }

  // Ensure user-data-dir initialized from _tmp and orgPath
  ensureRpaProfileInitialized(cfg.entry, effectiveUserDataDirRoot);

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
    userDataDirRoot: effectiveUserDataDirRoot,
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
    userDataDirRoot: launched.userDataDirRoot,
    profileDirectory: launched.profileDirectory,
    url: launched.url,
    webSocketDebuggerUrl: launched.webSocketDebuggerUrl,
    error: null,
  });

  return {
    reused: false,
    profileKey: cfg.profileKey,
    accountIdx,
    gmail: normalized.gmail,
    port: effectivePort,
    proxy: effectiveProxy || null,
    userDataDirRoot: effectiveUserDataDirRoot,
    runtime: nextRuntime,
  };
}

module.exports = (registerTool) => {
  registerTool(
    "chrome_list_profiles",
    "列出 ~/Private/chrome.json 中全部 Chrome profiles，并附带 runtime + live 状态",
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
          gmail: normalized.gmail,
          orgPath: normalized.orgPath,
          rpaDir: normalized.rpaDir,
          port,
          proxy: normalized.proxyUrl,
          proxyRaw: normalized.proxy,
          platform: normalized.platform,
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
    "列出 ~/Private/chrome.json 中全部 profile 的 gmail",
    z.object({
      includeHidden: z.boolean().optional().describe("是否包含 __* 隐藏项（默认 false）"),
    }),
    async ({ includeHidden } = {}) => {
      const entries = listPrivateChromeEntries({ includeHidden: !!includeHidden });
      const gmails = entries
        .map(({ profileKey, accountIdx, entry }) => normalizePrivateChromeEntry(profileKey, accountIdx, entry).gmail)
        .filter(Boolean);
      return toToolResult({ gmails });
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_list_github_accounts",
    "列出 ~/Private/chrome.json 中全部 profile 的 GitHub 账号信息（platform.github）",
    z.object({
      includeHidden: z.boolean().optional().describe("是否包含 __* 隐藏项（默认 false）"),
    }),
    async ({ includeHidden } = {}) => {
      const entries = listPrivateChromeEntries({ includeHidden: !!includeHidden });
      const accounts = entries.map(({ profileKey, accountIdx, entry }) => {
        const normalized = normalizePrivateChromeEntry(profileKey, accountIdx, entry);
        const gh = normalized.platform?.github || {};
        return {
          profileKey,
          accountIdx,
          gmail: normalized.gmail,
          email: gh.email || "",
          username: gh.username || "",
        };
      });
      return toToolResult({ githubAccounts: accounts });
    },
    { tag: "Chrome" }
  );

  registerTool(
    "chrome_list_kiro_accounts",
    "列出 ~/Private/chrome.json 中全部 profile 的 Kiro 绑定状态（platform.kiro）",
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
      accountIdx: z.number().describe("账户索引，映射到 ~/Private/chrome.json 的 account_<idx>"),
    }),
    async ({ accountIdx }) => {
      const registry = getChromeRuntimeRegistry();
      const cfg = getPrivateChromeEntryByAccountIdx(accountIdx);
      if (!cfg) {
        return toToolResult(
          { error: `Missing chrome.json entry: account_${accountIdx}` },
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
    }),
    async ({ accountIdx, url, activateIfRunning } = {}) => {
      try {
        const result = await launchOrActivateProfile({
          accountIdx,
          url,
          activateIfRunning: activateIfRunning !== false,
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
    "新增账号（等价于 chrome-rpa.sh add）：从 ~/chrome/__tmp 创建 ~/chrome/account_N 并写回 ~/Private/chrome.json",
    z.object({
      gmail: z.string().optional().describe("可选：新账号 gmail"),
      orgPath: z.string().optional().describe("可选：orgPath（默认 Profile 9）"),
      launchAfterCreate: z.boolean().optional().describe("创建后是否立刻启动（默认 false）"),
    }),
    async ({ gmail, orgPath, launchAfterCreate } = {}) => {
      const data = readPrivateChromeConfig();
      const nums = Object.keys(data)
        .map((k) => (/^account_(\d+)$/.exec(k) ? Number(/^account_(\d+)$/.exec(k)[1]) : null))
        .filter((n) => typeof n === "number");
      const nextNum = nums.length ? Math.max(...nums) + 1 : 1;

      const profileKey = `account_${nextNum}`;
      const port = 11000 + nextNum;
      const rpaDirTilde = `~/chrome/${profileKey}`;
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
        proxy: "",
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
    "设置 ~/Private/chrome.json 中指定 accountIdx 的 proxy（脚本对齐；下次启动生效）",
    z.object({
      accountIdx: z.number().describe("账户索引"),
      proxy: z.string().optional().describe("代理 URL；留空则清空"),
    }),
    async ({ accountIdx, proxy } = {}) => {
      const data = readPrivateChromeConfig();
      const key = `account_${accountIdx}`;
      if (!data[key]) {
        return toToolResult({ error: `Missing chrome.json entry: ${key}` }, { isError: true });
      }
      data[key] = {
        ...data[key],
        proxy: typeof proxy === "string" ? proxy : "",
      };
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
      const port = typeof cfg?.entry?.port === "number" ? cfg.entry.port : registry.get(accountIdx)?.debuggerPort;

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
      const port = typeof cfg?.entry?.port === "number" ? cfg.entry.port : registry.get(accountIdx)?.debuggerPort;

      if (!port) {
        return toToolResult({ error: `Missing debuggerPort for accountIdx=${accountIdx}` }, { isError: true });
      }

      try {
        const result = await callCdp({
          debuggerPort: port,
          method,
          params: params || {},
          target,
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
};
