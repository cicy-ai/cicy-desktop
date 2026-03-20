const request = require("supertest");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { killPort, isPortOpen } = require("../src/utils/process-utils");

// 重写 console.log，直接输出到 stderr，绕过 Jest 拦截
console.log = (...args) => {
  process.stderr.write(args.join(" ") + "\n");
};

let PORT = 9843;
let baseURL = `http://localhost:${PORT}`;
let initUrl = "http://www.google.com";

const LOG_DIR = path.join(os.homedir(), "logs");
const LOG_FILE = path.join(LOG_DIR, "test-utils.log");

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function log(level, message) {
  const now = new Date();
  const timestamp = now.toISOString().replace("T", " ").substring(0, 23);
  const line = `[${timestamp}] [${level}] - ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    // 在 CI 环境中忽略日志写入错误
    if (process.env.CI) {
      console.log(`[${level}] ${message}`);
    }
  }
}

function enableDebug(enabled = true) {
  if (enabled) {
    log("TEST", `Debug logging enabled, log file: ${LOG_FILE}`);
  }
}

function setPort(port) {
  PORT = port;
  baseURL = `http://localhost:${PORT}`;
  log("TEST", `Port set to: ${PORT}`);
}

function setInitUrl(url) {
  initUrl = url;
}

let desktopProcess;
let sessionId;
let sseReq;
let sseResponses = {};
let requestId = 1;
let authToken;

async function setupTest() {
  const isOpen = await isPortOpen(PORT);
  console.log(PORT, "isOpen:", isOpen);
  if (isOpen) {
    await killPort(PORT);
  }

  process.env.NODE_ENV = "test";
  log("TEST", `========================================`);
  log("TEST", `  Starting test setup`);
  log("TEST", `  Port: ${PORT}`);
  log("TEST", `  Init URL: ${initUrl}`);
  log("TEST", `========================================`);

  log("DEBUG", `Killing any existing processes on port ${PORT}...`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  log("DEBUG", `Port ${PORT} cleared`);

  log("DEBUG", `Spawning CiCy Desktop server...`);
  log("DEBUG", `  Command: electron . --port=${PORT} --url=${initUrl} --no-sandbox`);
  const desktopArgs = [".", `--port=${PORT}`, `--url=${initUrl}`];

  // CI 环境中禁用沙箱
  if (process.env.CI || process.env.ELECTRON_DISABLE_SANDBOX) {
    // desktopArgs.push("--no-sandbox");
    // desktopArgs.push("--disable-setuid-sandbox");
    // log("DEBUG", "  Running in CI mode with sandbox disabled");
  }

  desktopProcess = spawn("electron", desktopArgs, {
    stdio: "pipe",
    detached: false,
    env: { ...process.env, TEST: "TRUE" },
  });

  desktopProcess.stdout.on("data", (data) => {
    const output = data.toString();
    process.stdout.write(`[ELECTRON] ${output}`);
  });

  desktopProcess.stderr.on("data", (data) => {
    const output = data.toString();
    process.stderr.write(`[ELECTRON-ERR] ${output}`);
  });

  desktopProcess.on("error", (err) => {
    log("ERROR", `Failed to start Electron: ${err.message}`);
  });

  desktopProcess.on("exit", (code) => {
    log("DEBUG", `Electron process exited with code ${code}`);
  });

  log("DEBUG", `Waiting for server to start...`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("服务器启动超时")), 20000);

    desktopProcess.stdout.on("data", (data) => {
      const output = data.toString();
      if (output.includes("Server listening on")) {
        clearTimeout(timeout);
        log("INFO", `Server started successfully`);
        resolve();
      }
    });
  });

  await new Promise((resolve) => setTimeout(resolve, 3000));
  log("DEBUG", `Waited 3s for server to stabilize`);

  const tokenPath = path.join(os.homedir(), "global.json");
  log("DEBUG", `Checking for auth token at: ${tokenPath}`);
  if (fs.existsSync(tokenPath)) {
    const config = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    authToken = config.api_token || "";
    log("DEBUG", `Auth token loaded, length: ${authToken.length}`);
  } else {
    log("WARN", `Auth token file not found`);
  }

  log("DEBUG", `Establishing SSE connection to http://localhost:${PORT}/mcp...`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("SSE连接超时")), 10000);

    const options = {
      hostname: "localhost",
      port: PORT,
      path: "/mcp",
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${authToken}`,
      },
    };

    sseReq = http.request(options, (res) => {
      log("DEBUG", `SSE connection established, status: ${res.statusCode}`);
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString();

        const lines = buffer.split("\n");
        let eventType = null;
        let eventData = null;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith("event:")) {
            eventType = line.substring(6).trim();
            log("DEBUG", `SSE event: ${eventType}`);
          } else if (line.startsWith("data:")) {
            eventData = line.substring(5).trim();

            if (eventType === "endpoint" && !sessionId) {
              const urlMatch = eventData.match(/sessionId=([^\s&]+)/);
              if (urlMatch) {
                sessionId = urlMatch[1];
                log("INFO", `SSE sessionId received: ${sessionId}`);
                clearTimeout(timeout);
                resolve();
              }
            } else if (eventType === "message" && eventData) {
              try {
                if (eventData.startsWith("{") && !eventData.endsWith("}")) return;
                const messageData = JSON.parse(eventData);
                if (messageData.id) {
                  sseResponses[messageData.id] = messageData;
                }
              } catch (e) {}
            }

            eventType = null;
            eventData = null;
          }
        }

        const lastNewlineIndex = buffer.lastIndexOf("\n");
        if (lastNewlineIndex !== -1) {
          buffer = buffer.substring(lastNewlineIndex + 1);
        }
      });

      res.on("error", (err) => {
        log("ERROR", `SSE response error: ${err.message}`);
        reject(err);
      });
    });

    sseReq.on("error", (err) => {
      log("ERROR", `SSE request error: ${err.message}`);
      reject(err);
    });
    sseReq.end();
  });

  log("TEST", `========================================`);
  log("TEST", `  Test setup complete`);
  log("TEST", `  Session ID: ${sessionId}`);
  log("TEST", `========================================`);
}

async function teardownTest(nokill) {
  log("TEST", `========================================`);
  log("TEST", `  Starting test teardown`);
  log("TEST", `========================================`);

  if (sseReq) {
    log("DEBUG", `Destroying SSE connection...`);
    sseReq.destroy();
  }
  console.log("TEST_ALL", process.env.TEST_ALL);
  if (desktopProcess && nokill) {
    console.log("kill current electron process", desktopProcess.pid);
    log("DEBUG", `Killing desktop process (PID: ${desktopProcess.pid})...`);
    desktopProcess.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    log("DEBUG", `Electron process killed`);
  }

  log("TEST", `Teardown complete`);
}

async function sendRequest(method, params = {}) {
  const id = requestId++;
  const reqBody = { jsonrpc: "2.0", id, method, params };

  log("REQUEST", `➤ ${method} #${id}`);
  log("REQUEST", JSON.stringify(reqBody, null, 2));

  const response = await request(baseURL)
    .post(`/messages?sessionId=${sessionId}`)
    .set("Accept", "application/json")
    .set("Content-Type", "application/json")
    .set("Authorization", `Bearer ${authToken}`)
    .send(reqBody);

  await new Promise((resolve) => {
    const checkResponse = () => {
      if (sseResponses[id]) {
        const responseData = sseResponses[id];
        log("RESPONSE", `◀ ${method} #${id}`);
        log("RESPONSE", JSON.stringify(responseData, null, 2));
        resolve();
      } else {
        setTimeout(checkResponse, 100);
      }
    };
    checkResponse();
  });

  return sseResponses[id];
}

function getSessionId() {
  return sessionId;
}

module.exports = {
  setPort,
  setInitUrl,
  setupTest,
  teardownTest,
  sendRequest,
  getSessionId,
  enableDebug,
};
