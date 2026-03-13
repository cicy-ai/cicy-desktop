#!/bin/bash

# Electron MCP 启动脚本
# 用于在 macOS 上双击启动 Electron MCP 服务

# 设置脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"

# 输出启动信息
echo "========================================="
echo "  Electron MCP 启动脚本"
echo "  项目目录: $PROJECT_DIR"
echo "========================================="

# 检查是否在正确的项目目录
if [ ! -f "$PROJECT_DIR/package.json" ]; then
    echo "❌ 错误: 未找到 package.json 文件"
    echo "请确保脚本在 electron-mcp 项目根目录中"
    read -p "按任意键退出..."
    exit 1
fi

# 切换到项目目录
cd "$PROJECT_DIR"

# 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未找到 Node.js"
    echo "请先安装 Node.js: https://nodejs.org/"
    read -p "按任意键退出..."
    exit 1
fi

# 检查 npm 是否安装
if ! command -v npm &> /dev/null; then
    echo "❌ 错误: 未找到 npm"
    echo "请先安装 npm"
    read -p "按任意键退出..."
    exit 1
fi

# 检查依赖是否安装
if [ ! -d "node_modules" ]; then
    echo "📦 正在安装依赖..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ 依赖安装失败"
        read -p "按任意键退出..."
        exit 1
    fi
fi

# 检查 Electron 是否安装
if ! command -v electron &> /dev/null && [ ! -f "node_modules/.bin/electron" ]; then
    echo "❌ 错误: 未找到 Electron"
    echo "正在安装 Electron..."
    npm install electron --save-dev
    if [ $? -ne 0 ]; then
        echo "❌ Electron 安装失败"
        read -p "按任意键退出..."
        exit 1
    fi
fi

# 设置环境变量
export NODE_ENV=development

# 启动服务
echo "🚀 正在启动 Electron MCP 服务..."
echo "端口: 8101"
echo "调试端口: 9221"
echo ""
echo "服务启动后可以访问:"
echo "- MCP 服务: http://localhost:8101/mcp"
echo "- API 文档: http://localhost:8101/docs"
echo "- 远程调试: http://localhost:9221"
echo ""
echo "按 Ctrl+C 停止服务"
echo "========================================="

# 启动应用
npm start

# 如果启动失败，显示错误信息
if [ $? -ne 0 ]; then
    echo ""
    echo "❌ 服务启动失败"
    echo "请检查错误信息并重试"
    read -p "按任意键退出..."
    exit 1
fi