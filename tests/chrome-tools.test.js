const registerChromeTools = require("../src/tools/chrome-tools");

const { ensurePageTargets } = registerChromeTools.__testables;

describe("chrome tools", () => {
  test("ensurePageTargets creates and activates about:blank when no page targets exist", async () => {
    const getTargets = jest
      .fn()
      .mockResolvedValueOnce([{ id: "worker-1", type: "service_worker", url: "chrome-extension://abc/sw.js" }])
      .mockResolvedValueOnce([{ id: "page-1", type: "page", url: "about:blank", title: "New Tab" }]);
    const createTarget = jest.fn().mockResolvedValue({ id: "page-1" });
    const activateTarget = jest.fn().mockResolvedValue("Target activated");

    const result = await ensurePageTargets({
      debuggerPort: 11001,
      activateIfRunning: true,
      deps: { getTargets, createTarget, activateTarget },
    });

    expect(createTarget).toHaveBeenCalledWith(11001, "about:blank");
    expect(activateTarget).toHaveBeenCalledWith(11001, "page-1");
    expect(result).toEqual({
      activatedTargetId: "page-1",
      targets: [{ id: "page-1", type: "page", url: "about:blank", title: "New Tab" }],
    });
  });

  test("ensurePageTargets creates and activates requested url when no matching page target exists", async () => {
    const getTargets = jest
      .fn()
      .mockResolvedValueOnce([{ id: "page-0", type: "page", url: "https://example.com", title: "Example" }])
      .mockResolvedValueOnce([
        { id: "page-0", type: "page", url: "https://example.com", title: "Example" },
        { id: "page-2", type: "page", url: "https://cicy.ai", title: "CiCy" },
      ]);
    const createTarget = jest.fn().mockResolvedValue({ id: "page-2" });
    const activateTarget = jest.fn().mockResolvedValue("Target activated");

    const result = await ensurePageTargets({
      debuggerPort: 11002,
      url: "https://cicy.ai",
      activateIfRunning: true,
      deps: { getTargets, createTarget, activateTarget },
    });

    expect(createTarget).toHaveBeenCalledWith(11002, "https://cicy.ai");
    expect(activateTarget).toHaveBeenCalledWith(11002, "page-2");
    expect(result.activatedTargetId).toBe("page-2");
    expect(result.targets).toHaveLength(2);
  });
});
