const { app: electronApp } = require("electron");
const log = require("electron-log");

function setupElectronFlags() {
  // Must be called before app.whenReady()
  electronApp.commandLine.appendSwitch("no-sandbox");
  electronApp.commandLine.appendSwitch("disable-setuid-sandbox");

  if (process.platform === "linux") {
    process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";
    electronApp.commandLine.appendSwitch("log-level", "3");
    electronApp.commandLine.appendSwitch("disable-notifications");
    electronApp.commandLine.appendSwitch("disable-geolocation");
    electronApp.commandLine.appendSwitch("disable-dev-shm-usage");
    electronApp.commandLine.appendSwitch("disable-gpu");
    electronApp.commandLine.appendSwitch("disable-software-rasterizer");
    electronApp.commandLine.appendSwitch("disable-gpu-compositing");
    electronApp.commandLine.appendSwitch("disable-gpu-rasterization");
    electronApp.commandLine.appendSwitch("use-gl", "swiftshader");
  }
}

function setupErrorHandlers() {
  process.on("uncaughtException", (error) => {
    log.error("[Uncaught Exception]", error);
    console.error("[Uncaught Exception]", error);
  });

  process.on("unhandledRejection", (reason, promise) => {
    log.error("[Unhandled Rejection]", reason);
    console.error("[Unhandled Rejection]", reason);
  });
}

module.exports = { setupElectronFlags, setupErrorHandlers };
