const { BrowserWindow } = require("electron");
const { z } = require("zod");
const {
  initWindowMonitoring,
  getConsoleLogs,
  getRequests,
  getRequestDetail,
  getBeforeSendRequests,
  getRequestDetailByUrl,
  getLoadingFinishedRequests,
  clearRequests,
} = require("../utils/window-monitor");
const { captureSnapshot } = require("../utils/snapshot-utils");
const { createWindow, getWindowInfo } = require("../utils/window-utils");
const { config } = require("../config");

function registerTools(registerTool) {
  registerTool(
    "get_windows",
    `获取当前所有 Electron 窗口的实时状态列表。返回每个窗口的详细信息，是窗口管理和自动化操作的基础工具。
  
  返回信息包括：
  - id: 窗口的唯一标识符（调用其他 invoke_window 工具时必需）
  - title/url: 窗口当前的标题和网址
  - debuggerIsAttached: 调试器是否已附加
  - isActive/isVisible: 窗口焦点和可见性状态
  - accountIdx: 窗口所在帐户,帐户可以是0,1,2,3...每个相同帐户下面的所有窗口共享缓存cookie等,
  - bounds: 窗口位置和大小 (x, y, width, height)
  - 加载状态: isLoading, isDomReady, isCrashed 等

  主要用途：
  - 窗口管理：获取窗口ID进行后续操作
  - 状态监控：检查窗口是否正常运行
  - 自动化测试：验证窗口状态和属性
  - 调试辅助：查看所有窗口的实时信息`,
    z.object({}),
    async () => {
      try {
        const windows = BrowserWindow.getAllWindows()
          .map(getWindowInfo)
          .filter((w) => w !== null);
        return { content: [{ type: "text", text: JSON.stringify(windows, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Window" }
  );

  registerTool(
    "get_window_info",
    "获取指定窗口的详细信息",
    z.object({ win_id: z.number().optional().default(1).describe("Window ID") }),
    async ({ win_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);
        return { content: [{ type: "text", text: JSON.stringify(getWindowInfo(win), null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Window" }
  );

  registerTool(
    "open_window",
    "打开新的浏览器窗口。用于创建新窗口访问网页、测试多窗口应用或隔离不同的浏览会话。支持自定义窗口大小和位置。",
    z.object({
      url: z.string().describe("URL to open"),
      accountIdx: z
        .number()
        .optional()
        .default(0)
        .describe("窗口所在帐户,帐户可以是0,1,2,3...每个相同帐户下面的所有窗口共享缓存cookie等"),
      reuseWindow: z
        .boolean()
        .optional()
        .default(true)
        .describe("是否复用现有窗口。true=复用(默认)，false=创建新窗口"),
      options: z.object({}).optional().describe("Electron BrowserWindow options"),
    }),
    async ({ url, accountIdx, reuseWindow, options }) => {
      // Determine if we should create a new window
      const forceNew = reuseWindow === false;

      // Get existing windows count before creating
      const existingCount = BrowserWindow.getAllWindows().length;

      // Create or reuse window
      const win = createWindow({ url, ...options }, accountIdx, forceNew);

      // Check if window was reused (count didn't change)
      const newCount = BrowserWindow.getAllWindows().length;
      const wasReused = newCount === existingCount;

      if (wasReused) {
        return {
          content: [
            {
              type: "text",
              text: `Window already exists (ID: ${win.id}), reusing it. URL load triggered. Please use tool: get_window_info and wait for webContents dom-ready`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Opened window with ID: ${win.id}, use tool: get_window_info and wait window webContents dom-ready`,
          },
        ],
      };
    },
    { tag: "Window" }
  );

  registerTool(
    "close_window",
    "关闭窗口",
    z.object({ win_id: z.number().optional().default(1).describe("Window ID") }),
    async ({ win_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (win) {
          win.close();
          return { content: [{ type: "text", text: `Closed ${win_id}` }] };
        }
        throw new Error(`Window ${win_id} not found`);
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Window" }
  );

  registerTool(
    "load_url",
    "加载URL",
    z.object({
      url: z.string().describe("URL"),
      win_id: z.number().optional().describe("Window ID"),
    }),
    async ({ url, win_id }) => {
      try {
        const actualWinId = win_id || 1;
        const win = BrowserWindow.fromId(actualWinId);
        if (!win) throw new Error(`Window ${actualWinId} not found`);
        await win.loadURL(url);
        return { content: [{ type: "text", text: `Loaded ${url}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Window" }
  );

  registerTool(
    "get_title",
    "获取窗口标题",
    z.object({ win_id: z.number().optional().default(1).describe("Window ID") }),
    async ({ win_id }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);
        return { content: [{ type: "text", text: win.getTitle() }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Window" }
  );

  registerTool(
    "control_electron_BrowserWindow",
    "直接调用Electron BrowserWindow实例的方法和属性。主要用途：窗口控制(移动、调整大小、最小化、最大化)、状态管理(置顶、焦点、可见性)、属性获取(位置、大小、状态)、高级操作(透明度、边框、图标)。可访问win(BrowserWindow实例)和webContents对象，支持async/await。示例: win.getBounds() 或 win.maximize() 或 win.webContents.executeJavaScript('document.title')",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      code: z.string().describe("JS 代码"),
    }),
    async ({ win_id, code }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const execute = new AsyncFunction("win", "webContents", `return ${code}`);
        const result = await execute(win, win.webContents);

        let outputText =
          typeof result === "object"
            ? JSON.stringify(result, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2)
            : String(result);

        return { content: [{ type: "text", text: outputText }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Window" }
  );

  registerTool(
    "set_window_bounds",
    "设置窗口的位置和大小。可以单独设置 x, y 坐标或 width, height 尺寸，也可以同时设置。坐标原点在屏幕左上角。",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      x: z.number().optional().describe("窗口 X 坐标（像素）"),
      y: z.number().optional().describe("窗口 Y 坐标（像素）"),
      width: z.number().optional().describe("窗口宽度（像素）"),
      height: z.number().optional().describe("窗口高度（像素）"),
    }),
    async ({ win_id, x, y, width, height }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        const currentBounds = win.getBounds();
        const newBounds = {
          x: x !== undefined ? x : currentBounds.x,
          y: y !== undefined ? y : currentBounds.y,
          width: width !== undefined ? width : currentBounds.width,
          height: height !== undefined ? height : currentBounds.height,
        };

        // Unmaximize/unfullscreen first so setBounds takes effect
        if (win.isMaximized()) win.unmaximize();
        if (win.isFullScreen()) win.setFullScreen(false);

        win.setBounds(newBounds);
        const updatedBounds = win.getBounds();

        return {
          content: [
            {
              type: "text",
              text: `窗口 ${win_id} 位置和大小已更新:\n${JSON.stringify(updatedBounds, null, 2)}`,
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Window" }
  );

  registerTool(
    "control_electron_WebContents",
    "调用Electron webContents的方法和属性。主要用途：页面操作(截图、打印、缩放、导航)、内容获取(URL、标题、源码)、脚本执行(在页面中执行JS)、开发调试(控制台信息、性能数据)、媒体控制(音频/视频)。可访问webContents和win对象，支持async/await，自动处理NativeImage返回为图像格式。示例: webContents.getURL() 或 webContents.reload() 或 webContents.capturePage()",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      code: z.string().describe("JS 代码"),
    }),
    async ({ win_id, code }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`未找到窗口 ${win_id}`);

        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const execute = new AsyncFunction("webContents", "win", `return ${code}`);
        let result = await execute(win.webContents, win);

        if (result?.constructor.name === "NativeImage") {
          const size = result.getSize();
          const base64 = result.toPNG().toString("base64");
          return {
            content: [
              { type: "text", text: `Image: ${size.width}x${size.height}` },
              { type: "image", data: base64, mimeType: "image/png" },
            ],
          };
        }

        let outputText =
          typeof result === "object"
            ? JSON.stringify(result, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2)
            : String(result);

        return { content: [{ type: "text", text: outputText }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Window" }
  );

  registerTool(
    "get_console_logs",
    "获取窗口的控制台日志。返回自窗口创建或上次重载以来的所有 console 输出，包括 log/info/warning/error 等级别。支持分页查询和过滤。",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      page: z.number().optional().default(1).describe("页码，从1开始"),
      page_size: z.number().optional().default(50).describe("每页数量"),
      keyword: z.string().optional().describe("关键词过滤，匹配日志消息"),
      level: z.enum(["verbose", "info", "warning", "error"]).optional().describe("日志级别过滤"),
    }),
    async ({ win_id, page, page_size, keyword, level }) => {
      try {
        let logs = getConsoleLogs(win_id);

        // 关键词过滤
        if (keyword) {
          logs = logs.filter((log) => log.message.includes(keyword));
        }

        // 级别过滤
        if (level) {
          logs = logs.filter((log) => log.level === level);
        }

        const start = (page - 1) * page_size;
        const end = start + page_size;
        const paginated = logs.slice(start, end);
        
        const header = `Console Logs (${logs.length} total, page ${page}/${Math.ceil(logs.length / page_size) || 1}):\n`;
        const logLines = paginated.map(log => {
          const time = new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false });
          const source = log.source ? ` (${log.source}:${log.line})` : '';
          return `#${log.index} [${time}] [${log.level}] ${log.message}${source}`;
        }).join('\n');
        
        return { content: [{ type: "text", text: header + logLines }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Console" }
  );

  registerTool(
    "get_requests",
    "获取窗口的网络请求记录。返回所有请求的详细信息（包含文件路径）。支持 URL 过滤和分页。",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      page: z.number().optional().default(1).describe("页码，从1开始"),
      page_size: z.number().optional().default(50).describe("每页数量"),
      filter: z.string().optional().describe("URL 过滤关键词（支持正则表达式）"),
    }),
    async ({ win_id, page, page_size, filter }) => {
      try {
        const allRequests = getLoadingFinishedRequests(win_id);
        let entries = Array.from(allRequests.entries()).map(([url, data]) => ({
          url,
          requestCount: data.requests?.length || 0,
          responseCount: data.responses?.length || 0,
          requests: data.requests || [],
          responses: data.responses || [],
        }));

        // 应用过滤
        if (filter) {
          try {
            const regex = new RegExp(filter, "i");
            entries = entries.filter((entry) => regex.test(entry.url));
          } catch (e) {
            entries = entries.filter((entry) => entry.url.includes(filter));
          }
        }

        const start = (page - 1) * page_size;
        const end = start + page_size;
        const paginated = entries.slice(start, end);

        const result = {
          total: entries.length,
          page: page,
          page_size: page_size,
          total_pages: entries.length > 0 ? Math.ceil(entries.length / page_size) : 0,
          data: paginated,
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Network" }
  );

  registerTool(
    "filter_requests",
    "根据关键词或文档类型过滤网络请求。搜索 URL、POST data 或按文档类型筛选。",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      keyword: z.string().optional().describe("搜索关键词（可选）"),
      doc_type: z
        .string()
        .optional()
        .describe("文档类型过滤（如 json, html, javascript, css, image, xml）"),
      page: z.number().optional().default(1).describe("页码，从1开始"),
      page_size: z.number().optional().default(50).describe("每页数量"),
    }),
    async ({ win_id, keyword, doc_type, page, page_size }) => {
      try {
        const allRequests = getRequests(win_id);

        // 过滤匹配的请求
        const filtered = allRequests.filter((req) => {
          let match = true;

          // 关键词过滤
          if (keyword) {
            const lowerKeyword = keyword.toLowerCase();
            let keywordMatch = false;

            // 检查 URL
            if (req.url.toLowerCase().includes(lowerKeyword)) {
              keywordMatch = true;
            }

            // 检查 POST data
            if (!keywordMatch) {
              const detail = getRequestDetail(win_id, req.index);
              if (detail && detail.postData) {
                const postData =
                  typeof detail.postData === "string"
                    ? detail.postData
                    : JSON.stringify(detail.postData);
                if (postData.toLowerCase().includes(lowerKeyword)) {
                  keywordMatch = true;
                }
              }
            }

            match = match && keywordMatch;
          }

          // 文档类型过滤
          if (doc_type && match) {
            const lowerType = doc_type.toLowerCase();
            const reqMime = (req.mimeType || "").toLowerCase();
            match = match && reqMime.includes(lowerType);
          }

          return match;
        });

        const start = (page - 1) * page_size;
        const end = start + page_size;
        const paginated = filtered.slice(start, end);

        const result = {
          filters: { keyword, doc_type },
          total: filtered.length,
          page,
          page_size,
          total_pages: Math.ceil(filtered.length / page_size),
          data: paginated,
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Network" }
  );

  registerTool(
    "get_request_detail",
    "获取指定请求的详细信息，包括请求头和请求体。使用请求的 index 来查询。",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      index: z.number().describe("请求的 index"),
    }),
    async ({ win_id, index }) => {
      try {
        const detail = getRequestDetail(win_id, index);
        if (!detail) {
          throw new Error(`Request with index ${index} not found`);
        }

        // 如果有 responseBodyFile 和 responseBodySize，检查大小
        if (detail.responseBodyFile && detail.responseBodySize) {
          if (detail.responseBodySize > 1024) {
            // Response body > 1KB，返回文件路径
            const result = {
              ...detail,
              responseBody: `[Response body too large: ${detail.responseBodySize} bytes]`,
              responseBodyPath: detail.responseBodyFile,
            };
            delete result.responseBodyFile;
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          } else {
            // Response body <= 1KB，读取并包含在响应中
            const fs = require("fs");
            if (fs.existsSync(detail.responseBodyFile)) {
              const encoding = detail.base64Encoded ? "base64" : "utf8";
              const body = fs.readFileSync(detail.responseBodyFile, encoding);
              const result = {
                ...detail,
                responseBody: body,
              };
              delete result.responseBodyFile;
              return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }
          }
        }

        return { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Network" }
  );

  registerTool(
    "session_download_url",
    "使用窗口的 session 下载文件到指定路径。不会弹出保存对话框，下载完成后文件直接保存到 save_path。",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      url: z.string().describe("下载 URL"),
      save_path: z.string().describe("保存路径（完整路径包含文件名），下载完成后文件保存在此路径"),
      timeout: z.number().optional().default(300000).describe("超时时间（毫秒），默认 5 分钟"),
    }),
    async ({ win_id, url, save_path, timeout }) => {
      try {
        const win = BrowserWindow.fromId(win_id);
        if (!win) throw new Error(`Window ${win_id} not found`);

        const fs = require("fs");
        const path = require("path");
        const session = win.webContents.session;

        // 检查文件是否已存在
        if (fs.existsSync(save_path)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "exists",
                    url,
                    path: save_path,
                    message: "File already exists",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // 创建目录
        fs.mkdirSync(path.dirname(save_path), { recursive: true });

        // 下载文件
        const result = await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new Error(`Download timeout after ${timeout / 1000}s`));
          }, timeout);

          session.once("will-download", (event, item) => {
            try {
              item.setSavePath(save_path);
              item.resume();

              item.on("updated", (event, state) => {
                const received = item.getReceivedBytes();
                const total = item.getTotalBytes();
                console.log(`Downloading: ${received} / ${total} bytes`);
              });

              item.once("done", (event, state) => {
                clearTimeout(timeoutId);

                if (state !== "completed") {
                  return reject(new Error(`Download failed: ${state}`));
                }

                resolve({
                  status: "completed",
                  url,
                  path: save_path,
                  size: item.getTotalBytes(),
                  mime: item.getMimeType(),
                  filename: item.getFilename(),
                });
              });
            } catch (err) {
              clearTimeout(timeoutId);
              reject(err);
            }
          });

          session.downloadURL(url);
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Network" }
  );

  registerTool(
    "webpage_screenshot_to_clipboard",
    `捕获指定窗口的页面截图并自动复制到系统剪贴板。这是快速获取页面视觉内容的便捷工具。

主要用途：
- 快速截图：一键获取页面截图
- 文档记录：保存页面状态用于报告或文档
- 测试验证：验证页面显示效果
- 问题报告：快速获取错误页面截图
- 内容分享：将页面内容复制到其他应用

特点：
- 自动复制到剪贴板，可直接粘贴到其他应用
- 返回 MCP 图像格式，支持在对话中显示
- 包含图像尺寸信息`,
    z.object({
      win_id: z.number().optional().describe("Window ID to capture (defaults to 1)"),
    }),
    async ({ win_id }) => {
      try {
        const actualWinId = win_id || 1;
        const win = BrowserWindow.fromId(actualWinId);
        if (!win) throw new Error(`Window ${actualWinId} not found`);
        const result = await captureSnapshot(win.webContents, {
          win_id: actualWinId,
        });

        return result;
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error capturing snapshot: ${error.message}` }],
          isError: true,
        };
      }
    },
    { tag: "Screenshot" }
  );

  registerTool(
    "webpage_snapshot",
    "捕获页面的结构快照，包含 URL 和所有可交互元素的信息。支持按类型/文本搜索元素。",
    z.object({
      win_id: z.number().optional().describe("Window ID"),
      max_elements: z.number().optional().default(20).describe("最大元素数量"),
      show_overlays: z
        .boolean()
        .optional()
        .default(false)
        .describe("是否显示可点击元素遮罩(5秒后消失)"),
    }),
    async ({ win_id, max_elements, show_overlays }) => {
      try {
        const actualWinId = win_id || 1;
        const win = BrowserWindow.fromId(actualWinId);
        if (!win) throw new Error(`Window ${actualWinId} not found`);

        const result = await win.webContents.executeJavaScript(`
          (() => {
            const url = window.location.href;
            const title = document.title;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const scrollX = window.scrollX;
            const scrollY = window.scrollY;

            const getElementInfo = (el) => {
              const rect = el.getBoundingClientRect();
              return {
                tag: el.tagName.toLowerCase(),
                text: (el.textContent || '').substring(0, 100).trim(),
                href: el.href || null,
                src: el.src || null,
                placeholder: el.placeholder || null,
                id: el.id || null,
                className: el.className ? el.className.substring(0, 50) : null,
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              };
            };

            const interactiveElements = [];
            document.querySelectorAll('a, button, input, select, textarea, [onclick], [role="button"], [role="link"]').forEach(el => {
              if (el.offsetParent !== null) {
                interactiveElements.push(getElementInfo(el));
              }
            });

            return {
              url: url,
              title: title,
              viewportWidth: viewportWidth,
              viewportHeight: viewportHeight,
              scrollX: scrollX,
              scrollY: scrollY,
              interactive_elements: interactiveElements
            };
          })()
        `);

        const response = [
          {
            type: "text",
            text:
              "Page Snapshot\n" +
              "url: " +
              result.url +
              "\n" +
              "title: " +
              result.title +
              "\n" +
              "viewport: " +
              result.viewportWidth +
              "x" +
              result.viewportHeight +
              "\n" +
              "scroll: (" +
              result.scrollX +
              ", " +
              result.scrollY +
              ")\n" +
              "Interactive Elements (" +
              result.interactive_elements.length +
              "):\n" +
              result.interactive_elements
                .slice(0, max_elements || 20)
                .map(
                  (el, i) =>
                    i +
                    1 +
                    ". [" +
                    el.tag +
                    "] " +
                    (el.text || "(no text)") +
                    " @ (" +
                    el.x +
                    ", " +
                    el.y +
                    ") " +
                    el.width +
                    "x" +
                    el.height
                )
                .join("\n"),
          },
        ];

        if (show_overlays) {
          await win.webContents.executeJavaScript(`
            (function() {
              const elements = ${JSON.stringify(result.interactive_elements)};
              elements.forEach((el, i) => {
                const overlay = document.createElement('div');
                overlay.style.cssText = \`position:fixed;left:\${el.x}px;top:\${el.y}px;width:\${el.width}px;height:\${el.height}px;background:rgba(255,0,0,0.2);border:2px solid red;z-index:999999;pointer-events:none;box-sizing:border-box\`;
                const label = document.createElement('div');
                label.textContent = i + 1;
                label.style.cssText = 'position:absolute;top:2px;left:2px;background:red;color:white;padding:2px 6px;font-size:12px;font-weight:bold;font-family:monospace;line-height:1';
                overlay.appendChild(label);
                document.body.appendChild(overlay);
                setTimeout(() => overlay.remove(), 5000);
              });
            })()
          `);
        }

        return { content: response };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
    { tag: "Screenshot" }
  );

  registerTool(
    "get_request_urls",
    "获取窗口的所有请求 URL 列表（队列）。支持 URL 过滤。",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      page: z.number().optional().default(1).describe("页码，从1开始"),
      page_size: z.number().optional().default(100).describe("每页数量"),
      filter: z.string().optional().describe("URL 过滤关键词（支持正则表达式）"),
    }),
    async ({ win_id, page, page_size, filter }) => {
      try {
        let urls = getBeforeSendRequests(win_id);

        // 应用过滤
        if (filter) {
          try {
            const regex = new RegExp(filter, "i");
            urls = urls.filter((url) => regex.test(url));
          } catch (e) {
            // 如果不是有效的正则，使用简单字符串匹配
            urls = urls.filter((url) => url.includes(filter));
          }
        }

        const start = (page - 1) * page_size;
        const end = start + page_size;
        const paginated = urls.slice(start, end);
        const result = {
          total: urls.length,
          page: page,
          page_size: page_size,
          total_pages: urls.length > 0 ? Math.ceil(urls.length / page_size) : 0,
          urls: paginated,
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Network" }
  );

  registerTool(
    "get_request_detail_by_url",
    "根据 URL 获取请求的完整详情。返回该 URL 的所有请求和响应的文件路径列表。",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
      url: z.string().describe("请求的完整 URL"),
    }),
    async ({ win_id, url }) => {
      try {
        const detail = getRequestDetailByUrl(win_id, url);
        if (!detail) {
          return {
            content: [{ type: "text", text: `Request not found for URL: ${url}` }],
            isError: true,
          };
        }

        // 返回文件路径列表，用户可以自己读取文件
        const result = {
          url,
          requestCount: detail.requests?.length || 0,
          responseCount: detail.responses?.length || 0,
          requests: detail.requests || [],
          responses: detail.responses || [],
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Network" }
  );

  registerTool(
    "clear_requests",
    "清空指定窗口的所有请求记录（仅清空内存，不删除已保存的文件）。",
    z.object({
      win_id: z.number().optional().default(1).describe("窗口 ID"),
    }),
    async ({ win_id }) => {
      try {
        clearRequests(win_id);
        return { content: [{ type: "text", text: `Cleared all requests for window ${win_id}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Network" }
  );
}

module.exports = registerTools;
