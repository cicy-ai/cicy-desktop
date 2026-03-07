# ChatGPT Web 自动化

ChatGPT Web 自动化工具，通过 IndexedDB 读取对话、发送消息、获取回复。

## 自动检测

启动时自动检测:

1. 检查 electron-mcp 服务，如未运行则启动
2. 检查 ChatGPT 窗口，如不存在则打开
3. 检查登录状态，未登录提示手动登录

## 使用方法

```bash
bash skills/chatgpt-web/chatgpt-web.sh <command>
```

## 命令

### 状态

```bash
bash skills/chatgpt-web/chatgpt-web.sh status
```

### 对话列表

```bash
bash skills/chatgpt-web/chatgpt-web.sh conversations
bash skills/chatgpt-web/chatgpt-web.sh conversations 5  # 指定数量
```

### 当前消息

```bash
bash skills/chatgpt-web/chatgpt-web.sh messages
```

### 提问

```bash
bash skills/chatgpt-web/chatgpt-web.sh ask <text>
# 示例
bash skills/chatgpt-web/chatgpt-web.sh ask 你好
bash skills/chatgpt-web/chatgpt-web.sh ask "what is 2+2?"
```

### 打开对话

```bash
bash skills/chatgpt-web/chatgpt-web.sh open <conversation_id>
```

### 登录检查

```bash
bash skills/chatgpt-web/chatgpt-web.sh is-logged
```

## MCP 工具

直接使用 curl-rpc:

```bash
# 状态
curl-rpc chatgpt_web_status

# 对话列表
curl-rpc get_chatgpt_web_conversations limit=5

# 当前消息
curl-rpc get_chatgpt_web_current_messages

# 提问 (自动发送+等待回复)
curl-rpc chatgpt_web_ask text="你好"

# 打开对话
curl-rpc open_chatgpt_web_chat_by_id conversation_id=xxx
```

## 依赖

- electron-mcp 服务
- 登录 ChatGPT Web
