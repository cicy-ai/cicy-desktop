#!/bin/bash

# 复制修复后的启动脚本到桌面

DESKTOP_PATH="$HOME/Desktop"
SOURCE_FILE="./cicy-desktop-fixed.command"
TARGET_FILE="$DESKTOP_PATH/cicy-desktop.command"

echo "正在复制修复后的启动脚本到桌面..."

# 备份原文件（如果存在）
if [ -f "$TARGET_FILE" ]; then
    echo "备份原文件为 cicy-desktop.command.backup"
    cp "$TARGET_FILE" "$TARGET_FILE.backup"
fi

# 复制新文件
cp "$SOURCE_FILE" "$TARGET_FILE"

# 设置执行权限
chmod +x "$TARGET_FILE"

echo "✅ 复制完成！"
echo "📁 文件位置: $TARGET_FILE"
echo ""
echo "现在你可以双击桌面上的 cicy-desktop.command 文件来启动服务了！"