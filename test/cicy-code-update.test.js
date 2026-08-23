const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.join(__dirname, "..", "src", "sidecar", "container-scripts", "cicy-code-update.sh");

function writeExecutable(file, content) {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function runUpdate({ complete = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cicy-code-update-"));
  const home = path.join(root, "home");
  const store = path.join(root, "store");
  const bin = path.join(root, "bin");
  const dest = path.join(store, "2.3.563");
  fs.mkdirSync(path.join(dest, "bin"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  writeExecutable(path.join(dest, "bin", "cicy-code"), "#!/bin/sh\nexit 0\n");
  if (complete) {
    fs.mkdirSync(path.join(dest, "lib", "node_modules", "cicy-code-linux-x64"), { recursive: true });
    fs.writeFileSync(path.join(dest, "lib", "node_modules", "cicy-code-linux-x64", "package.json"), "{}\n");
  }
  writeExecutable(path.join(bin, "supervisorctl"), "#!/bin/sh\nexit 1\n");
  writeExecutable(path.join(bin, "npm"), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${root}/npm.log"
prefix=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--prefix" ]; then prefix="$arg"; break; fi
  prev="$arg"
done
[ -n "$prefix" ]
mkdir -p "$prefix/lib/node_modules/cicy-code-linux-x64"
printf '{}\\n' > "$prefix/lib/node_modules/cicy-code-linux-x64/package.json"
`);
  const result = spawnSync("bash", [script, "2.3.563"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      CICY_CODE_STORE: store,
      NPM_REGISTRY: "https://registry.npmjs.org",
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  return {
    ...result,
    platformPackage: path.join(dest, "lib", "node_modules", "cicy-code-linux-x64", "package.json"),
    npmLog: fs.existsSync(path.join(root, "npm.log")) ? fs.readFileSync(path.join(root, "npm.log"), "utf8") : "",
  };
}

test("repairs an existing cicy-code runtime when its linux-x64 package is missing", () => {
  const result = runUpdate();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(result.platformPackage), true);
  assert.match(result.npmLog, /cicy-code-linux-x64@2\.3\.563/);
});

test("does not reinstall an existing runtime when its platform package is present", () => {
  const result = runUpdate({ complete: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.npmLog, "");
});
