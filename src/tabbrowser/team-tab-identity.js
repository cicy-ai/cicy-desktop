// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Apply the canonical, user-owned team identity to an existing tab. Keeping
// this separate from document.title prevents a cicy-code page title update
// from replacing the name chosen on the Desktop team card.
function applyTeamIdentityToTab(tab, identity) {
  if (!tab || !identity || !identity.id) return false;
  let changed = false;

  const nextTitle = String(identity.title || "").trim();
  if (nextTitle && tab.fixedTitle !== nextTitle) {
    tab.fixedTitle = nextTitle;
    changed = true;
  }
  const nextAvatar = identity.avatar || "";
  if ((tab.avatar || "") !== nextAvatar) {
    tab.avatar = nextAvatar;
    changed = true;
  }
  if (tab.colorKey !== identity.id) {
    tab.colorKey = identity.id;
    changed = true;
  }
  if (!tab.team) {
    tab.team = true;
    changed = true;
  }
  return changed;
}

module.exports = { applyTeamIdentityToTab };
