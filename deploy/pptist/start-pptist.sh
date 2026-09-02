#!/usr/bin/env bash
# 启动 PPTist 服务并打开浏览器页面
# 用法：./start-pptist.sh [play|editor|upload]   （默认 play）
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"

PAGE="${1:-play}"
case "$PAGE" in
  play|editor|upload) ;;
  *) PAGE="play" ;;
esac

# ---- 读取配置 ----
if [ -f config.env ]; then
  . ./config.env
fi
PORT="${PPTIST_PORT:-8686}"

# ---- 选择 Node：优先包内自带 ----
if [ -x "runtime/node/bin/node" ]; then
  NODE_CMD="$DIR/runtime/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_CMD="$(command -v node)"
else
  echo "[pptist] 错误：未找到 Node.js，请先执行 ./setup.sh"
  exit 1
fi
export PPTIST_PORT PPTIST_PUBLIC_URL PPTIST_DATA_DIR PPTIST_MAX_UPLOAD_MB

# ---- 启动服务（已在运行则跳过；清理端口占用，避免旧进程残留导致新服务启动失败） ----
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then
  echo "[pptist] 服务已在运行（PID $(cat server.pid)）"
else
  rm -f server.pid
  # 清理占用端口的其他进程（上次的孤儿进程等）
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" 2>/dev/null && sleep 1
  fi
  echo "[pptist] 启动服务（端口 ${PORT}）..."
  nohup "$NODE_CMD" server/pptist-server.mjs >> server.log 2>&1 &
  echo $! > server.pid
  sleep 1
  if ! kill -0 "$(cat server.pid)" 2>/dev/null; then
    echo "[pptist] 服务启动失败，最近日志："
    tail -5 server.log
    exit 1
  fi
fi

# ---- 等待服务就绪（最多 15 秒，用 node 自身探测，无需 curl） ----
"$NODE_CMD" - "$PORT" <<'EOF'
const port = process.argv[2] || '8686'
const start = Date.now()
;(async () => {
  while (Date.now() - start < 15000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/default-ppt-api/config`)
      if (r.ok) {
        const c = await r.json()
        console.log(`[pptist] 服务就绪（上传上限 ${c.maxUploadMB}MB）`)
        process.exit(0)
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  console.error('[pptist] 服务未能在 15 秒内就绪，请查看 server.log')
  process.exit(1)
})()
EOF

# ---- 打开浏览器页面 ----
URL="http://127.0.0.1:${PORT}/${PAGE}"
open_browser() {
  if command -v chromium-browser >/dev/null 2>&1; then
    chromium-browser --kiosk --noerrdialogs --disable-session-crashed-bubble --check-for-update-interval=31536000 "$URL" &
  elif command -v chromium >/dev/null 2>&1; then
    chromium --kiosk --noerrdialogs --disable-session-crashed-bubble --check-for-update-interval=31536000 "$URL" &
  elif command -v google-chrome >/dev/null 2>&1; then
    google-chrome --kiosk --noerrdialogs "$URL" &
  elif command -v firefox >/dev/null 2>&1; then
    firefox --kiosk "$URL" &
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
  else
    echo "[pptist] 未找到浏览器，请手动访问：$URL"
  fi
}
echo "[pptist] 打开页面：$URL"
open_browser
