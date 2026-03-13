#!/bin/bash

echo "🔄 更新桌面启动脚本..."

# 设置路径
DESKTOP_FILE="$HOME/Desktop/electron-mcp.command"
SOURCE_FILE="./electron-mcp-simple.command"

# 备份现有文件
if [ -f "$DESKTOP_FILE" ]; then
    echo "📋 备份现有文件..."
    cp "$DESKTOP_FILE" "$DESKTOP_FILE.old"
fi

# 复制新文件
echo "📁 复制新文件..."
cp "$SOURCE_FILE" "$DESKTOP_FILE"

# 设置权限
echo "🔐 设置执行权限..."
chmod +x "$DESKTOP_FILE"

# 验证
if [ -f "$DESKTOP_FILE" ] && [ -x "$DESKTOP_FILE" ]; then
    echo "✅ 更新完成！"
    echo "📁 文件: $DESKTOP_FILE"
    echo "🔐 权限: $(ls -l "$DESKTOP_FILE" | cut -d' ' -f1)"
    echo ""
    echo "现在可以双击桌面上的 electron-mcp.command 启动服务了！"
else
    echo "❌ 更新失败"
    exit 1
fi