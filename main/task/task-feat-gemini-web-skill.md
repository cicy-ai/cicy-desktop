# 任务：Gemini Web 技能模块

## 需求描述

创建一个新的 Electron MCP 技能模块 `hook-gemini`，类似于现有的 `hook-chatgpt.js`，用于自动化操作 Gemini Web (gemini.google.com)。

## 实现方案

### 技术架构

- **MCP 工具注册**：在 `src/tools/` 目录下创建 `hook-gemini.js`
- **DOM 交互**：通过 Electron 的 `webContents.executeJavaScript` 执行 JavaScript
- **IndexedDB 访问**：读取 Gemini Web 本地存储的对话数据

### 目录结构

```
src/tools/
└── hook-gemini.js    # 新增：Gemini Web 自动化工具
```

### 核心功能

1. **对话管理**
   - `get_gemini_web_conversations` - 获取对话列表
   - `get_gemini_web_current_messages` - 获取当前对话消息
   - `get_gemini_web_messages_by_id` - 通过 ID 获取对话消息
   - `open_gemini_web_chat_by_id` - 打开指定对话

2. **登录状态**
   - `is_gemini_logged` - 检查登录状态

3. **页面状态**
   - `gemini_web_status` - 获取页面状态（登录、URL、输入框状态）

4. **消息操作**
   - `gemini_web_clear_prompt` - 清除输入框
   - `gemini_web_set_prompt` - 设置输入框内容
   - `gemini_web_click_send` - 点击发送按钮

5. **完整流程**
   - `gemini_web_ask` - 提问并等待回复

## TODO 清单

- [x] 创建 `src/tools/hook-gemini.js`
- [x] 实现对话列表获取功能
- [x] 实现消息获取功能
- [x] 实现登录状态检查
- [x] 实现页面状态获取
- [x] 实现输入框操作
- [x] 实现发送消息功能
- [x] 实现完整提问流程
- [x] 在 `src/tools/index.js` 中注册新模块
- [ ] 测试验证

## 关键实现细节

### Gemini Web URL 结构

- 主站：`https://gemini.google.com`
- 对话页面：`https://gemini.google.com/app`
- 带 ID：`https://gemini.google.com/app?dialog={conversation_id}`

### DOM 选择器

- 输入框：`rich-textarea > div > p` 或 `textarea[aria-label="Type something"]`
- 发送按钮：`div[class*="send-button-container"] > button`
- 登录按钮：`button[data-testid="sign-in-button"]` 或类似

### IndexedDB 数据库

- 需要探索 Gemini Web 的 IndexedDB 结构
- 可能的数据库名：`gemini-chats` 或类似

### 等待响应策略

- 监听 "Stop" 按钮消失
- 监听 "Microphone" 按钮出现
- 检查最后一条消息是否为assistant角色

## 验收标准

- [ ] 成功获取对话列表
- [ ] 成功获取对话消息
- [ ] 成功打开指定对话
- [ ] 正确检测登录状态
- [ ] 成功设置和清除输入框
- [ ] 成功发送消息并获取回复
- [ ] 所有工具注册到 MCP
