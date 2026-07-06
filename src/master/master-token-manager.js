// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { readGlobalConfig, updateGlobalConfig } = require("../utils/global-json");

class MasterTokenManager {
  constructor() {
    this.configPath = path.join(os.homedir(), "cicy-ai", "global.json");
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

      const token = "cicy_" + crypto.randomBytes(32).toString("hex");
      this.saveToken(token);
      return token;
    } catch (error) {
      return "cicy_" + crypto.randomBytes(32).toString("hex");
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
