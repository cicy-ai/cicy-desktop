# Feature: Distributed Multi-Agent Cluster

## 概述

将 Electron MCP Server 升级为分布式 Multi-Agent 集群系统，支持大规模并行自动化任务。

## 目标

- 支持 100+ Agent 并行工作
- 分布式部署，弹性扩容
- 统一的任务调度和监控
- 高可用、容错设计

## 架构设计

### 1. Master Node（调度中心）

**职责：**
- 任务分发和调度
- 负载均衡
- Worker 健康检查
- Agent Hub 管理界面
- 全局状态监控

**技术栈：**
- Express.js (HTTP API)
- Socket.IO (实时通信)
- Redis (任务队列 + 状态存储)
- Bull (任务队列管理)

**核心 API：**
```javascript
POST /api/tasks          // 创建任务
GET  /api/tasks/:id      // 查询任务状态
GET  /api/workers        // 获取 Worker 列表
GET  /api/agents         // 获取所有 Agent 列表
POST /api/agents/create  // 创建新 Agent
DELETE /api/agents/:id   // 关闭 Agent
```

### 2. Worker Node（执行节点）

**职责：**
- 运行多个 Electron 窗口（Agent）
- 从队列拉取任务
- 执行自动化操作
- 上报状态和结果

**配置：**
```javascript
{
  "workerId": "worker-1",
  "masterUrl": "http://master:8100",
  "maxAgents": 10,        // 最大 Agent 数量
  "port": 8101,
  "resources": {
    "cpu": 4,
    "memory": "8GB"
  }
}
```

**心跳机制：**
- 每 5 秒向 Master 发送心跳
- 上报 CPU、内存、Agent 状态
- 超过 30 秒无心跳视为离线

### 3. Agent（窗口实例）

**属性：**
```javascript
{
  "agentId": "agent-1",
  "workerId": "worker-1",
  "windowId": 1,
  "accountIdx": 0,
  "status": "idle|busy|error",
  "currentTask": "task-123",
  "createdAt": "2026-02-09T05:00:00Z"
}
```

**状态流转：**
```
idle → busy → idle
  ↓      ↓
error ← error
```

## 核心功能

### 1. 任务队列系统

**任务结构：**
```javascript
{
  "taskId": "task-123",
  "type": "scrape|test|automation",
  "priority": 1-10,
  "payload": {
    "url": "https://example.com",
    "actions": [
      { "tool": "open_window", "args": {...} },
      { "tool": "cdp_click", "args": {...} },
      { "tool": "exec_js", "args": {...} }
    ]
  },
  "requirements": {
    "accountIdx": 0,      // 指定账户
    "workerId": null,     // 指定 Worker（可选）
    "timeout": 300000     // 超时时间（ms）
  },
  "status": "pending|running|completed|failed",
  "result": {...},
  "createdAt": "2026-02-09T05:00:00Z",
  "startedAt": null,
  "completedAt": null
}
```

**队列优先级：**
- High Priority Queue (priority 8-10)
- Normal Queue (priority 4-7)
- Low Priority Queue (priority 1-3)

### 2. 负载均衡策略

**策略选择：**
1. **Round Robin**：轮询分配
2. **Least Connections**：分配给最空闲的 Worker
3. **Resource Based**：根据 CPU/内存负载分配
4. **Affinity**：相同账户的任务分配到同一 Worker

**实现：**
```javascript
class LoadBalancer {
  selectWorker(task, workers) {
    // 过滤健康的 Worker
    const healthy = workers.filter(w => w.status === 'online');
    
    // 根据策略选择
    switch (this.strategy) {
      case 'least-connections':
        return healthy.sort((a, b) => a.busyAgents - b.busyAgents)[0];
      case 'resource-based':
        return healthy.sort((a, b) => a.cpuUsage - b.cpuUsage)[0];
      default:
        return healthy[this.roundRobinIndex++ % healthy.length];
    }
  }
}
```

### 3. Agent Hub 管理界面

**页面结构：**
```
/agent-hub
├── Dashboard
│   ├── 总览统计（Worker/Agent/Task 数量）
│   ├── 实时监控图表（CPU/内存/任务吞吐）
│   └── 告警信息
├── Workers
│   ├── Worker 列表（状态、资源、Agent 数量）
│   ├── 添加 Worker
│   └── Worker 详情（Agent 列表、日志）
├── Agents
│   ├── Agent 列表（带缩略图）
│   ├── 创建 Agent
│   ├── Agent 详情（当前任务、历史记录）
│   └── 批量操作
├── Tasks
│   ├── 任务列表（状态、进度）
│   ├── 创建任务
│   ├── 任务详情（执行日志、结果）
│   └── 任务模板
└── Settings
    ├── 负载均衡策略
    ├── 资源限制
    └── 告警配置
```

**技术栈：**
- React + TypeScript
- Ant Design / Material-UI
- Socket.IO Client (实时更新)
- ECharts (监控图表)

### 4. 健康检查与容错

**健康检查：**
```javascript
// Worker 心跳
setInterval(() => {
  axios.post(`${masterUrl}/api/heartbeat`, {
    workerId: this.workerId,
    status: 'online',
    agents: this.getAgentStatus(),
    resources: {
      cpuUsage: os.loadavg()[0],
      memoryUsage: process.memoryUsage(),
      diskUsage: getDiskUsage()
    }
  });
}, 5000);
```

**容错机制：**
1. **Worker 离线**：
   - 将其任务重新分配到其他 Worker
   - 标记 Agent 为 offline
   - 发送告警通知

2. **任务超时**：
   - 自动重试（最多 3 次）
   - 标记为 failed
   - 记录错误日志

3. **Agent 崩溃**：
   - 自动重启 Agent
   - 恢复任务执行
   - 上报异常

### 5. 服务发现与注册

**使用 Redis 作为注册中心：**
```javascript
// Worker 注册
redis.hset('workers', workerId, JSON.stringify({
  workerId,
  url: `http://${ip}:${port}`,
  status: 'online',
  maxAgents: 10,
  registeredAt: Date.now()
}));

// 设置 TTL（30 秒）
redis.expire(`worker:${workerId}`, 30);

// Master 发现 Worker
const workers = await redis.hgetall('workers');
```

## 数据模型

### Redis 数据结构

```
# Worker 注册表
workers:{workerId} → {workerId, url, status, maxAgents, ...}

# Agent 状态
agents:{agentId} → {agentId, workerId, windowId, status, ...}

# 任务队列
queue:high → [taskId1, taskId2, ...]
queue:normal → [taskId3, taskId4, ...]
queue:low → [taskId5, taskId6, ...]

# 任务状态
tasks:{taskId} → {taskId, status, result, ...}

# Worker 心跳
heartbeat:{workerId} → timestamp (TTL: 30s)
```

## API 设计

### Master API

```javascript
// 任务管理
POST   /api/tasks              // 创建任务
GET    /api/tasks              // 任务列表
GET    /api/tasks/:id          // 任务详情
DELETE /api/tasks/:id          // 取消任务

// Worker 管理
GET    /api/workers            // Worker 列表
GET    /api/workers/:id        // Worker 详情
POST   /api/workers/:id/restart // 重启 Worker

// Agent 管理
GET    /api/agents             // Agent 列表
POST   /api/agents             // 创建 Agent
DELETE /api/agents/:id         // 关闭 Agent
GET    /api/agents/:id/screenshot // Agent 截图

// 监控
GET    /api/stats              // 统计信息
GET    /api/metrics            // Prometheus 指标
```

### Worker API

```javascript
// 保持现有 MCP 工具 API
POST   /rpc/{tool_name}        // 执行工具

// 新增集群相关
POST   /api/heartbeat          // 心跳上报
POST   /api/tasks/:id/result   // 任务结果上报
GET    /api/agents             // 本地 Agent 列表
```

## 部署方案

### 单机部署（开发/测试）

```bash
# 启动 Master
npm run start:master

# 启动 Worker
npm run start:worker -- --master=http://localhost:8100
```

### 分布式部署（生产）

```yaml
# docker-compose.yml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
  
  master:
    build: .
    command: npm run start:master
    ports:
      - "8100:8100"
    environment:
      - REDIS_URL=redis://redis:6379
      - NODE_ENV=production
  
  worker:
    build: .
    command: npm run start:worker
    environment:
      - MASTER_URL=http://master:8100
      - REDIS_URL=redis://redis:6379
      - DISPLAY=:99
    deploy:
      replicas: 3
```

### Kubernetes 部署

```yaml
# k8s/master-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: electron-mcp-master
spec:
  replicas: 1
  selector:
    matchLabels:
      app: electron-mcp-master
  template:
    metadata:
      labels:
        app: electron-mcp-master
    spec:
      containers:
      - name: master
        image: electron-mcp:latest
        command: ["npm", "run", "start:master"]
        ports:
        - containerPort: 8100
        env:
        - name: REDIS_URL
          value: "redis://redis-service:6379"

---
# k8s/worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: electron-mcp-worker
spec:
  replicas: 5
  selector:
    matchLabels:
      app: electron-mcp-worker
  template:
    metadata:
      labels:
        app: electron-mcp-worker
    spec:
      containers:
      - name: worker
        image: electron-mcp:latest
        command: ["npm", "run", "start:worker"]
        env:
        - name: MASTER_URL
          value: "http://master-service:8100"
        - name: DISPLAY
          value: ":99"
        resources:
          limits:
            memory: "4Gi"
            cpu: "2"
```

## 监控与告警

### Prometheus 指标

```javascript
// 指标定义
const metrics = {
  workers_total: new Gauge({ name: 'workers_total', help: 'Total workers' }),
  agents_total: new Gauge({ name: 'agents_total', help: 'Total agents' }),
  tasks_total: new Counter({ name: 'tasks_total', help: 'Total tasks' }),
  tasks_duration: new Histogram({ name: 'tasks_duration_seconds', help: 'Task duration' }),
  worker_cpu_usage: new Gauge({ name: 'worker_cpu_usage', help: 'Worker CPU usage' }),
  worker_memory_usage: new Gauge({ name: 'worker_memory_usage', help: 'Worker memory usage' })
};

// 暴露指标
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
```

### Grafana Dashboard

- Worker 状态面板
- Agent 数量趋势
- 任务吞吐量
- 资源使用率
- 错误率统计

### 告警规则

```yaml
# alerts.yml
groups:
  - name: electron-mcp
    rules:
      - alert: WorkerDown
        expr: up{job="electron-mcp-worker"} == 0
        for: 1m
        annotations:
          summary: "Worker {{ $labels.instance }} is down"
      
      - alert: HighCPUUsage
        expr: worker_cpu_usage > 0.8
        for: 5m
        annotations:
          summary: "Worker {{ $labels.worker_id }} CPU usage > 80%"
      
      - alert: TaskQueueBacklog
        expr: tasks_pending > 100
        for: 10m
        annotations:
          summary: "Task queue has {{ $value }} pending tasks"
```

## 安全考虑

1. **认证授权**：
   - Master API 需要 Bearer Token
   - Worker 注册需要预共享密钥
   - Agent Hub 需要登录

2. **网络隔离**：
   - Worker 只能访问 Master
   - Agent 网络流量可限制

3. **资源限制**：
   - 每个 Worker 最大 Agent 数量
   - 任务超时自动终止
   - 内存/CPU 限制

## 性能优化

1. **连接池**：
   - Redis 连接池
   - HTTP 连接复用

2. **批量操作**：
   - 批量创建 Agent
   - 批量查询状态

3. **缓存策略**：
   - Worker 列表缓存（5 秒）
   - Agent 状态缓存（1 秒）

4. **异步处理**：
   - 任务结果异步上报
   - 日志异步写入

## 实施计划

### Phase 1: 基础架构（2 周）
- [ ] Master Node 基础框架
- [ ] Worker 注册与心跳
- [ ] Redis 任务队列
- [ ] 基础 API 实现

### Phase 2: 任务调度（2 周）
- [ ] 任务分发逻辑
- [ ] 负载均衡实现
- [ ] 任务执行与结果上报
- [ ] 容错机制

### Phase 3: 管理界面（2 周）
- [ ] Agent Hub 前端开发
- [ ] Dashboard 实时监控
- [ ] Worker/Agent 管理
- [ ] 任务管理界面

### Phase 4: 监控告警（1 周）
- [ ] Prometheus 集成
- [ ] Grafana Dashboard
- [ ] 告警规则配置
- [ ] 日志收集

### Phase 5: 部署优化（1 周）
- [ ] Docker 镜像优化
- [ ] Kubernetes 配置
- [ ] 性能测试
- [ ] 文档完善

## 验收标准

1. **功能完整性**：
   - ✅ 支持 100+ Agent 并行
   - ✅ 任务自动分发和执行
   - ✅ Worker 动态扩容
   - ✅ 完整的管理界面

2. **性能指标**：
   - 任务分发延迟 < 100ms
   - 单 Worker 支持 10+ Agent
   - 任务吞吐量 > 1000/分钟
   - 系统可用性 > 99.9%

3. **可维护性**：
   - 完整的监控指标
   - 详细的日志记录
   - 清晰的错误提示
   - 完善的文档

## 参考资料

- [Bull Queue Documentation](https://github.com/OptimalBits/bull)
- [Socket.IO Documentation](https://socket.io/docs/)
- [Prometheus Best Practices](https://prometheus.io/docs/practices/)
- [Kubernetes Patterns](https://kubernetes.io/docs/concepts/)
