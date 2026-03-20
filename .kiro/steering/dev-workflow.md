---
inclusion: always
---

# Git 开发工作流程 - Git Development Workflow

## ⚠️ 开发前必读

**在开始任何开发任务前，必须完整阅读本文档并严格遵循所有规范。**

违反规范将导致：
- ❌ 代码被拒绝合并
- ❌ 浪费时间重做
- ❌ 影响项目质量

## 🚨 核心原则（必须遵守）

1. **开发前必读本文档** - 不要凭记忆或猜测
2. **严格遵循每个阶段** - 不要跳过任何步骤
3. **遇到问题先分析** - 不要盲目重试
4. **测试驱动开发** - 一功能一测试
5. **全部测试通过才提交** - npm test 必须 100% 通过

## 新功能/Bug修复标准流程

当收到开发新功能或修复bug的请求时，严格遵循以下流程：

### 阶段1：需求分析
1. **用户提出需求**
2. **AI 制定可行方案**
   - 分析技术实现路径
   - 评估工作量和风险
   - 提出具体实现方案
3. **询问用户是否有补充**
4. **等待用户确认"开始"**

### 阶段2：环境准备（用户说"开始"后执行）
```bash
# 分支命名规范：
# - 新功能：feat-MMDD-功能简述
# - Bug修复：fix-MMDD-问题简述

# 1. 直接在工作目录克隆并创建分支
mkdir -p ~/projects/cicy-desktop/branches/
git clone -b origin/main git@github.com:cicy-ai/cicy-desktop.git ~/projects/cicy-desktop/branches/<branch-name>
sudo ln -s /<branch-name> ~/projects/cicy-desktop/branches/<branch-name>
cd /<branch-name>
git fetch origin
git checkout -b <branch-name> origin/main

# 2. 安装依赖
npm install
```

### 阶段3：需求文档化
在工作目录创建 `task/task-<branch-name>.md` 文档，包含：

```markdown
# 任务：[功能/Bug简述]

## 需求描述
[用户原始需求]

## 实现方案
[技术方案详细说明]

## TODO 清单
- [ ] 任务1
- [ ] 任务2
- [ ] 任务3

## 验收标准
- [ ] 功能正常工作
- [ ] 所有测试通过
- [ ] 代码符合规范
- [ ] 文档已更新
```

### 阶段4：开发实现
```bash
# 在工作目录进行开发
cd /<branch-name>

# ⚠️ 必须遵循：一功能一测试
# ❌ 禁止：写完所有代码再测试
# ✅ 正确：每完成一个功能立即测试

# 实时更新 TASK.md 中的完成状态
```

**核心原则：增量开发，持续验证**

### 阶段5：本地测试（❗强制要求）
```bash
# ⚠️ 必须运行完整测试套件
npm test

# ❌ 如果测试失败，绝对不能提交
# ✅ 必须所有测试通过才能进入下一阶段
# ✅ 验证所有验收标准
```

**⚠️ 警告：如果跳过此步骤直接提交，视为严重违规！**

**遇到测试失败时：**
1. ❌ 不要盲目重试
2. ✅ 仔细阅读错误信息
3. ✅ 分析失败原因（依赖缺失？代码错误？环境问题？）
4. ✅ 总结问题根源
5. ✅ 制定修复方案
6. ✅ 修复后再次测试

### 阶段6：提交和推送
```bash
# 提交更改
git add .
git commit -m "feat/fix: 简要描述更改内容"

# 推送到远程
git push origin <branch-name>
```

### 阶段7：创建 Pull Request
```bash
# 使用 GitHub CLI 创建 PR
gh pr create --base main --head <branch-name> --title "标题" --body "详细描述"

# 或手动在 GitHub 网页创建 PR
```

## 分支命名示例

### 新功能
- `feat-0206-add-cdp-scroll`
- `feat-0206-multi-account-support`
- `feat-0206-network-monitor`

### Bug修复
- `fix-0206-window-close-crash`
- `fix-0206-screenshot-memory-leak`
- `fix-0206-test-timeout`

## 工作目录结构
```
~/
├── projects/
│   └── cicy-desktop/main             # 主仓库
└── projects/cicy-desktop/branches/
    ├── feat-0206-feature1/
    ├── fix-0206-bug1/
    └── feat-0206-feature2/
```

## 核心原则
- ✅ 始终基于 `origin/main` 创建新分支
- ✅ 使用独立工作目录避免污染主仓库
- ✅ **本地测试必须全部通过才能提交（npm test）**
- ✅ **一功能一测试，不要全写完再测试**
- ✅ 分支名称包含日期和清晰的功能/问题描述
- ✅ 提交信息遵循 conventional commits 规范
- ❌ **禁止跳过测试直接提交代码**
- ❌ **禁止一次性写完所有代码**

---
**制定时间：2026-02-06**
**适用项目：cicy-desktop**
