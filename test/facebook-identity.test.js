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
  // 从 profile 读回时多带 email / twofa / secondEmail 三项(面板 ⚙ 要显示),记录里没有就是空串。
  assert.deepEqual(fb.facebookIdentityFromProfile({ logins: [rec] }), { id: "100012345", username: "", displayName: "Zhang San", phone: "", email: "", twofa: "", secondEmail: "" });
  assert.deepEqual(fb.facebookIdentityFromProfile({ logins: [{ ...rec, email: "a@b.c", twofa: "abc", secondEmail: "x@y.z" }] }).twofa, "abc");
  assert.equal(fb.normalizeFacebookIdentity({ id: "0" }), null);
  assert.equal(fb.facebookIdentityFromProfile({ logins: [] }), null);
});
