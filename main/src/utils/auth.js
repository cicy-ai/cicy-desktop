const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const log = require("electron-log");

/**
 * 认证模块 - 处理令牌生成、验证和管理
 */
class AuthManager {
  constructor() {
    this.authToken = this.getOrGenerateToken();
    console.log("[MCP] Auth token enabled");
    console.log("[MCP] Token saved to ~/data/electron/token.txt");
  }

  /**
   * 获取或生成认证令牌
   * @returns {string} 认证令牌
   */
  getOrGenerateToken() {
    const tokenPath = path.join(os.homedir(), "data", "electron", "token.txt");

    try {
      // 检查是否已存在令牌
      if (fs.existsSync(tokenPath)) {
        const token = fs.readFileSync(tokenPath, "utf8").trim();
        if (token) {
          console.log("[MCP] Using existing token from", tokenPath);
          return token;
        }
      }

      // 生成新令牌
      const newToken = crypto.randomBytes(32).toString("hex");
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, newToken);
      console.log("[MCP] Generated new token and saved to", tokenPath);
      return newToken;
    } catch (error) {
      console.error("[MCP] Token management error:", error);
      return crypto.randomBytes(32).toString("hex"); // fallback
    }
  }

  /**
   * 验证认证令牌（支持 Bearer 和 Basic Auth）
   * @param {Object} req - HTTP 请求对象
   * @returns {boolean} 验证结果
   */
  validateAuth(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return false;

    // Bearer token
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.replace("Bearer ", "");
      return token === this.authToken;
    }

    // Basic Auth (username:password where password is token)
    if (authHeader.startsWith("Basic ")) {
      const base64Credentials = authHeader.replace("Basic ", "");
      const credentials = Buffer.from(base64Credentials, "base64").toString("utf8");
      const [, password] = credentials.split(":");
      return password === this.authToken;
    }

    return false;
  }

  /**
   * 获取当前认证令牌
   * @returns {string} 当前令牌
   */
  getToken() {
    return this.authToken;
  }
}

module.exports = { AuthManager };
