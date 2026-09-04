// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// User-configurable "+ 面板" dropdown.
//
// The menu used to be a hard-coded array in panel-menu.js, so a user who never
// touches Redroid still saw it and could not rename or reorder anything. The
// list now comes from ~/cicy-ai/db/panel-menu.json, which the homepage edits.
//
// The store only overrides PRESENTATION — which entries show, in what order,
// under what name. It can NOT invent new entries: every id is validated against
// the built-in set, because each preset must have a real page behind it
// (panel-page-router). A hand-edited or stale config therefore can never point
// the menu at a panel that would open blank.
const fs = require("fs");
const os = require("os");
const path = require("path");

const STORE = path.join(os.homedir(), "cicy-ai", "db", "panel-menu.json");

// id === the preset string createPanelMenuTemplate hands to openPanel().
const BUILTIN = [
  { id: "blank", title: "面板" },
  { id: "telegram-matrix", title: "Telegram 矩阵" },
  { id: "redroid-matrix", title: "Redroid 矩阵" },
  { id: "facebook-matrix", title: "Facebook 矩阵" },
  { id: "tiktok-matrix", title: "TikTok 矩阵" },
];
const BUILTIN_IDS = new Set(BUILTIN.map((b) => b.id));

function readRaw() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE, "utf8"));
    return Array.isArray(j && j.items) ? j.items : [];
  } catch {
    return [];
  }
}

// Configured entries keep their order; any built-in the config never mentioned
// is appended, so shipping a NEW panel later still surfaces it for users who
// already have a saved config.
function list() {
  const seen = new Set();
  const out = [];
  for (const c of readRaw()) {
    const id = String((c && c.id) || "");
    if (!BUILTIN_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    const b = BUILTIN.find((x) => x.id === id);
    const title = typeof c.title === "string" && c.title.trim() ? c.title.trim() : b.title;
    out.push({ id, title, enabled: c.enabled !== false });
  }
  for (const b of BUILTIN) if (!seen.has(b.id)) out.push({ ...b, enabled: true });
  return out;
}

// What the menu actually renders. Everything disabled would leave the user with
// no way to open a panel (and no way back to this setting), so an empty result
// falls back to the built-ins instead of an empty menu.
function enabled() {
  const on = list().filter((i) => i.enabled);
  return on.length ? on : BUILTIN.map((b) => ({ ...b, enabled: true }));
}

function save(items) {
  const clean = [];
  const seen = new Set();
  for (const x of Array.isArray(items) ? items : []) {
    const id = String((x && x.id) || "");
    if (!BUILTIN_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    const entry = { id, enabled: !(x && x.enabled === false) };
    if (x && typeof x.title === "string" && x.title.trim()) entry.title = x.title.trim();
    clean.push(entry);
  }
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify({ items: clean }, null, 2));
  return list();
}

// Title a tab should show for a preset (honours the user's rename).
function titleFor(id) {
  const hit = list().find((x) => x.id === String(id || ""));
  return hit ? hit.title : null;
}

module.exports = { STORE, BUILTIN, list, enabled, save, titleFor };
