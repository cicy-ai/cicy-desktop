# cicy-rpc

Node-based RPC CLI for CiCy Desktop workers.

## Commands

```bash
cicy-rpc init
cicy-rpc tools
cicy-rpc tools open_window
cicy-rpc ping
cicy-rpc open_window url=https://google.com
cicy-rpc --json get_windows
```

## Config

Reads `~/global.json` using the project-standard format:

```json
{
  "api_token": "your-token",
  "cicyDesktopNodes": {
    "local": {
      "api_token": "",
      "base_url": "http://localhost:8101"
    },
    "windows": {
      "api_token": "your-token",
      "base_url": "http://windows-host:8101"
    }
  }
}
```

Select a node with `CICY_NODE=<name>`.

## Notes

- `cicy-rpc` is the only supported CLI for RPC/tool calls.
- `cicy` / `cicy-desktop` only manage desktop and cluster lifecycle.
- `skills/cicy-rpc/cicy-rpc` is now a thin wrapper around the Node CLI.

```json
{
  "message": "Opened window with ID: 1",
  "winId": 1
}
```

#### get_windows - 获取所有窗口

```bash
cicy-rpc get_windows
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
cicy-rpc close_window win_id=1
```

**响应:**

```
Closed 1
```

### JavaScript执行

#### exec_js - 执行JavaScript代码

```bash
# 获取页面标题
cicy-rpc exec_js win_id=1 code='document.title'

# 点击元素
cicy-rpc exec_js win_id=1 code='document.querySelector("#btn").click()'

# 获取页面内容
cicy-rpc exec_js win_id=1 code='document.body.innerHTML'
```

**响应:**

```
Google
```

#### get_element_client_bound - 获取元素边界

```bash
cicy-rpc get_element_client_bound win_id=1 selector="#btn"
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
cicy-rpc wait_for_selector win_id=1 selector="#btn" timeout=5000
```

**响应:**

```
Element found
```

### 下载管理

#### session_download_url - 下载文件

```bash
# 基本下载
cicy-rpc session_download_url url=http://example.com/file.zip save_path=/tmp/file.zip

# 带超时设置
cicy-rpc session_download_url url=http://example.com/file.zip save_path=/tmp/file.zip timeout=60000
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
cicy-rpc get_downloads
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
cicy-rpc get_download id=1
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
cicy-rpc clear_downloads
```

**响应:**

```
All downloads cleared
```

### CDP操作

```bash
# 点击坐标
cicy-rpc cdp_click win_id=1 x=100 y=100

# 双击
cicy-rpc cdp_double_click win_id=1 x=100 y=100

# 右键点击
cicy-rpc cdp_right_click win_id=1 x=100 y=100

# 输入文本
cicy-rpc cdp_type_text win_id=1 text="Hello World"

# 按键
cicy-rpc cdp_press_key win_id=1 key="Enter"

# 按Enter
cicy-rpc cdp_press_enter win_id=1

# 按Tab
cicy-rpc cdp_press_tab win_id=1

# 粘贴
cicy-rpc cdp_press_paste win_id=1

# 滚动
cicy-rpc cdp_scroll win_id=1 y=500

# 鼠标移动
cicy-rpc cdp_mouse_move win_id=1 x=100 y=100

# 鼠标按下
cicy-rpc cdp_mouse_down win_id=1 x=100 y=100

# 鼠标释放
cicy-rpc cdp_mouse_up win_id=1 x=100 y=100
```

### 截图

```bash
# 网页截图并复制到剪贴板
cicy-rpc webpage_screenshot_to_clipboard win_id=1

# 网页快照（截图+HTML）
cicy-rpc webpage_snapshot win_id=1 save_path=/tmp/snapshot.png

# 元素截图
cicy-rpc screenshot_element win_id=1 selector="#btn" save_path=/tmp/element.png
```

### 剪贴板操作

```bash
# 写入文本
cicy-rpc clipboard_write_text text="Hello from clipboard"

# 读取文本
cicy-rpc clipboard_read_text

# 写入图片
cicy-rpc clipboard_write_image image_path=/tmp/image.png

# 读取图片
cicy-rpc clipboard_read_image save_path=/tmp/clipboard.png

# 清空剪贴板
cicy-rpc clipboard_clear
```

### 账户管理

```bash
# 获取账户信息
cicy-rpc get_account accountIdx=5

# 保存账户信息
cicy-rpc save_account_info accountIdx=5 metadata='{"description":"Test Account","tags":["test"]}'

# 列出所有账户
cicy-rpc list_accounts
```

### 系统工具

```bash
# 执行Shell命令
cicy-rpc exec_shell command="ls -la"

# 执行Python代码
cicy-rpc exec_python code="print(2+2)"

# 执行Node.js代码
cicy-rpc exec_node code="console.log(2+2)"

# 获取系统信息
cicy-rpc get_system_info

# 获取系统窗口
cicy-rpc get_system_windows

# 聚焦系统窗口
cicy-rpc focus_system_window win_id=12345
```

### 网络监控

```bash
# 获取控制台日志
cicy-rpc get_console_logs win_id=1

# 获取网络请求
cicy-rpc get_requests win_id=1

# 获取请求详情
cicy-rpc get_request_detail win_id=1 request_id=123

# 清空请求记录
cicy-rpc clear_requests win_id=1
```

## Token 配置

### 初始化配置

```bash
# 初始化配置文件
cicy-rpc init
```

配置文件位置：`~/global.json`

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
cicy-rpc ping

# 使用节点 1
CICY_NODE=1 cicy-rpc ping
```

### 调试模式

```bash
# 输出完整请求/响应信息
DEBUG=1 cicy-rpc ping
```

## 环境变量

```bash
# 自定义服务器地址
export CICY_URL=http://localhost:8101

# 选择节点 (0, 1, 2, ...)
export CICY_NODE=0

# 调试模式
export DEBUG=1
```

## 故障排除

### 配置文件未找到

```bash
❌ Error: ~/global.json not found

# 解决：初始化配置
cicy-rpc init
```

### Token 未设置

```bash
❌ Error: api_token is empty in ~/global.json

# 解决：编辑配置文件添加 token
vim ~/global.json
```

### 服务器未运行

```bash
❌ Error: Cannot connect to MCP server

# 解决：启动服务
cd /home/w3c_offical/projects/cicy-desktop/main
bash skills/cicy-desktop-service/service.sh start
```

### 工具不存在

```bash
❌ Error: Tool 'xxx' not found

# 解决：查看可用工具
cicy-rpc list
```

## 完整文档

- **工具列表和详细用法**: https://github.com/cicy-ai/cicy-desktop
- **API 文档**: https://github.com/cicy-ai/cicy-desktop/blob/main/docs/REST-API.md
- **技能列表**: https://github.com/cicy-ai/cicy-desktop/blob/main/skills/SKILLS-LIST.md

## 使用技巧

### 1. 选择合适的格式

**简单参数 → 简化语法**

```bash
cicy-rpc open_window url=https://google.com
```

**复杂参数/多行代码 → YAML 格式**

```bash
cicy-rpc "
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
cicy-rpc open_window url=https://google.com

# 含空格，需要引号
cicy-rpc cdp_type_text win_id=1 text="Hello World"

# 含特殊字符，需要引号
cicy-rpc exec_js win_id=1 code="document.querySelector('#btn').click()"
```

### 3. 多行 YAML 技巧

```bash
# 使用 | 保留换行
cicy-rpc "
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

当 LLM 需要使用 `cicy-rpc` 时：

1. **首选简化语法**：适合 90% 的场景

   ```bash
   cicy-rpc tool_name key1=value1 key2=value2
   ```

2. **复杂参数用 YAML**：多行代码、嵌套结构

   ```bash
   cicy-rpc "
   name: tool_name
   arguments:
     key: value
   "
   ```

3. **先查看帮助**：不确定时运行 `cicy-rpc --help` 或 `cicy-rpc list`

4. **测试连接**：开始前先 `cicy-rpc ping`

5. **错误处理**：仔细阅读错误信息，按提示修复

## 帮助

```bash
cicy-rpc --help    # 显示帮助
cicy-rpc --version # 显示版本
cicy-rpc list      # 列出所有工具
```
