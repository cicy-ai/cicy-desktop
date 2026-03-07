# Multi-Account Skill

多账户隔离管理工具，支持同时打开多个独立的浏览器会话。

## 功能特性

- ✅ 多账户窗口创建（独立 Cookie 和 Session）
- ✅ 账户信息管理
- ✅ 窗口列表查看
- ✅ 窗口关闭管理

## 使用方法

### 打开新账户窗口

```bash
# 打开 Telegram（账户1）
bash multi-account.sh open https://web.telegram.org/k/ account1

# 打开 Telegram（账户2）
bash multi-account.sh open https://web.telegram.org/k/ account2

# 自动生成账户名
bash multi-account.sh open https://web.telegram.org/k/
```

### 列出所有窗口

```bash
bash multi-account.sh list
```

### 关闭窗口

```bash
bash multi-account.sh close 1
```

## 环境变量

- `MCP_URL` - MCP 服务器地址（默认: http://localhost:8101）

## 应用场景

1. **多账户测试** - 同时测试多个 Telegram 账户
2. **账户隔离** - 每个窗口独立的 Cookie 和 Session
3. **自动化任务** - 批量操作多个账户

## 示例

```bash
# 打开3个不同的 Telegram 账户
bash multi-account.sh open https://web.telegram.org/k/ work
bash multi-account.sh open https://web.telegram.org/k/ personal
bash multi-account.sh open https://web.telegram.org/k/ test

# 查看所有窗口
bash multi-account.sh list

# 关闭指定窗口
bash multi-account.sh close 2
```

## 技术实现

- 使用 curl-rpc 调用 electron-mcp API
- 每个账户使用独立的 userData 目录
- 完全隔离的浏览器环境
