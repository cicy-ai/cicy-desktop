#!/bin/zsh
set -e

PROJECT_DIR="/Users/ton/projects/cicy-desktop"

exec 2>&1

echo "========================================="
echo "  🚀 CiCy Desktop Master + Worker"
echo "  📅 $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="

if [ ! -d "$PROJECT_DIR" ]; then
  echo "❌ Project directory not found: $PROJECT_DIR"
  echo "按回车键退出..."
  read
  exit 1
fi

cd "$PROJECT_DIR" || {
  echo "❌ Failed to cd into project directory"
  echo "按回车键退出..."
  read
  exit 1
}

echo "📁 Project: $PROJECT_DIR"

# Dev override: if .env.dev exists in the project root, source it before
# npm start. Useful for CICY_HOMEPAGE_URL=http://localhost:8173 to load
# the workers/render vite dev server (HMR) into the BrowserWindow instead
# of the production CF Worker / bundled file://.
if [ -f "$PROJECT_DIR/.env.dev" ]; then
  echo "🧪 .env.dev detected — loading dev overrides"
  set -a
  . "$PROJECT_DIR/.env.dev"
  set +a
fi

echo "🚀 Running: npm start"
echo "⚠️  关闭此窗口将停止 Master 和 Worker"
echo "========================================="
echo ""

npm start

echo ""
echo "========================================="
echo "Master + Worker 已停止"
echo "按回车键关闭窗口..."
read
