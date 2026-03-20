const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 18102;
const BASE_URL = `http://localhost:${PORT}`;

// 读取 token
const tokenPath = path.join(os.homedir(), "global.json");
const authToken = fs.existsSync(tokenPath) ? (JSON.parse(fs.readFileSync(tokenPath, "utf8")).api_token || "") : "";

async function getAllTools() {
  const response = await axios.get(`${BASE_URL}/rpc/tools`, {
    headers: {
      Authorization: `Bearer ${authToken}`,
      Connection: "close",
    },
  });
  return response.data.tools;
}

describe("All RPC Tools", () => {
  let allTools = [];

  beforeAll(async () => {
    allTools = await getAllTools();
    console.log(`\n📋 发现 ${allTools.length} 个工具\n`);
  });

  test("should list all tools", () => {
    expect(allTools.length).toBeGreaterThan(0);
    allTools.forEach((tool) => {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
    });
  });

  test("should have all expected tools", () => {
    const toolNames = allTools.map((t) => t.name);

    // 基础工具
    expect(toolNames).toContain("ping");
    expect(toolNames).toContain("get_windows");
    expect(toolNames).toContain("open_window");
    expect(toolNames).toContain("close_window");

    // CDP 工具
    expect(toolNames).toContain("cdp_click");
    expect(toolNames).toContain("cdp_type_text");

    // JS 执行
    expect(toolNames).toContain("exec_js");

    console.log(`\n✅ 所有预期工具都存在\n`);
  });

  test("should print all tools", () => {
    console.log("\n📝 所有可用工具：\n");
    allTools.forEach((tool, index) => {
      console.log(`${index + 1}. ${tool.name}`);
      console.log(`   ${tool.description.substring(0, 80)}...`);
    });
    console.log("");
  });
});
