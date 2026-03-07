const { callRPC, sleep } = require("./rpc-utils");

describe("RPC Set Window Bounds", () => {
  jest.setTimeout(30000);
  let winId;

  beforeAll(async () => {
    const result = await callRPC("open_window", { url: "https://google.com" });
    winId = parseInt(result.content[0].text.match(/\d+/)[0]);
    await sleep(1000);
  });

  test("should set position", async () => {
    const result = await callRPC("set_window_bounds", { win_id: winId, x: 100, y: 100 });
    expect(result.content[0].text).toContain("窗口");
  });

  test("should set size", async () => {
    const result = await callRPC("set_window_bounds", { win_id: winId, width: 800, height: 600 });
    expect(result.content[0].text).toContain("窗口");
  });

  test("should set position and size", async () => {
    const result = await callRPC("set_window_bounds", {
      win_id: winId,
      x: 200,
      y: 200,
      width: 1024,
      height: 768,
    });
    expect(result.content[0].text).toContain("窗口");
  });
});
