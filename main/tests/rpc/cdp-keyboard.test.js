const { callRPC, sleep } = require("./rpc-utils");

describe("RPC CDP Keyboard", () => {
  jest.setTimeout(30000);
  let winId;

  beforeAll(async () => {
    const result = await callRPC("open_window", { url: "https://google.com" });
    winId = parseInt(result.content[0].text.match(/\d+/)[0]);
    await sleep(2000);
  });

  test("should press key", async () => {
    const result = await callRPC("cdp_press_key", { win_id: winId, key: "a" });
    expect(result.content[0].text).toContain("Pressed key");
  });

  test("should press enter", async () => {
    const result = await callRPC("cdp_press_enter", { win_id: winId });
    expect(result.content[0].text).toContain("Enter");
  });

  test("should press backspace", async () => {
    const result = await callRPC("cdp_press_backspace", { win_id: winId });
    expect(result.content[0].text).toContain("Backspace");
  });

  test("should type text", async () => {
    const result = await callRPC("cdp_type_text", { win_id: winId, text: "test" });
    expect(result.content[0].text).toContain("Typed");
  });
});
