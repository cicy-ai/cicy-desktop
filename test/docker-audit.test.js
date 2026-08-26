const test = require("node:test");
const assert = require("node:assert/strict");

const { createDockerAuditRecord } = require("../src/backends/docker-audit");

test("records the destructive channel and Electron sender identity", () => {
  const event = {
    sender: { id: 17, getURL: () => "file:///C:/projects/cicy-desktop-win/index.html" },
    senderFrame: { url: "https://homepage.cicy.local/" },
  };

  const record = createDockerAuditRecord("docker:set-ports", event, { ports: [20001] });

  assert.equal(record.channel, "docker:set-ports");
  assert.equal(record.webContentsId, 17);
  assert.equal(record.senderUrl, "https://homepage.cicy.local/");
  assert.deepEqual(record.args, { ports: [20001] });
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/);
});

