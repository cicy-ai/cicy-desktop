const { BrowserWindow, clipboard } = require("electron");
const { z } = require("zod");
const { sendCDP } = require("../utils/cdp-utils");

function registerTools(registerTool) {
  registerTool(
    "cdp_click",
    "使用 Chrome DevTools Protocol 点击页面指定坐标",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      x: z.number().describe("X 坐标"),
      y: z.number().describe("Y 坐标"),
      button: z.enum(["left", "right", "middle"]).optional().default("left").describe("鼠标按钮"),
    }),
    async ({ win_id, x, y, button }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        await sendCDP(win.webContents, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button,
          clickCount: 1,
        });

        await sendCDP(win.webContents, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button,
          clickCount: 1,
        });

        return { content: [{ type: "text", text: `Clicked at (${x}, ${y})` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Input" }
  );

  registerTool(
    "cdp_dblclick",
    "使用 Chrome DevTools Protocol 双击页面指定坐标",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      x: z.number().describe("X 坐标"),
      y: z.number().describe("Y 坐标"),
      button: z.enum(["left", "right", "middle"]).optional().default("left").describe("鼠标按钮"),
    }),
    async ({ win_id, x, y, button }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        await sendCDP(win.webContents, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button,
          clickCount: 2,
        });

        await sendCDP(win.webContents, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button,
          clickCount: 2,
        });

        return { content: [{ type: "text", text: `Double clicked at (${x}, ${y})` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Input" }
  );

  registerTool(
    "cdp_press_key",
    "使用 CDP 按下指定按键",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      key: z.string().describe("按键名称，如 'Enter', 'Backspace', 'a', 'A'"),
    }),
    async ({ win_id, key }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        await sendCDP(win.webContents, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
        });

        await sendCDP(win.webContents, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
        });

        return { content: [{ type: "text", text: `Pressed key: ${key}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Input" }
  );

  registerTool(
    "cdp_press_enter",
    "使用 CDP 按下回车键",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        await sendCDP(win.webContents, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
        });

        await sendCDP(win.webContents, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
        });

        return { content: [{ type: "text", text: "Pressed Enter" }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Input" }
  );

  registerTool(
    "cdp_press_backspace",
    "使用 CDP 按下退格键",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        await sendCDP(win.webContents, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Backspace",
        });

        await sendCDP(win.webContents, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Backspace",
        });

        return { content: [{ type: "text", text: "Pressed Backspace" }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Input" }
  );

  registerTool(
    "cdp_press_copy",
    "使用 CDP 执行复制操作 (Ctrl+C)",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        await sendCDP(win.webContents, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "c",
          modifiers: 2,
        });

        await sendCDP(win.webContents, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "c",
          modifiers: 2,
        });

        return { content: [{ type: "text", text: "Pressed Ctrl+C" }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Input" }
  );

  registerTool(
    "cdp_press_paste",
    "执行粘贴操作，支持多种方法",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      method: z
        .enum(["sendInputEvent", "cdp", "js"])
        .optional()
        .default("sendInputEvent")
        .describe("粘贴方法: sendInputEvent(推荐), cdp(CDP按键), js(JavaScript事件)"),
    }),
    async ({ win_id, method }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        if (method === "sendInputEvent") {
          // Method 1: Electron sendInputEvent (推荐 - 触发真实事件)
          win.webContents.sendInputEvent({
            type: "keyDown",
            keyCode: "V",
            modifiers: ["control"],
          });
          win.webContents.sendInputEvent({
            type: "char",
            keyCode: "V",
            modifiers: ["control"],
          });
          win.webContents.sendInputEvent({
            type: "keyUp",
            keyCode: "V",
            modifiers: ["control"],
          });
          return { content: [{ type: "text", text: "Paste via sendInputEvent" }] };
        } else if (method === "cdp") {
          // Method 2: CDP dispatchKeyEvent (底层 - 不触发paste事件)
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
          return {
            content: [{ type: "text", text: "Paste via CDP (may not trigger paste event)" }],
          };
        } else if (method === "js") {
          // Method 3: JavaScript ClipboardEvent (完全控制)
          const text = clipboard.readText();
          const image = clipboard.readImage();

          if (!image.isEmpty()) {
            // Paste image
            const buffer = image.toPNG();
            const base64 = buffer.toString("base64");
            await win.webContents.executeJavaScript(`
              (async function() {
                const base64 = ${JSON.stringify(base64)};
                const blob = await fetch('data:image/png;base64,' + base64).then(r => r.blob());
                const file = new File([blob], 'image.png', { type: 'image/png' });
                
                const dt = new DataTransfer();
                dt.items.add(file);
                
                const event = new ClipboardEvent('paste', {
                  clipboardData: dt,
                  bubbles: true,
                  cancelable: true
                });
                
                document.activeElement?.dispatchEvent(event) || document.dispatchEvent(event);
                return 'Image pasted';
              })();
            `);
            return { content: [{ type: "text", text: "Paste image via JS event" }] };
          } else {
            // Paste text
            await win.webContents.executeJavaScript(`
              (function() {
                const text = ${JSON.stringify(text)};
                const dt = new DataTransfer();
                dt.setData('text/plain', text);
                
                const event = new ClipboardEvent('paste', {
                  clipboardData: dt,
                  bubbles: true,
                  cancelable: true
                });
                
                document.activeElement?.dispatchEvent(event) || document.dispatchEvent(event);
                return 'Text pasted';
              })();
            `);
            return { content: [{ type: "text", text: "Paste text via JS event" }] };
          }
        }
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Input" }
  );

  registerTool(
    "cdp_press_selectall",
    "使用 CDP 执行全选操作 (Ctrl+A)",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        await sendCDP(win.webContents, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "a",
          modifiers: 2,
        });

        await sendCDP(win.webContents, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "a",
          modifiers: 2,
        });

        return { content: [{ type: "text", text: "Pressed Ctrl+A" }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Input" }
  );

  registerTool(
    "cdp_press_cut",
    "使用 CDP 执行剪切操作 (Ctrl+X)",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        await sendCDP(win.webContents, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "x",
          modifiers: 2,
        });

        await sendCDP(win.webContents, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "x",
          modifiers: 2,
        });

        return { content: [{ type: "text", text: "Pressed Ctrl+X" }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Input" }
  );

  registerTool(
    "cdp_type_text",
    "使用 CDP 输入文本",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      text: z.string().describe("要输入的文本"),
    }),
    async ({ win_id, text }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        await sendCDP(win.webContents, "Input.insertText", { text });

        return { content: [{ type: "text", text: `Typed: ${text}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Input" }
  );

  registerTool(
    "cdp_scroll",
    "使用 CDP 滚动页面",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      x: z.number().optional().default(0).describe("水平滚动距离"),
      y: z.number().describe("垂直滚动距离"),
    }),
    async ({ win_id, x, y }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        await sendCDP(win.webContents, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 0,
          y: 0,
          deltaX: x,
          deltaY: y,
        });

        return { content: [{ type: "text", text: `Scrolled: x=${x}, y=${y}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Input" }
  );

  registerTool(
    "cdp_sendcmd",
    "使用 CDP 发送任意 Chrome DevTools Protocol 命令",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      method: z.string().describe("CDP 方法名，如 'Page.navigate', 'Runtime.evaluate'"),
      params: z.record(z.any()).optional().default({}).describe("CDP 参数对象"),
    }),
    async ({ win_id, method, params }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        const result = await sendCDP(win.webContents, method, params);

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "CDP" }
  );
}

module.exports = registerTools;
