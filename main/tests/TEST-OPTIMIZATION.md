# 测试优化说明

## 问题
运行全部测试会导致 CPU 100%，因为：
- 多个测试同时操作 Electron 窗口
- 进程清理不彻底
- 资源竞争

## 解决方案

### 1. 分批运行测试（推荐）
```bash
npm run test:batches
```
每批测试之间会自动清理进程，避免资源累积。

### 2. 运行单个测试文件
```bash
npm run test:single basic-tools.test.js
```

### 3. 运行所有测试（谨慎使用）
```bash
npm test
```
⚠️ 可能导致 CPU 高负载

## 测试分组

### Batch 1: 基础测试
- basic-tools.test.js
- error-handling.test.js
- rest-api.test.js

### Batch 2: 窗口测试
- window-tools.test.js
- set-window-bounds.test.js

### Batch 3: CDP 测试
- cdp-tools.test.js
- cdp-keyboard.test.js

### Batch 4: JS 执行测试
- exec-js.test.js

### Batch 5: 其他测试
- show-float-div.test.js
- multi-account.test.js
- network-capture.test.js
- all-tools.test.js

## 配置优化

- `maxWorkers: 1` - 单线程运行
- `maxConcurrency: 1` - 单个测试并发
- `--runInBand` - 串行执行
- `globalSetup/Teardown` - 统一启动/清理服务器

## 端口分配

- RPC 测试: 18101
- MCP 测试: 18102
