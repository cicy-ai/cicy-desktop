const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

class MasterTokenManager {
  constructor() {
    this.configPath = path.join(os.homedir(), "global.json");
    this.token = this.getOrCreateToken();
  }

  getOrCreateToken() {
    try {
      if (fs.existsSync(this.configPath)) {
        const config = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
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
    let config = {};
    try {
      if (fs.existsSync(this.configPath)) {
        config = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
      }
    } catch (_) {}

    config.api_token = token;
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2) + "\n");
  }

  getToken() {
    return this.token;
  }

  getConfigPath() {
    return this.configPath;
  }
}

module.exports = { MasterTokenManager };
