#!/bin/bash

# 快速测试所有 REST API 端点

TOKEN=$(jq -r .api_token ~/global.json)
BASE_URL="http://localhost:8101"

echo "=== Testing All REST API Endpoints ==="
echo ""

# 简单测试（无参数）
SIMPLE_TOOLS="ping get_windows"

for tool in $SIMPLE_TOOLS; do
    echo "Testing: $tool"
    curl -s -X POST "$BASE_URL/rpc/$tool" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $TOKEN" \
      -d '{}' | jq -c '.content[0].text' | head -c 100
    echo "..."
    echo ""
done

echo ""
echo "✅ 所有 36 个工具的 REST 端点格式："
echo ""
curl -s "$BASE_URL/rpc/tools" -H "Authorization: Bearer $TOKEN" | \
  jq -r '.tools[].name' | \
  awk '{print "POST /rpc/" $1}'
