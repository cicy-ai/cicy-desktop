const { z } = require("zod");
const downloadManager = require("../utils/download-manager");

module.exports = (registerTool) => {
  // 获取下载列表
  registerTool(
    "get_downloads",
    "获取所有下载记录",
    z.object({}),
    async () => {
      try {
        const downloads = downloadManager.getAllDownloads();
        return { content: [{ type: "text", text: JSON.stringify(downloads, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Network" }
  );

  // 获取单个下载信息
  registerTool(
    "get_download",
    "获取指定下载的详细信息",
    z.object({
      id: z.number().describe("下载ID"),
    }),
    async ({ id }) => {
      try {
        const download = downloadManager.getDownload(id);
        if (!download) {
          return { content: [{ type: "text", text: `Download ${id} not found` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(download, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Network" }
  );

  // 清空下载记录
  registerTool(
    "clear_downloads",
    "清空所有下载记录",
    z.object({}),
    async () => {
      try {
        downloadManager.clearDownloads();
        return { content: [{ type: "text", text: "All downloads cleared" }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Network" }
  );
};
