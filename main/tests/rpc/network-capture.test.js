const { callRPC, sleep } = require("./rpc-utils");

describe("RPC Network Capture", () => {
  jest.setTimeout(30000);
  let winId;

  beforeAll(async () => {
    const result = await callRPC("open_window", { url: "https://google.com" });
    winId = parseInt(result.content[0].text.match(/\d+/)[0]);
    await sleep(3000);
  });

  test("should get requests", async () => {
    const result = await callRPC("get_requests", { win_id: winId });
    expect(result.content[0].text).toBeTruthy();
  });

  test("should filter requests", async () => {
    const result = await callRPC("filter_requests", {
      win_id: winId,
      pattern: "google",
    });
    expect(result.content[0].text).toBeTruthy();
  });

  test("should get console logs", async () => {
    const result = await callRPC("get_console_logs", { win_id: winId });
    expect(result.content[0].text).toBeTruthy();
  });
});
