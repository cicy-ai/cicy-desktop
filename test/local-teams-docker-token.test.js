const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Static guard: openTeam must NOT use the host global.json token for the
// Windows Docker :8008 team — that token belongs to the container's own volume.
test("openTeam reads the container token for the Windows Docker :8008 team, never the host global.json", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "backends", "local-teams.js"), "utf8");
  const open = src.slice(src.indexOf("async function openTeam"), src.indexOf("async function openTeam") + 2000);
  // win32 + local + (is_docker | docker port) → container token
  assert.match(open, /const isWinDockerTeam = process\.platform === "win32" && isLocalUrl/);
  assert.match(open, /readContainerToken\(localPort\)/);
  // when it's the win docker team, the host global.json fallback must be gated OUT
  assert.match(open, /if \(isWinDockerTeam\)[^]*?\} else if \(isLocalUrl\) \{\s*token = readGlobal\(\)\?\.api_token/);
  // and a missing container token refuses to open (no silent host-token page)
  assert.match(open, /container_token_unavailable/);
});
