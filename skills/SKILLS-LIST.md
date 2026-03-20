# Skills List

## 服务管理

### cicy-desktop server

```bash
bash skills/cicy-desktop-service/service.sh start    # 启动服务
bash skills/cicy-desktop-service/service.sh stop     # 停止服务
bash skills/cicy-desktop-service/service.sh status   # 查看状态
bash skills/cicy-desktop-service/service.sh logs     # 查看日志
bash skills/cicy-desktop-service/service.sh restart  # 重启服务
```

**验证服务:**

```bash
cicy-rpc ping  # 应返回 "Pong"
```

**安装 cicy-rpc:**

```bash
npm install -g cicy-rpc
```

---

## 可用技能

### cicy-desktop-service

**位置:** `./cicy-desktop-service`  
**功能:** 浏览器自动化服务

```bash
bash skills/cicy-desktop-service/service.sh start
cicy-rpc ping
```

[文档](./cicy-desktop-service/README.md)

---

### cicy-rpc

**位置:** `../packages/cicy-rpc`  
**类型:** npm 包  
**功能:** 轻量级 CiCy Desktop RPC 命令行工具

```bash
# 安装
npm install -g cicy-rpc

# 测试连接
cicy-rpc ping

# 查看Tools <<important>>
cicy-rpc tools
cicy-rpc tools <tool_name>
cicy-rpc tools --full    # 显示所有工具+参数

# 示例
cicy-rpc init                 # 初始化配置
cicy-rpc tools ping          # 查看 ping 工具详情
cicy-rpc open_window url=https://example.com

环境变量:
  CICY_NODE=0         选择节点 (0, 1, 2, ...)
  DEBUG=1                     输出调试信息 (curl -v)

配置: ~/global.json
```

**特性:**

- 🚀 简化语法：`cicy-rpc tool_name key=value`
- 📋 工具列表：`cicy-rpc tools`
- 📖 工具详情：`cicy-rpc tools <tool_name>`
- 🔒 自动Token认证
- 📖 详细文档

[完整文档](../packages/cicy-rpc/README.md)

---

### telegram-web

**位置:** `./telegram-web`
**功能:** Telegram Web 自动化

```bash
# 打开 Telegram Web
bash skills/telegram-web/telegram-web.sh open

# 获取登录二维码
bash skills/telegram-web/telegram-web.sh qrcode

# 获取聊天列表
bash skills/telegram-web/telegram-web.sh chats

# 发送消息
bash skills/telegram-web/telegram-web.sh send "Saved Messages" "Hello"
```

[文档](./telegram-web/README.md)

---

### download-douyin-video

**位置:** `./download-douyin-video`  
**功能:** 下载抖音视频

```bash
bash skills/download-douyin-video/download-douyin-video.sh <url>
```

**依赖:** cicy-desktop 服务 + jq

[文档](./download-douyin-video/README.md)

---

### gemini-web

**位置:** `./gemini-web`  
**功能:** Gemini Web 自动化

```bash
# 查看状态
cicy-rpc gemini_web_status

# 检查登录
cicy-rpc is_gemini_logged

# 粘贴图片到输入框
cicy-rpc gemini_paste_image

# 设置问题并发送
cicy-rpc gemini_web_set_prompt text="问题"
cicy-rpc gemini_web_click_send

# 发送消息并等待回复
cicy-rpc gemini_web_ask text="你好"
```

[文档](./gemini-web/README.md)

---

### chatgpt-web

**位置:** `./chatgpt-web`  
**功能:** ChatGPT Web 自动化

```bash
# 查看状态
bash skills/chatgpt-web/chatgpt-web.sh status

# 对话列表
bash skills/chatgpt-web/chatgpt-web.sh conversations

# 提问
bash skills/chatgpt-web/chatgpt-web.sh ask 你好

# 打开对话
bash skills/chatgpt-web/chatgpt-web.sh open <conversation_id>
```

[文档](./chatgpt-web/README.md)
