const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { resolvePanelPreset } = require("../src/tabbrowser/panel-presets");
const { panelPageForUrl } = require("../src/tabbrowser/panel-page-router");
const {
  nextProfileId,
  normalizeTelegramProxy,
  addTelegramProfile,
  setTelegramProfileProxy,
} = require("../src/tabbrowser/telegram-matrix-profiles");
const { loadPanelCellUrl } = require("../src/tabbrowser/telegram-web-preferences");
const { shouldAttachPanelCell } = require("../src/tabbrowser/panel-cell-visibility");

test("Telegram matrix preset routes to its dedicated page", () => {
  assert.deepEqual(resolvePanelPreset("telegram-matrix"), {
    preset: "telegram-matrix",
    title: "Telegram 矩阵",
    query: "preset=telegram-matrix",
  });
  assert.equal(panelPageForUrl("cicyui://panel/abc?preset=telegram-matrix"), "telegram-matrix.html");
  assert.equal(panelPageForUrl("cicyui://panel/abc"), "split-panel.html");
});

test("profile IDs grow without reusing reserved profile 9", () => {
  assert.equal(nextProfileId([{ accountIdx: 1 }, { accountIdx: 2 }]), 3);
  assert.equal(nextProfileId([{ accountIdx: 8 }]), 10);
});

test("custom proxy accepts supported schemes and direct mode", () => {
  assert.equal(normalizeTelegramProxy("http://127.0.0.1:20001"), "http://127.0.0.1:20001");
  assert.equal(normalizeTelegramProxy("https://proxy.example:443"), "https://proxy.example:443");
  assert.equal(normalizeTelegramProxy("socks5://127.0.0.1:1080"), "socks5://127.0.0.1:1080");
  assert.equal(normalizeTelegramProxy("  "), "");
  assert.throws(() => normalizeTelegramProxy("ftp://proxy.example"), /http, https, socks5/);
});

test("adding a profile persists the default proxy and proxy edits", () => {
  const rows = [{ accountIdx: 1, name: "electron-1", proxy: { url: "", enabled: false } }];
  const store = {
    listProfiles: () => rows.slice(),
    setProxy: (_backend, accountIdx, proxy) => {
      const view = { accountIdx, name: `electron-${accountIdx}`, proxy: { url: proxy, enabled: !!proxy } };
      const index = rows.findIndex((row) => row.accountIdx === accountIdx);
      if (index < 0) rows.push(view); else rows[index] = view;
      return view;
    },
  };
  assert.equal(addTelegramProfile(store).accountIdx, 2);
  assert.equal(rows[1].proxy.url, "http://127.0.0.1:20001");
  assert.equal(setTelegramProfileProxy(2, "socks5://127.0.0.1:1080", store).proxy.url, "socks5://127.0.0.1:1080");
});

test("a cached-but-offline cell is reported as failed, not loaded", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "tabbrowser", "panel-cells.js"), "utf8");
  // service worker 会让断网的 Telegram 也「加载成功」,只能从 session 层探。
  assert.match(src, /net\.fetch\(target, \{[^]*session: session\.fromPartition\(partitionFor\(profileIdx\)\)/);
  assert.match(src, /ERR_NO_NETWORK/);
  assert.match(src, /did-stop-loading", \(\) => \{ push\(\); probeReachable\(\);/);
  assert.match(src, /if \(seq !== probeSeq\) return;/);
  // 一次失败不判定,避免代理抖动误报
  const probe = src.slice(src.indexOf("const probeReachable"), src.indexOf("wc.on(\"did-start-loading\""));
  assert.match(probe, /let detail = await attempt\(\);[^]*detail = await attempt\(\);/);
  assert.match(probe, /target = `\$\{u\.origin\}\$\{u\.pathname\}`/);
});

test("panel reload adopts existing session views instead of destroying them", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "tabbrowser", "telegram-matrix.html"), "utf8");
  assert.match(html, /pullStates\(\{ adopt: true \}\)[^]*loadProfiles\(\)/);
  const pull = html.slice(html.indexOf("async function pullStates"), html.indexOf("async function loadProfiles"));
  assert.match(pull, /if \(adopt\)[^]*openedProfiles\.add\(Number\(m\[1\]\)\)/);
});

test("reloading an unopened profile creates its cell instead of a bare reload", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "tabbrowser", "telegram-matrix.html"), "utf8");
  const reload = html.slice(html.indexOf("function reloadProfile"), html.indexOf("function render()"));
  assert.match(reload, /const fresh = !openedProfiles\.has\(idx\)/);
  assert.match(reload, /if \(!fresh\)[^]*panelAPI\.reload/);
});

test("matrix page exposes profile table, phone preview, proxy drawer and ip probe", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "tabbrowser", "telegram-matrix.html"), "utf8");
  assert.match(html, /id="rows"/);
  assert.match(html, /id="ov-error"/);
  assert.match(html, /panelAPI\.states/);
  assert.match(html, /panelAPI\.setProfileProxy/);
  assert.match(html, /panelAPI\.probeIp/);
  assert.match(html, /panelAPI\.removeProfile/);
  // 删除必须二次确认:确认块默认隐藏,只有 rm-yes 才真正调用删除
  assert.match(html, /\.cfg \.confirm \{ display: none;/);
  assert.match(html, /querySelector\('\.rm-yes'\)\.onclick = async[^]*await removeProfile\(p\)/);
  assert.doesNotMatch(html.slice(html.indexOf("querySelector('.rm').onclick"), html.indexOf("querySelector('.rm-no')")), /removeProfile\(/);
  assert.match(html, /id="add-profile"/);
  assert.match(html, /class="cfg"[^]*data-role="proxy"/);
  assert.match(html, /\.row\.cfg-open \.cfg \{ display: block; \}/);
  assert.match(html, /class="tg none"/);
  assert.match(html, /id="phone-preview"/);
  assert.match(html, /https:\/\/web\.telegram\.org\/k\//);
  assert.match(html, /panelAPI\.sync/);
  assert.match(html, /#phone\s*\{[^}]*overflow:\s*hidden/);
});

test("Telegram preview defaults to light before navigation without changing other sites", async () => {
  const events = [];
  const wc = {
    debugger: {
      isAttached: () => false,
      attach: () => events.push("attach"),
      sendCommand: async (method, params) => events.push([method, params]),
    },
    loadURL: async (url) => events.push(["load", url]),
    insertCSS: async (css) => events.push(["css", css]),
  };

  await loadPanelCellUrl(wc, "https://web.telegram.org/k/");
  assert.deepEqual(events, [
    ["load", "about:blank"],
    "attach",
    ["Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }],
    ["load", "https://web.telegram.org/k/"],
    ["css", "html, body { width: 100% !important; height: 100% !important; overflow: hidden !important; } body { clip-path: inset(0 round 19px); contain: paint; }"],
  ]);

  events.length = 0;
  await loadPanelCellUrl(wc, "https://example.com/");
  assert.deepEqual(events, [["load", "https://example.com/"]]);
});

test("opened Telegram profile views are retained and only the selected one is attached", () => {
  assert.equal(shouldAttachPanelCell(true, true), true);
  assert.equal(shouldAttachPanelCell(true, false), false);
  assert.equal(shouldAttachPanelCell(false, true), false);

  const html = fs.readFileSync(path.join(__dirname, "..", "src", "tabbrowser", "telegram-matrix.html"), "utf8");
  assert.match(html, /openedProfiles\s*=\s*new Set/);
  assert.match(html, /id:\s*cellId\(profileId\)/);
  assert.match(html, /`telegram-preview-\$\{idx\}`/);
  assert.match(html, /visible:\s*!!selected\s*&&\s*profileId\s*===\s*selected\.accountIdx/);
});
