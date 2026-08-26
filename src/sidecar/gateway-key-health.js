function gatewayKeyPresentInEnv(output) {
  return String(output || "")
    .split(/\r?\n/)
    .some((line) => /^CICY_AI_GATEWAY_LLM_API_KEY=sk-/.test(line));
}

function nextGatewayKeyHealth(missingChecks, keyState, threshold = 3) {
  if (keyState !== false) return { missingChecks: 0, shouldRecreate: false };
  const next = Number(missingChecks || 0) + 1;
  if (next >= threshold) return { missingChecks: 0, shouldRecreate: true };
  return { missingChecks: next, shouldRecreate: false };
}

module.exports = { gatewayKeyPresentInEnv, nextGatewayKeyHealth };
