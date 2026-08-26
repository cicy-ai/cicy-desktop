const test = require("node:test");
const assert = require("node:assert/strict");

const { parseMihomoSelections } = require("../src/sidecar/wsl-docker");
const { planSelectionUpdates } = require("../src/sidecar/host-mihomo");

test("reads Selector choices from the WSL Docker mihomo controller", () => {
  const selections = parseMihomoSelections(JSON.stringify({
    proxies: {
      "chrome-profile-1-group": { type: "Selector", now: "us_proxy_v1" },
      default_proxy_group: { type: "Selector", now: "us_proxy_v1" },
      us_proxy_v1: { type: "Socks5", alive: true },
    },
  }));

  assert.deepEqual(selections, {
    "chrome-profile-1-group": "us_proxy_v1",
    default_proxy_group: "us_proxy_v1",
  });
});

test("plans host changes only for valid, different Selector choices", () => {
  const updates = planSelectionUpdates({
    proxies: {
      "chrome-profile-1-group": {
        type: "Selector",
        now: "CKai-main",
        all: ["CKai-main", "us_proxy_v1"],
      },
      default_proxy_group: {
        type: "Selector",
        now: "us_proxy_v1",
        all: ["DIRECT", "us_proxy_v1"],
      },
      fallback_group: {
        type: "Selector",
        now: "DIRECT",
        all: ["DIRECT"],
      },
    },
  }, {
    "chrome-profile-1-group": "us_proxy_v1",
    default_proxy_group: "us_proxy_v1",
    fallback_group: "missing-node",
  });

  assert.deepEqual(updates, [
    { group: "chrome-profile-1-group", from: "CKai-main", to: "us_proxy_v1" },
  ]);
});

test("rejects malformed WSL Docker controller responses", () => {
  assert.throws(() => parseMihomoSelections("not json"), /mihomo controller/i);
  assert.throws(() => parseMihomoSelections("{}"), /mihomo controller/i);
});
