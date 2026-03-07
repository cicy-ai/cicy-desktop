# 任务：AI Studio 技能模块

## 需求描述
创建一个新的 Electron MCP 技能模块 `aistudio`，位于 `./skills/aistudio` 目录。
该模块通过 HTTP 调用 electron-mcp 服务，实现 AI Studio 相关的自动化操作。

## 实现方案

### 技术架构
- **MCP 客户端封装**：使用 axios 调用 electron-mcp HTTP API
- **端口可配置**：支持自定义 electron-mcp 服务端口（默认 8101）
- **工具封装**：封装常用的 AI Studio 操作

### 目录结构
```
skills/aistudio/
├── index.js                    # MCP 客户端封装
├── tools/
│   └── aistudio-tools.js      # AI Studio 工具实现
├── config.js                   # 配置文件
├── package.json
├── README.md
└── tests/
    └── aistudio.test.js
```

### 核心功能
1. **MCP 客户端**：封装与 electron-mcp 服务的通信
2. **打开窗口**：调用 open_window 工具打开 AI Studio
3. **配置管理**：支持端口等配置项

## TODO 清单
- [x] 创建目录结构
- [x] 实现 MCP 客户端封装 (index.js)
- [x] 实现配置管理 (config.js)
- [x] 实现 AI Studio 工具 (tools/aistudio-tools.js)
- [x] 创建 package.json
- [x] 编写 README 文档
- [x] 编写测试用例
- [ ] 运行测试验证
- [ ] 提交代码

## 验收标准
- [x] 成功连接到 electron-mcp 服务
- [x] 成功打开 AI Studio 窗口
- [x] 端口可通过配置文件自定义
- [x] 返回窗口 ID 供后续操作
- [ ] 所有测试通过
- [ ] 代码符合规范
- [ ] 文档完整
