#!/bin/bash

# 生成所有 RPC 工具的 REST API 调用示例

TOKEN=$(cat ~/data/electron/token.txt)
BASE_URL="http://localhost:8101"

echo "# Electron MCP REST API - All Tools"
echo ""
echo "## Available Tools"
echo ""

# 获取所有工具
TOOLS=$(curl -s "$BASE_URL/rpc/tools" -H "Authorization: Bearer $TOKEN" | jq -r '.tools[].name')

# 为每个工具生成示例
for tool in $TOOLS; do
    echo "### $tool"
    echo ""
    echo '```bash'
    echo "curl -X POST $BASE_URL/rpc/$tool \\"
    echo "  -H \"Content-Type: application/json\" \\"
    echo "  -H \"Authorization: Bearer \$(cat ~/data/electron/token.txt)\" \\"
    echo "  -d '{}'"
    echo '```'
    echo ""
done

echo ""
echo "## Common Examples with Parameters"
echo ""

cat << 'EOF'
### open_window
```bash
curl -X POST http://localhost:8101/rpc/open_window \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{"url":"https://example.com","accountIdx":0}'
```

### close_window
```bash
curl -X POST http://localhost:8101/rpc/close_window \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{"win_id":1}'
```

### exec_js
```bash
curl -X POST http://localhost:8101/rpc/exec_js \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{"win_id":1,"code":"document.title"}'
```

### cdp_click
```bash
curl -X POST http://localhost:8101/rpc/cdp_click \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{"win_id":1,"selector":"button.submit"}'
```

### cdp_type_text
```bash
curl -X POST http://localhost:8101/rpc/cdp_type_text \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{"win_id":1,"selector":"input[name=username]","text":"myuser"}'
```

### load_url
```bash
curl -X POST http://localhost:8101/rpc/load_url \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{"win_id":1,"url":"https://google.com"}'
```

### get_window_info
```bash
curl -X POST http://localhost:8101/rpc/get_window_info \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{"win_id":1}'
```

### cdp_scroll
```bash
curl -X POST http://localhost:8101/rpc/cdp_scroll \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{"win_id":1,"x":0,"y":500}'
```

### get_console_logs
```bash
curl -X POST http://localhost:8101/rpc/get_console_logs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{"win_id":1}'
```

### get_requests
```bash
curl -X POST http://localhost:8101/rpc/get_requests \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/data/electron/token.txt)" \
  -d '{"win_id":1}'
```
EOF
