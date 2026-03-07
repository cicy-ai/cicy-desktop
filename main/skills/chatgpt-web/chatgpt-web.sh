#!/bin/bash
# ChatGPT Web 自动化工具

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(dirname "$SCRIPT_DIR")"

check_service() {
    if ! curl-rpc ping >/dev/null 2>&1; then
        echo "服务未运行，正在启动..."
        bash "$SKILLS_DIR/electron-mcp-service/service.sh" start
        sleep 5
    fi
}

check_chatgpt_window() {
    local WINDOWS=$(curl-rpc get_windows 2>/dev/null)
    if echo "$WINDOWS" | grep -q "chatgpt.com"; then
        echo "ChatGPT 窗口已存在"
        return 0
    else
        echo "未找到 ChatGPT 窗口，正在打开..."
        curl-rpc open_window url="https://chatgpt.com"
        sleep 5
        return 1
    fi
}

wait_dom_ready() {
    echo "等待页面加载..."
    sleep 3
}

check_login() {
    local STATUS=$(curl-rpc chatgpt_web_status 2>/dev/null)
    if echo "$STATUS" | grep -q 'isLogged.*true'; then
        echo "已登录"
        return 0
    else
        echo "⚠️ 未登录! 请在浏览器中登录 ChatGPT"
        return 1
    fi
}

COMMAND=${1:-help}
shift || true

check_service

case "$COMMAND" in
    status)
        curl-rpc chatgpt_web_status
        ;;
    conversations)
        check_chatgpt_window
        wait_dom_ready
        LIMIT=${1:-10}
        STRIP=${2:-0}
        curl-rpc get_chatgpt_web_conversations limit="$LIMIT" strip="$STRIP"
        ;;
    messages)
        check_chatgpt_window
        wait_dom_ready
        curl-rpc get_chatgpt_web_current_messages
        ;;
    messages-by-id)
        check_chatgpt_window
        wait_dom_ready
        CONV_ID=$1
        curl-rpc get_chatgpt_web_messages_by_id conversation_id="$CONV_ID"
        ;;
    ask)
        check_chatgpt_window
        wait_dom_ready
        check_login || exit 1
        TEXT="$*"
        RESULT=$(curl-rpc chatgpt_web_ask text="$TEXT" 2>/dev/null)
        echo "$RESULT" | jq -r '.result[0].text | fromjson.reply' 2>/dev/null || echo "$RESULT" | grep -oP '"reply":\s*"\K[^"]+' | sed 's/\\n/\n/g'
        ;;
    set-prompt)
        check_chatgpt_window
        wait_dom_ready
        TEXT="$*"
        curl-rpc chatgpt_web_set_prompt text="$TEXT"
        ;;
    send)
        check_chatgpt_window
        wait_dom_ready
        curl-rpc chatgpt_web_click_send
        ;;
    clear)
        check_chatgpt_window
        wait_dom_ready
        curl-rpc chatgpt_web_clear_prompt
        ;;
    open)
        CONV_ID=$1
        if [ -z "$CONV_ID" ]; then
            echo "Usage: $0 open <conversation_id>"
            exit 1
        fi
        curl-rpc open_chatgpt_web_chat_by_id conversation_id="$CONV_ID"
        ;;
    is-logged)
        check_chatgpt_window
        wait_dom_ready
        curl-rpc is_chatgpt_logged
        ;;
    help|--help|-h)
        echo "ChatGPT Web 自动化工具"
        echo ""
        echo "用法: $0 <command> [options]"
        echo ""
        echo "命令:"
        echo "  status                    查看 ChatGPT 状态"
        echo "  conversations [limit]     获取对话列表 (默认 10)"
        echo "  messages                 获取当前对话消息"
        echo "  messages-by-id <id>      获取指定对话消息"
        echo "  ask <text>               提问并获取回复"
        echo "  set-prompt <text>        设置输入框内容"
        echo "  send                     发送消息"
        echo "  clear                    清空输入框"
        echo "  open <conversation_id>   打开指定对话"
        echo "  is-logged                检查登录状态"
        echo ""
        echo "示例:"
        echo "  $0 status"
        echo "  $0 conversations 5"
        echo "  $0 ask 你好"
        echo "  $0 open 6998268c-9480-8323-83ab-f6c58da23c6f"
        ;;
    *)
        echo "未知命令: $COMMAND"
        echo "使用 $0 help 查看帮助"
        exit 1
        ;;
esac
