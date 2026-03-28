const express = require("express");

function parseToolText(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) return null;
  return JSON.parse(text);
}

function createChromeManagementRoutes({ authMiddleware, executeTool, buildRequestContext }) {
  const router = express.Router();

  router.use(authMiddleware);

  router.get("/profiles", async (req, res) => {
    try {
      const result = await executeTool(
        "chrome_list_profiles",
        {},
        buildRequestContext(req, { transport: "rest-api", route: "chrome_list_profiles" })
      );
      const data = parseToolText(result) || {};
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/profiles/:accountIdx", async (req, res) => {
    try {
      const accountIdx = Number(req.params.accountIdx);
      const result = await executeTool(
        "chrome_get_profile",
        { accountIdx },
        buildRequestContext(req, { transport: "rest-api", route: "chrome_get_profile", accountIdx })
      );
      const data = parseToolText(result) || {};
      if (result?.isError) return res.status(404).json(data);
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/profiles/:accountIdx/targets", async (req, res) => {
    try {
      const accountIdx = Number(req.params.accountIdx);
      const result = await executeTool(
        "chrome_get_targets",
        { accountIdx },
        buildRequestContext(req, { transport: "rest-api", route: "chrome_get_targets", accountIdx })
      );
      const data = parseToolText(result) || {};
      if (result?.isError) return res.status(502).json(data);
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/profiles/:accountIdx/open", async (req, res) => {
    try {
      const accountIdx = Number(req.params.accountIdx);
      const result = await executeTool(
        "chrome_launch_profile",
        { accountIdx, url: req.body?.url, activateIfRunning: true },
        buildRequestContext(req, { transport: "rest-api", route: "chrome_launch_profile", accountIdx })
      );
      const data = parseToolText(result) || {};
      if (result?.isError) return res.status(400).json(data);
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/profiles/:accountIdx/stop", async (req, res) => {
    try {
      const accountIdx = Number(req.params.accountIdx);
      const result = await executeTool(
        "chrome_close_profile",
        { accountIdx },
        buildRequestContext(req, { transport: "rest-api", route: "chrome_close_profile", accountIdx })
      );
      const data = parseToolText(result) || {};
      if (result?.isError) return res.status(400).json(data);
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/profiles/:accountIdx/restart", async (req, res) => {
    try {
      const accountIdx = Number(req.params.accountIdx);
      await executeTool(
        "chrome_close_profile",
        { accountIdx },
        buildRequestContext(req, { transport: "rest-api", route: "chrome_close_profile", accountIdx })
      );
      const result = await executeTool(
        "chrome_launch_profile",
        { accountIdx, url: req.body?.url, activateIfRunning: true },
        buildRequestContext(req, { transport: "rest-api", route: "chrome_launch_profile", accountIdx })
      );
      const data = parseToolText(result) || {};
      if (result?.isError) return res.status(400).json(data);
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/profiles/:accountIdx/proxy", async (req, res) => {
    try {
      const accountIdx = Number(req.params.accountIdx);
      const proxy = req.body?.enabled === false ? "" : String(req.body?.proxy || "");
      const setResult = await executeTool(
        "chrome_set_profile_proxy",
        { accountIdx, proxy },
        buildRequestContext(req, { transport: "rest-api", route: "chrome_set_profile_proxy", accountIdx })
      );
      const data = parseToolText(setResult) || {};
      if (setResult?.isError) return res.status(400).json(data);
      if (req.body?.restart) {
        await executeTool(
          "chrome_close_profile",
          { accountIdx },
          buildRequestContext(req, { transport: "rest-api", route: "chrome_close_profile", accountIdx })
        );
        await executeTool(
          "chrome_launch_profile",
          { accountIdx, activateIfRunning: true },
          buildRequestContext(req, { transport: "rest-api", route: "chrome_launch_profile", accountIdx })
        );
      }
      res.json({ ok: true, ...data, restartApplied: !!req.body?.restart });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createChromeManagementRoutes };
