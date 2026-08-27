const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("desktop never writes the gateway key into cicy-code's global.json (mac native / WSL)", () => {
  assert.doesNotMatch(read("src/backends/local-teams.js"), /injectGatewayKey\(/);
  assert.doesNotMatch(read("src/backends/sidecar-ipc.js"), /CICY_AI_GATEWAY_LLM_API_KEY/);
});

test("homepage has no login card / wallet / billing entries", () => {
  const jsx = read("workers/render/src/App.jsx");
  assert.match(jsx, /const LOGIN_UI = false/);
  assert.doesNotMatch(jsx, /UserChip-wallet|UserChip-login|DockerCard-billing|LocalTeamCard-billing/);
});
