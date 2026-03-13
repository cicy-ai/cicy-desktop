#!/bin/bash

# Electron MCP 服务管理脚本

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"
PID_FILE="$PROJECT_DIR/.electron-mcp.pid"
LOG_FILE="$HOME/logs/electron-mcp-service.log"

# 创建日志目录
mkdir -p "$(dirname "$LOG_FILE")"

# 显示帮助信息
show_help() {
    echo "Electron MCP 服务管理"
    echo ""
    echo "用法: $0 {start|stop|restart|status|logs}"
    echo ""
    echo "命令:"
    echo "  start   - 启动服务"
    echo "  stop    - 停止服务"
    echo "  restart - 重启服务"
    echo "  status  - 查看状态"
    echo "  logs    - 查看日志"
    echo ""
}

# 启动服务
start_service() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if ps -p "$pid" > /dev/null 2>&1; then
            echo "✅ 服务已在运行 (PID: $pid)"
            return 0
        else
            rm -f "$PID_FILE"
        fi
    fi

    echo "🚀 正在启动 Electron MCP 服务..."
    
    cd "$PROJECT_DIR"
    
    # 检查依赖
    if [ ! -d "node_modules" ]; then
        echo "📦 正在安装依赖..."
        npm install
    fi
    
    # 后台启动服务
    nohup npm start > "$LOG_FILE" 2>&1 &
    local pid=$!
    
    # 保存 PID
    echo "$pid" > "$PID_FILE"
    
    # 等待服务启动
    sleep 3
    
    if ps -p "$pid" > /dev/null 2>&1; then
        echo "✅ 服务启动成功 (PID: $pid)"
        echo "📋 端口: 8101"
        echo "📋 日志: $LOG_FILE"
        echo "📋 MCP 端点: http://localhost:8101/mcp"
        echo "📋 API 文档: http://localhost:8101/docs"
    else
        echo "❌ 服务启动失败"
        rm -f "$PID_FILE"
        return 1
    fi
}

# 停止服务
stop_service() {
    if [ ! -f "$PID_FILE" ]; then
        echo "⚠️  服务未运行"
        return 0
    fi
    
    local pid=$(cat "$PID_FILE")
    
    if ps -p "$pid" > /dev/null 2>&1; then
        echo "🛑 正在停止服务 (PID: $pid)..."
        kill "$pid"
        
        # 等待进程结束
        local count=0
        while ps -p "$pid" > /dev/null 2>&1 && [ $count -lt 10 ]; do
            sleep 1
            count=$((count + 1))
        done
        
        if ps -p "$pid" > /dev/null 2>&1; then
            echo "⚠️  强制停止服务..."
            kill -9 "$pid"
        fi
        
        echo "✅ 服务已停止"
    else
        echo "⚠️  服务进程不存在"
    fi
    
    rm -f "$PID_FILE"
}

# 查看状态
show_status() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if ps -p "$pid" > /dev/null 2>&1; then
            echo "✅ 服务运行中 (PID: $pid)"
            echo "📋 端口: 8101"
            echo "📋 日志: $LOG_FILE"
            
            # 检查端口是否监听
            if lsof -i :8101 > /dev/null 2>&1; then
                echo "📋 端口 8101 正在监听"
            else
                echo "⚠️  端口 8101 未监听"
            fi
        else
            echo "❌ 服务进程不存在 (PID 文件存在但进程已死)"
            rm -f "$PID_FILE"
        fi
    else
        echo "⚠️  服务未运行"
    fi
}

# 查看日志
show_logs() {
    if [ -f "$LOG_FILE" ]; then
        echo "📋 日志文件: $LOG_FILE"
        echo "----------------------------------------"
        tail -f "$LOG_FILE"
    else
        echo "⚠️  日志文件不存在: $LOG_FILE"
    fi
}

# 主逻辑
case "$1" in
    start)
        start_service
        ;;
    stop)
        stop_service
        ;;
    restart)
        stop_service
        sleep 2
        start_service
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs
        ;;
    *)
        show_help
        exit 1
        ;;
esac