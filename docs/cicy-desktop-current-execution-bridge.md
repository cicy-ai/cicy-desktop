# CiCy Desktop 当前执行桥接架构说明

## 一句话结论

`cicy-desktop` 现在已经不是一个简单的 Electron 壳子，而是一个已经可工作的本地自动化执行节点：

- 它已经有本地认证
- 已经有 REST RPC / MCP SSE 服务
- 已经有工具注册中心
- 已经有 BrowserWindow / 账户隔离
- 已经有 Chrome CDP 控制
- 已经有页面 JS 执行和部分页面注入
- 已经有系统窗口控制能力

但它现在**还没有真正打通云端 worker agent 调度链路**。也就是说，`Desktop 本地执行能力` 已经有了，缺的是 `云端任务下发 / 回传 / 心跳 / 状态机` 这一层。

---

## 1. 当前代码里已经存在的核心能力

### 1.1 本地 Desktop Daemon 已存在

`src/main.js` 已经启动了一个本地服务进程，而不是只打开一个 Electron 窗口。

它现在提供：

- `GET /mcp` + `POST /messages`：MCP SSE 通道
- `POST /rpc/tools/call`：统一 RPC 调用入口
- `GET /rpc/tools`：工具列表
- `POST /rpc/<tool>`：每个工具的直接调用入口
- `POST /rpc/upload/*`：上传文件
- `POST /rpc/exec/:type`：远程提交脚本执行

所以从架构上说，`cicy-desktop` 现在已经具备“本地 agent server”形态。

### 1.2 本地鉴权已存在

`src/utils/auth.js` 已实现：

- 从 `~/global.json` 读取 `api_token`
- 不存在时自动生成
- 支持 `Bearer` 和 `Basic Auth`

这说明它已经能作为受保护的本地 worker 服务存在。

### 1.3 工具注册中心已存在

`src/tools/index.js` + `src/main.js` 已经形成统一工具注册机制。

现在工具并不是散的，而是统一挂在 tool registry 下，外部和内部最终都走同一套 handler：

- window tools
- cdp tools
- exec js
- automation tools
- system tools
- account tools
- clipboard tools
- download tools
- hook tools

这点很关键，因为后面无论你是走 HTTP、MCP、IPC，最终都可以复用这一层，不需要重写执行器。

### 1.4 BrowserWindow + 账户隔离已存在

`src/utils/window-utils.js` 已经做了：

- `partition: persist:sandbox-${accountIdx}`
- 多账户 Cookie / Storage 隔离
- 单窗口复用模式
- URL 级窗口状态恢复
- 每个窗口自动挂 debugger
- 代理设置
- 权限处理

这意味着“一个桌面节点服务多个账户 / 多个 worker 页面”的基础已经有了。

### 1.5 Chrome CDP 控制已存在

`src/main.js` 设置了：

- `remote-debugging-port = 9221`

`src/utils/cdp-utils.js` 和 `src/tools/cdp-tools.js` 已经做了：

- `webContents.debugger.attach("1.3")`
- `webContents.debugger.sendCommand(...)`
- 鼠标点击/双击
- 键盘按键
- 文本输入
- 滚动
- 任意 CDP command

所以你现在真正可依赖的主执行层，确实应该是 `Chrome CDP`。

### 1.6 页面执行层已存在

`src/tools/exec-js.js` 和 `src/tools/automation-tools.js` 已经提供：

- `exec_js`
- `exec_js_file`
- `electron_click`
- `electron_type`
- `electron_wait_for`
- `electron_evaluate`
- 读取页面内容/属性

这层适合补 DOM 级逻辑，或者做站点定制化流程。

### 1.7 系统层能力已存在

`src/tools/system-tools.js` 已经做了：

- 枚举系统窗口
- 聚焦窗口
- 读取系统信息
- 系统截图
- Linux 下通过 `wmctrl` / `xdotool` 做系统窗口控制

这说明 `cicy-desktop` 已经不只是“浏览器自动化”，而是“浏览器优先、桌面兜底”的本地执行桥。

### 1.8 页面注入与站点 Hook 能力已存在

`src/utils/window-utils.js` 会在 `dom-ready` 后：

- 为受信任页面注入 `window.electronRPC`
- 为每个域名加载 `~/data/electron/extension/inject/<domain>.js`
- 默认脚本来自 `src/extension/inject.js`

另外 `src/tools/hook-chatgpt.js`、`src/tools/hook-gemini.js` 已经证明：

- 可以做站点专属 hook
- 可以读 IndexedDB
- 可以走剪贴板桥接
- 可以在指定页面做定制增强

---

## 2. 当前真实可用的执行链路

### 2.1 外部控制面 -> Desktop

这是当前已经成立的链路：

```text
Remote Controller / CLI / Agent
  -> HTTP RPC or MCP SSE
  -> cicy-desktop local server
  -> tool registry
  -> tool handler
  -> BrowserWindow / CDP / system command
```

这是目前最稳的链路。

### 2.2 页面内 JS -> Electron IPC -> Tool Registry

当前代码也已经部分成立这条链：

```text
Page JS
  -> window.electronRPC(...) / window._g.rpc(...)
  -> ipcRenderer.invoke("rpc", toolName, args)
  -> ipcMain.handle("rpc", ...)
  -> tool registry
  -> tool handler
```

这条链在 `src/main.js` 的 `ipcMain.handle("rpc")` 已经做通了。

### 2.3 Tool -> Chrome CDP

当前核心浏览器执行链：

```text
tool handler
  -> sendCDP(...)
  -> webContents.debugger.sendCommand(...)
  -> Chromium
```

这条链现在是最应该作为虚拟员工主执行层的能力。

---

## 3. 一个非常关键的现实边界

### 3.1 `preload-rpc.js` 存在，但当前没有接到 BrowserWindow

仓库里有：

- `src/preload-rpc.js`

它暴露了：

- `window.electronRPC.invoke(...)`

但是当前 `createWindow()` 里**没有把这个 preload 挂进 `webPreferences.preload`**。

这意味着：

- 这个 preload bridge 文件是存在的
- 但当前不是主链路
- 当前真正生效的是运行时注入，而不是稳定 preload

### 3.2 当前 `window.electronRPC` 不是对所有站点都稳定可用

`src/utils/window-utils.js` 当前策略是：

- 受信任 URL：`localhost` 或 `*.de5.net`
- 这些页面会启用 `nodeIntegration`
- 并额外注入 `window.electronRPC`

对于普通公网站点：

- `nodeIntegration` 默认是关的
- `contextIsolation` 默认是开的
- `src/extension/inject.js` 里 `require("electron")` 很可能拿不到

也就是说：

- 对任意公网网站，`页面自己调用 ipcRenderer` 这件事目前**不是稳定能力**
- 现在最稳的是：`主进程/工具层直接控制页面`
- 如果要走你说的 `ws -> client js -> electron ipcRenderer -> rpc`，需要先把 preload 这层正式接上

这个点很重要，不然会把“某些域名能用的注入”误判成“所有页面都能稳定走 renderer bridge”。

---

## 4. 当前没有真正落地的部分

我直接按代码说结论。

### 4.1 没找到真实的云端 worker 调度实现

我在 `src/` 里没有找到已落地的：

- WebSocket 长连接 worker client
- 向 master 注册 worker
- 心跳上报
- 任务拉取 / ACK / 重试
- 任务状态机
- 云端 agent session 绑定

### 4.2 `feature-distributed-multi-agent.md` 目前是设计稿，不是现状

`docs/feature-distributed-multi-agent.md` 里写了：

- master node
- worker node
- Redis
- Bull
- 心跳
- 调度
- 任务队列

但从当前 `src/` 代码来看，这些还没有真正落地。

所以这份文档应该被视为：

- 方向设计稿
- 不是当前已完成实现

### 4.3 当前没有云端到本地的“常驻任务循环”

现在 `cicy-desktop` 更像是：

- 一个被动等待调用的本地执行服务

而不是：

- 一个主动连接云端、持续领取任务、持续回传结果的 worker client

这就是“能力有了，但没打通”的核心原因。

---

## 5. 结合当前代码，Desktop 在整个虚拟员工系统中的正确角色

你前面说得对，应该定成下面这个角色：

### 5.1 Chrome CDP 是主执行层

真正干活的主能力应该是：

- 页面打开
- 元素交互
- 输入
- 滚动
- 网络监听
- 页面状态读取

这些都应该优先走：

- `webContents.debugger.sendCommand`
- `executeJavaScript`

也就是 `CDP first, DOM/JS second`。

### 5.2 Electron Desktop 是本地特权桥

Desktop 的职责不应该定义成“大脑”，而应该定义成：

- 本地 worker 宿主
- 本地认证和安全边界
- Chromium / BrowserWindow 宿主
- CDP 和系统能力桥
- 多账户和本地缓存宿主
- 必要时的系统级兜底执行器

### 5.3 页面内 client JS 只能是补充层，不该是唯一主链路

页面 JS 适合做：

- 某站点 DOM helper
- 某站点页面内状态抽取
- 某站点 IndexedDB 读取
- 某站点专用组件点击和观察

页面 JS 不适合单独承担：

- 全局任务调度
- 可靠心跳
- 跨站统一 agent runtime

因为页面会跳转、站点脚本会变、权限模型也不稳定。

---

## 6. 基于现有代码，最小打通方案

这里不写空想，只写最贴近当前代码的最短路径。

### 方案 A：推荐方案

```text
Cloud Agent / Scheduler
  -> WebSocket / SSE / HTTP task stream
  -> cicy-desktop main process worker client
  -> tool registry
  -> CDP / JS / system tools
```

这个方案的特点：

- 不依赖页面是否支持 `ipcRenderer`
- 不依赖特定域名注入
- 直接复用现在的 tool registry
- 结构最稳

这个方案下，Electron renderer 只是浏览器页面本身，不承担云端调度职责。

### 方案 B：按你说的桥接方案来做

```text
Cloud Agent
  -> WS
  -> client js
  -> ipcRenderer
  -> ipcMain.handle("rpc")
  -> tool registry
```

这个方案并非不能做，但要先补齐两个前提：

- 把 `src/preload-rpc.js` 正式接到 BrowserWindow
- 把 WS client 放到 preload / isolated world，而不是普通页面脚本

否则现在这种基于页面注入的 `require("electron")`，在公网站点上不稳定。

### 我建议的落地方向

如果你的目标是“虚拟员工长期稳定打工”，推荐：

- 调度链放主进程
- 页面 hook 只做站点增强
- preload 只做最薄 IPC 桥

这更贴近你现有代码，也更稳。

---

## 7. 要真正“打通”到 worker agent，还缺什么

按现有代码，最少还要补这几块：

### 7.1 Worker 身份与注册

- worker_id
- device_id
- token / secret
- 当前版本
- 当前机器资源

### 7.2 长连接任务通道

- WebSocket 或长轮询
- 领取任务
- ACK
- 心跳
- cancel
- reconnect

### 7.3 任务执行器

把云端任务格式映射到现有 tool registry，例如：

- open window
- wait dom ready
- cdp click
- exec js
- system fallback

### 7.4 任务结果与观测

- stdout / step log
- screenshot
- request log
- last url / title
- success / fail
- retryable / non-retryable

### 7.5 账户和窗口复用策略

要明确：

- 一个任务对应哪个 `accountIdx`
- 一个 worker 是否复用已有窗口
- 同站点是否复用 session
- 哪些任务必须新开隔离窗口

### 7.6 稳定的 renderer bridge

如果你坚持让 client JS 参与调度，需要：

- 正式启用 preload
- 固定暴露 `window.electronRPC`
- 不再依赖普通页面里 `require("electron")`

---

## 8. 现阶段我对这套系统的定稿判断

### 已经做成的

- Desktop 本地执行节点
- 本地 RPC/MCP 服务
- BrowserWindow 多账户隔离
- CDP 主控能力
- 页面 JS 执行能力
- 系统级兜底能力
- 页面注入与 hook 扩展点

### 还没做成的

- 云端调度到本地 worker 的真实闭环
- 稳定的跨站 renderer/preload bridge
- 任务状态机和结果回传链路
- 真正的多 worker / 多 agent 分布式运行面

### 正确理解

现在不是“`cicy-desktop` 没能力”。

而是：

- `执行器` 已经基本成形
- `调度层` 还没接上

---

## 9. 建议你后面把文档和实现统一成下面这句话

> `cicy-desktop` 是虚拟员工的本地执行宿主，主执行层使用 Chrome CDP，Electron 负责本地权限桥接、窗口宿主、多账户隔离和系统级兜底；云端调度层后续通过 worker 长连接接入，而不是把 Electron 本身当成调度中心。

---

## 10. 如果按当前代码继续推进，我建议的实施顺序

### 第一阶段

- 先补 worker 长连接
- 先让云端能给 desktop 发 task
- 直接在 main process 调用现有 tool registry

### 第二阶段

- 把 `preload-rpc.js` 正式挂上
- 固化 renderer bridge
- 把页面内 hook 变成站点增强层

### 第三阶段

- 再做多 worker / 多 agent / 队列 / 调度
- 再把 `feature-distributed-multi-agent.md` 里的设计逐步落地

---

## 11. 当前最重要的非空想结论

你现在最该复用的，不是重新发明一个浏览器自动化壳子。

你最该做的是：

- 承认 `cicy-desktop` 已经是本地执行器
- 以 `tool registry + CDP + BrowserWindow isolation` 为基础
- 把云端任务调度接到它上面

这才是“结合已经做的继续往前推”，而不是重写一遍。
