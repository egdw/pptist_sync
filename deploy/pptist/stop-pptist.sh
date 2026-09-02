#!/usr/bin/env bash
# 停止 PPTist 服务（pid 文件 + 进程名双重清理，确保无残留）
cd "$(dirname "$0")"
STOPPED=0
if [ -f server.pid ]; then
  PID=$(cat server.pid)
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" && STOPPED=1
    echo "[pptist] 已停止服务进程（PID $PID）"
  fi
  rm -f server.pid
fi
# 兜底：按进程名清理所有实例（含无 pid 文件的孤儿进程 / 其他目录启动的旧实例）
if pkill -f 'pptist-server\.mjs' 2>/dev/null; then
  echo "[pptist] 已清理其余服务进程"
  STOPPED=1
fi
[ "$STOPPED" = "1" ] || echo "[pptist] 服务未在运行"
