// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

function shouldSkipCicyUpdate({ latest, current, platformReady }) {
  return Boolean(latest && current && latest === current && platformReady);
}

module.exports = { shouldSkipCicyUpdate };
