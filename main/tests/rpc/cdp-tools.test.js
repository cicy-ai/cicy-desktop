const { callRPC, sleep } = require("./rpc-utils");

describe("RPC CDP Tools", () => {
  jest.setTimeout(30000);
  let winId;

  beforeAll(async () => {
    const result = await callRPC("open_window", { url: "https://google.com" });
    winId = parseInt(result.content[0].text.match(/\d+/)[0]);
    await sleep(2000);
  });

  test("should click", async () => {
    const result = await callRPC("cdp_click", { win_id: winId, x: 100, y: 100 });
    expect(result.content[0].text).toContain("Clicked at (100, 100)");
  });

  test("should double click", async () => {
    const result = await callRPC("cdp_dblclick", { win_id: winId, x: 150, y: 150 });
    expect(result.content[0].text).toContain("Double clicked at (150, 150)");
  });

  test("should press key", async () => {
    const result = await callRPC("cdp_press_key", { win_id: winId, key: "a" });
    expect(result.content[0].text).toContain("Pressed key: a");
  });

  test("should press enter", async () => {
    const result = await callRPC("cdp_press_enter", { win_id: winId });
    expect(result.content[0].text).toContain("Pressed Enter");
  });

  test("should press backspace", async () => {
    const result = await callRPC("cdp_press_backspace", { win_id: winId });
    expect(result.content[0].text).toContain("Pressed Backspace");
  });

  test("should copy", async () => {
    const result = await callRPC("cdp_press_copy", { win_id: winId });
    expect(result.content[0].text).toContain("Ctrl+C");
  });

  test("should paste", async () => {
    const result = await callRPC("cdp_press_paste", { win_id: winId });
    expect(result.content[0].text).toBeTruthy();
  });

  test("should select all", async () => {
    const result = await callRPC("cdp_press_selectall", { win_id: winId });
    expect(result.content[0].text).toContain("Ctrl+A");
  });

  test("should cut", async () => {
    const result = await callRPC("cdp_press_cut", { win_id: winId });
    expect(result.content[0].text).toContain("Ctrl+X");
  });

  test("should type text", async () => {
    const result = await callRPC("cdp_type_text", { win_id: winId, text: "Hello World" });
    expect(result.content[0].text).toContain("Typed: Hello World");
  });

  test("should scroll", async () => {
    const result = await callRPC("cdp_scroll", { win_id: winId, y: 100 });
    expect(result.content[0].text).toContain("Scrolled");
  });

  test("should send CDP command", async () => {
    const result = await callRPC("cdp_sendcmd", {
      win_id: winId,
      method: "Runtime.evaluate",
      params: { expression: "1 + 1" },
    });
    expect(result.content[0].text).toBeTruthy();
  });
});
