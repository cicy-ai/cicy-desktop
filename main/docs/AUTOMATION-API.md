# Electron 自动化 API 文档

## 概述

Electron MCP 自动化系统提供完整的浏览器自动化能力，支持窗口管理、页面导航、元素操作、JavaScript执行等功能。

**服务端口**: 8101  
**基础URL**: `http://localhost:8101`

## 认证

所有API需要Bearer Token认证：

```bash
Authorization: Bearer YOUR_TOKEN
```

## API端点

### 1. 窗口管理

#### 创建窗口
```bash
POST /rpc/open_window
Content-Type: application/json

{
  "url": "https://www.google.com",
  "accountIdx": 0,
  "reuseWindow": true
}
```

#### 获取窗口列表
```bash
POST /rpc/get_windows
Content-Type: application/json

{}
```

#### 获取窗口信息
```bash
POST /rpc/get_window_info
Content-Type: application/json

{
  "win_id": 1
}
```

#### 关闭窗口
```bash
POST /rpc/close_window
Content-Type: application/json

{
  "win_id": 1
}
```

### 2. 页面导航

#### 加载URL
```bash
POST /rpc/load_url
Content-Type: application/json

{
  "win_id": 1,
  "url": "https://www.youtube.com"
}
```

#### 获取页面标题
```bash
POST /rpc/get_title
Content-Type: application/json

{
  "win_id": 1
}
```

### 3. 元素操作

#### 点击元素
```bash
POST /rpc/electron_click
Content-Type: application/json

{
  "win_id": 1,
  "selector": "button[aria-label='close']",
  "waitTimeout": 5000
}
```

**参数说明**:
- `win_id`: 窗口ID（可选，默认1）
- `selector`: CSS选择器
- `waitTimeout`: 等待超时时间（毫秒，默认5000）

#### 输入文字
```bash
POST /rpc/electron_type
Content-Type: application/json

{
  "win_id": 1,
  "selector": "input[name='username']",
  "text": "Hello World",
  "clear": true,
  "waitTimeout": 5000
}
```

**参数说明**:
- `selector`: CSS选择器
- `text`: 要输入的文字
- `clear`: 是否清空原有内容（默认true）
- `waitTimeout`: 等待超时时间（毫秒，默认5000）

#### 选择下拉框
```bash
POST /rpc/electron_select
Content-Type: application/json

{
  "win_id": 1,
  "selector": "select[name='country']",
  "value": "US"
}
```

#### 获取元素属性
```bash
POST /rpc/electron_get_attribute
Content-Type: application/json

{
  "win_id": 1,
  "selector": "a.link",
  "attribute": "href"
}
```

### 4. 页面信息

#### 获取页面内容
```bash
POST /rpc/electron_get_content
Content-Type: application/json

{
  "win_id": 1,
  "selector": "div.content",
  "type": "text"
}
```

**参数说明**:
- `selector`: CSS选择器（可选，不指定则获取整个页面）
- `type`: 返回类型，`text`或`html`（默认text）

### 5. JavaScript执行

#### 执行JavaScript代码
```bash
POST /rpc/electron_evaluate
Content-Type: application/json

{
  "win_id": 1,
  "code": "document.querySelector('button').click()"
}
```

**示例**:
```bash
# 获取页面标题
{
  "code": "document.title"
}

# 获取所有链接
{
  "code": "Array.from(document.querySelectorAll('a')).map(a => a.href)"
}
```

### 6. 等待和同步

#### 等待元素出现
```bash
POST /rpc/electron_wait_for
Content-Type: application/json

{
  "win_id": 1,
  "selector": "div.loaded",
  "timeout": 10000
}
```

### 7. 截图

#### 窗口截图
```bash
POST /rpc/electron_screenshot
Content-Type: application/json

{
  "win_id": 1,
  "format": "png"
}
```

**返回格式**:
```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"format\":\"png\",\"size\":12345,\"base64\":\"data:image/png;base64,...\"}"
    }
  ]
}
```

## 使用示例

### 示例1：自动化登录流程

```bash
# 1. 打开登录页面
curl -X POST http://localhost:8101/rpc/open_window \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/login"}'

# 2. 等待页面加载
curl -X POST http://localhost:8101/rpc/electron_wait_for \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"selector": "input[name=\"username\"]"}'

# 3. 输入用户名
curl -X POST http://localhost:8101/rpc/electron_type \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"selector": "input[name=\"username\"]", "text": "myuser"}'

# 4. 输入密码
curl -X POST http://localhost:8101/rpc/electron_type \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"selector": "input[name=\"password\"]", "text": "mypass"}'

# 5. 点击登录按钮
curl -X POST http://localhost:8101/rpc/electron_click \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"selector": "button[type=\"submit\"]"}'
```

### 示例2：数据抓取

```bash
# 1. 打开目标页面
curl -X POST http://localhost:8101/rpc/load_url \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/data"}'

# 2. 等待内容加载
curl -X POST http://localhost:8101/rpc/electron_wait_for \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"selector": "div.data-container"}'

# 3. 获取页面内容
curl -X POST http://localhost:8101/rpc/electron_get_content \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"selector": "div.data-container", "type": "text"}'

# 4. 执行自定义JavaScript提取数据
curl -X POST http://localhost:8101/rpc/electron_evaluate \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"code": "Array.from(document.querySelectorAll(\".item\")).map(el => ({title: el.querySelector(\".title\").innerText, price: el.querySelector(\".price\").innerText}))"}'
```

### 示例3：截图和监控

```bash
# 1. 打开页面
curl -X POST http://localhost:8101/rpc/load_url \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'

# 2. 等待加载完成
sleep 3

# 3. 截图
curl -X POST http://localhost:8101/rpc/electron_screenshot \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"format": "jpeg"}'
```

## 错误处理

所有API在出错时返回以下格式：

```json
{
  "content": [
    {
      "type": "text",
      "text": "Error: Element not found: button.submit"
    }
  ],
  "isError": true
}
```

## 最佳实践

1. **使用等待**: 在操作元素前使用 `electron_wait_for` 确保元素已加载
2. **错误处理**: 检查返回的 `isError` 字段
3. **超时设置**: 根据网络情况调整 `waitTimeout` 参数
4. **选择器优化**: 使用精确的CSS选择器避免误操作
5. **窗口管理**: 使用 `accountIdx` 实现多账户隔离

## 技术支持

- 项目地址: `/home/w3c_offical/projects/electron-mcp`
- 端口: 8101
- 协议: HTTP REST API + MCP
