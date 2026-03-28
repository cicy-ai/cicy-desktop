const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const HOME = os.homedir();
const GLOBAL_CONFIG_FILE = path.join(HOME, "global.json");
const PRIVATE_CICY_DESKTOP_FILE = path.join(HOME, "Private", "cicy-desktop.json");
const PRIVATE_CICY_DESKTOP_AUDIT_LOG = path.join(HOME, "Private", "cicy-desktop.audit.log");
const DEFAULT_WORKER_PORT = 8101;

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function redactTokens(value) {
  if (Array.isArray(value)) return value.map(redactTokens);
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "api_token" && typeof v === "string" && v.length) {
      out[k] = v.length <= 8 ? "***" : `${v.slice(0, 4)}***${v.slice(-4)}`;
      continue;
    }
    out[k] = redactTokens(v);
  }
  return out;
}

function appendAuditLog(event) {
  try {
    const dir = path.dirname(PRIVATE_CICY_DESKTOP_AUDIT_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(PRIVATE_CICY_DESKTOP_AUDIT_LOG, `${JSON.stringify(event)}\n`);
  } catch (_) {}
}

function writeNodeConfig(nextConfig, { reason } = {}) {
  const dir = path.dirname(PRIVATE_CICY_DESKTOP_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const beforeRaw = fs.existsSync(PRIVATE_CICY_DESKTOP_FILE)
    ? fs.readFileSync(PRIVATE_CICY_DESKTOP_FILE, "utf8")
    : null;
  const beforeConfig = beforeRaw ? JSON.parse(beforeRaw) : null;

  const afterRaw = `${JSON.stringify(nextConfig || {}, null, 2)}\n`;
  fs.writeFileSync(PRIVATE_CICY_DESKTOP_FILE, afterRaw);

  appendAuditLog({
    ts: new Date().toISOString(),
    action: "write",
    file: "~/Private/cicy-desktop.json",
    reason: reason || "unspecified",
    pid: process.pid,
    ppid: process.ppid,
    node: process.version,
    argv: process.argv,
    cwd: process.cwd(),
    before: beforeConfig ? redactTokens(beforeConfig) : null,
    after: redactTokens(nextConfig || {}),
  });
}

function ensureNodeConfig(workerPort = DEFAULT_WORKER_PORT) {
  if (fs.existsSync(PRIVATE_CICY_DESKTOP_FILE)) {
    return readJson(PRIVATE_CICY_DESKTOP_FILE, {});
  }

  const legacy = readJson(GLOBAL_CONFIG_FILE, {});
  const initialConfig = {
    cicyDesktopNodes:
      legacy.cicyDesktopNodes && typeof legacy.cicyDesktopNodes === "object"
        ? legacy.cicyDesktopNodes
        : {
            local: {
              api_token: "",
              base_url: `http://localhost:${workerPort}`,
            },
          },
  };
  writeNodeConfig(initialConfig, { reason: "auto-create from legacy global.json" });
  return initialConfig;
}

function initRpcConfig(workerPort = DEFAULT_WORKER_PORT) {
  if (!fs.existsSync(GLOBAL_CONFIG_FILE)) {
    fs.writeFileSync(GLOBAL_CONFIG_FILE, `${JSON.stringify({ api_token: "" }, null, 2)}\n`);
    console.log(`✅ Created: ${GLOBAL_CONFIG_FILE}`);
  }

  const config = ensureNodeConfig(workerPort);
  console.log(`📁 Nodes config: ${PRIVATE_CICY_DESKTOP_FILE}`);
  console.log("📋 cicyDesktopNodes:");
  Object.entries(config.cicyDesktopNodes || {}).forEach(([name, node]) => {
    console.log(`  ${name}: ${node.base_url}`);
  });
}

function loadRpcNode(workerPort = DEFAULT_WORKER_PORT) {
  const config = readJson(GLOBAL_CONFIG_FILE, null);
  if (!config) {
    throw new Error(`${GLOBAL_CONFIG_FILE} not found. Run 'cicy-rpc init' first`);
  }

  const nodesConfig = ensureNodeConfig(workerPort);
  const nodes = nodesConfig.cicyDesktopNodes || {};
  const nodeName = process.env.CICY_NODE || "local";
  const node = nodes?.[nodeName];
  if (!node) {
    const available = Object.keys(nodes || {}).join(", ");
    throw new Error(
      `node '${nodeName}' not found in cicyDesktopNodes${available ? ` (available: ${available})` : ""}`
    );
  }

  return {
    nodeName,
    token: node.api_token || config.api_token || "",
    baseUrl: node.base_url || `http://localhost:${workerPort}`,
  };
}

function parseRpcValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    try {
      return JSON.parse(value);
    } catch {}
  }
  return value;
}

function parseRpcArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    const match = arg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=(.+)$/);
    if (!match) {
      throw new Error(`Invalid argument format: ${arg}`);
    }
    parsed[match[1]] = parseRpcValue(match[2]);
  }
  return parsed;
}

async function rpcRequest(node, method, body, { accept = "application/json" } = {}) {
  const response = await fetch(`${node.baseUrl}/rpc/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: accept,
      Authorization: `Bearer ${node.token}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("yaml")) {
    return yaml.load(text);
  }
  return JSON.parse(text);
}

async function listTools({ detailName, showFull, workerPort = DEFAULT_WORKER_PORT }) {
  const node = loadRpcNode(workerPort);
  const response = await fetch(`${node.baseUrl}/rpc/tools`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${node.token}`,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const data = JSON.parse(text);
  const tools = data.tools || [];

  if (detailName) {
    const tool = tools.find((item) => item.name === detailName);
    if (!tool) {
      throw new Error(`Tool '${detailName}' not found`);
    }
    console.log(`${tool.name} - ${tool.description}`);
    const props = tool.inputSchema?.properties || {};
    const required = new Set(tool.inputSchema?.required || []);
    Object.entries(props).forEach(([key, schema]) => {
      const mark = required.has(key) ? "*" : "?";
      console.log(`  - ${key}${mark} (${schema.type || "any"}): ${schema.description || ""}`);
      if (schema.default !== undefined) {
        console.log(`    default: ${schema.default}`);
      }
    });
    return;
  }

  for (const tool of tools) {
    console.log(`${tool.name} - ${tool.description}`);
    if (!showFull) continue;
    const props = tool.inputSchema?.properties || {};
    const required = new Set(tool.inputSchema?.required || []);
    Object.entries(props).forEach(([key, schema]) => {
      const mark = required.has(key) ? "*" : "?";
      console.log(`  - ${key}${mark} (${schema.type || "any"}): ${schema.description || ""}`);
    });
  }
}

function renderRpcResult(result, rawJson) {
  if (rawJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const content = result?.result?.content;
  if (!Array.isArray(content) || !content.length) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("----------------");
  for (const item of content) {
    if (item.type === "text") {
      console.log(item.text);
    } else if (item.type === "image") {
      console.log(`Image (${item.mimeType}): ${(item.data || "").slice(0, 100)}...`);
    } else {
      console.log(JSON.stringify(item, null, 2));
    }
  }
  console.log("----------------");
}

async function callRpcTool(toolName, argv, { rawJson = false, workerPort = DEFAULT_WORKER_PORT } = {}) {
  const node = loadRpcNode(workerPort);
  const argumentsPayload = parseRpcArgs(argv);

  if (process.env.DEBUG === "1") {
    console.log("====== DEBUG ======");
    console.log(`Node: ${node.nodeName}`);
    console.log(`URL: ${node.baseUrl}/rpc/tools/call`);
    console.log(`Body: ${JSON.stringify({ name: toolName, arguments: argumentsPayload })}`);
    console.log("===================");
  }

  const result = await rpcRequest(node, "tools/call", {
    name: toolName,
    arguments: argumentsPayload,
  });

  if (result?.error) {
    throw new Error(result.error);
  }

  renderRpcResult(result, rawJson);
}

async function runRpcCli({
  argv,
  version,
  workerPort = DEFAULT_WORKER_PORT,
  programName = "cicy-rpc",
}) {
  let command = null;
  let showVersion = false;
  let rawJson = false;

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      showRpcHelp(programName);
      return 0;
    }
    if (arg === "-v" || arg === "--version") {
      showVersion = true;
      continue;
    }
    if (arg === "-j" || arg === "--json") {
      rawJson = true;
      continue;
    }
    if (!arg.startsWith("-") && command === null) {
      command = arg;
    }
  }

  if (showVersion) {
    console.log(`${programName} version ${version}`);
    return 0;
  }

  if (!command) {
    showRpcHelp(programName);
    return 1;
  }

  if (command === "init") {
    initRpcConfig(workerPort);
    return 0;
  }

  if (command === "tools") {
    const detailName = argv.find((arg, index) => index > argv.indexOf("tools") && !arg.startsWith("-"));
    const showFull = argv.includes("--full");
    await listTools({ detailName, showFull, workerPort });
    return 0;
  }

  const rpcArgs = argv.slice(argv.indexOf(command) + 1).filter((arg) => !["-j", "--json"].includes(arg));
  await callRpcTool(command, rpcArgs, { rawJson, workerPort });
  return 0;
}

function showRpcHelp(programName = "cicy-rpc") {
  console.log(`${programName} - CiCy Desktop RPC CLI\n\nUsage: ${programName} <command> [options]\n\nCommands:\n  init                     Initialize RPC node config in ~/global.json\n  tools [--full]           List all tools\n  tools <tool_name>        View tool details\n  <tool_name> [key=value]  Call a worker RPC tool directly\n\nOptions:\n  -h, --help               Show this help message\n  -v, --version            Show version\n  -j, --json               Use raw JSON output\n\nEnvironment:\n  CICY_NODE=<name>         Select RPC node from ~/global.json\n  DEBUG=1                  Show RPC request details\n\nExamples:\n  ${programName} init\n  ${programName} tools\n  ${programName} tools open_window\n  ${programName} ping\n  ${programName} open_window url=https://example.com\n  ${programName} -j get_window_info win_id=1`);
}

module.exports = {
  DEFAULT_WORKER_PORT,
  callRpcTool,
  initRpcConfig,
  listTools,
  loadRpcNode,
  parseRpcArgs,
  parseRpcValue,
  renderRpcResult,
  rpcRequest,
  runRpcCli,
  showRpcHelp,
};
