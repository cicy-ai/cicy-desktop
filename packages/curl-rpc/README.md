# curl-rpc

轻量级 MCP RPC 调用工具，用于调用 Electron MCP 服务器。

## 特性

- 🚀 **简化语法** - 最简洁的调用方式：`curl-rpc tool_name key=value`
- 📋 **工具列表** - `curl-rpc list` 查看所有可用工具
- 📝 **YAML 优先** - 默认 YAML 格式，节省 30% token
- 🔄 **JSON 支持** - 使用 `--json` 或 `-j` 标志切换到 JSON
- ✅ **完善的错误处理** - 清晰的错误提示和建议
- 🔒 **Token 认证** - 自动从配置读取
- 🌐 **多节点支持** - 支持多个服务器配置
- 🔧 **初始化配置** - `curl-rpc init` 快速配置
- 🐛 **调试模式** - `DEBUG=1` 输出详细信息

## 安装

```bash
# 全局安装（推荐）
npm install -g curl-rpc

# 或者从项目安装
cd /home/w3c_offical/projects/electron-mcp/main/packages/curl-rpc
sudo npm install -g .
```

## 快速开始

```bash
# 测试连接
curl-rpc ping

# 列出所有工具
curl-rpc list

# 打开窗口
curl-rpc open_window url=https://google.com

# 获取下载列表
curl-rpc get_downloads
```

## 使用方法

### 1. 列出所有工具

```bash
curl-rpc list
```

输出示例：

```
📋 获取工具列表...

ping
  测试 MCP 服务器连接
  用法: curl-rpc ping

open_window
  打开新窗口或重用现有窗口
  用法: curl-rpc open_window url=<value>

get_downloads
  获取所有下载记录
  用法: curl-rpc get_downloads

💡 详细文档: https://github.com/cicy-dev/electron-mcp
```

### 2. 简化语法（推荐）

```bash
# 无参数工具
curl-rpc ping

# 单参数
curl-rpc open_window url=https://google.com

# 多参数
curl-rpc exec_js win_id=1 code='document.title'

# 带引号的参数
curl-rpc cdp_type_text win_id=1 text="Hello World"
```

### 3. 查看工具详情

每个工具的详细用法、参数说明、返回值示例，请查看：

**📖 完整文档**: https://github.com/cicy-dev/electron-mcp

## 完整工具参考

### 窗口管理

#### ping - 测试连接

```bash
curl-rpc ping
```

**响应:**

```
Pong v:2 2026-02-13 16:00:00
```

#### open_window - 打开窗口

```bash
# 基本用法
curl-rpc open_window url=https://google.com

# 指定大小和位置
curl-rpc open_window url=https://google.com width=800 height=600 x=100 y=100
```

**响应:**

```json
{
  "message": "Opened window with ID: 1",
  "winId": 1
}
```

#### get_windows - 获取所有窗口

```bash
curl-rpc get_windows
```

**响应:**

```json
[
  {
    "id": 1,
    "title": "Google",
    "url": "https://google.com",
    "bounds": { "x": 0, "y": 0, "width": 1200, "height": 800 }
  }
]
```

#### close_window - 关闭窗口

```bash
curl-rpc close_window win_id=1
```

**响应:**

```
Closed 1
```

### JavaScript执行

#### exec_js - 执行JavaScript代码

```bash
# 获取页面标题
curl-rpc exec_js win_id=1 code='document.title'

# 点击元素
curl-rpc exec_js win_id=1 code='document.querySelector("#btn").click()'

# 获取页面内容
curl-rpc exec_js win_id=1 code='document.body.innerHTML'
```

**响应:**

```
Google
```

#### get_element_client_bound - 获取元素边界

```bash
curl-rpc get_element_client_bound win_id=1 selector="#btn"
```

**响应:**

```json
{
  "x": 100,
  "y": 200,
  "width": 80,
  "height": 30
}
```

#### wait_for_selector - 等待元素出现

```bash
curl-rpc wait_for_selector win_id=1 selector="#btn" timeout=5000
```

**响应:**

```
Element found
```

### 下载管理

#### session_download_url - 下载文件

```bash
# 基本下载
curl-rpc session_download_url url=http://example.com/file.zip save_path=/tmp/file.zip

# 带超时设置
curl-rpc session_download_url url=http://example.com/file.zip save_path=/tmp/file.zip timeout=60000
```

**响应:**

```json
{
  "id": 1,
  "status": "completed",
  "url": "http://example.com/file.zip",
  "path": "/tmp/file.zip",
  "size": 10485760,
  "mime": "application/zip",
  "filename": "file.zip",
  "progress": 100
}
```

#### get_downloads - 获取下载列表

```bash
curl-rpc get_downloads
```

**响应:**

```json
[
  {
    "id": 1,
    "url": "http://example.com/file.zip",
    "path": "/tmp/file.zip",
    "status": "completed",
    "progress": 100,
    "size": 10485760
  }
]
```

#### get_download - 获取单个下载信息

```bash
curl-rpc get_download id=1
```

**响应:**

```json
{
  "id": 1,
  "status": "completed",
  "progress": 100,
  "received": 10485760,
  "total": 10485760
}
```

#### clear_downloads - 清空下载记录

```bash
curl-rpc clear_downloads
```

**响应:**

```
All downloads cleared
```

### CDP操作

```bash
# 点击坐标
curl-rpc cdp_click win_id=1 x=100 y=100

# 双击
curl-rpc cdp_double_click win_id=1 x=100 y=100

# 右键点击
curl-rpc cdp_right_click win_id=1 x=100 y=100

# 输入文本
curl-rpc cdp_type_text win_id=1 text="Hello World"

# 按键
curl-rpc cdp_press_key win_id=1 key="Enter"

# 按Enter
curl-rpc cdp_press_enter win_id=1

# 按Tab
curl-rpc cdp_press_tab win_id=1

# 粘贴
curl-rpc cdp_press_paste win_id=1

# 滚动
curl-rpc cdp_scroll win_id=1 y=500

# 鼠标移动
curl-rpc cdp_mouse_move win_id=1 x=100 y=100

# 鼠标按下
curl-rpc cdp_mouse_down win_id=1 x=100 y=100

# 鼠标释放
curl-rpc cdp_mouse_up win_id=1 x=100 y=100
```

### 截图

```bash
# 网页截图并复制到剪贴板
curl-rpc webpage_screenshot_to_clipboard win_id=1

# 网页快照（截图+HTML）
curl-rpc webpage_snapshot win_id=1 save_path=/tmp/snapshot.png

# 元素截图
curl-rpc screenshot_element win_id=1 selector="#btn" save_path=/tmp/element.png
```

### 剪贴板操作

```bash
# 写入文本
curl-rpc clipboard_write_text text="Hello from clipboard"

# 读取文本
curl-rpc clipboard_read_text

# 写入图片
curl-rpc clipboard_write_image image_path=/tmp/image.png

# 读取图片
curl-rpc clipboard_read_image save_path=/tmp/clipboard.png

# 清空剪贴板
curl-rpc clipboard_clear
```

### 账户管理

```bash
# 获取账户信息
curl-rpc get_account accountIdx=5

# 保存账户信息
curl-rpc save_account_info accountIdx=5 metadata='{"description":"Test Account","tags":["test"]}'

# 列出所有账户
curl-rpc list_accounts
```

### 系统工具

```bash
# 执行Shell命令
curl-rpc exec_shell command="ls -la"

# 执行Python代码
curl-rpc exec_python code="print(2+2)"

# 执行Node.js代码
curl-rpc exec_node code="console.log(2+2)"

# 获取系统信息
curl-rpc get_system_info

# 获取系统窗口
curl-rpc get_system_windows

# 聚焦系统窗口
curl-rpc focus_system_window win_id=12345
```

### 网络监控

```bash
# 获取控制台日志
curl-rpc get_console_logs win_id=1

# 获取网络请求
curl-rpc get_requests win_id=1

# 获取请求详情
curl-rpc get_request_detail win_id=1 request_id=123

# 清空请求记录
curl-rpc clear_requests win_id=1
```

## Token 配置

### 初始化配置

```bash
# 初始化配置文件
curl-rpc init
```

配置文件位置：`~/data/electron/curl-rpc.json`

配置格式：

```json
[
  {
    "api_token": "your-token-here",
    "base_url": "http://localhost:8101"
  },
  {
    "api_token": "your-token-2",
    "base_url": "https://other-server.com"
  }
]
```

### 多节点切换

```bash
# 使用节点 0（默认）
curl-rpc ping

# 使用节点 1
ELECTRON_MCP_NODE=1 curl-rpc ping
```

### 调试模式

```bash
# 输出完整请求/响应信息
DEBUG=1 curl-rpc ping
```

## 环境变量

```bash
# 自定义服务器地址
export ELECTRON_MCP_URL=http://localhost:8101

# 选择节点 (0, 1, 2, ...)
export ELECTRON_MCP_NODE=0

# 调试模式
export DEBUG=1
```

## 故障排除

### 配置文件未找到

```bash
❌ Error: ~/data/electron/curl-rpc.json not found

# 解决：初始化配置
curl-rpc init
```

### Token 未设置

```bash
❌ Error: api_token is empty in ~/data/electron/curl-rpc.json

# 解决：编辑配置文件添加 token
vim ~/data/electron/curl-rpc.json
```

### 服务器未运行

```bash
❌ Error: Cannot connect to MCP server

# 解决：启动服务
cd /home/w3c_offical/projects/electron-mcp/main
bash skills/electron-mcp-service/service.sh start
```

### 工具不存在

```bash
❌ Error: Tool 'xxx' not found

# 解决：查看可用工具
curl-rpc list
```

## 完整文档

- **工具列表和详细用法**: https://github.com/cicy-dev/electron-mcp
- **API 文档**: https://github.com/cicy-dev/electron-mcp/blob/main/docs/REST-API.md
- **技能列表**: https://github.com/cicy-dev/electron-mcp/blob/main/skills/SKILLS-LIST.md

## 使用技巧

### 1. 选择合适的格式

**简单参数 → 简化语法**

```bash
curl-rpc open_window url=https://google.com
```

**复杂参数/多行代码 → YAML 格式**

```bash
curl-rpc "
name: exec_js
arguments:
  win_id: 1
  code: |
    const btn = document.querySelector('#submit');
    btn.click();
"
```

### 2. 参数引号规则

```bash
# 不含空格，不需要引号
curl-rpc open_window url=https://google.com

# 含空格，需要引号
curl-rpc cdp_type_text win_id=1 text="Hello World"

# 含特殊字符，需要引号
curl-rpc exec_js win_id=1 code="document.querySelector('#btn').click()"
```

### 3. 多行 YAML 技巧

```bash
# 使用 | 保留换行
curl-rpc "
name: exec_js
arguments:
  win_id: 1
  code: |
    const title = document.title;
    const url = window.location.href;
    return { title, url };
"
```

## LLM 使用建议

当 LLM 需要使用 `curl-rpc` 时：

1. **首选简化语法**：适合 90% 的场景

   ```bash
   curl-rpc tool_name key1=value1 key2=value2
   ```

2. **复杂参数用 YAML**：多行代码、嵌套结构

   ```bash
   curl-rpc "
   name: tool_name
   arguments:
     key: value
   "
   ```

3. **先查看帮助**：不确定时运行 `curl-rpc --help` 或 `curl-rpc list`

4. **测试连接**：开始前先 `curl-rpc ping`

5. **错误处理**：仔细阅读错误信息，按提示修复

## 帮助

```bash
curl-rpc --help    # 显示帮助
curl-rpc --version # 显示版本
curl-rpc list      # 列出所有工具
```
