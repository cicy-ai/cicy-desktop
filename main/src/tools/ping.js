const { z } = require("zod");

module.exports = (registerTool) => {
  registerTool(
    "ping",
    "测试 MCP 服务器连接",
    z.object({}),
    async () => {
      const now = new Date();
      const utc8Time = new Date(now.getTime() + 8 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      return {
        content: [{ type: "text", text: `Pong v:2 ${utc8Time}` }],
      };
    },
    { tag: "System" }
  );

  registerTool(
    "refresh_token",
    "刷新认证 token",
    z.object({}),
    async () => {
      const crypto = require("crypto");
      const fs = require("fs");
      const os = require("os");
      const path = require("path");

      const newToken = crypto.randomBytes(32).toString("hex");
      const tokenPath = path.join(os.homedir(), "data/electron/token.txt");

      fs.writeFileSync(tokenPath, newToken);

      // Update global auth manager
      if (global.authManager) {
        global.authManager.authToken = newToken;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                token: newToken,
                message: "Token refreshed successfully",
              },
              null,
              2
            ),
          },
        ],
      };
    },
    { tag: "System" }
  );
};
