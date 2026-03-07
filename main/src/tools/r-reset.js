const { z } = require("zod");

module.exports = (registerTool) => {
  registerTool(
    "r-reset",
    "清除 require 缓存，重新加载 tools 和 utils 模块",
    z.object({}),
    async () => {
      let count = 0;
      Object.keys(require.cache).forEach((key) => {
        if (key.includes("/tools/") || key.includes("/utils/")) {
          delete require.cache[key];
          count++;
        }
      });
      return {
        content: [
          {
            type: "text",
            text: `Cleared ${count} cached modules. Next request will use fresh code.`,
          },
        ],
      };
    },
    { tag: "System" }
  );
};
