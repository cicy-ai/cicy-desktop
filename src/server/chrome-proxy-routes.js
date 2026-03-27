const express = require("express");

const { getVersion, getTargets, activateTarget, callCdp } = require("../chrome/chrome-cdp-client");
const { resolveChromeDebuggerPort } = require("../chrome/debugger-port-resolver");

function sendError(res, status, message, extra = {}) {
  res.status(status).json({ error: message, ...extra });
}

function parseAccountIdx(param) {
  const n = Number(param);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

function createChromeProxyRoutes({ registry, chromeConfig } = {}) {
  // Optional chromeConfig injection for tests.
  const router = express.Router();

  function resolvePortOrRespond(req, res) {
    const accountIdx = parseAccountIdx(req.params.accountIdx);
    if (accountIdx === null) {
      return { ok: false, accountIdx: null, debuggerPort: null, responded: true, source: null };
    }

    const { debuggerPort, source } = resolveChromeDebuggerPort(accountIdx, { registry, chromeConfig });
    if (!debuggerPort) {
      sendError(res, 404, `Missing debuggerPort for accountIdx=${accountIdx}`);
      return { ok: false, accountIdx, debuggerPort: null, responded: true, source };
    }

    return { ok: true, accountIdx, debuggerPort, responded: false, source };
  }

  // Keep compatible paths under /chrome/:accountIdx/*
  router.get("/:accountIdx/json/version", async (req, res) => {
    const r = resolvePortOrRespond(req, res);
    if (!r.ok) {
      if (r.accountIdx === null) sendError(res, 400, "accountIdx must be an integer");
      return;
    }

    try {
      const version = await getVersion(r.debuggerPort);
      res.json(version);
    } catch (error) {
      sendError(res, 502, error.message, { debuggerPort: r.debuggerPort });
    }
  });

  router.get("/:accountIdx/json/list", async (req, res) => {
    const r = resolvePortOrRespond(req, res);
    if (!r.ok) {
      if (r.accountIdx === null) sendError(res, 400, "accountIdx must be an integer");
      return;
    }

    try {
      const targets = await getTargets(r.debuggerPort);
      res.json(targets);
    } catch (error) {
      sendError(res, 502, error.message, { debuggerPort: r.debuggerPort });
    }
  });

  router.post("/:accountIdx/json/activate/:targetId", async (req, res) => {
    const r = resolvePortOrRespond(req, res);
    if (!r.ok) {
      if (r.accountIdx === null) sendError(res, 400, "accountIdx must be an integer");
      return;
    }

    const targetId = req.params.targetId;
    if (!targetId) {
      sendError(res, 400, "Missing targetId");
      return;
    }

    try {
      const text = await activateTarget(r.debuggerPort, targetId);
      // Chrome returns text/plain; we return JSON to keep API consistent.
      res.json({ ok: true, text });
    } catch (error) {
      sendError(res, 502, error.message, { debuggerPort: r.debuggerPort, targetId });
    }
  });

  router.post("/:accountIdx/cdp/call", async (req, res) => {
    const r = resolvePortOrRespond(req, res);
    if (!r.ok) {
      if (r.accountIdx === null) sendError(res, 400, "accountIdx must be an integer");
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const method = body.method;
    const params = body.params;
    const target = body.target;

    if (typeof method !== "string" || !method.length) {
      sendError(res, 400, "Missing method");
      return;
    }

    try {
      const result = await callCdp({
        debuggerPort: r.debuggerPort,
        method,
        params: params && typeof params === "object" ? params : {},
        target: typeof target === "string" && target.length ? target : undefined,
      });
      res.json({ result });
    } catch (error) {
      sendError(res, 502, error.message, { debuggerPort: r.debuggerPort, method });
    }
  });

  return router;
}

module.exports = { createChromeProxyRoutes };
