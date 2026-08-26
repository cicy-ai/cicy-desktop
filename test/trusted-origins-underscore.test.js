const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeHost } = require("../src/profiles/trusted-origins-store");

test("trusted-origins accepts hostnames with underscores, bare or as URL", () => {
  assert.equal(normalizeHost("xs_master.cicy-ai.com"), "xs_master.cicy-ai.com");
  assert.equal(normalizeHost("https://XS_master.cicy-ai.com/path?q=1"), "xs_master.cicy-ai.com");
  assert.equal(normalizeHost("xs_master.cicy-ai.com:8008"), "xs_master.cicy-ai.com");
  assert.equal(normalizeHost("bad host"), "");
  assert.equal(normalizeHost(".x.com"), "");
});
