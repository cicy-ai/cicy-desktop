const { createTarget } = require("../src/chrome/chrome-cdp-client");

describe("chrome cdp client", () => {
  test("createTarget uses the json/new endpoint with PUT", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "target-1" }),
    });

    const originalFetch = global.fetch;
    global.fetch = fetchMock;

    try {
      const result = await createTarget(11000, "http://localhost:8101/console/chrome?token=abc");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:11000/json/new?http%3A%2F%2Flocalhost%3A8101%2Fconsole%2Fchrome%3Ftoken%3Dabc",
        { method: "PUT" }
      );
      expect(result).toEqual({ id: "target-1" });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
