const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { readGlobalConfig, updateGlobalConfig } = require("../utils/global-json");

class MasterTokenManager {
  constructor() {
    this.configPath = path.join(os.homedir(), "global.json");
    this.token = this.getOrCreateToken();
  }

  getOrCreateToken() {
    try {
      if (fs.existsSync(this.configPath)) {
        const config = readGlobalConfig(this.configPath);
        if (config.api_token) {
          return config.api_token;
        }
      }

      const token = crypto.randomBytes(32).toString("hex");
      this.saveToken(token);
      return token;
    } catch (error) {
      return crypto.randomBytes(32).toString("hex");
    }
  }

  saveToken(token) {
    updateGlobalConfig(this.configPath, (config) => {
      config.api_token = token;
      return config;
    });
  }

  getToken() {
    return this.token;
  }

  getConfigPath() {
    return this.configPath;
  }
}

module.exports = { MasterTokenManager };
