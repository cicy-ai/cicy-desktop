const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 18102; // 与 setup-test-server.js 一致
const BASE_URL = `http://localhost:${PORT}`;
const TOKEN_FILE = path.join(os.homedir(), "data/electron/token.txt");

function getAuthToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    return fs.readFileSync(TOKEN_FILE, "utf-8").trim();
  }
  return "";
}

async function callRPC(toolName, args = {}) {
  const token = getAuthToken();
  const response = await axios.post(
    `${BASE_URL}/rpc/tools/call`,
    {
      name: toolName,
      arguments: args,
    },
    {
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }
  );

  return response.data.result;
}

module.exports = { callRPC };
