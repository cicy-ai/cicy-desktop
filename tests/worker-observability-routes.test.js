const { toPublicSnapshot } = require("../src/server/worker-observability-routes");

describe("worker observability routes", () => {
  test("public snapshot omits authToken", () => {
    const publicSnapshot = toPublicSnapshot({
      authToken: "super-secret-token",
      agents: [],
      artifacts: [],
      capabilities: ["ping"],
      chromeProfiles: [],
      resources: {
        memory: { rss: 42 },
        uptime: 10,
      },
    });

    expect(publicSnapshot.authToken).toBeUndefined();
    expect(publicSnapshot.capabilities).toEqual(["ping"]);
  });
});
