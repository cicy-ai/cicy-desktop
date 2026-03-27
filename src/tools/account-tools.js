const fs = require("fs");
const path = require("path");
const os = require("os");
const { z } = require("zod");

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

  // 设置账户代理
  registerTool(
    "set_account_proxy",
    "为指定账户设置代理，该账户下所有窗口都会使用此代理",
    z.object({
      accountIdx: z.number().describe("账户索引"),
      proxy: z.string().optional().describe("代理地址，如 http://127.0.0.1:8888，留空则清除代理"),
    }),
    async ({ accountIdx, proxy }) => {
      try {
        const { session } = require("electron");
        const ses = session.fromPartition(`persist:sandbox-${accountIdx}`);

        if (proxy) {
          await ses.setProxy({ proxyRules: proxy });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: true, accountIdx, proxy }, null, 2),
              },
            ],
          };
        } else {
          await ses.setProxy({ proxyRules: "" });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: true, accountIdx, proxy: "cleared" }, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
    { tag: "Account" }
  );
};
