# YAML 支持文档

## 概述

CiCy Desktop Server 支持 YAML 和 JSON 双格式，**默认使用 YAML** 以节省 token 消耗。

## 为什么选择 YAML？

### Token 节省对比

**JSON 格式（~100 字符）：**
```json
{"name":"open_window","arguments":{"url":"https://google.com","reuseWindow":false}}
```

**YAML 格式（~70 字符）：**
```yaml
name: open_window
arguments:
  url: https://google.com
  reuseWindow: false
```

**节省约 30-45% token！**

### 其他优势

- ✅ 更易读易写
- ✅ 无需大量引号和逗号
- ✅ 支持注释（虽然在 API 调用中不常用）
- ✅ 更自然的缩进结构

## 服务器端支持

### Accept 头控制

服务器根据 `Accept` 头返回相应格式：

```bash
# 请求 YAML 响应
curl -H "Accept: application/yaml" http://localhost:8101/rpc

# 请求 JSON 响应（默认）
curl -H "Accept: application/json" http://localhost:8101/rpc
```

### 响应格式对比

**YAML 响应（~50 字符）：**
```yaml
jsonrpc: '2.0'
id: 1
result:
  content:
    - type: text
      text: Pong
```

**JSON 响应（~90 字符）：**
```json
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Pong"}]}}
```

## cicy-rpc 工具

### 默认行为

`cicy-rpc` 默认使用 YAML 格式：

```bash
# YAML（默认，无需标志）
cicy-rpc "
name: ping
arguments: {}
"

# JSON（需要 --json 或 -j）
cicy-rpc --json '{"name":"ping","arguments":{}}'
```

### 自动处理

工具自动处理格式转换：

1. **输入处理**：
   - YAML 输入 → 使用 `yq` 转换为 JSON
   - JSON 输入 → 直接使用

2. **Accept 头**：
   - YAML 模式 → `Accept: application/yaml`
   - JSON 模式 → `Accept: application/json`

3. **输出解析**：
   - YAML 响应 → 使用 `yq` 解析
   - JSON 响应 → 使用 `jq` 解析

## 依赖安装

### 服务器端

```bash
npm install js-yaml
```

### 客户端

```bash
pip install yq --break-system-packages
```

## 实际使用示例

### 打开窗口

```bash
cicy-rpc "
name: open_window
arguments:
  url: https://gemini.google.com
"
```

### 设置窗口位置

```bash
cicy-rpc "
name: set_window_bounds
arguments:
  win_id: 1
  x: 1320
  y: 0
  width: 360
  height: 720
"
```

### 执行 JavaScript

```bash
cicy-rpc "
name: exec_js
arguments:
  win_id: 1
  code: document.title
"
```

### 复杂参数

```bash
cicy-rpc "
name: open_window
arguments:
  url: https://example.com
  accountIdx: 1
  reuseWindow: false
  options:
    width: 1280
    height: 720
"
```

## 性能影响

### Token 消耗

- **YAML**: 平均节省 30-45% 字符
- **网络传输**: 响应体积减少约 40%
- **解析速度**: YAML 略慢，但差异可忽略

### 推荐使用场景

- ✅ **AI 对话**: 使用 YAML（节省 token）
- ✅ **命令行工具**: 使用 YAML（易读易写）
- ⚠️ **程序化调用**: JSON 或 YAML 均可
- ⚠️ **性能关键**: JSON（解析更快）

## 故障排除

### yq 未安装

```bash
❌ Error: yq not found. Install with: pip install yq --break-system-packages
```

**解决方案：**
```bash
pip install yq --break-system-packages
```

### YAML 语法错误

```bash
❌ Error: yaml.scanner.ScannerError: mapping values are not allowed here
```

**解决方案：**
- 检查缩进（使用空格，不要用 Tab）
- 确保冒号后有空格
- 检查特殊字符是否需要引号

### 服务器不支持 YAML

如果服务器版本较旧，使用 JSON 格式：

```bash
cicy-rpc --json '{"name":"ping","arguments":{}}'
```

## 技术实现

### 服务器端 (Node.js)

```javascript
const yaml = require('js-yaml');

app.post("/rpc", async (req, res) => {
  const acceptHeader = req.get('Accept') || 'application/json';
  const useYaml = acceptHeader.includes('application/yaml');
  
  const response = { /* ... */ };
  
  if (useYaml) {
    res.type('application/yaml').send(yaml.dump(response));
  } else {
    res.json(response);
  }
});
```

### 客户端 (Bash)

```bash
# YAML 转 JSON
PARAMS=$(echo "$PARAMS_INPUT" | yq -c .)

# 设置 Accept 头
ACCEPT_HEADER="application/yaml"

# 解析 YAML 响应
curl ... | yq -r '.result.content[].text'
```

## 最佳实践

1. **默认使用 YAML** - 节省 token 和带宽
2. **复杂嵌套使用 JSON** - 避免 YAML 缩进问题
3. **程序化调用优先 JSON** - 更好的库支持
4. **命令行优先 YAML** - 更易读易写

## 参考资源

- [YAML 规范](https://yaml.org/)
- [js-yaml 文档](https://github.com/nodeca/js-yaml)
- [yq 文档](https://github.com/kislyuk/yq)
