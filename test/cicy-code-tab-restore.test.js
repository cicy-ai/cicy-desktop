const test = require("node:test");
const assert = require("node:assert/strict");

const { restoredCicyCodeUrl } = require("../src/tabbrowser/cicy-code-tab-restore");

test("restores the Docker tab with the container token", async () => {
  let reads = 0;
  const url = await restoredCicyCodeUrl(async () => {
    reads += 1;
    return "cicy_container_token";
  });

  assert.equal(reads, 1);
  assert.equal(url, "http://127.0.0.1:8008/?token=cicy_container_token");
});

test("does not open a tokenless Docker tab when the container token is unavailable", async () => {
  const url = await restoredCicyCodeUrl(async () => "");

  assert.equal(url, "");
});
