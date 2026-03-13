#!/bin/bash

# 简化版 Electron MCP 启动脚本
# 避免复杂的路径检测，直接使用固定路径

# 强制保持终端打开
exec 2>&1

echo "========================================="
echo "  🚀 Electron MCP 启动脚本 (简化版)"
echo "  📅 $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="

# 尝试多个可能的项目路径
PROJECT_PATHS=(
    "/Users/ton/Desktop/electron-mcp"
    "$HOME/Desktop/electron-mcp"
    "$HOME/Documents/electron-mcp"
    "$HOME/Projects/electron-mcp"
)

PROJECT_DIR=""

echo "🔍 正在查找项目目录..."

for path in "${PROJECT_PATHS[@]}"; do
    echo "检查: $path"
    if [ -f "$path/package.json" ]; then
        PROJECT_DIR="$path"
        echo "✅ 找到项目: $PROJECT_DIR"
        break
    fi
done

if [ -z "$PROJECT_DIR" ]; then
    echo ""
    echo "❌ 错误: 找不到 electron-mcp 项目"
    echo ""
    echo "请确保项目在以下位置之一："
    for path in "${PROJECT_PATHS[@]}"; do
        echo "  - $path"
    done
    echo ""
    echo "或者手动输入项目路径:"
    read -p "项目路径: " USER_PATH
    if [ -f "$USER_PATH/package.json" ]; then
        PROJECT_DIR="$USER_PATH"
        echo "✅ 使用用户指定路径: $PROJECT_DIR"
    else
        echo "❌ 指定路径无效"
        echo "按回车键退出..."
        read
        exit 1
    fi
fi

echo ""
echo "📁 项目目录: $PROJECT_DIR"
echo "📁 切换到项目目录..."

cd "$PROJECT_DIR" || {
    echo "❌ 无法切换到项目目录"
    echo "按回车键退出..."
    read
    exit 1
}

echo "✅ 当前目录: $(pwd)"

# 检查 Node.js
echo ""
echo "🔍 检查 Node.js..."
if command -v node >/dev/null 2>&1; then
    echo "✅ Node.js: $(node --version)"
else
    echo "❌ 未找到 Node.js"
    echo "请安装 Node.js: https://nodejs.org/"
    echo "按回车键退出..."
    read
    exit 1
fi

# 检查 npm
echo "🔍 检查 npm..."
if command -v npm >/dev/null 2>&1; then
    echo "✅ npm: $(npm --version)"
else
    echo "❌ 未找到 npm"
    echo "按回车键退出..."
    read
    exit 1
fi

# 检查依赖
echo ""
echo "🔍 检查项目依赖..."
if [ ! -d "node_modules" ]; then
    echo "📦 安装依赖中..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ 依赖安装失败"
        echo "按回车键退出..."
        read
        exit 1
    fi
else
    echo "✅ 依赖已安装"
fi

# 启动服务
echo ""
echo "========================================="
echo "🚀 启动 Electron MCP 服务"
echo "📋 端口: 8101"
echo "📋 API: http://localhost:8101/docs"
echo ""
echo "⚠️  关闭此窗口将停止服务"
echo "   按 Ctrl+C 停止服务"
echo "========================================="
echo ""

# 启动并保持运行
npm start

# 服务停止后的处理
echo ""
echo "========================================="
if [ $? -eq 0 ]; then
    echo "✅ 服务正常停止"
else
    echo "❌ 服务异常退出 (退出码: $?)"
fi
echo ""
echo "按回车键关闭窗口..."
read