# 请求监控系统文档

## 概述

CiCy Desktop 提供了完整的网络请求监控和存储系统，自动捕获所有 HTTP 请求/响应并保存到本地文件。

## 核心特性

- ✅ 自动捕获所有请求和响应
- ✅ 智能文件保存（JSON/JS/CSS/HTML 自动格式化）
- ✅ 双数据结构（queue + map）
- ✅ 同一 URL 多次请求支持
- ✅ 文件路径长度保护
- ✅ 扩展名根据 content-type 确定

## 数据结构

### 目录结构

```
~/request-data/
└── win-{id}/
    ├── queue.json          # URL 列表（按时间顺序）
    ├── map.json            # 请求详情映射
    └── {domain}/           # 域名目录（hostname）
        └── {pathname}/     # 路径目录（保持原样）
            ├── {file}-{ts}-{idx}-header-req.json
            ├── {file}-{ts}-{idx}-header-res.json
            ├── {file}-{ts}-{idx}-body-req.txt
            └── {file}-{ts}-{idx}-body-res.js
```

### 文件命名格式

```
{basename}-{timestamp}-{index}-{part}-{direction}.{ext}
```

**参数说明：**
- `basename`: URL 路径的文件名（去除扩展名）
- `timestamp`: 时间戳（毫秒）
- `index`: 计数器（同一 URL 的第 N 个请求）
- `part`: `header` 或 `body`
- `direction`: `req`（请求）或 `res`（响应）
- `ext`: 根据 content-type 确定的扩展名

**示例：**
```
api-1770405397441-1-header-req.json
api-1770405397441-1-body-req.json
api-1770405397442-1-header-res.json
api-1770405397442-1-body-res.json
```

### queue.json

URL 列表，按请求时间顺序排列：

```json
[
  "https://example.com/api/users",
  "https://example.com/api/posts",
  "https://example.com/static/app.js"
]
```

### map.json

URL 到请求/响应详情的映射：

```json
{
  "https://example.com/api/users": {
    "requests": [
      {
        "__file": "/path/to/users-1770405397441-1-header-req.json",
        "__size": 1234,
        "__binary": false
      }
    ],
    "responses": [
      {
        "__file": "/path/to/users-1770405397442-1-header-res.json",
        "__size": 5678,
        "__binary": false
      }
    ]
  }
}
```

## 文件保存策略

### 自动保存规则

1. **JSON/JS/CSS/HTML**：即使 <1KB 也保存到文件并格式化
2. **其他类型**：>1KB 或二进制数据才保存
3. **小数据**：<1KB 的非代码数据直接存储在 map.json 中

### 格式化

使用 `js-beautify` 自动格式化：
- JSON - 2 空格缩进
- JavaScript - 2 空格缩进
- CSS - 2 空格缩进
- HTML - 2 空格缩进

### 扩展名映射

根据 `Content-Type` 确定文件扩展名：

| Content-Type | 扩展名 |
|--------------|--------|
| application/json | .json |
| text/javascript | .js |
| application/javascript | .js |
| text/css | .css |
| text/html | .html |
| image/png | .png |
| image/jpeg | .jpg |
| video/mp4 | .mp4 |
| font/woff2 | .bin |
| 其他 | .txt 或 .bin |

## MCP 工具

### get_request_urls

获取窗口的所有请求 URL 列表。

**参数：**
```javascript
{
  win_id: number,           // 窗口 ID
  page?: number,            // 页码（默认 1）
  page_size?: number,       // 每页数量（默认 100）
  filter?: string           // URL 过滤（支持正则）
}
```

**返回：**
```json
{
  "total": 150,
  "page": 1,
  "page_size": 100,
  "total_pages": 2,
  "urls": ["https://...", "https://..."]
}
```

**示例：**
```javascript
// 获取所有 URL
{ win_id: 1 }

// 过滤包含 "api" 的 URL
{ win_id: 1, filter: "api" }

// 过滤所有 .js 文件
{ win_id: 1, filter: "\\.js$" }
```

### get_requests

获取窗口的所有请求详情。

**参数：**
```javascript
{
  win_id: number,           // 窗口 ID
  page?: number,            // 页码（默认 1）
  page_size?: number,       // 每页数量（默认 50）
  filter?: string           // URL 过滤（支持正则）
}
```

**返回：**
```json
{
  "total": 150,
  "page": 1,
  "page_size": 50,
  "total_pages": 3,
  "data": [
    {
      "url": "https://example.com/api",
      "requestCount": 2,
      "responseCount": 2,
      "requests": [
        {
          "__file": "/path/to/req-1.json",
          "__size": 1234,
          "__binary": false
        }
      ],
      "responses": [
        {
          "__file": "/path/to/res-1.json",
          "__size": 5678,
          "__binary": false
        }
      ]
    }
  ]
}
```

### get_request_detail_by_url

根据 URL 获取特定请求的详情。

**参数：**
```javascript
{
  win_id: number,           // 窗口 ID
  url: string               // 完整 URL
}
```

**返回：**
```json
{
  "url": "https://example.com/api",
  "requestCount": 2,
  "responseCount": 2,
  "requests": [...],
  "responses": [...]
}
```

### clear_requests

清空窗口的所有请求记录（仅清空内存，不删除文件）。

**参数：**
```javascript
{
  win_id: number            // 窗口 ID
}
```

## 请求/响应文件格式

### Request Header 文件

```json
{
  "timestamp": 1770405397441,
  "url": "https://example.com/api",
  "method": "POST",
  "resourceType": "xhr",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer ..."
  },
  "postData": {
    "__file": "/path/to/body-req.json",
    "__size": 1234
  }
}
```

### Response Header 文件

```json
{
  "timestamp": 1770405397442,
  "status": 200,
  "statusText": "OK",
  "headers": {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache"
  },
  "mimeType": "application/json",
  "encodedDataLength": 5678,
  "body": {
    "__file": "/path/to/body-res.json",
    "__size": 5678,
    "__binary": false
  }
}
```

### Body 文件

根据 content-type 自动格式化：

**JSON:**
```json
{
  "id": 123,
  "name": "example"
}
```

**JavaScript:**
```javascript
function example() {
  console.log("formatted");
}
```

**CSS:**
```css
body {
  margin: 0;
  padding: 0;
}
```

## 路径长度保护

系统自动处理超长路径：

- **pathname** 最大 200 字符
- **basename** 最大 100 字符
- 超长部分截断并添加 MD5 哈希（8位）

**示例：**
```
原始: /very/long/path/with/many/segments/...（300字符）
处理: /very/long/path/with/many/segments/...-a1b2c3d4
```

## 错误处理

文件保存失败时返回错误信息：

```json
{
  "__error": "ENAMETOOLONG: name too long",
  "__url": "https://...",
  "__size": 12345
}
```

## 性能优化

- **节流保存**：1 秒延迟批量写入 map.json 和 queue.json
- **分离文件**：大数据保存到独立文件，减少 JSON 体积
- **计数器缓存**：内存中维护文件计数器，避免重复扫描

## 使用示例

### 捕获网页请求

```javascript
// 打开窗口
const win = await openWindow({ url: "https://example.com" });

// 等待页面加载
await sleep(10000);

// 获取所有请求
const requests = await getRequests(win.id);
console.log(`捕获了 ${requests.total} 个请求`);

// 过滤 API 请求
const apiRequests = await getRequests(win.id, { filter: "api" });

// 获取特定 URL 的详情
const detail = await getRequestDetailByUrl(win.id, "https://example.com/api/users");
```

### 读取保存的文件

```javascript
const fs = require('fs');

// 读取 request header
const reqHeader = JSON.parse(fs.readFileSync('/path/to/req-header.json'));

// 读取 response body
const resBody = fs.readFileSync('/path/to/res-body.json', 'utf8');
const data = JSON.parse(resBody);
```

## 常见问题

### Q: 如何删除已保存的文件？

A: 手动删除 `~/request-data/win-{id}/` 目录。`clear_requests` 工具只清空内存。

### Q: 文件保存在哪里？

A: `~/request-data/win-{id}/` 目录，每个窗口独立目录。

### Q: 如何过滤特定类型的请求？

A: 使用 `filter` 参数，支持正则表达式：
```javascript
{ filter: "\\.js$" }      // JS 文件
{ filter: "api" }         // 包含 api
{ filter: "google|facebook" }  // 多个关键词
```

### Q: 同一个 URL 多次请求会覆盖吗？

A: 不会。每次请求都会保存为独立文件，使用时间戳和计数器区分。

### Q: 支持哪些文件类型？

A: 支持所有类型。文本文件会格式化，二进制文件直接保存。

## 技术细节

### 监听机制

- `onBeforeSendHeaders` - 捕获请求
- `Network.loadingFinished` - 捕获响应
- `Network.getResponseBody` - 获取响应体

### 数据流

```
Request → onBeforeSendHeaders → handleData → saveDataToFile
                                           ↓
                                    queue.json (URL)
                                           ↓
Response → loadingFinished → handleData → saveDataToFile
                                        ↓
                                  map.json (详情)
```

## 更新日志

### v1.0.0 (2026-02-07)

- ✅ 初始版本
- ✅ 双数据结构（queue + map）
- ✅ 自动格式化代码
- ✅ 路径长度保护
- ✅ 扩展名智能识别
- ✅ MCP 工具集成
