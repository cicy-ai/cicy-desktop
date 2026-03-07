const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { killPort, isPortOpen } = require("../../src/utils/process-utils");

const PORT = 18102;
const initUrl = "http://www.google.com";

let electronProcess;
let sessionId;
let sseReq;
let authToken;
let sseResponses = {};

async function startTestServer() {
  const isOpen = await isPortOpen(PORT);
  if (isOpen) {
    await killPort(PORT);
  }

  // Fix chrome-sandbox permissions on Linux
  if (process.platform === "linux") {
    const sandboxPath = path.join(__dirname, "../../node_modules/electron/dist/chrome-sandbox");
    if (fs.existsSync(sandboxPath)) {
      try {
        const { execSync } = require("child_process");
        execSync(`sudo chown root:root "${sandboxPath}" && sudo chmod 4755 "${sandboxPath}"`, {
          stdio: "ignore",
        });
      } catch (err) {
        // Ignore permission errors
      }
    }
  }

  process.env.NODE_ENV = "test";
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const electronArgs = [".", `--port=${PORT}`, `--url=${initUrl}`];

  electronProcess = spawn("electron", electronArgs, {
    stdio: "pipe",
    detached: false,
    cwd: path.join(__dirname, "../.."),
    env: { ...process.env, TEST: "TRUE" },
  });

  electronProcess.stdout.on("data", (data) => {
    const output = data.toString();
    process.stdout.write(`[MCP-${PORT}] ${output}`);
  });

  electronProcess.stderr.on("data", (data) => {
    const output = data.toString();
    process.stderr.write(`[MCP-${PORT}-ERR] ${output}`);
  });

  let serverStarted = false;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP 服务器启动超时")), 20000);

    const checkOutput = (data) => {
      if (!serverStarted && data.toString().includes("Server listening on")) {
        serverStarted = true;
        clearTimeout(timeout);
        resolve();
      }
    };

    electronProcess.stdout.on("data", checkOutput);
    electronProcess.stderr.on("data", checkOutput);
  });

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const tokenPath = path.join(os.homedir(), "data/electron/token.txt");
  if (fs.existsSync(tokenPath)) {
    authToken = fs.readFileSync(tokenPath, "utf8").trim();
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("SSE 连接超时")), 10000);

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
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        let eventType = null;
        let eventData = null;

        for (let line of lines) {
          line = line.trim();
          if (line.startsWith("event:")) {
            eventType = line.substring(6).trim();
          } else if (line.startsWith("data:")) {
            eventData = line.substring(5).trim();

            if (eventType === "endpoint" && !sessionId) {
              const urlMatch = eventData.match(/sessionId=([^\s&]+)/);
              if (urlMatch) {
                sessionId = urlMatch[1];
                clearTimeout(timeout);
                resolve();
              }
            } else if (eventType === "message" && eventData) {
              try {
                if (eventData.startsWith("{") && !eventData.endsWith("}")) continue;
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
      });
    });

    sseReq.on("error", reject);
    sseReq.end();
  });
}

async function stopTestServer() {
  if (sseReq) {
    sseReq.destroy();
  }

  if (electronProcess) {
    electronProcess.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function getSessionId() {
  return sessionId;
}

function getAuthToken() {
  return authToken;
}

function getPort() {
  return PORT;
}

function getSSEResponses() {
  return sseResponses;
}

module.exports = {
  startTestServer,
  stopTestServer,
  getSessionId,
  getAuthToken,
  getPort,
  getSSEResponses,
};
