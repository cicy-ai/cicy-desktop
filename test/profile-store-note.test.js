const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

test("setNote persists a trimmed note on electron profiles", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cicy-note-"));
  const prevHome = process.env.HOME, prevUp = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  delete require.cache[require.resolve("../src/profiles/profile-store")];
  try {
    const store = require("../src/profiles/profile-store");
    fs.mkdirSync(store.ELECTRON_DIR, { recursive: true });
    const view = store.setNote("electron", 3, "  主号，别乱动  ");
    assert.equal(view.note, "主号，别乱动");
    assert.equal(store.getProfile("electron", 3).note, "主号，别乱动");
    assert.equal(store.setNote("electron", 3, "").note, "");
  } finally {
    process.env.HOME = prevHome; if (prevUp === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUp;
    delete require.cache[require.resolve("../src/profiles/profile-store")];
    fs.rmSync(home, { recursive: true, force: true });
  }
});
