# Electron MCP Service

浏览器自动化服务，提供窗口管理、CDP 操作、JavaScript 执行等功能。

## 使用方法

```bash
# 启动服务
bash skills/electron-mcp-service/electron-mcp-service.sh start

# 验证服务
curl-rpc "name: ping"

# 使用工具
curl-rpc "
name: open_window
arguments:
  url: https://google.com
"
```

## 服务管理

```bash
bash skills/electron-mcp-service/electron-mcp-service.sh start    # 启动
bash skills/electron-mcp-service/electron-mcp-service.sh stop     # 停止
bash skills/electron-mcp-service/electron-mcp-service.sh status   # 状态
bash skills/electron-mcp-service/electron-mcp-service.sh logs     # 日志
bash skills/electron-mcp-service/electron-mcp-service.sh restart  # 重启
```

## 配置

**环境变量:**
- `PORT` - 服务端口（默认 8101）
- `DISPLAY` - X11 显示（默认 :2）

**启动参数:**
```bash
npm start -- --port=8102 --url=https://example.com
```

## 详细文档

查看项目根目录 [README.md](../../README.md)
