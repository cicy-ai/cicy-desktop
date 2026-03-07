const log = require("electron-log");
const path = require("path");
const fs = require("fs");

function setupLogging(config) {
  const logsDir = path.join(require("electron").app.getPath("home"), "logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  config.logsDir = logsDir;
  config.logFilePath = path.join(logsDir, `electron-mcp-${config.port}.log`);

  log.transports.file.resolvePathFn = () => config.logFilePath;
  log.transports.file.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}";
  log.transports.console.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}";
}

function getCallerInfo() {
  const stack = new Error().stack.split("\n");
  const callerLine = stack[3] || "";
  const match = callerLine.match(/\((.+):(\d+):(\d+)\)/) || callerLine.match(/at (.+):(\d+):(\d+)/);
  if (match) {
    const file = match[1].split("/").pop();
    const line = match[2];
    return `${file}:${line}`;
  }
  return "";
}

function wrapLogger() {
  const originalInfo = log.info.bind(log);
  const originalError = log.error.bind(log);
  const originalWarn = log.warn.bind(log);
  const originalDebug = log.debug.bind(log);

  log.info = (...args) => {
    const caller = getCallerInfo();
    originalInfo(` ${args.join(" ")} (${caller})`);
  };

  log.error = (...args) => {
    const caller = getCallerInfo();
    originalError(` ${args.join(" ")} (${caller})`);
  };

  log.warn = (...args) => {
    const caller = getCallerInfo();
    originalWarn(` ${args.join(" ")} (${caller})`);
  };

  log.debug = (...args) => {
    const caller = getCallerInfo();
    originalDebug(` ${args.join(" ")} (${caller})`);
  };
}

module.exports = { setupLogging, wrapLogger };
