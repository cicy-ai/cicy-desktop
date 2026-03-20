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
    this.globalJsonPath = path.join(os.homedir(), "global.json");
    this.legacyTokenPath = path.join(os.homedir(), "data", "electron", "token.txt");
    this.authToken = this.getOrGenerateToken();
    log.info("[MCP] Auth token enabled");
    log.info("[MCP] Token stored in ~/global.json");
  }

  /**
   * 获取或生成认证令牌
   * 优先读取 ~/global.json，兼容旧版 ~/data/electron/token.txt（自动迁移）
   * @returns {string} 认证令牌
   */
  getOrGenerateToken() {
    try {
      // 1. Try ~/global.json first
      if (fs.existsSync(this.globalJsonPath)) {
        const config = JSON.parse(fs.readFileSync(this.globalJsonPath, "utf8"));
        if (config.api_token) {
          log.info("[MCP] Using token from ~/global.json");
          return config.api_token;
        }
      }

      // 2. Migrate from legacy token.txt
      if (fs.existsSync(this.legacyTokenPath)) {
        const token = fs.readFileSync(this.legacyTokenPath, "utf8").trim();
        if (token) {
          log.info("[MCP] Migrating token from legacy token.txt → ~/global.json");
          this._saveToGlobalJson(token);
          return token;
        }
      }

      // 3. Generate new token
      const newToken = crypto.randomBytes(32).toString("hex");
      this._saveToGlobalJson(newToken);
      log.info("[MCP] Generated new token → ~/global.json");
      return newToken;
    } catch (error) {
      log.error("[MCP] Token management error:", error);
      return crypto.randomBytes(32).toString("hex");
    }
  }

  /**
   * 将 token 写入 ~/global.json（保留已有字段）
   */
  _saveToGlobalJson(token) {
    let config = {};
    try {
      if (fs.existsSync(this.globalJsonPath)) {
        config = JSON.parse(fs.readFileSync(this.globalJsonPath, "utf8"));
      }
    } catch (_) {}
    config.api_token = token;
    fs.writeFileSync(this.globalJsonPath, JSON.stringify(config, null, 2) + "\n");
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
