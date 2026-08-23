const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldSkipCicyUpdate } = require("../src/sidecar/cicy-runtime-health");

test("does not skip an update when the recorded version matches but the platform package is missing", () => {
  assert.equal(shouldSkipCicyUpdate({ latest: "2.3.563", current: "2.3.563", platformReady: false }), false);
});

test("skips an update only when the recorded version matches and the runtime is complete", () => {
  assert.equal(shouldSkipCicyUpdate({ latest: "2.3.563", current: "2.3.563", platformReady: true }), true);
});
