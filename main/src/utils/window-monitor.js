const fs = require("fs");
const path = require("path");
const os = require("os");
const beautify = require("js-beautify");

// 存储每个窗口的日志和请求
const windowLogs = new Map();
const windowRequests = new Map(); // 已废弃，保留兼容性
const windowRequestDetails = new Map();
const windowIndexCounters = new Map();
const windowBeforeSendRequests = new Map(); // onBeforeSendHeaders 捕获的所有请求
const windowLoadingFinishedRequests = new Map(); // loadingFinished 捕获的完成请求

const MAX_INLINE_SIZE = 1024; // 1KB

// 标准化路径：移除特殊字符，保留 .
function sanitizePath(str) {
  return str.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9-_.]/g, "_");
}

// 根据 content-type 获取扩展名
function getExtFromContentType(contentType, isBinary) {
  if (!contentType) return isBinary ? "bin" : "txt";

  const mimeMap = {
    "application/json": "json",
    "text/html": "html",
    "text/css": "css",
    "text/javascript": "js",
    "application/javascript": "js",
    "text/plain": "txt",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "application/pdf": "pdf",
    "application/zip": "zip",
  };

  const mime = contentType.split(";")[0].trim().toLowerCase();
  return mimeMap[mime] || (isBinary ? "bin" : "txt");
}

// 为每个窗口维护文件计数器
const windowFileCounters = new Map();

// 处理数据：二进制或大数据保存到文件
function handleData(winId, url, data, type, contentType) {
  if (!data) return null;

  // 检查是否是二进制数据
  const isBinary = Buffer.isBuffer(data) || (data.bytes && Buffer.isBuffer(data.bytes));

  // 检查大小
  let dataSize = 0;
  let content = data;

  if (isBinary) {
    const buffer = Buffer.isBuffer(data) ? data : data.bytes;
    dataSize = buffer.length;
    content = buffer;
  } else {
    const str = typeof data === "string" ? data : JSON.stringify(data);
    dataSize = Buffer.byteLength(str);
    content = str;
  }

  // 判断是否需要格式化的文件类型
  const mime = contentType ? contentType.split(";")[0].trim().toLowerCase() : "";
  const needsPretty =
    mime === "application/json" ||
    mime === "text/javascript" ||
    mime === "application/javascript" ||
    mime === "text/css" ||
    mime === "text/html";

  // 如果是可格式化类型，或者大于1KB，保存到文件
  if (needsPretty || isBinary || dataSize > MAX_INLINE_SIZE) {
    return saveDataToFile(winId, url, content, type, contentType, isBinary, dataSize);
  }

  // 其他小数据直接返回
  return data;
}

// 强制保存数据到文件（用于 response/request 对象）
// type: 'response' | 'response-body' | 'request' | 'post'
function saveDataToFile(winId, url, content, type, contentType, isBinary, dataSize, timestamp) {
  try {
    // 解析 URL
    const urlObj = new URL(url);
    const domain = sanitizePath(urlObj.hostname);
    let pathname = urlObj.pathname.replace(/^\/+|\/+$/g, "") || "root";

    // 限制路径长度，避免 ENAMETOOLONG 错误
    const MAX_PATH_LENGTH = 200;
    if (pathname.length > MAX_PATH_LENGTH) {
      // 截断并添加哈希
      const crypto = require("crypto");
      const hash = crypto.createHash("md5").update(pathname).digest("hex").substring(0, 8);
      pathname = pathname.substring(0, MAX_PATH_LENGTH - 10) + "-" + hash;
    }

    let dir, baseName;

    // 如果路径以 / 结尾，使用 index
    if (urlObj.pathname.endsWith("/")) {
      dir = path.join(os.homedir(), "request-data", `win-${winId}`, domain, pathname);
      baseName = "index";
    } else {
      // 分离目录和文件名
      const lastSlash = pathname.lastIndexOf("/");
      const dirPath = lastSlash >= 0 ? pathname.substring(0, lastSlash) : "";
      baseName = lastSlash >= 0 ? pathname.substring(lastSlash + 1) : pathname;

      // 移除原有扩展名
      baseName = baseName.replace(/\.[^.]*$/, "");

      // 限制文件名长度
      if (baseName.length > 100) {
        const crypto = require("crypto");
        const hash = crypto.createHash("md5").update(baseName).digest("hex").substring(0, 8);
        baseName = baseName.substring(0, 90) + "-" + hash;
      }

      dir = path.join(os.homedir(), "request-data", `win-${winId}`, domain, dirPath);
    }

    // 获取计数器
    if (!windowFileCounters.has(winId)) {
      windowFileCounters.set(winId, new Map());
    }
    const counters = windowFileCounters.get(winId);
    const key = `${domain}/${pathname}/${type}`;
    const count = (counters.get(key) || 0) + 1;
    counters.set(key, count);

    // 根据 content-type 确定扩展名
    const ext = getExtFromContentType(contentType, isBinary);

    // 确定文件类型标识：header|body 和 req|res
    let part, direction;
    if (type === "response") {
      part = "header";
      direction = "res";
    } else if (type === "response-body") {
      part = "body";
      direction = "res";
    } else if (type === "request") {
      part = "header";
      direction = "req";
    } else if (type === "post") {
      part = "body";
      direction = "req";
    }

    // 文件名格式：{basename}-{timestamp}-{index}-{header|body}-{req|res}.{ext}
    const ts = timestamp || Date.now();
    const filename = `${baseName}-${ts}-${count}-${part}-${direction}.${ext}`;

    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);

    if (isBinary) {
      fs.writeFileSync(filepath, content);
    } else {
      let formattedContent = content;

      // 使用 js-beautify 格式化
      try {
        const beautify = require("js-beautify");
        const contentStr = typeof content === "string" ? content : JSON.stringify(content);

        if (ext === "json") {
          formattedContent = beautify.js_beautify(contentStr, { indent_size: 2 });
        } else if (ext === "js") {
          formattedContent = beautify.js_beautify(contentStr, { indent_size: 2 });
        } else if (ext === "css") {
          formattedContent = beautify.css(contentStr, { indent_size: 2 });
        } else if (ext === "html") {
          formattedContent = beautify.html(contentStr, { indent_size: 2 });
        } else {
          formattedContent = contentStr;
        }
      } catch (e) {
        // 格式化失败，使用原始内容
        formattedContent = typeof content === "string" ? content : JSON.stringify(content, null, 2);
      }

      fs.writeFileSync(filepath, formattedContent);
    }

    return {
      __file: filepath,
      __size: dataSize,
      __binary: isBinary,
    };
  } catch (error) {
    // 文件保存失败，返回错误信息
    console.error(`[Window ${winId}] Failed to save file for ${url}:`, error.message);
    return {
      __error: error.message,
      __url: url,
      __size: dataSize,
    };
  }
}

// 保存请求数据到文件（节流）
let saveTimeout = null;
function saveRequestsToFile(winId) {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const urls = windowBeforeSendRequests.get(winId) || [];
      const detailsMap = windowLoadingFinishedRequests.get(winId) || new Map();

      const data = {
        queue: urls,
        map: Object.fromEntries(detailsMap),
      };

      // 保存到 request-data 目录
      const dir = path.join(os.homedir(), "request-data", `win-${winId}`);
      fs.mkdirSync(dir, { recursive: true });

      const queueFile = path.join(dir, "queue.json");
      const mapFile = path.join(dir, "map.json");

      fs.writeFileSync(queueFile, JSON.stringify(urls, null, 2));
      fs.writeFileSync(mapFile, JSON.stringify(Object.fromEntries(detailsMap), null, 2));
    } catch (e) {
      console.error(`Failed to save requests for window ${winId}:`, e.message);
    }
  }, 1000); // 1秒后保存
}

function initWindowMonitoring(win) {
  const winId = win.id;

  // 初始化队列和计数器
  windowLogs.set(winId, []);
  windowRequests.set(winId, []); // 保留兼容性
  windowRequestDetails.set(winId, new Map());
  windowIndexCounters.set(winId, { log: 0, request: 0 });
  windowBeforeSendRequests.set(winId, []); // URL 队列
  windowLoadingFinishedRequests.set(winId, new Map()); // 详情 Map (key: URL)

  // 监听 onBeforeSendHeaders - 只记录 URL
  win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    const urlQueue = windowBeforeSendRequests.get(winId);
    const detailsMap = windowLoadingFinishedRequests.get(winId);

    // 队列只存 URL
    if (urlQueue && !urlQueue.includes(details.url)) {
      urlQueue.push(details.url);
    }

    // 详情存到 Map
    if (detailsMap) {
      const timestamp = Date.now();
      const contentType =
        details.requestHeaders["Content-Type"] || details.requestHeaders["content-type"];
      const postData = handleData(winId, details.url, details.uploadData, "post", contentType);

      const requestData = {
        timestamp,
        url: details.url,
        method: details.method,
        resourceType: details.resourceType,
        headers: details.requestHeaders,
        postData: postData,
      };

      // 保存完整 request 到文件
      const requestStr = JSON.stringify(requestData);
      const requestSize = Buffer.byteLength(requestStr);
      const requestFile = saveDataToFile(
        winId,
        details.url,
        requestStr,
        "request",
        "application/json",
        false,
        requestSize,
        timestamp
      );

      // 如果 URL 已存在，追加到数组；否则创建新条目
      if (detailsMap.has(details.url)) {
        const entry = detailsMap.get(details.url);
        entry.requests.push(requestFile);
      } else {
        detailsMap.set(details.url, {
          requests: [requestFile],
          responses: [],
        });
      }
      saveRequestsToFile(winId);
    }

    callback({ requestHeaders: details.requestHeaders });
  });

  // 立即启用网络监控（在任何请求之前）
  try {
    win.webContents.debugger.sendCommand("Network.enable");
    console.log(`[Window ${winId}] Network monitoring enabled`);
  } catch (e) {
    console.error(`[Window ${winId}] Failed to enable Network:`, e);
  }

  // 监听控制台日志
  win.webContents.on("console-message", (event, level, message, line, sourceId) => {
    const logs = windowLogs.get(winId);

    const counters = windowIndexCounters.get(winId);
    console.log(
      `[${JSON.stringify({
        timestamp: Date.now(),
        level: ["verbose", "info", "warning", "error"][level] || "log",
        message,
        line,
        source: sourceId,
      })}`
    );
    if (logs && counters) {
      logs.push({
        index: ++counters.log,
        timestamp: Date.now(),
        level: ["verbose", "info", "warning", "error"][level] || "log",
        message,
        line,
        source: sourceId,
      });
    }
  });

  // 临时存储 requestId -> url 映射和响应信息
  const requestIdToUrl = new Map();
  const requestIdToResponse = new Map();

  // 监听网络请求
  win.webContents.debugger.on("message", async (event, method, params) => {
    // responseReceived: 记录 requestId -> url 映射和响应头
    if (method === "Network.responseReceived") {
      const url = params.response.url;
      requestIdToUrl.set(params.requestId, url);
      requestIdToResponse.set(params.requestId, {
        status: params.response.status,
        statusText: params.response.statusText,
        headers: params.response.headers,
        mimeType: params.response.mimeType,
      });
    }

    // loadingFinished: 更新 Map 中的 response
    if (method === "Network.loadingFinished") {
      const url = requestIdToUrl.get(params.requestId);
      const responseInfo = requestIdToResponse.get(params.requestId);

      if (url && responseInfo) {
        const loadingFinishedMap = windowLoadingFinishedRequests.get(winId);
        const entry = loadingFinishedMap?.get(url);
        if (entry) {
          // 尝试获取 response body
          let responseBody = null;
          try {
            const result = await win.webContents.debugger.sendCommand("Network.getResponseBody", {
              requestId: params.requestId,
            });
            if (result.body) {
              responseBody = handleData(
                winId,
                url,
                result.base64Encoded ? Buffer.from(result.body, "base64") : result.body,
                "response-body",
                responseInfo.mimeType
              );
            }
          } catch (e) {
            // 某些请求无法获取 body（如 304, 204 等）
          }

          const responseData = {
            timestamp: Date.now(),
            status: responseInfo.status,
            statusText: responseInfo.statusText,
            headers: responseInfo.headers,
            mimeType: responseInfo.mimeType,
            encodedDataLength: params.encodedDataLength,
            body: responseBody,
          };

          // 强制保存完整 response 到文件
          const responseStr = JSON.stringify(responseData);
          const responseSize = Buffer.byteLength(responseStr);
          const responseFile = saveDataToFile(
            winId,
            url,
            responseStr,
            "response",
            "application/json",
            false,
            responseSize,
            responseData.timestamp
          );

          // 追加到 responses 数组（只保留文件引用）
          entry.responses.push(responseFile);
          saveRequestsToFile(winId);
        }
        requestIdToUrl.delete(params.requestId);
        requestIdToResponse.delete(params.requestId);
      }
    }

    // 保留旧的 requestWillBeSent 逻辑以兼容现有代码
    if (method === "Network.requestWillBeSent") {
      const requests = windowRequests.get(winId);
      const details = windowRequestDetails.get(winId);
      const counters = windowIndexCounters.get(winId);
      if (requests && counters && details) {
        const url = new URL(params.request.url);
        const index = ++counters.request;
        const postData = params.request.postData;
        const postDataSize = postData ? Buffer.byteLength(postData, "utf8") : 0;

        // 打印包含 __vid 的请求
        if (params.request.url.includes("__vid")) {
          console.log("\n=== REQUEST WITH __vid DETECTED ===");
          console.log("URL:", params.request.url);
          console.log("Method:", params.request.method);
          console.log("Type:", params.type);
          console.log("===================================\n");
        }

        requests.push({
          index,
          timestamp: Date.now(),
          requestId: params.requestId,
          url: params.request.url,
          domain: url.hostname,
          path: url.pathname + url.search,
          method: params.request.method,
          type: params.type,
          mimeType: params.request.headers["Content-Type"] || params.type,
          postDataSize,
        });

        // 存储详细信息
        const detailData = {
          requestId: params.requestId,
          url: params.request.url,
          method: params.request.method,
          headers: params.request.headers,
          postDataSize,
          type: params.type,
        };

        // 如果 postData 太大，保存到文件
        if (postData && postDataSize > MAX_INLINE_SIZE) {
          const tmpDir = path.join(os.tmpdir(), "electron-mcp", `win-${winId}`);
          if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
          const postDataFile = path.join(tmpDir, `post-${params.requestId}.dat`);
          fs.writeFileSync(postDataFile, postData);
          detailData.postDataFile = postDataFile;
        } else if (postData) {
          detailData.postData = postData;
        }

        details.set(index, detailData);
        details.set(params.requestId, { url: params.request.url, method: params.request.method });
      }
    }

    if (method === "Network.responseReceived") {
      const details = windowRequestDetails.get(winId);
      if (details) {
        const info = details.get(params.requestId);
        if (info) {
          info.mimeType = params.response.mimeType;
          info.responseHeaders = params.response.headers;
          info.status = params.response.status;
        }
      }
    }

    if (method === "Network.loadingFinished") {
      const details = windowRequestDetails.get(winId);
      const requests = windowRequests.get(winId);
      if (!details || !requests) return;
      const info = details.get(params.requestId);
      if (!info) return;

      // 旧的文件保存逻辑已删除，现在使用新的 handleData 逻辑

      win.webContents.session.flushStorageData();
    }
  });

  // 页面重载时清空队列并重置计数器（注释掉，避免误清空）
  // win.webContents.on("did-start-loading", () => {
  //   windowLogs.set(winId, []);
  //   windowRequests.set(winId, []);
  //   windowRequestDetails.set(winId, new Map());
  //   windowIndexCounters.set(winId, { log: 0, request: 0 });
  // });

  // 窗口关闭时清理
  win.on("closed", () => {
    // 清理临时文件
    const tmpDir = path.join(os.tmpdir(), "electron-mcp", `win-${winId}`);
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    windowLogs.delete(winId);
    windowRequests.delete(winId);
    windowRequestDetails.delete(winId);
    windowIndexCounters.delete(winId);
  });
}

function getConsoleLogs(winId) {
  return windowLogs.get(winId) || [];
}

function getRequests(winId) {
  return windowRequests.get(winId) || [];
}

function getBeforeSendRequests(winId) {
  return windowBeforeSendRequests.get(winId) || [];
}

function getLoadingFinishedRequests(winId) {
  const map = windowLoadingFinishedRequests.get(winId);
  return map ? Array.from(map.values()) : [];
}

function getRequestDetailByUrl(winId, url) {
  const map = windowLoadingFinishedRequests.get(winId);
  return map ? map.get(url) : null;
}

function clearRequests(winId) {
  windowLogs.set(winId, []);
  windowRequests.set(winId, []);
  windowBeforeSendRequests.set(winId, []);
  windowLoadingFinishedRequests.set(winId, new Map());
  windowRequestDetails.set(winId, new Map());
  windowIndexCounters.set(winId, { log: 0, request: 0 });
}

function getRequestDetail(winId, index) {
  // 优先从 .info.txt 文件加载
  const captureBase = process.env.TEST === "TRUE" ? "CaptureDataTest" : "CaptureData";
  const captureDir = path.join(os.homedir(), "Desktop", captureBase);

  // 递归查找 .info.txt 文件
  function findInfoFile(dir) {
    if (!fs.existsSync(dir)) return null;

    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
      const fullPath = path.join(dir, file.name);
      if (file.isDirectory()) {
        const found = findInfoFile(fullPath);
        if (found) return found;
      } else if (file.name.endsWith(".info.txt")) {
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          const data = JSON.parse(content);
          if (data.index === index) return data;
        } catch (e) {}
      }
    }
    return null;
  }

  const detail = findInfoFile(captureDir);
  if (detail) return detail;

  // 回退到内存数据
  const details = windowRequestDetails.get(winId);
  return details ? details.get(index) : null;
}

module.exports = {
  initWindowMonitoring,
  getConsoleLogs,
  getRequests,
  getBeforeSendRequests,
  getLoadingFinishedRequests,
  getRequestDetail,
  getRequestDetailByUrl,
  clearRequests,
};
