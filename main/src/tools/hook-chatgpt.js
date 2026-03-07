const { BrowserWindow } = require("electron");
const { z } = require("zod");
const { sendCDP } = require("../utils/cdp-utils");

function registerTools(registerTool) {
  registerTool(
    "get_chatgpt_web_conversations",
    "List chatgpt conversations from indexedDB, returns id, title, updateTime, total",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      limit: z.number().optional().default(10).describe("return limit"),
      strip: z.number().optional().default(0).describe("return strip"),
    }),
    async ({ win_id, limit, strip }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        const result = await win.webContents.executeJavaScript(`(async () => {
          const href = location.href;
          const urlMatch = href.match(/\\/c\\/([a-f0-9-]+)/);
          const currentId = urlMatch ? urlMatch[1] : null;
          const rows = await window._g.getIndexedDBRows("ConversationsDatabase", "conversations");
          rows.sort((a, b) => b.updateTime - a.updateTime);
          const sliced = rows.slice(${strip}, ${strip} + ${limit});
          return JSON.stringify({ total: rows.length, conversations: sliced.map(c => ({
            id: c.id,
            title: c.title,
            updateTime: c.updateTime,
            updateDate: new Date(c.updateTime * 1000).toISOString(),
            isCurrent: c.id === currentId
          })) });
        })()`);

        const data = JSON.parse(result);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "ChatGPT" }
  );

  registerTool(
    "get_chatgpt_web_current_messages",
    "Get messages from the most recent chatgpt conversation in indexedDB",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        const result = await win.webContents.executeJavaScript(`(async () => {
          const href = location.href;
          const rows = await window._g.getIndexedDBRows("ConversationsDatabase", "conversations");
          const urlMatch = href.match(/\\/c\\/([a-f0-9-]+)/);
          let c;
          if (urlMatch) {
            c = rows.find(r => r.id === urlMatch[1]);
          }
          if (!c) {
            rows.sort((a, b) => b.updateTime - a.updateTime);
            c = rows[0];
          }
          if (!c) return JSON.stringify({ error: "No conversations found", href, isInConversationPage: !!urlMatch });
          return JSON.stringify({
            href,
            isInConversationPage: !!urlMatch,
            id: c.id,
            title: c.title,
            updateTime: c.updateTime,
            updateDate: new Date(c.updateTime * 1000).toISOString(),
            messages: (c.messages || []).slice().reverse()
          });
        })()`);

        const data = JSON.parse(result);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "ChatGPT" }
  );
  registerTool(
    "get_chatgpt_web_messages_by_id",
    "Get messages from a specific chatgpt conversation by id",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      conversation_id: z.string().describe("Conversation ID"),
    }),
    async ({ win_id, conversation_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        const result = await win.webContents.executeJavaScript(`(async () => {
          if (!window._g) {
            window._g = {};
            window._g.getIndexedDBRows = function(dbName, storeName, limit) {
              limit = limit || 100;
              return new Promise(function(resolve, reject) {
                var req = indexedDB.open(dbName);
                req.onsuccess = function() {
                  var db = req.result;
                  var tx = db.transaction(storeName, 'readonly');
                  var store = tx.objectStore(storeName);
                  var results = [];
                  var cursorReq = store.openCursor();
                  cursorReq.onsuccess = function(e) {
                    var cursor = e.target.result;
                    if (cursor && results.length < limit) {
                      results.push(cursor.value);
                      cursor.continue();
                    } else { resolve(results); }
                  };
                };
                req.onerror = function() { reject(req.error); };
              });
            };
          }
          const rows = await window._g.getIndexedDBRows("ConversationsDatabase", "conversations");
          const c = rows.find(r => r.id === "${conversation_id}");
          if (!c) return JSON.stringify({ error: "Conversation not found" });
          return JSON.stringify({
            id: c.id,
            title: c.title,
            updateTime: c.updateTime,
            updateDate: new Date(c.updateTime * 1000).toISOString(),
            messages: (c.messages || []).slice().reverse()
          });
        })()`);

        const data = JSON.parse(result);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "ChatGPT" }
  );

  registerTool(
    "open_chatgpt_web_chat_by_id",
    "Navigate to a specific chatgpt conversation by id",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      conversation_id: z.string().describe("Conversation ID"),
    }),
    async ({ win_id, conversation_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        const url = `https://chatgpt.com/c/${conversation_id}`;
        await win.webContents.executeJavaScript(`location.href = "${url}"`);
        return {
          content: [{ type: "text", text: `Navigated to ${url}` }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "ChatGPT" }
  );

  registerTool(
    "is_chatgpt_logged",
    "Check if chatgpt is logged in by inspecting cookies and page state",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        const result = await win.webContents.executeJavaScript(`(async () => {
          const href = location.href;
          const hasLoginBtn = !!document.querySelector('[data-testid="login-button"]');
          const hasPromptTextarea = !!document.querySelector('textarea[name="prompt-textarea"]');
          const isLogged = !hasLoginBtn && hasPromptTextarea;
          return JSON.stringify({ href, isLogged });
        })()`);

        const data = JSON.parse(result);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "ChatGPT" }
  );

  registerTool(
    "chatgpt_web_status",
    "Get chatgpt web page status: login state, current URL, conversation info, prompt textarea state",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        const result = await win.webContents.executeJavaScript(`(async () => {
          const href = location.href;
          const hasLoginBtn = !!document.querySelector('[data-testid="login-button"]');
          const hasPromptTextarea = !!document.querySelector('textarea[name="prompt-textarea"]');
          const isLogged = !hasLoginBtn && hasPromptTextarea;
          const urlMatch = href.match(/\\/c\\/([a-f0-9-]+)/);
          const isInConversationPage = !!urlMatch;
          const conversationId = urlMatch ? urlMatch[1] : null;
          const title = document.title;
          const promptValue = hasPromptTextarea ? (document.querySelector('#prompt-textarea')?.innerText || document.querySelector('textarea[name="prompt-textarea"]').value) : null;
          const sendBtn = document.querySelector('button[data-testid="send-button"]');
          const voiceBtn = document.querySelector('button[aria-label="Start Voice"]');
          const hasSendPromptBtn = !!sendBtn;
          const isOnVoiceMode = !!voiceBtn && !hasSendPromptBtn;
          const promptSendBtnCanBeSend = hasSendPromptBtn && !sendBtn.disabled;
          return JSON.stringify({
            href,
            title,
            isLogged,
            hasLoginBtn,
            hasPromptTextarea,
            isInConversationPage,
            conversationId,
            promptValue,
            hasSendPromptBtn,
            isOnVoiceMode,
            promptSendBtnCanBeSend
          });
        })()`);

        const data = JSON.parse(result);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "ChatGPT" }
  );

  registerTool(
    "chatgpt_web_clear_prompt",
    "Clear the chatgpt prompt input",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        await win.webContents.executeJavaScript(`(async () => {
          const div = document.querySelector('#prompt-textarea');
          if (div) { div.innerHTML = '<p><br></p>'; div.dispatchEvent(new Event('input', { bubbles: true })); }
          const textarea = document.querySelector('textarea[name="prompt-textarea"]');
          if (textarea) { textarea.value = ''; textarea.dispatchEvent(new Event('input', { bubbles: true })); }
        })()`);

        return {
          content: [{ type: "text", text: "Prompt cleared" }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "ChatGPT" }
  );

  registerTool(
    "chatgpt_web_set_prompt",
    "Set the chatgpt prompt input value",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      text: z.string().describe("Text to set in prompt"),
    }),
    async ({ win_id, text }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        await win.webContents.executeJavaScript(
          `document.querySelector('#prompt-textarea')?.focus()`
        );
        await win.webContents.executeJavaScript(`document.execCommand('selectAll')`);
        await sendCDP(win.webContents, "Input.insertText", { text });

        return {
          content: [{ type: "text", text: `Prompt set to: ${text}` }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "ChatGPT" }
  );

  registerTool(
    "chatgpt_web_click_send",
    "Click the chatgpt send prompt button",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        const hasSendBtn = await win.webContents.executeJavaScript(
          `!!document.querySelector('button[data-testid="send-button"]')`
        );
        if (!hasSendBtn) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: false, error: "Send button not found" }, null, 2),
              },
            ],
          };
        }

        await sendCDP(win.webContents, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" });
        await sendCDP(win.webContents, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter" });

        return {
          content: [{ type: "text", text: JSON.stringify({ success: true }, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "ChatGPT" }
  );

  registerTool(
    "chatgpt_web_ask",
    "Ask chatgpt a question - checks login, sets prompt, sends, waits for response, returns reply",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      text: z.string().describe("Question to ask"),
      waitMs: z.number().optional().default(10000).describe("Wait time for response in ms"),
    }),
    async ({ win_id, text, waitMs }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        const statusResult = await win.webContents.executeJavaScript(`(async () => {
          const href = location.href;
          const hasLoginBtn = !!document.querySelector('[data-testid="login-button"]');
          const hasPromptTextarea = !!document.querySelector('textarea[name="prompt-textarea"]');
          const sendBtn = document.querySelector('button[data-testid="send-button"]');
          const hasSendPromptBtn = !!sendBtn;
          const isOnVoiceMode = !hasSendPromptBtn;
          const isLogged = !hasLoginBtn && hasPromptTextarea;
          const isOnChatGPT = href.includes('chatgpt.com');
          return JSON.stringify({ href, isLogged, hasPromptTextarea, hasSendPromptBtn, isOnVoiceMode, isOnChatGPT });
        })()`);

        const status = JSON.parse(statusResult);

        if (!status.isLogged) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: "Not logged in", status }, null, 2) },
            ],
          };
        }

        const urlMatch = status.href.match(/\/c\/([a-f0-9-]+)/);
        const isInConversation = !!urlMatch;

        if (!isInConversation) {
          await win.webContents.loadURL("https://chatgpt.com/");
          await new Promise((r) => setTimeout(r, 3000));
        }

        if (!status.hasSendPromptBtn && !status.hasPromptTextarea) {
          await win.webContents.loadURL("https://chatgpt.com/");
          await new Promise((r) => setTimeout(r, 3000));
        }

        await win.webContents.executeJavaScript(`if (!window._g) window._g = {};`);

        const injectHelperCode = `
(function() {
  if (!window._g) window._g = {};
  window._g.getIndexedDBRows = function(dbName, storeName, limit) {
    limit = limit || 100;
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open(dbName);
      req.onsuccess = function() {
        var db = req.result;
        var tx = db.transaction(storeName, 'readonly');
        var store = tx.objectStore(storeName);
        var results = [];
        var cursorReq = store.openCursor();
        cursorReq.onsuccess = function(e) {
          var cursor = e.target.result;
          if (cursor && results.length < limit) {
            results.push(cursor.value);
            cursor.continue();
          } else {
            resolve(results);
          }
        };
      };
      req.onerror = function() { reject(req.error); };
    });
  };
})();
`;

        await win.webContents.executeJavaScript(
          "document.querySelector('#prompt-textarea')?.focus()"
        );
        await sendCDP(win.webContents, "Input.insertText", { text });

        await new Promise((r) => setTimeout(r, 500));

        await sendCDP(win.webContents, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" });
        await sendCDP(win.webContents, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter" });

        var replyText = null;
        var startTime = Date.now();

        while (Date.now() - startTime < waitMs) {
          await new Promise((r) => setTimeout(r, 1000));

          var checkCode =
            '(function(){var a=document.querySelectorAll("[data-message-author-role=\\"assistant\\"]");if(a.length>=2){var b=a[a.length-1];if(b.querySelector("[aria-label=\\"Copy\\"]")||b.querySelector("[aria-label=\\"Good response\\"]")){return"ok"}else{return"no-btn"}}return"waiting"})()';
          var checkResult = await win.webContents.executeJavaScript(checkCode);

          if (checkResult === "ok") {
            var getCode =
              '(async function(){var rows=await window._g.getIndexedDBRows("ConversationsDatabase","conversations");rows.sort(function(a,b){return b.updateTime-a.updateTime});var msgs=rows[0]?rows[0].messages:[];return msgs.length>0?msgs[msgs.length-1].text:""})()';
            replyText = await win.webContents.executeJavaScript(getCode);
            var duration = Date.now() - startTime;
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ reply: replyText, duration_ms: duration }, null, 2),
                },
              ],
            };
          }
        }

        if (!replyText) {
          var getCode =
            '(async function(){var rows=await window._g.getIndexedDBRows("ConversationsDatabase","conversations");rows.sort(function(a,b){return b.updateTime-a.updateTime});var msgs=rows[0]?rows[0].messages:[];return msgs.length>0?msgs[msgs.length-1].text:""})()';
          replyText = await win.webContents.executeJavaScript(getCode);
        }

        var duration = Date.now() - startTime;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ reply: replyText, duration_ms: duration }, null, 2),
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "ChatGPT" }
  );
}

module.exports = registerTools;
