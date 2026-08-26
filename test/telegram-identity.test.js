const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
  isTelegramUrl,
  TELEGRAM_IDENTITY_SCRIPT,
  normalizeTelegramIdentity,
  telegramLoginRecord,
  telegramIdentityFromProfile,
} = require("../src/tabbrowser/telegram-identity");

test("recognizes telegram web urls only", () => {
  assert.equal(isTelegramUrl("https://web.telegram.org/k/"), true);
  assert.equal(isTelegramUrl("https://web.telegram.org/a/#123"), true);
  assert.equal(isTelegramUrl("https://example.com/web.telegram.org"), false);
  assert.equal(isTelegramUrl("chrome-error://chromewebdata/"), false);
});

test("identity script is valid JS and returns null without storage", async () => {
  new vm.Script(TELEGRAM_IDENTITY_SCRIPT); // syntax
  const ctx = vm.createContext({ localStorage: { getItem: () => null }, indexedDB: {} });
  assert.equal(await vm.runInContext(TELEGRAM_IDENTITY_SCRIPT, ctx), null);
});

test("identity script never leaks auth material", () => {
  assert.doesNotMatch(TELEGRAM_IDENTITY_SCRIPT, /auth_key|server_salt|account\d/);
});

test("normalizes identity and maps to a profile login record", () => {
  const it = normalizeTelegramIdentity({ id: 42, username: "@alice", firstName: " Alice ", lastName: "L", phone: "1234" });
  assert.deepEqual(it, { id: "42", username: "alice", displayName: "Alice L", phone: "1234" });
  assert.deepEqual(telegramLoginRecord(it), { url: "https://web.telegram.org", name: "telegram", username: "alice", mobile: "1234", note: "Alice L" });
  assert.equal(normalizeTelegramIdentity(null), null);
  assert.equal(normalizeTelegramIdentity({ username: "x" }), null);
});

test("reads identity back from a stored profile", () => {
  const p = { logins: [{ name: "gmail", username: "a@b" }, { name: "Telegram", username: "alice", mobile: "1", note: "Alice" }] };
  assert.deepEqual(telegramIdentityFromProfile(p), { username: "alice", displayName: "Alice", phone: "1" });
  assert.equal(telegramIdentityFromProfile({ logins: [] }), null);
});
