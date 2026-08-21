// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Build the one atomic update used by the custom-team editor. The title is
// user-owned metadata; it must never be regenerated from the access URL.
export function buildCustomTeamEditPatch({ title, url } = {}) {
  const name = String(title || "").trim();
  if (!name) return { ok: false, error: "title_required" };

  return {
    ok: true,
    patch: {
      name,
      base_url: String(url || "").trim(),
    },
  };
}
