// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

const assert = require("node:assert/strict");
const test = require("node:test");

test("custom team edit saves the user title together with the access URL", async () => {
  const { buildCustomTeamEditPatch } = await import("../workers/render/src/custom-team-edit.js");

  assert.deepEqual(
    buildCustomTeamEditPatch({
      title: "  Project Alpha  ",
      url: "  https://example.com/#/project/3  ",
    }),
    {
      ok: true,
      patch: {
        name: "Project Alpha",
        base_url: "https://example.com/#/project/3",
      },
    }
  );
});
test("custom team edit rejects an empty custom title", async () => {
  const { buildCustomTeamEditPatch } = await import("../workers/render/src/custom-team-edit.js");

  assert.deepEqual(
    buildCustomTeamEditPatch({ title: "   ", url: "https://example.com" }),
    { ok: false, error: "title_required" }
  );
});
