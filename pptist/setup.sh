#!/usr/bin/env bash
# ============================================================
# PPTist 一键部署脚本（RK3588 / 任意 Linux aarch64 或 x64）
# 用法：把整个 pptist 目录拷到板子上，然后执行：
#   ./setup.sh              常规部署（生成桌面快捷方式）
#   ./setup.sh --autostart  部署 + 开机自启大屏播放页
# ============================================================
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"

# ---- 0. 升级保护提示：覆盖部署不动任何数据 ----
if [ -d "data" ] || [ -f "config.env" ]; then
  echo "[setup] 检测到已有部署：本次为覆盖升级，不会删除任何数据。"
  echo "        保留内容：主屏/副屏文稿(data/)、Studio 草稿与版本(data/studio/)、"
  echo "        联动方案(data/showflow/)、MQTT 配置(data/config/)、config.env"
fi

# ---- 1. 解压包内自带的 Node.js 运行时（无需联网） ----
NODE_TARBALL=$(ls runtime/node-v*-linux-arm64.tar.xz 2>/dev/null | head -1 || true)
if [ ! -x "runtime/node/bin/node" ]; then
  if [ -n "$NODE_TARBALL" ]; then
    echo "[setup] 解压自带 Node.js 运行时 ..."
    command -v xz >/dev/null 2>&1 || { echo "[setup] 缺少 xz，正在安装 xz-utils ..."; (sudo apt-get install -y xz-utils || apt-get install -y xz-utils) >/dev/null 2>&1 || true; }
    mkdir -p runtime/node
    tar -xJf "$NODE_TARBALL" -C runtime/node --strip-components=1
    echo "[setup] Node 运行时就绪：$(runtime/node/bin/node --version)"
  fi
fi

# ---- 2. 选择 Node：优先包内自带，其次系统 Node（需 >= 18） ----
if [ -x "runtime/node/bin/node" ]; then
  NODE_CMD="$DIR/runtime/node/bin/node"
else
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)'; then
    NODE_CMD="$(command -v node)"
    echo "[setup] 使用系统 Node.js：$($NODE_CMD --version)"
  else
    echo "[setup] 错误：未找到可用的 Node.js（需 >= 18）"
    echo "        请联网后重新执行本脚本，或手动安装 Node.js 18+"
    exit 1
  fi
fi

# ---- 3. 生成/升级配置文件 ----
# 上传大小上限默认即为 1GB（程序内置）；如需自定义，取消注释并修改数值后重启服务
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' | tr -d '[:space:]')"
PORT_DEFAULT=8686
if [ ! -f config.env ]; then
  cat > config.env <<EOF
# PPTist 服务配置（修改后重新运行 start-pptist.sh 生效）
PPTIST_PORT=${PORT_DEFAULT}
# 对外访问地址：其他电脑通过该地址访问上传页（已自动填入本机局域网 IP）
PPTIST_PUBLIC_URL=http://${LAN_IP:-127.0.0.1}:${PORT_DEFAULT}
PPTIST_DATA_DIR=${DIR}/data
# 副屏文稿（PPTist B）独立存储目录：与主屏完全独立的两份 PPT
PPTIST_SECONDARY_DATA_DIR=${DIR}/data/secondary-ppt
# LCD JPEG 缓存与岗位照片（升级时请保留 data/）
PPTIST_LED_CACHE_DIR=${DIR}/data/led-cache
PPTIST_LED_PORTRAIT_DIR=${DIR}/data/led-assets/portraits
# 上传大小上限（MB），默认 1024（1GB）；需要调整时取消注释并修改
# PPTIST_MAX_UPLOAD_MB=1024
EOF
  echo "[setup] 已生成 config.env（局域网 IP：${LAN_IP:-未探测到}）"
else
  # 旧版本部署包生成的 config.env 固定了较小上限（如 100/300），会屏蔽程序默认值：
  # 将其注释停用，改用程序默认值 1024MB；需要自定义时取消注释并修改数值
  if grep -q '^PPTIST_MAX_UPLOAD_MB=' config.env; then
    sed -i 's/^PPTIST_MAX_UPLOAD_MB=/# PPTIST_MAX_UPLOAD_MB=/' config.env
    echo '[setup] 已停用 config.env 中旧的上传上限设置，将使用程序默认值 1024MB（重启服务后生效）'
  fi
fi

# ---- 4. 赋予脚本执行权限 ----
chmod +x start-pptist.sh stop-pptist.sh service-run.sh enable-boot-service.sh disable-boot-service.sh 2>/dev/null || true

# ---- 5. 生成桌面快捷方式 ----
DESKTOP_DIR="${XDG_DESKTOP_DIR:-$HOME/Desktop}"
[ -d "$DESKTOP_DIR" ] || DESKTOP_DIR="$HOME/桌面"
[ -d "$DESKTOP_DIR" ] || DESKTOP_DIR="$HOME/Desktop"
mkdir -p "$DESKTOP_DIR" "$HOME/.local/share/applications"

make_desktop() { # $1=输出文件  $2=名称  $3=页面参数  $4=备注
  cat > "$1" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=$2
Comment=$4
Exec=${DIR}/start-pptist.sh ${3}
Path=${DIR}
Icon=${DIR}/logo.png
Terminal=false
Categories=Network;Presentation;
StartupNotify=true
EOF
  chmod +x "$1"
}

make_desktop "$HOME/.local/share/applications/pptist-play.desktop"  "PPTist 大屏播放" "play"   "启动 PPTist 服务并打开大屏播放页"
make_desktop "$HOME/.local/share/applications/pptist-editor.desktop" "PPTist 编辑器" "editor" "启动 PPTist 服务并打开编辑器"
make_desktop "$HOME/.local/share/applications/pptist-upload.desktop" "PPTist 上传页" "upload" "启动 PPTist 服务并打开上传管理页"

# 桌面上只放“大屏播放”主入口，避免杂乱；上传/编辑器可从应用菜单启动
cp "$HOME/.local/share/applications/pptist-play.desktop" "$DESKTOP_DIR/pptist-play.desktop" 2>/dev/null || true
chmod +x "$DESKTOP_DIR/pptist-play.desktop" 2>/dev/null || true
echo "[setup] 已创建桌面快捷方式：PPTist 大屏播放（编辑器/上传页在应用菜单中）"

# ---- 6. 可选：开机自启（通电即放映） ----
if [ "$1" = "--autostart" ]; then
  mkdir -p "$HOME/.config/autostart"
  make_desktop "$HOME/.config/autostart/pptist-play.desktop" "PPTist 大屏播放" "play" "开机自动启动 PPTist 服务并打开播放页"
  echo "[setup] 已设置开机自启（登录桌面后自动打开大屏播放页）"
fi

# ---- 7. 首次部署自检 ----
echo "[setup] 自检：LED 渲染模块（失败仅影响 LCD 即时渲染，不影响主服务）..."
if ! "$NODE_CMD" --input-type=module -e "await import('file://${DIR}/server/led/renderer.mjs')" >/dev/null 2>&1; then
  echo "[setup] 警告：LED 渲染模块加载失败（通常为缺少 @napi-rs/canvas 平台二进制，"
  echo "        或字体文件缺失）。主服务与放映联动不受影响。"
fi
echo "[setup] 自检：启动服务并检查接口 ..."
if ! "./start-pptist.sh" play; then
  echo ""
  echo "=============================================="
  echo " 自检未通过：服务未正常启动（上方已给出原因）。"
  echo " 按提示处理后重新运行 ./start-pptist.sh 即可，"
  echo " 无需重复执行 setup.sh。"
  echo "=============================================="
  exit 1
fi

echo ""
echo "=============================================="
echo " 部署完成！"
echo "   播放页   : http://${LAN_IP:-127.0.0.1}:${PORT_DEFAULT}/play"
echo "   上传页   : http://${LAN_IP:-127.0.0.1}:${PORT_DEFAULT}/upload  （局域网其他电脑访问）"
echo "   编辑器   : http://${LAN_IP:-127.0.0.1}:${PORT_DEFAULT}/editor"
echo "   联动编排 : http://${LAN_IP:-127.0.0.1}:${PORT_DEFAULT}/showflow"
echo "   副屏PPTist: http://${LAN_IP:-127.0.0.1}:${PORT_DEFAULT}/secondary"
echo "   副屏Reveal: http://${LAN_IP:-127.0.0.1}:${PORT_DEFAULT}/reveal"
echo "   LCD预览   : http://${LAN_IP:-127.0.0.1}:${PORT_DEFAULT}/led-preview"
echo " 桌面双击「PPTist 大屏播放」即可一键启动。"
echo " 后台服务开机自启：bash enable-boot-service.sh"
echo "=============================================="
