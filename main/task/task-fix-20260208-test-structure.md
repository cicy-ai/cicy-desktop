# 任务：测试结构重构 - 统一使用 RPC 方式

## 需求描述
将 `tests/` 目录下所有使用 MCP SSE 方式的测试文件重写为 RPC 方式，并移动到 `tests/rpc/` 目录。

## 实现方案

### 技术变更
- **旧方式**：MCP SSE (Server-Sent Events) - 需要建立持久连接
- **新方式**：RPC (JSON-RPC over HTTP) - 简单的 HTTP POST 请求

### 优势
- ✅ 更简单 - 无需管理 SSE 连接
- ✅ 更快 - 同步返回结果
- ✅ 更稳定 - 无状态请求
- ✅ 易调试 - 可直接用 curl 测试

### 需要迁移的文件
```
tests/
├── api.window-tools.test.js          → tests/rpc/window-tools.test.js
├── api.set-window-bounds.test.js     → tests/rpc/set-window-bounds.test.js
├── api.ping.test.js                  → tests/rpc/ping.test.js (已存在于 basic-tools)
├── api.exec-js.test.js               → tests/rpc/exec-js.test.js
├── api.cdp-tools.test.js             → tests/rpc/cdp-tools.test.js
├── api.error-handling.test.js        → tests/rpc/error-handling.test.js
├── api.window-lifecycle.test.js      → tests/rpc/window-lifecycle.test.js
├── api.large-request.test.js         → tests/rpc/large-request.test.js
├── api.show-float-div.test.js        → tests/rpc/show-float-div.test.js
├── api.cdp-big-input.test.js         → tests/rpc/cdp-big-input.test.js
├── api.cdp-tools-action.test.js      → tests/rpc/cdp-tools-action.test.js
├── api.cdp-with-toast.test.js        → tests/rpc/cdp-with-toast.test.js
├── api.show-overlays.test.js         → tests/rpc/show-overlays.test.js
├── api.multi-account.test.js         → tests/rpc/multi-account.test.js
├── api.webpage-snapshot.test.js      → tests/rpc/webpage-snapshot.test.js
├── api.get-window-info.test.js       → tests/rpc/get-window-info.test.js
├── api.event-trigger.test.js         → tests/rpc/event-trigger.test.js
├── api.cdp-keyboard.test.js          → tests/rpc/cdp-keyboard.test.js
├── api.window-monitor.test.js        → tests/rpc/window-monitor.test.js
├── mcp.test.js                       → 删除（RPC 不需要）
├── auth.test.js                      → tests/rpc/auth.test.js
├── process-utils.test.js             → tests/rpc/process-utils.test.js
├── network-capture.test.js           → tests/rpc/network-capture.test.js
├── demo-pretty-log.test.js           → tests/rpc/demo-pretty-log.test.js
└── showFloatdiv.test.js              → tests/rpc/show-float-div.test.js (合并)
```

## TODO 清单 - 测试重构完成

### 基本 RPC 测试 (保留在 tests/rpc/)
- [x] basic-tools.test.js - 基础工具测试
- [x] rpc-tools.test.js - RPC 调用测试
- [x] rest-api.test.js - REST API 测试
- [x] all-tools.test.js - 所有工具列表测试
- [x] error-handling.test.js - 错误处理测试

### 功能测试 (移到 skills/)
- [x] skills/window-management/ - 窗口管理测试
- [x] skills/cdp-automation/ - CDP 自动化测试
- [x] skills/javascript/ - JavaScript 执行测试
- [x] skills/network/ - 网络监控测试
- [x] skills/multi-account/ - 多账户测试

## 验收标准
- [x] 所有基本 RPC 测试通过
- [x] 功能测试移到 skills/ 目录
- [x] 测试结构清晰，易于维护
- [x] 代码符合规范
