const { callRPC, sleep } = require("./rpc-utils");

describe("RPC Show Float Div", () => {
  jest.setTimeout(30000);
  let winId;

  beforeAll(async () => {
    const result = await callRPC("open_window", { url: "https://google.com" });
    winId = parseInt(result.content[0].text.match(/\d+/)[0]);
    await sleep(2000);
  });

  test("should show float div", async () => {
    const result = await callRPC("show_float_div", { win_id: winId });
    expect(result.content[0].text).toBeTruthy();
  });

  test("should show float div with custom content", async () => {
    const result = await callRPC("show_float_div", {
      win_id: winId,
      content: "Custom message",
    });
    expect(result.content[0].text).toBeTruthy();
  });
});
