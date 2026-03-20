#!/bin/bash

# REST API Examples for CiCy Desktop

TOKEN=$(jq -r .api_token ~/global.json)
BASE_URL="http://localhost:8101"

echo "=== CiCy Desktop REST API Examples ==="
echo ""

# 1. Ping
echo "1. Ping"
curl -s -X POST "$BASE_URL/rpc/ping" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{}' | jq
echo ""

# 2. List all tools
echo "2. List all tools"
curl -s "$BASE_URL/rpc/tools" \
  -H "Authorization: Bearer $TOKEN" | jq '.tools | length'
echo ""

# 3. Get windows
echo "3. Get windows"
curl -s -X POST "$BASE_URL/rpc/get_windows" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{}' | jq
echo ""

# 4. Open window
echo "4. Open window"
curl -s -X POST "$BASE_URL/rpc/open_window" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"url":"https://example.com","accountIdx":0}' | jq
echo ""

echo "5. Wait 3 seconds..."
sleep 3

# 6. Get windows again
echo "6. Get windows (should show 1 window)"
curl -s -X POST "$BASE_URL/rpc/get_windows" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{}' | jq '.content[0].text | fromjson'
echo ""

# 7. Close window
echo "7. Close window 1"
curl -s -X POST "$BASE_URL/rpc/close_window" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"win_id":1}' | jq
echo ""

echo "=== Done ==="
echo ""
echo "📚 Swagger UI: http://localhost:8101/api-docs"
echo "📖 Documentation: docs/REST-API.md"
