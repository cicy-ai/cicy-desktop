const test = require("node:test");
const assert = require("node:assert/strict");

const {
  gatewayKeyPresentInEnv,
  nextGatewayKeyHealth,
} = require("../src/sidecar/gateway-key-health");

test("finds the gateway key in docker inspect environment output", () => {
  const output = [
    "HOME=/home/cicy",
    "CICY_AI_GATEWAY_LLM_API_KEY=sk-example",
    "NODE_ENV=production",
  ].join("\n");

  assert.equal(gatewayKeyPresentInEnv(output), true);
  assert.equal(gatewayKeyPresentInEnv("HOME=/home/cicy\nNODE_ENV=production"), false);
});

test("does not recreate when the key check is unknown", () => {
  assert.deepEqual(nextGatewayKeyHealth(2, null), {
    missingChecks: 0,
    shouldRecreate: false,
  });
});

test("recreates only after three consecutive confirmed missing checks", () => {
  const first = nextGatewayKeyHealth(0, false);
  const second = nextGatewayKeyHealth(first.missingChecks, false);
  const third = nextGatewayKeyHealth(second.missingChecks, false);

  assert.deepEqual(first, { missingChecks: 1, shouldRecreate: false });
  assert.deepEqual(second, { missingChecks: 2, shouldRecreate: false });
  assert.deepEqual(third, { missingChecks: 0, shouldRecreate: true });
  assert.deepEqual(nextGatewayKeyHealth(2, true), {
    missingChecks: 0,
    shouldRecreate: false,
  });
});

