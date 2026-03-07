const { callRPC, sleep } = require("./rpc-utils");

describe("RPC Window Tools", () => {
  jest.setTimeout(30000);
  let winId;

  test("should open window", async () => {
    const result = await callRPC("open_window", { url: "https://google.com" });
    expect(result.content[0].text).toContain("Opened window");
    winId = parseInt(result.content[0].text.match(/\d+/)[0]);
    expect(winId).toBeGreaterThan(0);
    await sleep(2000);
  });

  test("should get windows", async () => {
    const result = await callRPC("get_windows");
    expect(result.content[0].text).toContain(winId.toString());
  });

  test("should get title", async () => {
    const result = await callRPC("get_title", { win_id: winId });
    expect(result.content[0].text).toBeTruthy();
  });

  test("should load url", async () => {
    const result = await callRPC("load_url", { win_id: winId, url: "https://www.google.com" });
    expect(result.content[0].text).toContain("Loaded");
    await sleep(2000);
  });

  test("should screenshot and copy to clipboard", async () => {
    const result = await callRPC("webpage_screenshot_to_clipboard", { win_id: winId });
    expect(result.content).toBeDefined();
    const hasImage = result.content.some((item) => item.type === "image");
    expect(hasImage).toBe(true);
    const imageContent = result.content.find((item) => item.type === "image");
    expect(imageContent.data).toBeDefined();
    expect(imageContent.mimeType).toBe("image/png");
  });

  test("should capture webpage snapshot", async () => {
    const result = await callRPC("webpage_snapshot", { win_id: winId });
    expect(result.content[0].text).toContain("Page Snapshot");
    expect(result.content[0].text).toContain("url:");
    expect(result.content[0].text).toContain("Interactive Elements");
  });

  test.skip("should close window", async () => {
    const result = await callRPC("close_window", { win_id: winId });
    expect(result.content[0].text).toContain("Closed");
  });
});
