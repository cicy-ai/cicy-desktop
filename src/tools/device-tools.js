const { z } = require("zod");

// get_device_info — return this machine's identity + detected network/locale
// info, read from global.json (deviceInfo block + deviceId). Instant, no
// network: the egress-IP/region/system-language detection runs at startup
// (src/main.js → cloud-client.detectAndPersistDeviceInfo) and persists here.
// The cicy-code app SPA calls this over electronRPC and forwards it on the
// chat-WS register so the cicy-code backend (and agent-webpage `clients`) can
// see each desktop client's ip / region / system language / deviceId.
module.exports = (registerTool) => {
  registerTool(
    "get_device_info",
    "返回本机 deviceId + 出口公网 IP + IP 所在地区 + 系统语言（读 global.json 的 deviceInfo，秒回，不发网络请求）",
    z.object({}),
    async () => {
      try {
        const info = require("../cloud/cloud-client").getDeviceInfo();
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    },
    { tag: "Device" }
  );
};
