#!/usr/bin/env bash
# 停止 PPTist 服务
cd "$(dirname "$0")"
if [ -f server.pid ]; then
  PID=$(cat server.pid)
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "[pptist] 服务已停止（PID $PID）"
  else
    echo "[pptist] 服务未在运行"
  fi
  rm -f server.pid
else
  echo "[pptist] 未找到 server.pid，服务可能未启动"
fi
