const test = require("node:test");
const assert = require("node:assert/strict");

const wslDocker = require("../src/sidecar/wsl-docker");

test("pushes the cicy-code repair script as root inside the container", () => {
  assert.equal(typeof wslDocker.buildPushUpdateScriptCommand, "function");
  assert.equal(
    wslDocker.buildPushUpdateScriptCommand("Y29udGVudA==", "cicy-code-docker-8008"),
    "echo Y29udGVudA== | base64 -d | docker exec -u root -i cicy-code-docker-8008 bash -c 'cat > /usr/local/bin/cicy-code-update.sh && chmod 0755 /usr/local/bin/cicy-code-update.sh'"
  );
});
