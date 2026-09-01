// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// The "+ 面板" dropdown. The entries are no longer hard-coded here: they come
// from panel-menu-store, which the homepage lets the user reorder, rename and
// switch off. The store guarantees a non-empty, id-validated list, so this stays
// a straight map from stored entry → Electron menu item.
const store = require("./panel-menu-store");

function createPanelMenuTemplate(openPanel) {
  return store.enabled().map((item) => ({
    label: item.title,
    click: () => openPanel(item.id),
  }));
}

module.exports = { createPanelMenuTemplate };
