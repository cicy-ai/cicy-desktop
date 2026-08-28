const test = require("node:test");
const assert = require("node:assert/strict");
const fb = require("../src/tabbrowser/facebook-identity");

test("facebook url detection", () => {
  assert.equal(fb.isFacebookUrl("https://www.facebook.com/"), true);
  assert.equal(fb.isFacebookUrl("https://m.facebook.com/home.php"), true);
  assert.equal(fb.isFacebookUrl("https://web.telegram.org/k/"), false);
});

test("facebook identity normalizes and round-trips through the login record", () => {
  const it = fb.normalizeFacebookIdentity({ id: "100012345", displayName: "Zhang San", shortName: "Zhang" });
  assert.deepEqual(it, { id: "100012345", username: "", displayName: "Zhang San", phone: "" });
  const rec = fb.facebookLoginRecord(it);
  assert.equal(rec.name, "facebook");
  assert.equal(rec.username, "100012345");
  assert.equal(rec.note, "Zhang San");
  assert.deepEqual(fb.facebookIdentityFromProfile({ logins: [rec] }), { id: "100012345", username: "", displayName: "Zhang San", phone: "" });
  assert.equal(fb.normalizeFacebookIdentity({ id: "0" }), null);
  assert.equal(fb.facebookIdentityFromProfile({ logins: [] }), null);
});
