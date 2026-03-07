const { BrowserWindow } = require("electron");
const { z } = require("zod");
const { captureSnapshot } = require("../snapshot-utils");

function registerTools(registerTool) {
  registerTool(
    "webpage_screenshot_to_clipboard",
    "截图并复制到剪贴板",
    z.object({ win_id: z.number().optional().describe("窗口 ID") }),
    async ({ win_id }) => {
      try {
        const actualWinId = win_id || 1;
        const win = BrowserWindow.fromId(actualWinId);
        if (!win) throw new Error(`Window ${actualWinId} not found`);

        const result = await captureSnapshot(win.webContents, { win_id: actualWinId });
        return result;
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}

module.exports = registerTools;
