#!/usr/bin/env bash
# 启动 PPTist 服务并打开浏览器页面
# 用法：./start-pptist.sh [play|editor|upload|showflow|secondary|reveal|led-preview]（默认 play）
#
# 每次启动都会先清掉所有旧的服务进程（含没有 pid 文件的孤儿进程），
# 确保磁盘上的新版 server/pptist-server.mjs 与最新配置真正生效。
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"

PAGE="${1:-play}"
case "$PAGE" in
  play|editor|upload|showflow|secondary|reveal|led-preview|lcd-preview) ;;
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
export PPTIST_PORT PPTIST_PUBLIC_URL PPTIST_DATA_DIR PPTIST_SECONDARY_DATA_DIR PPTIST_MAX_UPLOAD_MB

# ---- 0. 校验服务端文件为新版（旧文件 + 新页面会协议不一致） ----
if ! grep -q 'uploadEnvelope' server/pptist-server.mjs 2>/dev/null; then
  echo "[pptist] 错误：server/pptist-server.mjs 是旧版文件（缺少新上传协议）。"
  echo "        请用最新部署包中的 server/pptist-server.mjs 覆盖本文件后重试。"
  exit 1
fi
# ShowFlow 多屏联动的服务端依赖 ws 包（已随部署包捆绑在 server/node_modules/）
if [ ! -d "server/node_modules/ws" ]; then
  echo "[pptist] 错误：缺少 server/node_modules/ws（多屏联动 WebSocket 依赖）。"
  echo "        请用最新部署包完整覆盖 server/ 目录后重试。"
  exit 1
fi
if [ ! -d "server/node_modules/@napi-rs/canvas" ]; then
  echo "[pptist] 错误：缺少 ARM64 LCD 图片渲染依赖 @napi-rs/canvas。"
  echo "        请使用最新完整部署包覆盖 server/ 目录。"
  exit 1
fi

# ---- 1. 清理旧服务进程：按进程名杀掉所有实例（不依赖 pid 文件、不依赖 fuser） ----
if pkill -f 'pptist-server\.mjs' 2>/dev/null; then
  echo "[pptist] 已停止旧的服务进程"
  sleep 1
fi
rm -f server.pid

# 等待端口真正释放（最多 5 秒），避免新进程因端口占用启动失败
"$NODE_CMD" - "$PORT" <<'EOF' || true
const port = process.argv[2] || '8686'
const net = require('net')
const start = Date.now()
;(function probe() {
  const s = net.connect({ port, host: '127.0.0.1', timeout: 400 }, () => {
    s.destroy()
    if (Date.now() - start > 5000) process.exit(0)
    setTimeout(probe, 400)
  })
  s.on('error', () => process.exit(0))      // 连不上 = 端口已释放
  s.on('timeout', () => { s.destroy(); process.exit(0) })
})()
EOF

# ---- 2. 启动服务 ----
echo "[pptist] 启动服务（端口 ${PORT}）..."
nohup "$NODE_CMD" server/pptist-server.mjs >> server.log 2>&1 &
echo $! > server.pid
sleep 1
if ! kill -0 "$(cat server.pid)" 2>/dev/null; then
  echo "[pptist] 服务启动失败，最近日志："
  tail -5 server.log
  exit 1
fi

# ---- 3. 等待就绪并自检（上传协议版本 + 上传上限，直接确认新服务生效） ----
"$NODE_CMD" - "$PORT" <<'EOF'
const port = process.argv[2] || '8686'
const start = Date.now()
;(async () => {
  while (Date.now() - start < 20000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/default-ppt-api/config`)
      if (r.ok) {
        const c = await r.json()
        if (c.uploadEnvelope !== 2) {
          console.error(`[pptist] 警告：响应来自旧版服务进程（协议版本 ${c.uploadEnvelope || '无'}），`)
          console.error('        请执行: pkill -f pptist-server.mjs && ./start-pptist.sh')
          process.exit(1)
        }
        console.log(`[pptist] 服务就绪（新协议已生效，上传上限 ${c.maxUploadMB}MB）`)
        if (c.maxUploadMB <= 100) {
          console.log('[pptist] 提示：上传上限偏小，可在 config.env 中取消 PPTIST_MAX_UPLOAD_MB 注释并调大（默认 1024）')
        }
        process.exit(0)
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  console.error('[pptist] 服务未能在 20 秒内就绪，请查看 server.log')
  process.exit(1)
})()
EOF

# ---- 4. 打开浏览器页面 ----
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
