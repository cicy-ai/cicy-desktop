const { clipboard, BrowserWindow } = require("electron");
const { z } = require("zod");
const { sendCDP } = require("../utils/cdp-utils");

function registerTools(registerTool) {
  registerTool(
    "clipboard_write_text",
    "Write text to system clipboard",
    z.object({
      text: z.string().describe("Text to write to clipboard"),
    }),
    async ({ text }) => {
      try {
        clipboard.writeText(text);
        return {
          content: [
            {
              type: "text",
              text: `Text written to clipboard: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
    { tag: "Clipboard" }
  );

  registerTool(
    "clipboard_read_text",
    "Read text from system clipboard",
    z.object({}),
    async () => {
      try {
        const text = clipboard.readText();
        return {
          content: [{ type: "text", text: `Clipboard text: ${text}` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
    { tag: "Clipboard" }
  );

  registerTool(
    "clipboard_write_image",
    "Write image to system clipboard from base64 data",
    z.object({
      base64: z.string().describe("Base64 encoded image data"),
    }),
    async ({ base64 }) => {
      try {
        const { nativeImage } = require("electron");
        const image = nativeImage.createFromDataURL(`data:image/png;base64,${base64}`);
        clipboard.writeImage(image);
        const size = image.getSize();
        return {
          content: [
            { type: "text", text: `Image written to clipboard: ${size.width}x${size.height}` },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
    { tag: "Clipboard" }
  );
  registerTool(
    "test_paste_methods",
    "测试三种粘贴方法，返回哪些方法有效",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        // Inject test listener
        await win.webContents.executeJavaScript(`
          window.__pasteTestResults = {
            sendInputEvent: false,
            cdp: false,
            js: false,
            count: 0
          };
          
          const listener = (e) => {
            window.__pasteTestResults.count++;
            const text = e.clipboardData?.getData('text/plain') || '';
            if (text.includes('TEST_SENDINPUT')) {
              window.__pasteTestResults.sendInputEvent = true;
            } else if (text.includes('TEST_CDP')) {
              window.__pasteTestResults.cdp = true;
            } else if (text.includes('TEST_JS')) {
              window.__pasteTestResults.js = true;
            }
          };
          
          document.removeEventListener('paste', listener);
          document.addEventListener('paste', listener);
          'Listener installed';
        `);

        const results = [];

        // Test 1: sendInputEvent
        clipboard.writeText("TEST_SENDINPUT");
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "V", modifiers: ["control"] });
        win.webContents.sendInputEvent({ type: "char", keyCode: "V", modifiers: ["control"] });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "V", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Test 2: CDP
        clipboard.writeText("TEST_CDP");
        await sendCDP(win.webContents, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "v",
          modifiers: 2,
        });
        await sendCDP(win.webContents, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "v",
          modifiers: 2,
        });
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Test 3: JS
        clipboard.writeText("TEST_JS");
        await win.webContents.executeJavaScript(`
          const text = 'TEST_JS';
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          const event = new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true
          });
          document.dispatchEvent(event);
        `);
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Get results
        const testResults = await win.webContents.executeJavaScript("window.__pasteTestResults");

        const report = [
          `Paste events detected: ${testResults.count}`,
          `✅ sendInputEvent: ${testResults.sendInputEvent ? "WORKS" : "FAILED"}`,
          `${testResults.cdp ? "✅" : "❌"} CDP: ${testResults.cdp ? "WORKS" : "FAILED"}`,
          `✅ JavaScript: ${testResults.js ? "WORKS" : "FAILED"}`,
          "",
          "Recommended method: " +
            (testResults.sendInputEvent
              ? "sendInputEvent"
              : testResults.js
                ? "js"
                : "none working"),
        ].join("\n");

        return { content: [{ type: "text", text: report }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Test" }
  );
}

module.exports = registerTools;
