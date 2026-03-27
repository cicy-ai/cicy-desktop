const express = require("express");
const request = require("supertest");

jest.mock("../../src/chrome/chrome-cdp-client", () => ({
  getVersion: jest.fn(),
  getTargets: jest.fn(),
  activateTarget: jest.fn(),
  callCdp: jest.fn(),
}));

const cdpClient = require("../../src/chrome/chrome-cdp-client");
const { createChromeProxyRoutes } = require("../../src/server/chrome-proxy-routes");

describe("worker chrome proxy routes", () => {
  function createApp({ chromeConfig, registryValues } = {}) {
    const app = express();
    app.use(express.json());

    const runtimes = new Map(
      Object.entries(registryValues || {}).map(([accountIdx, runtime]) => [Number(accountIdx), runtime])
    );
    const registry = {
      get(accountIdx) {
        return runtimes.get(accountIdx) || null;
      },
    };

    app.use("/chrome", createChromeProxyRoutes({ chromeConfig, registry }));
    return app;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("GET /chrome/:accountIdx/json/version uses chrome.json port first", async () => {
    cdpClient.getVersion.mockResolvedValue({ Browser: "Chrome/123", webSocketDebuggerUrl: "ws://127.0.0.1:11001" });
    const app = createApp({
      chromeConfig: { account_1: { port: 11001 } },
      registryValues: { 1: { debuggerPort: 22001 } },
    });

    const response = await request(app).get("/chrome/1/json/version");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ Browser: "Chrome/123", webSocketDebuggerUrl: "ws://127.0.0.1:11001" });
    expect(cdpClient.getVersion).toHaveBeenCalledWith(11001);
  });

  test("GET /chrome/:accountIdx/json/list falls back to runtime registry port", async () => {
    cdpClient.getTargets.mockResolvedValue([{ id: "target-1", type: "page" }]);
    const app = createApp({
      chromeConfig: {},
      registryValues: { 2: { debuggerPort: 11002 } },
    });

    const response = await request(app).get("/chrome/2/json/list");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: "target-1", type: "page" }]);
    expect(cdpClient.getTargets).toHaveBeenCalledWith(11002);
  });

  test("POST /chrome/:accountIdx/json/activate/:targetId returns activation result", async () => {
    cdpClient.activateTarget.mockResolvedValue("Target activated");
    const app = createApp({ chromeConfig: { account_3: { port: 11003 } } });

    const response = await request(app).post("/chrome/3/json/activate/abc123");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, text: "Target activated" });
    expect(cdpClient.activateTarget).toHaveBeenCalledWith(11003, "abc123");
  });

  test("POST /chrome/:accountIdx/cdp/call returns CDP result", async () => {
    cdpClient.callCdp.mockResolvedValue({ product: "Chrome/123" });
    const app = createApp({ chromeConfig: { account_4: { port: 11004 } } });

    const response = await request(app)
      .post("/chrome/4/cdp/call")
      .send({ method: "Browser.getVersion", params: {}, target: "page-1" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: { product: "Chrome/123" } });
    expect(cdpClient.callCdp).toHaveBeenCalledWith({
      debuggerPort: 11004,
      method: "Browser.getVersion",
      params: {},
      target: "page-1",
    });
  });

  test("returns 400 for non-numeric accountIdx", async () => {
    const app = createApp({ chromeConfig: {} });

    const response = await request(app).get("/chrome/not-a-number/json/version");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "accountIdx must be an integer" });
  });

  test("returns 404 when no debugger port is available", async () => {
    const app = createApp({ chromeConfig: {}, registryValues: {} });

    const response = await request(app).get("/chrome/9/json/version");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Missing debuggerPort for accountIdx=9" });
  });

  test("returns 400 when cdp call method is missing", async () => {
    const app = createApp({ chromeConfig: { account_5: { port: 11005 } } });

    const response = await request(app).post("/chrome/5/cdp/call").send({ params: {} });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Missing method" });
  });

  test("returns 502 when debugger port is unreachable", async () => {
    cdpClient.getTargets.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:11006"));
    const app = createApp({ chromeConfig: { account_6: { port: 11006 } } });

    const response = await request(app).get("/chrome/6/json/list");

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: "connect ECONNREFUSED 127.0.0.1:11006",
      debuggerPort: 11006,
    });
  });
});
