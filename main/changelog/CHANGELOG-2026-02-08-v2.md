# 更新日志 - 2026-02-08

## 🎉 重大更新

### 1. 模块化架构重构
- 将 main.js 拆分为多个独立模块
- 新增 `src/server/` 目录，包含：
  - `electron-setup.js` - Electron 配置
  - `args-parser.js` - 参数解析
  - `logging.js` - 日志系统
  - `express-app.js` - Express 应用
  - `mcp-server.js` - MCP 服务器
  - `tool-registry.js` - 工具注册
- 代码更清晰，易于维护和测试

### 2. 🔥 热重载支持
- 修改 `src/tools/` 或 `src/utils/` 中的代码无需重启 Electron
- 每次 RPC 调用自动加载最新代码
- 大幅提升开发效率

### 3. YAML 响应支持
- `/rpc/tools/call` 端点支持 YAML 格式响应
- 根据 `Accept: application/yaml` header 自动返回 YAML
- 与 curl-rpc 工具完美配合

### 4. service.sh 增强
- 支持自定义 DISPLAY 参数
- 默认使用 DISPLAY=:2
- 用法：`./service.sh start [port] [display]`
- 示例：`./service.sh start 8102 :1`

### 5. curl-rpc 工具修复
- 修复端点路径为 `/rpc/tools/call`
- 支持 YAML 输入和 YAML 输出
- 自动解析响应内容

## 📝 文档更新
- 更新 README.md 核心特性
- 添加热重载开发说明
- 更新 service.sh 使用文档
- 完善项目结构说明

## 🏷️ 版本标签
- `v1.1.0-yaml-support` - YAML 支持和窗口控制功能

## 🔧 技术改进
- 代码模块化，职责分离
- 热重载机制，提升开发体验
- YAML 格式支持，节省 token
- 更灵活的服务管理

## 📦 文件变更
- 新增：`src/server/` 目录及所有模块
- 修改：`src/main.js` - 简化为 130 行
- 修改：`service.sh` - 添加 DISPLAY 参数
- 修改：`bin/curl-rpc` - 修复端点和 YAML 支持
- 更新：`README.md` - 完善文档

## 🚀 下一步计划
- [ ] 添加更多测试用例
- [ ] 优化热重载性能
- [ ] 支持更多 CDP 功能
- [ ] 完善错误处理
