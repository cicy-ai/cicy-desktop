const { BrowserWindow, clipboard, nativeImage } = require("electron");
const { z } = require("zod");
const { sendCDP } = require("../utils/cdp-utils");
const { createWindow } = require("../utils/window-utils");

const GEMINI_URL = "https://gemini.google.com/app";

async function ensureGeminiWindow(win_id, accountIdx = 0) {
  let win = win_id ? BrowserWindow.fromId(win_id) : null;

  if (!win) {
    if (win_id) {
      throw new Error(`Window ${win_id} not found`);
    }
    win = createWindow({ url: GEMINI_URL }, accountIdx, false);
    await new Promise((r) => setTimeout(r, 3000));
    return win;
  }

  const url = win.webContents.getURL();
  if (!url.includes("gemini.google.com")) {
    await win.loadURL(GEMINI_URL);
    await new Promise((r) => setTimeout(r, 3000));
  }

  return win;
}

function registerTools(registerTool) {
  registerTool(
    "gemini_web_ensure",
    "Ensure gemini window exists and is on gemini.google.com",
    z.object({
      win_id: z.number().optional().describe("窗口 ID，不提供则创建新窗口"),
      accountIdx: z.number().optional().default(0).describe("账户索引"),
    }),
    async ({ win_id, accountIdx }) => {
      try {
        const win = await ensureGeminiWindow(win_id, accountIdx);
        const url = win.webContents.getURL();
        return {
          content: [{ type: "text", text: JSON.stringify({ win_id: win.id, url }, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    },
    { tag: "Gemini" }
  );

  registerTool(
    "is_gemini_logged",
    "Check if gemini is logged in",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        const win = await ensureGeminiWindow(win_id);

        const result = await win.webContents.executeJavaScript(`
          (function() {
            var href = location.href;
            var richTextarea = document.querySelector('rich-textarea');
            var isLogged = !!richTextarea;
            return JSON.stringify({ href: href, isLogged: isLogged });
          })()
        `);

        const data = JSON.parse(result);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    },
    { tag: "Gemini" }
  );

  registerTool(
    "gemini_web_status",
    "Get gemini web page status",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        const win = await ensureGeminiWindow(win_id);

        const result = await win.webContents.executeJavaScript(`
          (function() {
            var href = location.href;
            var title = document.title;
            var richTextarea = document.querySelector('rich-textarea');
            var editor = richTextarea?.querySelector('div.ql-editor');
            var hasPrompt = !!richTextarea;
            var promptText = (editor?.textContent || '').slice(0, 100);
            var sendBtn = document.querySelector('button[aria-label="Send"]');
            var stopBtn = document.querySelector('button[aria-label="Stop"]');
            var isGenerating = !!stopBtn;
            var hasLoginBtn = document.querySelector('[data-testid="sign-in-button"]');
            var isLogged = !hasLoginBtn && hasPrompt;
            var hasImage = !!document.querySelector('uploader-file-preview img') || !!document.querySelector('file-preview-container img');
            var isUploading = !!document.querySelector('uploader-file-preview[aria-label*="加载"], uploader-file-preview[aria-label*="loading"], div[role="progressbar"]');
            return JSON.stringify({ href, title, isLogged, hasPrompt, promptText, hasSendBtn: !!sendBtn, isGenerating, hasImage, isUploading });
          })()
        `);

        const data = JSON.parse(result);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    },
    { tag: "Gemini" }
  );

  registerTool(
    "gemini_web_clear_prompt",
    "Clear the gemini prompt input",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        const win = await ensureGeminiWindow(win_id);

        await win.webContents.executeJavaScript(`
          (function() {
            var richTextarea = document.querySelector('rich-textarea');
            var editor = richTextarea?.querySelector('div.ql-editor');
            if (editor) { 
              editor.innerHTML = '<p><br></p>'; 
              editor.dispatchEvent(new Event('input', { bubbles: true })); 
            }
          })()
        `);

        return { content: [{ type: "text", text: "Prompt cleared" }] };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    },
    { tag: "Gemini" }
  );

  registerTool(
    "gemini_web_set_prompt",
    "Set the gemini prompt input value",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      text: z.string().describe("Text to set in prompt"),
    }),
    async ({ win_id, text }) => {
      try {
        const win = await ensureGeminiWindow(win_id);

        const hasInput = await win.webContents.executeJavaScript(
          `!!document.querySelector('rich-textarea')`
        );
        if (!hasInput) {
          return { content: [{ type: "text", text: "Input area not found" }], isError: true };
        }

        await win.webContents.executeJavaScript(
          `document.querySelector('rich-textarea div.ql-editor').focus()`
        );
        await sendCDP(win.webContents, "Input.insertText", { text });

        return { content: [{ type: "text", text: "Prompt set to: " + text }] };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    },
    { tag: "Gemini" }
  );

  registerTool(
    "gemini_web_click_send",
    "Click send button or press Enter in Gemini",
    z.object({
      win_id: z.number().optional(),
    }),
    async (args) => {
      const win_id = args?.win_id || 1;
      try {
        const win = await ensureGeminiWindow(win_id);
        // Use JS to click send instead of CDP to avoid page reload
        await win.webContents.executeJavaScript(`
          (function() {
            var btn = document.querySelector('button[aria-label="Send"]');
            if (btn) { btn.click(); return 'clicked'; }
            var editor = document.querySelector('rich-textarea div.ql-editor');
            if (editor) { editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 'event'; }
            return 'notfound';
          })()
        `);
        return { content: [{ type: "text", text: "sent" }] };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    },
    { tag: "Gemini" }
  );

  registerTool(
    "gemini_web_image_clipboard_prompt",
    "Paste image from clipboard to gemini input",
    z.object({
      win_id: z.number().optional(),
    }),
    async (args) => {
      const win_id = args?.win_id || 1;
      try {
        console.log("DEBUG: gemini_web_image_clipboard_prompt called");
        const win = await ensureGeminiWindow(win_id);
        await win.webContents.executeJavaScript(`
          (function() {
            var richTextarea = document.querySelector('rich-textarea');
            if (richTextarea) {
              var editor = richTextarea.querySelector('div.ql-editor');
              if (editor) editor.click();
            }
          })()
        `);

        // Use Electron sendInputEvent for paste
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

        // Wait for upload
        var startTime = Date.now();
        var uploadResult = null;

        while (Date.now() - startTime < 15000) {
          await new Promise((r) => setTimeout(r, 500));

          var checkResult = await win.webContents.executeJavaScript(`
            (function() {
              var hasImage = !!document.querySelector('uploader-file-preview img');
              var progressBar = document.querySelector('div[role="progressbar"]');
              if (hasImage) return 'success';
              if (progressBar) return 'uploading';
              return 'waiting';
            })()
          `);

          if (checkResult === "success") {
            uploadResult = { success: true, status: "uploaded" };
            break;
          }
        }

        if (!uploadResult) {
          uploadResult = { success: false, status: "timeout" };
        }

        return { content: [{ type: "text", text: JSON.stringify(uploadResult, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    },
    { tag: "Gemini" }
  );

  registerTool(
    "gemini_web_image_base64_prompt",
    "Ask Gemini with base64 image and prompt",
    z.object({
      win_id: z.number().optional(),
      imageBase64: z.string().describe("Base64 image data"),
      prompt: z.string().describe("Question to ask about the image"),
      waitMs: z.number().optional().default(20000).describe("Wait time for response"),
    }),
    async (args) => {
      const win_id = args?.win_id || 1;
      const { imageBase64, prompt, waitMs } = args;
      try {
        const win = await ensureGeminiWindow(win_id);

        // Write base64 to clipboard as image
        const imgBuffer = Buffer.from(imageBase64, "base64");
        const { nativeImage } = require("electron");
        const img = nativeImage.createFromBuffer(imgBuffer);
        require("electron").clipboard.writeImage(img);

        // Click input and paste
        await win.webContents.executeJavaScript(`
          (function() {
            var richTextarea = document.querySelector('rich-textarea');
            if (richTextarea) {
              var editor = richTextarea.querySelector('div.ql-editor');
              if (editor) editor.click();
            }
          })()
        `);

        // Paste image
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "V", modifiers: ["control"] });
        win.webContents.sendInputEvent({ type: "char", keyCode: "V", modifiers: ["control"] });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "V", modifiers: ["control"] });

        // Wait for upload
        var startTime = Date.now();
        while (Date.now() - startTime < 15000) {
          await new Promise((r) => setTimeout(r, 500));
          var hasImage = await win.webContents.executeJavaScript(`
            (function() { return !!document.querySelector('uploader-file-preview img'); })()
          `);
          if (hasImage) break;
        }

        // Set prompt text
        await win.webContents.executeJavaScript(
          `document.querySelector('rich-textarea div.ql-editor').focus()`
        );
        await sendCDP(win.webContents, "Input.insertText", { text: prompt });
        await new Promise((r) => setTimeout(r, 500));

        // Send
        await win.webContents.executeJavaScript(`
          (function() {
            var btn = document.querySelector('button[aria-label="Send"]');
            if (btn) btn.click();
          })()
        `);

        // Wait for response
        while (Date.now() - startTime < waitMs) {
          await new Promise((r) => setTimeout(r, 1000));
          var checkResult = await win.webContents.executeJavaScript(`
            (function() {
              var stopBtn = document.querySelector('button[aria-label="Stop"]');
              if (stopBtn) return 'generating';
              var lastResponse = document.querySelector('model-response message-content .markdown');
              if (lastResponse) {
                var text = lastResponse.textContent?.trim();
                if (text && text.length > 0) return 'ok';
              }
              return 'waiting';
            })()
          `);

          if (checkResult === "ok") {
            var reply = await win.webContents.executeJavaScript(`
              (function() {
                var lastResponse = document.querySelector('model-response message-content .markdown');
                return lastResponse ? lastResponse.textContent?.trim() : '';
              })()
            `);
            var duration = Date.now() - startTime;
            return {
              content: [
                { type: "text", text: JSON.stringify({ reply, duration_ms: duration }, null, 2) },
              ],
            };
          }
        }

        return { content: [{ type: "text", text: "timeout" }] };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    },
    { tag: "Gemini" }
  );
}

module.exports = registerTools;
