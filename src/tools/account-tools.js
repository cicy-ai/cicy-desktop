// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");
const os = require("os");
const { z } = require("zod");

const profileStore = require("../profiles/profile-store");
const { summarizeCookieLogins } = require("../utils/cookie-logins");
const { probeIpViaSession } = require("../utils/ip-probe");

const ACCOUNT_DIR = path.join(os.homedir(), "data", "electron");

function ensureAccountDir() {
  if (!fs.existsSync(ACCOUNT_DIR)) {
    fs.mkdirSync(ACCOUNT_DIR, { recursive: true });
  }
}

function getAccountFile(accountIdx) {
  return path.join(ACCOUNT_DIR, `account-${accountIdx}.json`);
}

function readAccount(accountIdx) {
  const accountFile = getAccountFile(accountIdx);
  if (!fs.existsSync(accountFile)) return null;
  return JSON.parse(fs.readFileSync(accountFile, "utf-8"));
}

function writeAccount(accountData) {
  ensureAccountDir();
  fs.writeFileSync(getAccountFile(accountData.accountIdx), JSON.stringify(accountData, null, 2));
}

module.exports = (registerTool) => {
  // 获取账户信息
  registerTool(
    "get_account",
    "获取指定账户的配置信息，包括窗口列表、创建时间等",
    z.object({
      accountIdx: z.number().describe("账户索引"),
    }),
    async ({ accountIdx }) => {
      try {
        const accountFile = getAccountFile(accountIdx);

        if (!fs.existsSync(accountFile)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: `Account ${accountIdx} not found` }, null, 2),
              },
            ],
            isError: true,
          };
        }

        const accountData = readAccount(accountIdx);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(accountData, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
    { tag: "Account" }
  );

  // 保存账户信息
  registerTool(
    "save_account_info",
    "保存或更新账户配置信息",
    z.object({
      accountIdx: z.number().describe("账户索引"),
      metadata: z
        .object({
          description: z.string().optional().describe("账户描述"),
          tags: z.array(z.string()).optional().describe("标签"),
          name: z.string().optional().describe("账户或 profile 名称"),
        })
        .optional(),
      chrome: z
        .object({
          enabled: z.boolean().optional().describe("是否启用 Chrome profile runtime"),
          debuggerPort: z.number().optional().describe("固定 CDP 调试端口"),
          proxy: z.string().optional().describe("Chrome profile 启动代理"),
          binaryPath: z.string().optional().describe("Chrome/Chromium 可执行文件路径"),
          userDataDirRoot: z.string().optional().describe("Chrome user-data-dir 根目录"),
        })
        .optional(),
    }),
    async ({ accountIdx, metadata, chrome }) => {
      try {
        let accountData = readAccount(accountIdx);

        if (accountData) {
          if (metadata) {
            accountData.metadata = { ...accountData.metadata, ...metadata };
          }
          if (chrome) {
            accountData.chrome = { ...(accountData.chrome || {}), ...chrome };
          }
          accountData.updatedAt = new Date().toISOString();
        } else {
          // 创建新账户
          accountData = {
            accountIdx,
            createdAt: new Date().toISOString(),
            windows: [],
            metadata: metadata || {
              description: `Account ${accountIdx}`,
              tags: [],
            },
            chrome: chrome || undefined,
            updatedAt: new Date().toISOString(),
          };
        }

        writeAccount(accountData);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, account: accountData }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
    { tag: "Account" }
  );

  // 列出所有账户
  registerTool(
    "list_accounts",
    "列出所有已创建的账户",
    z.object({}),
    async () => {
      try {
        if (!fs.existsSync(ACCOUNT_DIR)) {
          return {
            content: [{ type: "text", text: JSON.stringify([], null, 2) }],
          };
        }

        const files = fs.readdirSync(ACCOUNT_DIR);
        const accounts = files
          .filter((f) => f.startsWith("account-") && f.endsWith(".json"))
          .map((f) => {
            const accountFile = path.join(ACCOUNT_DIR, f);
            return JSON.parse(fs.readFileSync(accountFile, "utf-8"));
          })
          .sort((a, b) => a.accountIdx - b.accountIdx);

        return {
          content: [{ type: "text", text: JSON.stringify(accounts, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
    { tag: "Account" }
  );

  // 设置账户代理（持久化到 account-N.json + 立即应用到 session）
  registerTool(
    "set_account_proxy",
    "为指定账户设置代理：持久化写入 account-N.json，并立即应用到该 sandbox session（之后新开窗口也会自动套用）。留空则清除。",
    z.object({
      accountIdx: z.number().describe("账户索引"),
      proxy: z.string().optional().describe("代理地址，如 socks5://127.0.0.1:20001，留空则清除代理"),
    }),
    async ({ accountIdx, proxy }) => {
      try {
        // 1) persist the desired proxy (canonical {url, enabled}) to the store
        const view = profileStore.setProxy("electron", accountIdx, proxy || "");
        // 2) apply to the live session now
        const { session } = require("electron");
        const ses = session.fromPartition(`persist:sandbox-${accountIdx}`);
        await ses.setProxy({ proxyRules: profileStore.proxyRules(view.proxy) });
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, accountIdx, proxy: view.proxy }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
    { tag: "Account" }
  );

  // ── Unified profile surface (mirrors agent-chrome verbs) ──────────────────
  const toResult = (obj, isError = false) => ({
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
    ...(isError ? { isError: true } : {}),
  });

  registerTool(
    "electron_list_profiles",
    "列出所有 Electron profile（从 account-N.json 配置读取，含 name/proxy/logins）",
    z.object({}),
    async () => {
      try {
        return toResult(profileStore.listProfiles("electron"));
      } catch (e) {
        return toResult({ error: e.message }, true);
      }
    },
    { tag: "Account" }
  );

  registerTool(
    "electron_add_profile",
    "新增一个 Electron profile：在 ~/data/electron/ 写入下一个 account-N.json（N=现有最大+1，至少为 1），返回统一视图",
    z.object({ name: z.string().optional().describe("可选：profile 名称（metadata.name）") }),
    async ({ name } = {}) => {
      try {
        ensureAccountDir();
        const re = /^account-(\d+)\.json$/;
        const nums = fs.readdirSync(ACCOUNT_DIR).map((f) => (re.exec(f) ? Number(re.exec(f)[1]) : null)).filter((n) => typeof n === "number");
        const next = nums.length ? Math.max(...nums) + 1 : 1;
        const file = path.join(ACCOUNT_DIR, `account-${next}.json`);
        if (fs.existsSync(file)) return toResult({ error: `account-${next}.json already exists` }, true);
        const now = new Date().toISOString();
        const data = {
          accountIdx: next, createdAt: now, updatedAt: now, windows: [],
          metadata: { description: `Account ${next}`, ...(name ? { name } : {}), tags: [] },
          // New electron profiles (next is always ≥1, so account-0 is never created
          // here) default to the chrome-profile-1 mihomo listener.
          proxy: { url: "socks5://127.0.0.1:20001", enabled: true }, logins: [],
        };
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        return toResult({ success: true, accountIdx: next, profile: profileStore.getProfile("electron", next) });
      } catch (e) {
        return toResult({ error: e.message }, true);
      }
    },
    { tag: "Account" }
  );

  registerTool(
    "electron_get_profile",
    "获取单个 Electron profile 的统一视图（name/proxy/logins/partition）",
    z.object({ accountIdx: z.number().describe("账户索引") }),
    async ({ accountIdx }) => {
      try {
        const p = profileStore.getProfile("electron", accountIdx);
        return p ? toResult(p) : toResult({ error: `electron-${accountIdx} not found` }, true);
      } catch (e) {
        return toResult({ error: e.message }, true);
      }
    },
    { tag: "Account" }
  );

  registerTool(
    "electron_probe_ip",
    "探测某 Electron profile 当前出口 IP + 地区(经该 sandbox session 的代理),写入 config 并盖探测时间;可重复探测",
    z.object({ accountIdx: z.number().describe("账户索引") }),
    async ({ accountIdx }) => {
      try {
        const { session } = require("electron");
        const ses = session.fromPartition(`persist:sandbox-${accountIdx}`);
        // Ensure the profile's configured proxy is applied to the session before
        // probing — otherwise (e.g. no window opened yet) it goes DIRECT and we'd
        // report the machine's own IP instead of the profile's egress.
        const prof = profileStore.getProfile("electron", accountIdx);
        const rules = profileStore.proxyRules(prof && prof.proxy);
        await ses.setProxy({ proxyRules: rules || "direct://" });
        const info = await probeIpViaSession(ses);
        const view = profileStore.setIpInfo("electron", accountIdx, info);
        return toResult({ accountIdx, backend: "electron", proxy: rules || null, ipInfo: view.ipInfo });
      } catch (e) {
        return toResult({ error: e.message }, true);
      }
    },
    { tag: "Account" }
  );

  registerTool(
    "electron_detect_logins",
    "探测指定 Electron profile（persist:sandbox-N）当前 session 登录了哪些站点：读取该 partition 全部 cookie 按域名归并，标记带会话 cookie 的域名（cookie 在≠一定登录，仅强信号）",
    z.object({ accountIdx: z.number().describe("账户索引") }),
    async ({ accountIdx }) => {
      try {
        const { session } = require("electron");
        const ses = session.fromPartition(`persist:sandbox-${accountIdx}`);
        const cookies = await ses.cookies.get({});
        return toResult({ accountIdx, backend: "electron", ...summarizeCookieLogins(cookies) });
      } catch (e) {
        return toResult({ error: e.message }, true);
      }
    },
    { tag: "Account" }
  );

  registerTool(
    "electron_profile_login_add",
    "记录某 Electron profile 登录了哪个平台账号（每个平台一条，重复平台覆盖）",
    z.object({
      accountIdx: z.number().describe("账户索引"),
      platform: z.string().describe("平台，如 github / google / x"),
      account: z.string().describe("账号标识，如 alice@x.com"),
    }),
    async ({ accountIdx, platform, account }) => {
      try {
        return toResult(profileStore.addLogin("electron", accountIdx, platform, account));
      } catch (e) {
        return toResult({ error: e.message }, true);
      }
    },
    { tag: "Account" }
  );

  registerTool(
    "electron_profile_login_set",
    "新增/更新某 Electron profile 的一条登录记录（富字段：地址/名称/用户名/邮箱/手机/2FA/备用邮箱/备注；按名称 name 归并，只覆盖传入的非空字段）",
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
    async ({ accountIdx, ...login }) => {
      try {
        return toResult(profileStore.setLogin("electron", accountIdx, login));
      } catch (e) {
        return toResult({ error: e.message }, true);
      }
    },
    { tag: "Account" }
  );

  registerTool(
    "electron_profile_login_rm",
    "移除某 Electron profile 的某平台登录记录",
    z.object({
      accountIdx: z.number().describe("账户索引"),
      platform: z.string().describe("平台"),
    }),
    async ({ accountIdx, platform }) => {
      try {
        return toResult(profileStore.removeLogin("electron", accountIdx, platform));
      } catch (e) {
        return toResult({ error: e.message }, true);
      }
    },
    { tag: "Account" }
  );

  registerTool(
    "electron_profile_logins",
    "列出某 Electron profile 已记录的平台登录",
    z.object({ accountIdx: z.number().describe("账户索引") }),
    async ({ accountIdx }) => {
      try {
        return toResult(profileStore.listLogins("electron", accountIdx));
      } catch (e) {
        return toResult({ error: e.message }, true);
      }
    },
    { tag: "Account" }
  );
};
