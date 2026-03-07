# 任务：抖音视频下载技能

## 需求描述

创建一个技能脚本，实现抖音视频自动下载功能：
- 接收抖音视频 URL（如 `https://www.douyin.com/video/7594434780347813155`）
- 使用 electron-mcp 服务器打开/加载 URL
- 捕获包含 `__vid` 的视频真实地址
- 使用 `session_download_url` 下载到 `~/Desktop/video`
- 通过 `./skills/curl-rpc` 调用所有 RPC API
- 在 `skills/download-douyin-video/` 中编写测试
- 提供详细使用文档和技能描述

## 实现方案

### 技术路径
1. 使用 `curl-rpc` 调用 electron-mcp 的 MCP 工具
2. 打开抖音视频页面，等待加载完成
3. 使用 `get_requests` 或 `filter_requests` 捕获包含 `__vid` 的视频 URL
4. 调用 `session_download_url` 下载视频
5. 保存到 `~/Desktop/video/{video_id}.mp4`

### 目录结构
```
skills/
└── download-douyin-video/
    ├── download-douyin-video.sh      # 主脚本
    ├── download-douyin-video.md      # 详细文档
    ├── tests/
    │   └── test-download.sh          # 测试脚本
    └── README.md                     # 快速使用指南
```

### 核心实现步骤
1. 参数解析和验证
2. 检查 electron-mcp 服务状态
3. 打开抖音视频页面
4. 等待页面加载（5-10秒）
5. 捕获包含 `__vid` 的视频 URL
6. 下载视频到指定目录
7. 错误处理和日志输出

## TODO 清单

- [x] 创建分支 feat-0209-douyin-download
- [x] 安装依赖
- [x] 创建任务文档
- [x] 创建 skills/download-douyin-video 目录结构
- [x] 实现主脚本 download-douyin-video.sh
  - [x] 参数解析（抖音 URL）
  - [x] 验证 electron-mcp 服务状态
  - [x] 调用 open_window 打开页面
  - [x] 等待页面加载完成
  - [x] 捕获视频 URL（包含 __vid）
  - [x] 下载视频到指定目录
  - [x] 错误处理和日志
- [x] 编写测试脚本 tests/test-download.sh
- [x] 编写 README.md（快速使用指南）
- [x] 编写 download-douyin-video.md（详细文档）
- [x] 运行测试验证功能
- [x] 更新 SKILLS-LIST.md
- [x] 提交代码并创建 PR
- [x] PR 已创建：https://github.com/cicy-dev/electron-mcp/pull/10

## 验收标准

- [x] 功能正常工作：能成功下载抖音视频
- [x] 所有测试通过：`bash skills/download-douyin-video/tests/test-download.sh`
- [x] 代码符合规范：使用 curl-rpc，遵循项目风格
- [x] 文档已更新：README 和详细文档完整
- [x] 错误处理完善：网络失败、视频不存在等情况

## 开发日志

### 2026-02-09 01:00 - 01:15
- ✅ 创建分支 feat-0209-douyin-download
- ✅ 克隆仓库到工作目录
- ✅ 安装依赖成功
- ✅ 创建任务文档
- ✅ 实现主脚本 download-douyin-video.sh
- ✅ 编写测试脚本 tests/test-download.sh
- ✅ 创建 README.md 快速使用指南
- ✅ 创建 download-douyin-video.md 详细文档
- ✅ 修正 curl-rpc 路径问题
- ✅ 所有基础测试通过
- ✅ 更新 SKILLS-LIST.md
- ✅ 提交代码到远程仓库
- ✅ 创建 PR #10
- 🎉 任务完成！
