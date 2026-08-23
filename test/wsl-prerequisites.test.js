const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyWslPrerequisites } = require("../src/sidecar/wsl-prerequisites");

test("requires feature enablement and reboot when wsl.exe exists but Windows features are disabled", () => {
  assert.deepEqual(
    classifyWslPrerequisites({
      executableMissing: false,
      subsystemEnabled: false,
      vmPlatformEnabled: false,
    }),
    { ready: false, enableFeatures: true, installWsl: false, needsReboot: true },
  );
});

test("is ready only when wsl.exe and both Windows features are available", () => {
  assert.deepEqual(
    classifyWslPrerequisites({
      executableMissing: false,
      subsystemEnabled: true,
      vmPlatformEnabled: true,
    }),
    { ready: true, enableFeatures: false, installWsl: false, needsReboot: false },
  );
});

test("installs WSL and enables features when wsl.exe is missing", () => {
  assert.deepEqual(
    classifyWslPrerequisites({
      executableMissing: true,
      subsystemEnabled: false,
      vmPlatformEnabled: false,
    }),
    { ready: false, enableFeatures: true, installWsl: true, needsReboot: true },
  );
});
