const { z } = require("zod");
const { execSync } = require("child_process");

function registerTools(registerTool) {
  registerTool(
    "get_system_windows",
    "获取系统所有窗口信息（进程名、PID、窗口位置）",
    z.object({
      detail: z.boolean().optional().default(false).describe("是否显示详细信息"),
    }),
    async ({ detail }) => {
      try {
        const fs = require("fs");
        const path = require("path");
        let windows = [];

        if (process.platform === "linux") {
          // 使用 wmctrl 获取窗口信息
          const output = execSync("wmctrl -lGp", { encoding: "utf8" });
          const lines = output.trim().split("\n");

          // 获取当前活动窗口
          let activeWinId = "";
          try {
            activeWinId = execSync("xdotool getactivewindow", { encoding: "utf8" }).trim();
            activeWinId = "0x" + parseInt(activeWinId).toString(16).padStart(8, "0");
          } catch (e) {
            // xdotool not available
          }

          windows = lines.map((line) => {
            const parts = line.split(/\s+/);
            const winId = parts[0];
            const desktop = parts[1];
            const pid = parts[2];
            const x = parseInt(parts[3]);
            const y = parseInt(parts[4]);
            const width = parseInt(parts[5]);
            const height = parseInt(parts[6]);
            const title = parts.slice(8).join(" ");

            // 获取进程名
            let processName = "";
            try {
              processName = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf8" }).trim();
            } catch (e) {
              processName = "unknown";
            }

            const isFocused = winId === activeWinId;
            const isVisible = desktop !== "-1" && width > 0 && height > 0;

            if (detail) {
              // 生成缩略图 URL
              const baseUrl =
                process.env.ELECTRON_MCP_BASE_URL || `http://localhost:${process.env.PORT || 8101}`;
              const thumbUrl = `${baseUrl}/files/screenshot/sys_win_${winId.replace(/^0x/, "")}.jpeg`;

              return {
                windowId: winId,
                pid: parseInt(pid),
                processName,
                title,
                bounds: { x, y, width, height },
                desktop: parseInt(desktop),
                isVisible,
                isFocused,
                thumbUrl,
              };
            } else {
              return {
                windowId: winId,
                title,
                processName,
              };
            }
          });
        } else if (process.platform === "darwin") {
          // macOS 使用 osascript
          const script = `
            tell application "System Events"
              set windowList to {}
              repeat with proc in (every process whose background only is false)
                set procName to name of proc
                set procPID to unix id of proc
                repeat with win in (every window of proc)
                  set winName to name of win
                  set winPos to position of win
                  set winSize to size of win
                  set end of windowList to {procName, procPID, winName, item 1 of winPos, item 2 of winPos, item 1 of winSize, item 2 of winSize}
                end repeat
              end repeat
              return windowList
            end tell
          `;
          const output = execSync(`osascript -e '${script}'`, { encoding: "utf8" });
          // Parse output and format
          windows = [{ raw: output }];
        } else {
          throw new Error("Unsupported platform");
        }

        // 清理不在列表中的截图文件
        const screenshotDir = path.join(
          require("os").homedir(),
          "electron-mcp-files",
          "screenshot"
        );
        if (fs.existsSync(screenshotDir)) {
          const validIds = new Set(windows.map((w) => w.windowId.replace(/^0x/, "")));
          const files = fs.readdirSync(screenshotDir);

          for (const file of files) {
            if (file.startsWith("sys_win_") && file.endsWith(".jpeg")) {
              const winId = file.replace("sys_win_", "").replace(".jpeg", "");
              if (!validIds.has(winId)) {
                fs.unlinkSync(path.join(screenshotDir, file));
              }
            }
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  platform: process.platform,
                  total: windows.length,
                  windows,
                },
                null,
                2
              ),
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
    { tag: "System" }
  );

  registerTool(
    "focus_system_window",
    "聚焦指定的系统窗口",
    z.object({
      windowId: z.string().describe("窗口ID（从 get_system_windows 获取）"),
    }),
    async ({ windowId }) => {
      try {
        if (process.platform === "linux") {
          execSync(`wmctrl -ia ${windowId}`);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    windowId,
                    message: "Window focused",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else {
          throw new Error("Unsupported platform");
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
    { tag: "System" }
  );

  registerTool(
    "get_system_info",
    "获取系统信息（CPU、内存、磁盘、负载、IP）",
    z.object({}),
    async () => {
      try {
        const os = require("os");

        // CPU
        const cpus = os.cpus();
        const cpuModel = cpus[0].model;
        const cpuCount = cpus.length;

        // CPU 使用率
        let cpuUsage = 0;
        if (process.platform === "linux") {
          const top = execSync("top -bn1 | grep 'Cpu(s)'", { encoding: "utf8" });
          const match = top.match(/(\d+\.\d+)\s+id/);
          if (match) {
            cpuUsage = (100 - parseFloat(match[1])).toFixed(1) + "%";
          }
        }

        // 内存
        const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
        const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
        const usedMem = (totalMem - freeMem).toFixed(1);

        // 负载
        const loadavg = os.loadavg().map((l) => l.toFixed(2));

        // 磁盘（Linux）
        let disk = {};
        if (process.platform === "linux") {
          const df = execSync("df -h /", { encoding: "utf8" });
          const lines = df.trim().split("\n");
          const parts = lines[1].split(/\s+/);
          disk = {
            total: parts[1],
            used: parts[2],
            available: parts[3],
            usePercent: parts[4],
          };
        }

        // 本地 IP
        const networkInterfaces = os.networkInterfaces();
        const localIPs = [];
        for (const name in networkInterfaces) {
          for (const net of networkInterfaces[name]) {
            if (net.family === "IPv4" && !net.internal) {
              localIPs.push(net.address);
            }
          }
        }

        // 公网 IP
        let publicIP = "";
        try {
          publicIP = execSync("curl -s https://api.myip.com", { encoding: "utf8", timeout: 5000 });
          publicIP = JSON.parse(publicIP);
        } catch (e) {
          publicIP = "Failed to fetch";
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  platform: os.platform(),
                  arch: os.arch(),
                  hostname: os.hostname(),
                  uptime: Math.floor(os.uptime() / 60) + " minutes",
                  cpu: {
                    model: cpuModel,
                    cores: cpuCount,
                    usage: cpuUsage,
                  },
                  memory: {
                    total: totalMem + "G",
                    used: usedMem + "G",
                    free: freeMem + "G",
                  },
                  loadavg: {
                    "1min": loadavg[0],
                    "5min": loadavg[1],
                    "15min": loadavg[2],
                  },
                  disk,
                  network: {
                    localIP: localIPs,
                    publicIP,
                  },
                },
                null,
                2
              ),
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
    { tag: "System" }
  );

  registerTool(
    "system_screenshot",
    "截取系统屏幕并保存到文件",
    z.object({
      quality: z.number().optional().default(80).describe("JPEG 质量 (1-100)"),
      copyToClipboard: z.boolean().optional().default(false).describe("是否复制到剪贴板"),
    }),
    async ({ quality, copyToClipboard }) => {
      try {
        const fs = require("fs");
        const path = require("path");
        const crypto = require("crypto");

        // 创建目录
        const screenshotDir = path.join(
          require("os").homedir(),
          "electron-mcp-files",
          "screenshot"
        );
        if (!fs.existsSync(screenshotDir)) {
          fs.mkdirSync(screenshotDir, { recursive: true });
        }

        // 临时文件
        const tmpFile = `/tmp/screenshot-${Date.now()}.png`;

        // 截图
        if (process.platform === "linux") {
          execSync(`import -window root ${tmpFile}`);
        } else {
          throw new Error("Unsupported platform");
        }

        // 转换为 JPEG
        const jpegFile = path.join(screenshotDir, "system.jpeg");
        execSync(`convert ${tmpFile} -quality ${quality} ${jpegFile}`);

        // 获取文件大小和尺寸
        const stats = fs.statSync(jpegFile);
        const sizeKB = (stats.size / 1024).toFixed(2);
        const identify = execSync(`identify -format "%wx%h" ${jpegFile}`, { encoding: "utf8" });
        const [width, height] = identify.split("x").map(Number);

        // 复制到剪贴板
        if (copyToClipboard) {
          execSync(`xclip -selection clipboard -t image/jpeg -i ${jpegFile}`);
        }

        // 清理临时文件
        fs.unlinkSync(tmpFile);

        // 返回 URL
        const baseUrl =
          process.env.ELECTRON_MCP_BASE_URL || `http://localhost:${process.env.PORT || 8101}`;
        const url = `${baseUrl}/files/screenshot/system.jpeg`;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  path: jpegFile,
                  url,
                  size: sizeKB + "KB",
                  width,
                  height,
                  quality,
                  copiedToClipboard: copyToClipboard,
                },
                null,
                2
              ),
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
    { tag: "System" }
  );

  registerTool(
    "sys_win_screenshot",
    "截取指定系统窗口并保存到文件",
    z.object({
      windowId: z.string().describe("窗口ID（从 get_system_windows 获取）"),
      quality: z.number().optional().default(80).describe("JPEG 质量 (1-100)"),
      copyToClipboard: z.boolean().optional().default(false).describe("是否复制到剪贴板"),
    }),
    async ({ windowId, quality, copyToClipboard }) => {
      try {
        const fs = require("fs");
        const path = require("path");

        // 创建目录
        const screenshotDir = path.join(
          require("os").homedir(),
          "electron-mcp-files",
          "screenshot"
        );
        if (!fs.existsSync(screenshotDir)) {
          fs.mkdirSync(screenshotDir, { recursive: true });
        }

        // 临时文件
        const tmpFile = `/tmp/screenshot-${Date.now()}.png`;

        // 截图
        if (process.platform === "linux") {
          execSync(`import -window ${windowId} ${tmpFile}`);
        } else {
          throw new Error("Unsupported platform");
        }

        // 转换为 JPEG
        const filename = `sys_win_${windowId.replace(/^0x/, "")}.jpeg`;
        const jpegFile = path.join(screenshotDir, filename);
        execSync(`convert ${tmpFile} -quality ${quality} ${jpegFile}`);

        // 获取文件大小和尺寸
        const stats = fs.statSync(jpegFile);
        const sizeKB = (stats.size / 1024).toFixed(2);
        const identify = execSync(`identify -format "%wx%h" ${jpegFile}`, { encoding: "utf8" });
        const [width, height] = identify.split("x").map(Number);

        // 复制到剪贴板
        if (copyToClipboard) {
          execSync(`xclip -selection clipboard -t image/jpeg -i ${jpegFile}`);
        }

        // 清理临时文件
        fs.unlinkSync(tmpFile);

        // 返回 URL
        const baseUrl =
          process.env.ELECTRON_MCP_BASE_URL || `http://localhost:${process.env.PORT || 8101}`;
        const url = `${baseUrl}/files/screenshot/${filename}`;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  windowId,
                  path: jpegFile,
                  url,
                  size: sizeKB + "KB",
                  width,
                  height,
                  quality,
                  copiedToClipboard: copyToClipboard,
                },
                null,
                2
              ),
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
    { tag: "System" }
  );

  registerTool(
    "system_window_setbound",
    "设置系统窗口的位置和大小",
    z.object({
      windowId: z.string().describe("窗口ID（从 get_system_windows 获取）"),
      x: z.number().optional().describe("X 坐标"),
      y: z.number().optional().describe("Y 坐标"),
      width: z.number().optional().describe("宽度"),
      height: z.number().optional().describe("高度"),
    }),
    async ({ windowId, x, y, width, height }) => {
      try {
        if (process.platform === "linux") {
          // 构建 wmctrl 命令
          const gravity = 0; // 左上角
          const flags = [];

          if (x !== undefined || y !== undefined || width !== undefined || height !== undefined) {
            const posX = x !== undefined ? x : -1;
            const posY = y !== undefined ? y : -1;
            const w = width !== undefined ? width : -1;
            const h = height !== undefined ? height : -1;
            execSync(`wmctrl -ir ${windowId} -e ${gravity},${posX},${posY},${w},${h}`);
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    windowId,
                    bounds: { x, y, width, height },
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else {
          throw new Error("Unsupported platform");
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
    { tag: "System" }
  );
}

module.exports = registerTools;
