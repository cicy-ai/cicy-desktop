const { z } = require("zod");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILES_DIR = path.join(require("os").homedir(), "electron-mcp-files");

function registerTools(registerTool) {
  // 文本文件工具（默认 UTF-8）
  registerTool(
    "file_read",
    "读取文本文件内容",
    z.object({
      path: z.string().describe("文件路径"),
    }),
    async ({ path: filePath }) => {
      try {
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }

        const content = fs.readFileSync(filePath, "utf8");
        const stats = fs.statSync(filePath);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  path: filePath,
                  size: stats.size,
                  content,
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
    { tag: "File" }
  );

  registerTool(
    "file_write",
    "写入文本文件内容",
    z.object({
      path: z.string().describe("文件路径"),
      content: z.string().describe("文件内容"),
    }),
    async ({ path: filePath, content }) => {
      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(filePath, content, "utf8");
        const stats = fs.statSync(filePath);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  path: filePath,
                  size: stats.size,
                  message: `File written: ${stats.size} bytes`,
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
    { tag: "File" }
  );

  // 文件上传下载（通过 HTTP）
  registerTool(
    "file_upload",
    "上传文件到服务器（base64编码），返回可访问的 URL",
    z.object({
      filename: z.string().describe("文件名"),
      content: z.string().describe("文件内容（base64编码）"),
    }),
    async ({ filename, content }) => {
      try {
        if (!fs.existsSync(FILES_DIR)) {
          fs.mkdirSync(FILES_DIR, { recursive: true });
        }

        const hash = crypto.createHash("md5").update(content).digest("hex").slice(0, 8);
        const ext = path.extname(filename);
        const basename = path.basename(filename, ext);
        const uniqueFilename = `${basename}-${hash}${ext}`;
        const filePath = path.join(FILES_DIR, uniqueFilename);

        const buffer = Buffer.from(content, "base64");
        fs.writeFileSync(filePath, buffer);
        const stats = fs.statSync(filePath);

        const baseUrl =
          process.env.ELECTRON_MCP_BASE_URL || `http://localhost:${process.env.PORT || 8101}`;
        const url = `${baseUrl}/files/${uniqueFilename}`;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  filename: uniqueFilename,
                  path: filePath,
                  url,
                  size: stats.size,
                  message: `File uploaded: ${stats.size} bytes`,
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
    { tag: "File" }
  );

  registerTool(
    "file_download",
    "从本地路径下载文件，复制到服务器并返回 URL",
    z.object({
      path: z.string().describe("本地文件路径"),
    }),
    async ({ path: filePath }) => {
      try {
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }

        if (!fs.existsSync(FILES_DIR)) {
          fs.mkdirSync(FILES_DIR, { recursive: true });
        }

        const stats = fs.statSync(filePath);
        const buffer = fs.readFileSync(filePath);
        const hash = crypto.createHash("md5").update(buffer).digest("hex").slice(0, 8);
        const ext = path.extname(filePath);
        const basename = path.basename(filePath, ext);
        const uniqueFilename = `${basename}-${hash}${ext}`;
        const destPath = path.join(FILES_DIR, uniqueFilename);

        fs.copyFileSync(filePath, destPath);

        const baseUrl =
          process.env.ELECTRON_MCP_BASE_URL || `http://localhost:${process.env.PORT || 8101}`;
        const url = `${baseUrl}/files/${uniqueFilename}`;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  filename: uniqueFilename,
                  path: destPath,
                  url,
                  size: stats.size,
                  message: `File copied: ${stats.size} bytes`,
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
    { tag: "File" }
  );
}

module.exports = registerTools;
