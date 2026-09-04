// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// The "+ 面板" dropdown is configured from the homepage. These lock the store's
// contract: presentation is user-owned (order / title / enabled), but the id set
// is not — a config can never introduce a panel that has no page behind it, and
// can never leave the user with an empty menu.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cicy-panelmenu-"));
  const prevHome = process.env.HOME;
  const prevUp = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete require.cache[require.resolve("../src/tabbrowser/panel-menu-store")];
  try {
    fn(require("../src/tabbrowser/panel-menu-store"), home);
  } finally {
    process.env.HOME = prevHome;
    if (prevUp === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUp;
    delete require.cache[require.resolve("../src/tabbrowser/panel-menu-store")];
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("panel menu: no config → every built-in, enabled, in shipped order", () => {
  withHome((store) => {
    const list = store.list();
    assert.deepEqual(
      list.map((i) => i.id),
      ["blank", "telegram-matrix", "redroid-matrix", "facebook-matrix", "tiktok-matrix"]
    );
    assert.ok(list.every((i) => i.enabled));
    assert.equal(store.enabled().length, 5);
  });
});

test("panel menu: homepage can reorder, rename and disable", () => {
  withHome((store) => {
    store.save([
      { id: "telegram-matrix", title: "我的 TG" },
      { id: "blank" },
      { id: "redroid-matrix", enabled: false },
    ]);
    const list = store.list();
    // configured order first, untouched built-ins appended
    assert.deepEqual(
      list.map((i) => i.id),
      ["telegram-matrix", "blank", "redroid-matrix", "facebook-matrix", "tiktok-matrix"]
    );
    assert.equal(list[0].title, "我的 TG"); // rename honoured
    assert.equal(list.find((i) => i.id === "redroid-matrix").enabled, false);
    // the dropdown skips the disabled one
    assert.deepEqual(
      store.enabled().map((i) => i.id),
      ["telegram-matrix", "blank", "facebook-matrix", "tiktok-matrix"]
    );
    // a renamed entry also renames its tab
    assert.equal(store.titleFor("telegram-matrix"), "我的 TG");
  });
});

test("panel menu: unknown ids are dropped, never persisted", () => {
  withHome((store, home) => {
    store.save([{ id: "evil-panel", title: "x" }, { id: "blank" }]);
    const saved = JSON.parse(
      fs.readFileSync(path.join(home, "cicy-ai", "db", "panel-menu.json"), "utf8")
    );
    assert.deepEqual(
      saved.items.map((i) => i.id),
      ["blank"]
    );
    assert.ok(!store.list().some((i) => i.id === "evil-panel"));
  });
});

test("panel menu: disabling everything falls back to built-ins, never an empty menu", () => {
  withHome((store) => {
    store.save(store.list().map((i) => ({ ...i, enabled: false })));
    assert.ok(store.list().every((i) => !i.enabled)); // the setting is respected…
    assert.equal(store.enabled().length, 5); // …but the menu still renders
  });
});

test("panel-menu template is built from the store, not a hard-coded array", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src/tabbrowser/panel-menu.js"), "utf8");
  assert.match(src, /require\("\.\/panel-menu-store"\)/);
  assert.match(src, /store\.enabled\(\)\.map/);
  assert.doesNotMatch(src, /label:\s*"Telegram 矩阵"/); // no hard-coded entries left
});
