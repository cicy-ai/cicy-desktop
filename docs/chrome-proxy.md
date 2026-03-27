# Worker Chrome HTTP 代理路由（/chrome）说明文档

## 背景 / 目标

现状：worker 的 HTTP 服务端口（例如 8101）已承载 REST/RPC（`/rpc/*`），但各 Chrome profile 的 CDP 实际监听在各自的本地 debugger port（例如 11001）。外部目前只能通过 `/rpc/chrome_*` 工具间接操作，无法通过 worker 的稳定入口直接访问 Chrome 的常用 HTTP 端点（如 `/json/version`、`/json/list`、`/json/activate/*`）或发起任意 CDP method call。

目标：在不改变现有 `/rpc/:toolName` 调用方式的前提下，新增 worker 侧 HTTP 路由，让外部可以通过统一的 8101（或 worker 实际监听端口）入口，按 `accountIdx` 路由到对应 profile 的 debugger port。

## 新增能力（HTTP 路由）

以下路由均挂载在 worker 的 HTTP 服务下，并与 `/rpc/*` 一样受 `authMiddleware` 保护（Bearer token）。

- `GET /chrome/:accountIdx/json/version`
- `GET /chrome/:accountIdx/json/list`
- `POST /chrome/:accountIdx/json/activate/:targetId`
- `POST /chrome/:accountIdx/cdp/call`

> 首版只做 HTTP facade（调用现有 helper），不做 websocket upgrade 透传。

## 端口解析规则（accountIdx -> debuggerPort）

与现有 `/rpc` 工具行为对齐，优先级如下：

1. 若 `~/Private/chrome.json` 中存在 `account_<idx>.port`，优先使用该 port
2. 否则回退到 `runtime-registry` 中 `registry.get(accountIdx)?.debuggerPort`
3. 都没有则返回错误（HTTP 404）

这部分被抽成共享逻辑，避免 `/rpc/chrome_*` 与 `/chrome/*` 对同一账号解析出不同端口。

## 认证

所有 `/chrome/*` 路由均复用既有 `authMiddleware`（与 `/rpc/*` 一致）。

请求示例（token 来自 `~/global.json` 的 `api_token`，或你自己的注入方式）：

```bash
curl -H "Authorization: Bearer <token>" \
  http://127.0.0.1:<PORT>/chrome/1/json/version
```

## API 细节与示例

### 1) 获取版本信息

`GET /chrome/:accountIdx/json/version`

返回：Chrome 原始 `/json/version` JSON（不改写字段）。

```bash
curl -H "Authorization: Bearer <token>" \
  http://127.0.0.1:<PORT>/chrome/1/json/version
```

### 2) 获取 targets 列表

`GET /chrome/:accountIdx/json/list`

返回：Chrome 原始 `/json/list` 数组。

```bash
curl -H "Authorization: Bearer <token>" \
  http://127.0.0.1:<PORT>/chrome/1/json/list
```

### 3) 激活某个 target

`POST /chrome/:accountIdx/json/activate/:targetId`

返回：统一返回 JSON（避免 text/plain 不一致）：

```json
{ "ok": true, "text": "Target activated" }
```

```bash
curl -X POST -H "Authorization: Bearer <token>" \
  http://127.0.0.1:<PORT>/chrome/1/json/activate/<targetId>
```

### 4) 发起任意 CDP method call

`POST /chrome/:accountIdx/cdp/call`

Body：

```json
{ "method": "Browser.getVersion", "params": {}, "target": "optional" }
```

返回：

```json
{ "result": { ... } }
```

```bash
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"method":"Browser.getVersion","params":{}}' \
  http://127.0.0.1:<PORT>/chrome/1/cdp/call
```

## 错误语义（HTTP）

- `accountIdx` 非整数：`400`
  `{"error":"accountIdx must be an integer"}`
- account 找不到 port（private config + runtime 都没有）：`404`
  `{"error":"Missing debuggerPort for accountIdx=<n>"}`
- 上游 debugger port 不可达、或 CDP 调用失败：`502`
  `{"error":"<message>","debuggerPort":11001,...}`
- `/cdp/call` 缺少 `method`：`400`
  `{"error":"Missing method"}`

## 非目标（本次不做）

- 不做 websocket proxy / upgrade
  因此也不改写 `/json/version` 和 `/json/list` 里的 `webSocketDebuggerUrl`，避免“看起来能连，实际无法 upgrade”的误导。
- 不引入通用反向代理依赖，不做字节级 raw reverse proxy。

## 代码变更点（关键文件）

- 新增：`src/server/chrome-proxy-routes.js`
  实现 `/chrome/:accountIdx/...` 路由
- 新增：`src/chrome/debugger-port-resolver.js`
  统一端口解析优先级（private config > runtime registry）
- 修改：`src/main.js`
  挂载：`app.use("/chrome", authMiddleware, createChromeProxyRoutes(...))`
- 修改：`src/tools/chrome-tools.js`
  让 `chrome_get_targets` / `chrome_cdp_call` 复用同一端口解析逻辑（保持行为一致）
- 新增测试：`tests/rpc/chrome-proxy-routes.test.js`
  覆盖成功路径与关键错误语义

## 测试验证

已新增并通过的单测（只跑该文件）：

```bash
npx jest tests/rpc/chrome-proxy-routes.test.js --runInBand
```

> 注：完整 `npm test` 当前在仓库内存在与本次变更无关的既有失败（例如其他 RPC suite 报 `sleep is not a function`），不属于本次引入回归。
