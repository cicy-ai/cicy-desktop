const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// linux-backend 在 require 时不做事,init() 才判定;每个用例换一个临时 HOME + 清模块缓存。
function fresh({ platform = "win32", files = {}, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lb-"));
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body);
  }
  const saved = { platform: process.platform, home: os.homedir, env: { ...process.env } };
  Object.defineProperty(process, "platform", { value: platform });
  os.homedir = () => home;
  delete process.env.CICY_DOCKER_APP_PORT; delete process.env.CICY_SIDECAR_PORT; delete process.env.CICY_LINUX_BACKEND;
  Object.assign(process.env, env);
  delete require.cache[require.resolve("../src/sidecar/linux-backend")];
  const lb = require("../src/sidecar/linux-backend");
  const restore = () => { Object.defineProperty(process, "platform", { value: saved.platform }); os.homedir = saved.home; process.env = saved.env; };
  return { lb, home, restore };
}

test("new Windows machine (no WSL install) → qemu on :8009, and the choice is persisted", () => {
  const { lb, home, restore } = fresh();
  try {
    assert.strictEqual(lb.init(), "qemu");
    assert.strictEqual(process.env.CICY_DOCKER_APP_PORT, "8009");
    const j = JSON.parse(fs.readFileSync(path.join(home, "cicy-ai", "db", "linux-backend.json"), "utf8"));
    assert.strictEqual(j.backend, "qemu");
  } finally { restore(); }
});

test("old machine with a WSL docker status on :8008 stays on wsl and keeps :8008", () => {
  const { lb, restore } = fresh({ files: { "cicy-ai/db/docker-status.json": JSON.stringify({ installed: true, port: 8008 }) } });
  try {
    assert.strictEqual(lb.init(), "wsl");
    assert.strictEqual(process.env.CICY_DOCKER_APP_PORT, undefined);
  } finally { restore(); }
});

test("a persisted decision wins over later evidence (no flip-flopping)", () => {
  const { lb, restore } = fresh({ files: {
    "cicy-ai/db/linux-backend.json": JSON.stringify({ backend: "qemu" }),
    "cicy-ai/db/docker-status.json": JSON.stringify({ installed: true, port: 8008 }),
  } });
  try { assert.strictEqual(lb.init(), "qemu"); } finally { restore(); }
});

test("CICY_LINUX_BACKEND forces the backend; non-Windows is native", () => {
  let f = fresh({ env: { CICY_LINUX_BACKEND: "wsl" } });
  try { assert.strictEqual(f.lb.init(), "wsl"); } finally { f.restore(); }
  f = fresh({ platform: "darwin" });
  try { assert.strictEqual(f.lb.init(), "native"); assert.strictEqual(process.env.CICY_DOCKER_APP_PORT, undefined); } finally { f.restore(); }
});
