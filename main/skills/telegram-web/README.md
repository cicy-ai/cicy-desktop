# Telegram Web 自动化

自动化操作 Telegram Web 版的技能脚本。

## 功能

- 🌐 打开 Telegram Web
- 💬 发送消息到指定聊天
- 📖 读取聊天消息
- 🤖 创建 Telegram Bot 并获取 Token
- 📊 从 IndexedDB 读取数据（用户、聊天、消息）
- 🔧 自动注入 JS 工具函数
- 📱 支持二维码登录（远程使用）

## 核心文件

- `telegram-web.sh` - 主脚本
- `README.md` - 本文档

**注入文件（自动管理）：**
- `~/data/electron/extension/inject/telegram.org.js` - 全局注入的工具函数（由 electron-mcp 自动注入）

## 依赖

```bash
# 安装 curl-rpc
npm install -g curl-rpc

# 启动 electron-mcp 服务
bash skills/electron-mcp-service/service.sh start
```

## ⚠️ Known Limitations

1. **open_chat**: 三种方式打开聊天，推荐 `location.hash`
   ```bash
   # 推荐: location.hash（最简单稳定）
   curl-rpc exec_js win_id=6 code='location.hash="#@BotFather"'
   
   # 方式2: openUsername (内部API)
   curl-rpc exec_js win_id=6 code='window.appImManager.openUsername({userName:"BotFather"})'
   
   # 方式3: setInnerPeer (需要 peerId)
   curl-rpc exec_js win_id=6 code='window.appImManager.setInnerPeer({peerId:93372553})'
   ```

2. **messages store**: IndexedDB only caches loaded messages
   - Open the chat in Telegram Web to load messages
   - Then use `get_messages` to query from IndexedDB
   
3. **get_messages** [推荐]: 从 IndexedDB 读取结构化 JSON，比 DOM 提取更稳定
   ```bash
   # BotFather chatId=93372553
   bash skills/telegram-web/telegram-web.sh get_messages 93372553 5
   ```

4. **create_bot**: Token 通过 `get_messages` 从 BotFather 聊天记录提取
   - Username 规范: `cicy_<name>_bot`
   - 导航用 `location.hash`，不用 `open_chat`

## 使用方法

### 登录指南

```bash
bash skills/telegram-web/telegram-web.sh login
```

**方法 1: 手机扫码登录（推荐）**
1. 打开 Telegram Web
2. 获取二维码：`bash skills/telegram-web/telegram-web.sh qrcode`
3. 在手机 Telegram 中：
   - 打开 Settings（设置）
   - 点击 Devices（设备）
   - 点击 Link Desktop Device（连接桌面设备）
   - 扫描二维码（从截图 `/tmp/telegram-qrcode.png`）
4. 登录成功

**远程使用技巧：**
- 二维码保存到 `~/Desktop/screenshot/telegram-qrcode.png`
- 通过 VNC 查看并扫描
- 或下载到本地扫描

**方法 2: 手机号登录**
1. 打开 Telegram Web
2. 点击 "Log in by phone Number"
3. 输入手机号（带国家码，如 +86）
4. 输入收到的验证码
5. 如果启用了两步验证，输入密码

### 打开 Telegram Web

```bash
bash skills/telegram-web/telegram-web.sh open
```

### 获取当前账户信息

```bash
bash skills/telegram-web/telegram-web.sh account
```

返回：
- User ID
- Account ID
- DC ID

### 获取登录二维码（远程使用）

```bash
bash skills/telegram-web/telegram-web.sh qrcode
```

二维码会保存到 `~/Desktop/screenshot/telegram-qrcode.png`，可以：
- 通过 VNC 查看并扫描
- 下载到本地扫描
- 使用 `xdg-open ~/Desktop/screenshot/telegram-qrcode.png` 打开

### 创建 Telegram Bot

```bash
bash skills/telegram-web/telegram-web.sh create_bot "Bot Name" "cicy_name_bot"
```

自动完成：
1. 导航到 BotFather（`location.hash="#@BotFather"`）
2. 发送 `/newbot` → bot 名称 → bot username
3. 通过 `get_messages(93372553)` 从聊天记录提取 token
4. 保存到 `~/data/tts-tg-bot/token.txt`

**Username 规范：**
- 必须以 `cicy_` 开头，`_bot` 结尾
- 只允许小写字母、数字、下划线
- 示例: `cicy_master_xk_bot`, `cicy_kiro_bot`

```bash
bash skills/telegram-web/telegram-web.sh create_bot "Master XK" "cicy_master_xk_bot"
```

### 从 IndexedDB 获取数据

#### 获取用户列表

```bash
bash skills/telegram-web/telegram-web.sh users 10
```

返回用户信息：id, username, firstName, lastName, phone

#### 获取聊天数据

```bash
bash skills/telegram-web/telegram-web.sh db_chats 10
```

返回聊天信息：id, title, type

#### 获取消息

```bash
bash skills/telegram-web/telegram-web.sh db_messages 20
```

返回消息信息：id, message, date, peerId

### 发送消息

```bash
bash skills/telegram-web/telegram-web.sh send "Saved Messages" "Hello World"
bash skills/telegram-web/telegram-web.sh send "Chat Name" "Your message"
```

### 读取消息

```bash
bash skills/telegram-web/telegram-web.sh read "Saved Messages"
bash skills/telegram-web/telegram-web.sh read "Chat Name"
```

### 显示帮助

```bash
bash skills/telegram-web/telegram-web.sh --help
```

## 自动注入的全局工具

所有工具函数通过 electron-mcp 的 dom-ready 机制自动注入到 `*.telegram.org` 页面。

注入文件位置：`~/data/electron/extension/inject/telegram.org.js`

### 自定义全局工具函数

你可以编辑 `~/data/electron/extension/inject/telegram.org.js` 来添加自己的工具函数：

```javascript
// 添加你的自定义函数
window.tg_myCustomFunction = async () => {
  // 你的代码
  return "result";
};
```

**使用自定义函数：**

```bash
# 在脚本中调用
curl-rpc exec_js win_id=1 code="window.tg_myCustomFunction()"

# 或在 telegram-web.sh 中
result=$(curl-rpc exec_js win_id="$WIN_ID" code="window.tg_myCustomFunction()" 2>&1 | sed -n '/^---/,/^---/p' | sed '1d;$d')
```

**注意：** 修改后需要刷新页面才能生效。

### 基础工具

#### window.getIndexedDBRows(dbName, storeName, limit)

从 IndexedDB 读取数据。

**参数：**
- `dbName` - 数据库名称（如 "tweb-account-1"）
- `storeName` - Store 名称（如 "messages", "users", "chats"）
- `limit` - 限制返回数量（默认 100）

**示例：**
```javascript
// 获取消息
const messages = await getIndexedDBRows('tweb-account-1', 'messages', 50);

// 获取用户
const users = await getIndexedDBRows('tweb-account-1', 'users', 20);

// 获取聊天
const chats = await getIndexedDBRows('tweb-account-1', 'chats', 10);
```

### window.listIndexedDB()

列出所有 IndexedDB 数据库和 stores。

**示例：**
```javascript
const dbs = await listIndexedDB();
console.log(dbs);
// {
//   "tweb-account-1": ["chats", "dialogs", "messages", "users", ...],
//   "tweb-account-2": [...],
//   ...
// }
```

### Telegram 专用工具

所有 Telegram 专用函数都以 `tg_` 前缀命名：

- `window.tg_getAccount()` - 获取账户信息
- `window.tg_getDialogs(limit)` - 获取对话列表（peerId）
- `window.tg_getChats(limit)` - 获取聊天列表（含名称、未读数）
- `window.tg_getUsers(limit)` - 获取用户列表
- `window.tg_getMessages(limit)` - 获取消息列表
- `window.tg_getChatMessages(chatId, limit)` - 获取指定聊天的消息
- `window.tg_findQRCode()` - 查找二维码元素
- `window.tg_clickSearch()` - 点击搜索框
- `window.tg_extractBotToken()` - 提取 Bot Token
- `window.tg_readCurrentMessages(limit)` - 读取当前页面的消息

**示例：**
```javascript
// 获取聊天列表
const chats = await window.tg_getChats(10);
console.log(chats); // [{chatId, name, updated, unread}, ...]

// 获取用户列表
const users = await window.tg_getUsers(5);
console.log(users); // [{id, username, firstName, lastName}, ...]

// 获取指定聊天的消息
const messages = await window.tg_getChatMessages(-123456789, 20);
console.log(messages); // [{id, message, date, fromId}, ...]
```

### 在脚本中使用全局工具

**方法 1: 直接调用（简单）**
```bash
curl-rpc exec_js win_id=1 code="window.tg_getChats(5).then(c => c.map(x => x.name).join(','))"
```

**方法 2: 在 shell 脚本中使用**
```bash
#!/bin/bash
WIN_ID=1

# 获取聊天列表
chats=$(curl-rpc exec_js win_id="$WIN_ID" code="window.tg_getChats(10).then(c => JSON.stringify(c, null, 2))" 2>&1 | sed -n '/^---/,/^---/p' | sed '1d;$d')

echo "$chats"
```

**方法 3: 创建自定义函数**
```bash
# 编辑 ~/data/electron/extension/inject/telegram.org.js
window.tg_myFunction = async () => {
  const chats = await window.tg_getChats(5);
  const users = await window.tg_getUsers(5);
  return { chats, users };
};

# 使用
curl-rpc exec_js win_id=1 code="window.tg_myFunction().then(r => JSON.stringify(r))"
```

## IndexedDB 数据结构

### 数据库

- `tweb-account-1` - 账户 1 的数据
- `tweb-account-2` - 账户 2 的数据
- `tweb-account-3` - 账户 3 的数据
- `tweb-account-4` - 账户 4 的数据
- `tweb-common` - 公共数据

### Stores（每个账户数据库）

- `chats` / `chats__encrypted` - 聊天信息
- `dialogs` / `dialogs__encrypted` - 对话列表
- `messages` / `messages__encrypted` - 消息
- `session` / `session__encrypted` - 会话数据
- `stickerSets` / `stickerSets__encrypted` - 贴纸集
- `users` / `users__encrypted` - 用户信息
- `webapp` / `webapp__encrypted` - Web 应用数据

## 💡 重要提示：ID 类型区分

Telegram 中有三种不同的 ID 类型，**不要混淆**：

### 1. User ID（用户 ID）
- **格式**: 正整数（如 `7593582088`）
- **用途**: 标识单个用户或 Bot
- **示例**: 
  - `7593582088` - lvdou_dev_bot
  - `7943234085` - w3c_service
  - `777000` - Telegram 官方

### 2. Chat ID（群组/频道 ID）
- **格式**: 负整数（如 `-2794462766`）
- **用途**: 标识群组或频道
- **示例**:
  - `-2794462766` - 某个群组
  - `-4820103100` - 某个频道

### 3. Bot ID（机器人 ID）
- **格式**: 正整数（如 `6085877226`）
- **用途**: 标识 Bot（Bot 也是用户）
- **特点**: Bot ID 就是 User ID

### 如何区分？

```javascript
// 通过 ID 判断类型
const id = -2794462766;

if (id > 0) {
  console.log("这是用户或 Bot");
} else {
  console.log("这是群组或频道");
}
```

### 获取 ID 的方法

```bash
# 获取聊天列表（包含所有类型的 ID）
bash telegram-web.sh chats

# 输出示例：
# {
#   "chatId": 7593582088,        # 正数 = 用户/Bot
#   "name": "lvdou_dev_bot"
# }
# {
#   "chatId": -2794462766,       # 负数 = 群组
#   "name": "某个群组"
# }
```

### 使用 ID 获取消息

```bash
# 获取 Bot 的消息（正数 ID）
bash telegram-web.sh get_messages 7593582088 20

# 获取群组的消息（负数 ID）
bash telegram-web.sh get_messages -2794462766 20
```

### ⚠️ 常见错误

```bash
# ❌ 错误：混淆 Bot 名称和 ID
bash telegram-web.sh get_messages lvdou_dev_bot 20

# ✅ 正确：使用数字 ID
bash telegram-web.sh get_messages 7593582088 20
```

## 工作流程

### 发送消息流程

1. 打开 Telegram Web（首次使用）
2. 点击搜索框
3. 输入聊天名称
4. 选择聊天
5. 输入消息
6. 发送

### 读取消息流程

1. 打开聊天
2. 提取最新 5 条消息
3. 返回消息内容和时间

## 示例

### 完整工作流

```bash
# 1. 打开 Telegram Web
bash skills/telegram-web/telegram-web.sh open

# 2. 等待登录（手动扫码）

# 3. 发送消息到 Saved Messages
bash skills/telegram-web/telegram-web.sh send "Saved Messages" "Test message"

# 4. 读取消息
bash skills/telegram-web/telegram-web.sh read "Saved Messages"
```

### 自动化脚本

```bash
#!/bin/bash

# 打开 Telegram
bash skills/telegram-web/telegram-web.sh open

# 等待登录
echo "Please login to Telegram Web..."
read -p "Press Enter after login..."

# 发送多条消息
bash skills/telegram-web/telegram-web.sh send "Saved Messages" "Message 1"
bash skills/telegram-web/telegram-web.sh send "Saved Messages" "Message 2"
bash skills/telegram-web/telegram-web.sh send "Saved Messages" "Message 3"

# 读取消息
bash skills/telegram-web/telegram-web.sh read "Saved Messages"
```

## 注意事项

- ⚠️ 首次使用需要手动登录（扫码）
- ⚠️ 聊天名称必须精确匹配
- ⚠️ 需要等待页面加载完成
- ⚠️ 消息发送有延迟（sleep）

## 故障排除

### 错误：curl-rpc not found

```bash
npm install -g curl-rpc
```

### 错误：electron-mcp service not running

```bash
bash skills/electron-mcp-service/service.sh start
```

### 错误：Telegram Web not opened

```bash
bash skills/telegram-web/telegram-web.sh open
```

### 消息发送失败

- 检查聊天名称是否正确
- 确认已登录 Telegram Web
- 增加 sleep 延迟时间

## 高级用法

### 自定义选择器

编辑脚本中的 CSS 选择器以适配不同版本的 Telegram Web：

```bash
# 搜索框
document.querySelector('input[type="search"]')

# 消息列表
document.querySelectorAll('.message')

# 消息内容
.querySelector('.text-content')
```

### 批量操作

```bash
# 批量发送消息
for msg in "Hello" "World" "Test"; do
    bash skills/telegram-web/telegram-web.sh send "Saved Messages" "$msg"
    sleep 2
done
```

## 相关文档

- [electron-mcp README](../README.md)
- [curl-rpc 文档](https://github.com/cicy-dev/electron-mcp/blob/main/packages/curl-rpc/README.md)
- [Telegram Web](https://web.telegram.org/k/)
