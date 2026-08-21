// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const assert = require("node:assert/strict");
const test = require("node:test");

test("renaming a custom team updates the fixed title of its open tab", () => {
  const { applyTeamIdentityToTab } = require("../src/tabbrowser/team-tab-identity");
  const tab = {
    fixedTitle: "old generated title",
    title: "Codex | live | CiCy Code",
    avatar: "",
    team: true,
    colorKey: "custom-1",
  };

  assert.equal(
    applyTeamIdentityToTab(tab, {
      id: "custom-1",
      title: "Project Alpha",
      avatar: "data:image/png;base64,abc",
    }),
    true
  );
  assert.equal(tab.fixedTitle, "Project Alpha");
  assert.equal(tab.title, "Codex | live | CiCy Code");
  assert.equal(tab.avatar, "data:image/png;base64,abc");
  assert.equal(tab.colorKey, "custom-1");
  assert.equal(tab.team, true);
});
