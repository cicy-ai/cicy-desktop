#!/bin/bash

# Electron MCP 启动脚本 - 修复版本
# 用于在 macOS 上双击启动 Electron MCP 服务

# 设置错误处理
set -e

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 检查是否在项目目录中
if [ -f "$SCRIPT_DIR/package.json" ]; then
    PROJECT_DIR="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/electron-mcp/package.json" ]; then
    PROJECT_DIR="$SCRIPT_DIR/electron-mcp"
else
    # 如果脚本在桌面，尝试找到项目目录
    if [ -f "/Users/ton/Desktop/electron-mcp/package.json" ]; then
        PROJECT_DIR="/Users/ton/Desktop/electron-mcp"
    elif [ -f "$HOME/Desktop/electron-mcp/package.json" ]; then
        PROJECT_DIR="$HOME/Desktop/electron-mcp"
    else
        echo "❌ 错误: 找不到 electron-mcp 项目目录"
        echo "请确保项目在以下位置之一："
        echo "- $SCRIPT_DIR/electron-mcp/"
        echo "- $HOME/Desktop/electron-mcp/"
        echo ""
        echo "按任意键退出..."
        read -n 1
        exit 1
    fi
fi

# 输出启动信息
clear
echo "========================================="
echo "  🚀 Electron MCP 启动脚本"
echo "  📁 项目目录: $PROJECT_DIR"
echo "  📅 时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="

# 切换到项目目录
cd "$PROJECT_DIR"

# 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未找到 Node.js"
    echo "请先安装 Node.js: https://nodejs.org/"
    echo ""
    echo "按任意键退出..."
    read -n 1
    exit 1
fi

echo "✅ Node.js 版本: $(node --version)"

# 检查 npm 是否安装
if ! command -v npm &> /dev/null; then
    echo "❌ 错误: 未找到 npm"
    echo "请先安装 npm"
    echo ""
    echo "按任意键退出..."
    read -n 1
    exit 1
fi

echo "✅ npm 版本: $(npm --version)"

# 检查依赖是否安装
if [ ! -d "node_modules" ]; then
    echo ""
    echo "📦 正在安装依赖..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ 依赖安装失败"
        echo ""
        echo "按任意键退出..."
        read -n 1
        exit 1
    fi
    echo "✅ 依赖安装完成"
fi

# 检查 Electron 是否可用
if ! command -v electron &> /dev/null && [ ! -f "node_modules/.bin/electron" ]; then
    echo ""
    echo "📦 正在安装 Electron..."
    npm install electron --save-dev
    if [ $? -ne 0 ]; then
        echo "❌ Electron 安装失败"
        echo ""
        echo "按任意键退出..."
        read -n 1
        exit 1
    fi
    echo "✅ Electron 安装完成"
fi

# 设置环境变量
export NODE_ENV=development

# 显示启动信息
echo ""
echo "========================================="
echo "🚀 正在启动 Electron MCP 服务..."
echo "📋 端口: 8101"
echo "📋 调试端口: 9221"
echo ""
echo "服务启动后可以访问:"
echo "- MCP 服务: http://localhost:8101/mcp"
echo "- API 文档: http://localhost:8101/docs"
echo "- 远程调试: http://localhost:9221"
echo ""
echo "⚠️  关闭此窗口将停止服务"
echo "   按 Ctrl+C 可以优雅停止服务"
echo "========================================="
echo ""

# 启动应用（不使用 exit，让进程保持运行）
npm start

# 如果 npm start 退出，显示信息
echo ""
echo "========================================="
if [ $? -eq 0 ]; then
    echo "✅ 服务已正常停止"
else
    echo "❌ 服务异常退出"
    echo "请检查上面的错误信息"
fi
echo ""
echo "按任意键关闭窗口..."
read -n 1