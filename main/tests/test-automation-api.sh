#!/bin/bash
# Electron 自动化 API 测试脚本

BASE_URL="http://localhost:8101"
TOKEN="${ELECTRON_MCP_TOKEN:-test-token}"

echo "🧪 Electron 自动化 API 测试"
echo "================================"
echo ""

# 测试1: 创建窗口
echo "📝 测试1: 创建窗口"
curl -s -X POST "$BASE_URL/rpc/open_window" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}' | jq .
echo ""

# 等待窗口加载
sleep 3

# 测试2: 获取窗口列表
echo "📝 测试2: 获取窗口列表"
curl -s -X POST "$BASE_URL/rpc/get_windows" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
echo ""

# 测试3: 获取页面标题
echo "📝 测试3: 获取页面标题"
curl -s -X POST "$BASE_URL/rpc/get_title" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"win_id": 1}' | jq .
echo ""

# 测试4: 执行JavaScript
echo "📝 测试4: 执行JavaScript获取URL"
curl -s -X POST "$BASE_URL/rpc/electron_evaluate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"win_id": 1, "code": "window.location.href"}' | jq .
echo ""

# 测试5: 获取页面内容
echo "📝 测试5: 获取页面内容"
curl -s -X POST "$BASE_URL/rpc/electron_get_content" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"win_id": 1, "selector": "h1", "type": "text"}' | jq .
echo ""

# 测试6: 等待元素
echo "📝 测试6: 等待元素出现"
curl -s -X POST "$BASE_URL/rpc/electron_wait_for" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"win_id": 1, "selector": "body", "timeout": 5000}' | jq .
echo ""

# 测试7: 截图
echo "📝 测试7: 窗口截图"
SCREENSHOT=$(curl -s -X POST "$BASE_URL/rpc/electron_screenshot" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"win_id": 1, "format": "jpeg"}')
echo "$SCREENSHOT" | jq '.content[0].text | fromjson | {format, size}'
echo ""

# 测试8: 加载新URL
echo "📝 测试8: 加载新URL"
curl -s -X POST "$BASE_URL/rpc/load_url" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"win_id": 1, "url": "https://www.google.com"}' | jq .
echo ""

sleep 2

# 测试9: 点击元素（Google搜索框）
echo "📝 测试9: 点击搜索框"
curl -s -X POST "$BASE_URL/rpc/electron_click" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"win_id": 1, "selector": "textarea[name=\"q\"]", "waitTimeout": 5000}' | jq .
echo ""

# 测试10: 输入文字
echo "📝 测试10: 输入搜索关键词"
curl -s -X POST "$BASE_URL/rpc/electron_type" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"win_id": 1, "selector": "textarea[name=\"q\"]", "text": "Electron automation", "clear": true}' | jq .
echo ""

# 测试11: 获取元素属性
echo "📝 测试11: 获取输入框的值"
curl -s -X POST "$BASE_URL/rpc/electron_evaluate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"win_id": 1, "code": "document.querySelector(\"textarea[name=\\\"q\\\"]\").value"}' | jq .
echo ""

echo "✅ 测试完成！"
echo ""
echo "💡 提示："
echo "  - 设置TOKEN: export ELECTRON_MCP_TOKEN=your-token"
echo "  - 查看文档: cat docs/AUTOMATION-API.md"
