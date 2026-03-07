const fs = require("fs");
const path = require("path");
const os = require("os");
const { z } = require("zod");

const ACCOUNT_DIR = path.join(os.homedir(), "data", "electron");

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
        const accountFile = path.join(ACCOUNT_DIR, `account-${accountIdx}.json`);

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

        const accountData = JSON.parse(fs.readFileSync(accountFile, "utf-8"));

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
        })
        .optional(),
    }),
    async ({ accountIdx, metadata }) => {
      try {
        // 确保目录存在
        if (!fs.existsSync(ACCOUNT_DIR)) {
          fs.mkdirSync(ACCOUNT_DIR, { recursive: true });
        }

        const accountFile = path.join(ACCOUNT_DIR, `account-${accountIdx}.json`);

        let accountData;

        if (fs.existsSync(accountFile)) {
          // 更新现有账户
          accountData = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
          if (metadata) {
            accountData.metadata = { ...accountData.metadata, ...metadata };
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
            updatedAt: new Date().toISOString(),
          };
        }

        fs.writeFileSync(accountFile, JSON.stringify(accountData, null, 2));

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
};
