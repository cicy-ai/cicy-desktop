const fs = require("fs");
const path = require("path");

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileLock(lockPath, fn, { timeoutMs = 5000, retryDelayMs = 50 } = {}) {
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockPath, { recursive: false });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out acquiring lock: ${lockPath}`);
      }
      sleep(retryDelayMs);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lockPath);
    } catch (_) {}
  }
}

function readGlobalConfig(globalJsonPath) {
  if (!fs.existsSync(globalJsonPath)) {
    return {};
  }
  const raw = fs.readFileSync(globalJsonPath, "utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${globalJsonPath} must contain a JSON object`);
  }
  return parsed;
}

function writeGlobalConfig(globalJsonPath, nextConfig) {
  const dir = path.dirname(globalJsonPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${globalJsonPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  fs.renameSync(tempPath, globalJsonPath);
}

function updateGlobalConfig(globalJsonPath, updater) {
  const lockPath = `${globalJsonPath}.lock`;
  return withFileLock(lockPath, () => {
    const current = readGlobalConfig(globalJsonPath);
    const next = updater({ ...current });
    if (!next || Array.isArray(next) || typeof next !== "object") {
      throw new Error("updated global config must be a JSON object");
    }
    writeGlobalConfig(globalJsonPath, next);
    return next;
  });
}

function ensureGlobalApiTokenFile(globalJsonPath, apiToken = "") {
  return updateGlobalConfig(globalJsonPath, (config) => {
    if (typeof config.api_token !== "string") {
      config.api_token = apiToken;
    }
    return config;
  });
}

module.exports = {
  ensureGlobalApiTokenFile,
  readGlobalConfig,
  updateGlobalConfig,
};
