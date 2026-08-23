// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

function classifyWslPrerequisites({ executableMissing, subsystemEnabled, vmPlatformEnabled }) {
  const featuresReady = subsystemEnabled && vmPlatformEnabled;
  const ready = !executableMissing && featuresReady;
  return {
    ready,
    enableFeatures: !featuresReady,
    installWsl: executableMissing,
    needsReboot: !ready,
  };
}

module.exports = { classifyWslPrerequisites };
