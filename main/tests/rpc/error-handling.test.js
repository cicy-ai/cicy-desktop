const { callRPC, sleep } = require("./rpc-utils");

describe("RPC Error Handling", () => {
  jest.setTimeout(30000);

  test("should handle invalid window ID", async () => {
    try {
      await callRPC("get_title", { win_id: 99999 });
      fail("Should throw error");
    } catch (error) {
      expect(error.message).toBeTruthy();
    }
  });

  test("should handle invalid tool name", async () => {
    try {
      await callRPC("invalid_tool_name", {});
      fail("Should throw error");
    } catch (error) {
      expect(error.message).toBeTruthy();
    }
  });

  test("should handle missing required arguments", async () => {
    try {
      await callRPC("load_url", { win_id: 1 });
      fail("Should throw error");
    } catch (error) {
      expect(error.message).toBeTruthy();
    }
  });
});
