# CiCy CLI Skill

这个 skill 用来说明两个 CLI 的分工：

- `cicy` / `cicy-desktop`：只负责 **desktop / cluster 管理**
- `cicy-rpc`：只负责 **RPC / tool 调用**

---

## 一句话记忆

- 管服务，用 `cicy`
- 调工具，用 `cicy-rpc`

---

## 1. `cicy` / `cicy-desktop`

只做本地 desktop / cluster 生命周期管理：

```bash
cicy start
cicy stop
cicy status
cicy restart
cicy logs

# 等价
cicy-desktop start
cicy-desktop status
```

### 不支持的命令

下面这些不应该再用 `cicy` / `cicy-desktop`：

```bash
cicy ping
cicy tools
cicy open_window url=https://example.com
cicy-desktop get_windows
```

这些都应该改成 `cicy-rpc`。

---

## 2. `cicy-rpc`

只做 RPC 调用：

```bash
cicy-rpc init
cicy-rpc tools
cicy-rpc tools open_window
cicy-rpc ping
cicy-rpc open_window url=https://example.com
cicy-rpc get_windows
cicy-rpc get_window_info win_id=2
cicy-rpc --json get_windows
```

---

## 3. 快速开始

### 启动本地服务

```bash
cicy start
# 或
npm start
```

### 初始化配置

```bash
cicy-rpc init
```

配置文件是 `~/global.json`。

标准格式：

```json
{
  "api_token": "your-default-token",
  "cicyDesktopNodes": {
    "local": {
      "api_token": "",
      "base_url": "http://localhost:8101"
    },
    "windows": {
      "api_token": "your-windows-token",
      "base_url": "http://192.168.106.57:8101"
    }
  }
}
```

---

## 4. 多节点用法

默认走 `local`：

```bash
cicy-rpc ping
cicy-rpc tools
cicy-rpc open_window url=https://ifconfig.me
```

指定节点：

```bash
CICY_NODE=windows cicy-rpc ping
CICY_NODE=windows cicy-rpc get_windows
CICY_NODE=windows cicy-rpc open_window url=https://example.com
```

---

## 5. 常用命令

### 集群管理

```bash
cicy status
cicy restart
cicy logs
```

### 查看工具

```bash
cicy-rpc tools
cicy-rpc tools open_window
cicy-rpc tools --full
```

### 打开窗口

```bash
cicy-rpc open_window url=https://example.com
CICY_NODE=windows cicy-rpc open_window url=https://ifconfig.me
```

### 查看窗口

```bash
cicy-rpc get_windows
cicy-rpc get_window_info win_id=2
```

### JSON 输出

```bash
cicy-rpc --json get_windows
cicy-rpc -j get_window_info win_id=2
```

### 读取页面文本

```bash
CICY_NODE=windows cicy-rpc exec_js win_id=2 code="document.body.innerText"
```

---

## 6. 推荐工作流

```bash
# 1. 看服务
cicy status

# 2. 看工具
cicy-rpc tools

# 3. 打开页面
CICY_NODE=windows cicy-rpc open_window url=https://ifconfig.me

# 4. 查窗口
CICY_NODE=windows cicy-rpc get_windows
CICY_NODE=windows cicy-rpc get_window_info win_id=2
```

---

## 7. 排错

### `fetch failed`
说明节点不可达：
- IP/端口不对
- worker 没启动
- 网络不通

先试：

```bash
cicy-rpc ping
CICY_NODE=windows cicy-rpc ping
```

### `HTTP 401 Unauthorized`
说明地址通了，但 token 不对。

检查：
- `cicyDesktopNodes.<name>.api_token`
- `cicyDesktopNodes.<name>.base_url`

### 窗口刚打开但没加载完

```bash
CICY_NODE=windows cicy-rpc get_window_info win_id=2
```

重点看：
- `isDomReady`
- `isLoading`
- `url`
- `title`

---

## 8. 兼容层

仓库里保留了：

```bash
skills/cicy-rpc/cicy-rpc
```

它现在只是一个薄包装，底层仍然调用新的 Node 版 `cicy-rpc`。
