const { BrowserWindow } = require("electron");
const { z } = require("zod");

function registerTools(registerTool) {
  // 点击元素
  registerTool(
    "electron_click",
    "点击页面上的元素（通过CSS选择器）",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口ID"),
      selector: z.string().describe("CSS选择器，例如：button[aria-label='close']"),
      waitTimeout: z.number().optional().default(5000).describe("等待元素出现的超时时间（毫秒）"),
    }),
    async ({ win_id, selector, waitTimeout }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        const result = await win.webContents.executeJavaScript(`
          (async () => {
            const selector = ${JSON.stringify(selector)};
            const timeout = ${waitTimeout};
            const startTime = Date.now();
            
            while (Date.now() - startTime < timeout) {
              const element = document.querySelector(selector);
              if (element) {
                element.click();
                return { success: true, message: 'Element clicked' };
              }
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            throw new Error('Element not found: ' + selector);
          })()
        `);

        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Automation" }
  );

  // 输入文字
  registerTool(
    "electron_type",
    "在页面元素中输入文字（通过CSS选择器）",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口ID"),
      selector: z.string().describe("CSS选择器，例如：input[name='username']"),
      text: z.string().describe("要输入的文字"),
      clear: z.boolean().optional().default(true).describe("输入前是否清空原有内容"),
      waitTimeout: z.number().optional().default(5000).describe("等待元素出现的超时时间（毫秒）"),
    }),
    async ({ win_id, selector, text, clear, waitTimeout }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        const result = await win.webContents.executeJavaScript(`
          (async () => {
            const selector = ${JSON.stringify(selector)};
            const text = ${JSON.stringify(text)};
            const clear = ${clear};
            const timeout = ${waitTimeout};
            const startTime = Date.now();
            
            while (Date.now() - startTime < timeout) {
              const element = document.querySelector(selector);
              if (element) {
                if (clear) element.value = '';
                element.value = text;
                element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, message: 'Text typed' };
              }
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            throw new Error('Element not found: ' + selector);
          })()
        `);

        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Automation" }
  );

  // 获取页面内容
  registerTool(
    "electron_get_content",
    "获取页面的HTML内容或文本内容",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口ID"),
      selector: z.string().optional().describe("CSS选择器，不指定则获取整个页面"),
      type: z.enum(["html", "text"]).optional().default("text").describe("返回类型：html或text"),
    }),
    async ({ win_id, selector, type }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        const result = await win.webContents.executeJavaScript(`
          (() => {
            const selector = ${JSON.stringify(selector)};
            const type = ${JSON.stringify(type)};
            
            const element = selector ? document.querySelector(selector) : document.body;
            if (!element) throw new Error('Element not found: ' + selector);
            
            return type === 'html' ? element.innerHTML : element.innerText;
          })()
        `);

        return { content: [{ type: "text", text: result }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Automation" }
  );

  // 窗口截图
  registerTool(
    "electron_screenshot",
    "截取窗口的屏幕截图",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口ID"),
      format: z.enum(["png", "jpeg"]).optional().default("png").describe("图片格式"),
    }),
    async ({ win_id, format }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        const image = await win.webContents.capturePage();
        const buffer = format === "png" ? image.toPNG() : image.toJPEG(80);
        const base64 = buffer.toString("base64");

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                format,
                size: buffer.length,
                base64: `data:image/${format};base64,${base64}`,
              }),
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Automation" }
  );

  // 等待元素
  registerTool(
    "electron_wait_for",
    "等待页面元素出现",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口ID"),
      selector: z.string().describe("CSS选择器"),
      timeout: z.number().optional().default(10000).describe("超时时间（毫秒）"),
    }),
    async ({ win_id, selector, timeout }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        const result = await win.webContents.executeJavaScript(`
          (async () => {
            const selector = ${JSON.stringify(selector)};
            const timeout = ${timeout};
            const startTime = Date.now();
            
            while (Date.now() - startTime < timeout) {
              const element = document.querySelector(selector);
              if (element) {
                return { success: true, message: 'Element found', selector };
              }
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            throw new Error('Timeout waiting for element: ' + selector);
          })()
        `);

        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Automation" }
  );

  // 执行JavaScript并返回结果
  registerTool(
    "electron_evaluate",
    "在页面中执行JavaScript代码并返回结果",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口ID"),
      code: z.string().describe("要执行的JavaScript代码"),
    }),
    async ({ win_id, code }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        const result = await win.webContents.executeJavaScript(code);

        return {
          content: [
            {
              type: "text",
              text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Automation" }
  );

  // 获取元素属性
  registerTool(
    "electron_get_attribute",
    "获取页面元素的属性值",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口ID"),
      selector: z.string().describe("CSS选择器"),
      attribute: z.string().describe("属性名，例如：href, src, value, class"),
    }),
    async ({ win_id, selector, attribute }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        const result = await win.webContents.executeJavaScript(`
          (() => {
            const element = document.querySelector(${JSON.stringify(selector)});
            if (!element) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
            return element.getAttribute(${JSON.stringify(attribute)});
          })()
        `);

        return { content: [{ type: "text", text: result || "" }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Automation" }
  );

  // 选择下拉框选项
  registerTool(
    "electron_select",
    "选择下拉框（select）的选项",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口ID"),
      selector: z.string().describe("select元素的CSS选择器"),
      value: z.string().describe("要选择的option的value值"),
    }),
    async ({ win_id, selector, value }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        const result = await win.webContents.executeJavaScript(`
          (() => {
            const element = document.querySelector(${JSON.stringify(selector)});
            if (!element) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
            element.value = ${JSON.stringify(value)};
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true, message: 'Option selected' };
          })()
        `);

        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Automation" }
  );
}

module.exports = registerTools;
