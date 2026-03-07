#!/bin/bash
# Multi-Account Management Tool
# 多账户管理工具

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${MCP_URL:-http://localhost:8101}"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# RPC 调用函数
rpc_call() {
    local method="$1"
    shift
    curl -s -X POST "$BASE_URL/rpc" \
        -H "Content-Type: application/json" \
        -d "{\"method\":\"$method\",\"params\":{$@}}" | \
        yq -p json -o json '.result' 2>/dev/null || echo "null"
}

# 打开新账户窗口
open_account() {
    local url="$1"
    local account_idx="${2:-0}"
    
    echo -e "${GREEN}📂 Opening account: $account_idx${NC}"
    echo -e "${YELLOW}🌐 URL: $url${NC}"
    
    # 创建账户配置目录
    local account_dir="$HOME/data/electron"
    local account_file="$account_dir/account-${account_idx}.json"
    
    mkdir -p "$account_dir"
    
    # 如果账户文件不存在，创建默认配置
    if [ ! -f "$account_file" ]; then
        echo -e "${YELLOW}📝 Creating account config: $account_file${NC}"
        cat > "$account_file" << EOF
{
  "accountIdx": $account_idx,
  "createdAt": "$(date -Iseconds)",
  "windows": [],
  "metadata": {
    "description": "Account $account_idx",
    "tags": []
  }
}
EOF
    fi
    
    # 使用 curl-rpc 直接调用
    local result=$(curl-rpc open_window url="$url" accountIdx=$account_idx reuseWindow=false 2>&1)
    
    if echo "$result" | grep -q "Opened window"; then
        # 提取窗口 ID
        local win_id=$(echo "$result" | grep -oP 'ID: \K\d+')
        
        # 更新账户配置，添加窗口信息
        if [ -n "$win_id" ]; then
            local temp_file=$(mktemp)
            jq --arg url "$url" --arg win_id "$win_id" --arg time "$(date -Iseconds)" \
               '.windows += [{"winId": ($win_id|tonumber), "url": $url, "openedAt": $time}] | .updatedAt = $time' \
               "$account_file" > "$temp_file" && mv "$temp_file" "$account_file"
            echo -e "${GREEN}✅ Updated account config${NC}"
        fi
        
        echo -e "${GREEN}✅ Window opened successfully${NC}"
        echo "$result"
    else
        echo -e "${RED}❌ Failed to open window${NC}"
        echo "$result"
        return 1
    fi
}

# 列出所有窗口
list_windows() {
    echo -e "${GREEN}📋 Listing all windows...${NC}"
    curl-rpc get_windows
}

# 关闭窗口
close_window() {
    local win_id="$1"
    
    echo -e "${YELLOW}🗑️  Closing window $win_id...${NC}"
    
    local result=$(curl-rpc close_window win_id=$win_id 2>&1)
    
    if echo "$result" | grep -q "closed"; then
        echo -e "${GREEN}✅ Window closed${NC}"
    else
        echo -e "${RED}❌ Failed to close window${NC}"
        echo "$result"
        return 1
    fi
}

# 帮助信息
show_help() {
    cat << EOF
Multi-Account Management Tool

Usage:
    $0 <command> [options]

Commands:
    open <url> [account_idx]    Open a new account window (default: 0)
    list                        List all windows
    close <win_id>              Close a window
    help                        Show this help

Examples:
    # Open Telegram with account 0
    $0 open https://web.telegram.org/k/ 0
    
    # Open Telegram with account 1
    $0 open https://web.telegram.org/k/ 1
    
    # List all windows
    $0 list
    
    # Close window 1
    $0 close 1

Environment:
    MCP_URL    MCP server URL (default: http://localhost:8101)

EOF
}

# 主函数
main() {
    local command="${1:-help}"
    
    case "$command" in
        open)
            if [ -z "$2" ]; then
                echo -e "${RED}❌ Error: URL required${NC}"
                echo "Usage: $0 open <url> [account_idx]"
                exit 1
            fi
            open_account "$2" "${3:-0}"
            ;;
        list)
            list_windows
            ;;
        close)
            if [ -z "$2" ]; then
                echo -e "${RED}❌ Error: Window ID required${NC}"
                echo "Usage: $0 close <win_id>"
                exit 1
            fi
            close_window "$2"
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            echo -e "${RED}❌ Unknown command: $command${NC}"
            show_help
            exit 1
            ;;
    esac
}

main "$@"
