#!/usr/bin/env bash
# RK3588 双屏 kiosk 启动：主屏 /play（左）+ 副屏 /secondary（右）
#
# 背景（2026-09-13 双屏协同卡死排查结论）：
# 1. 单实例开两个窗口时，第二次调用只会把页面塞进 kiosk 窗口的隐藏标签页，
#    副屏物理屏幕上什么都没有（联动“假死”）——必须用两个独立实例；
# 2. 独立实例各自持有 GPU 进程，单屏解码故障不会拖垮另一屏；
# 3. 必须先安装 /etc/chromium-browser/customizations/10-disable-hw-video-decode
#    （禁用硬件视频解码，规避 vendor MPP 多会话 alloc_task failed 导致的整机冻结，
#     详见 部署说明.md「RK3588 系统侧稳定性配置」）；
# 4. GNOME 会把全屏/kiosk 窗口放到鼠标所在显示器——用指针位置引导放屏。
#
# 用法：bash start-dual-kiosk.sh
# 环境变量：PPTIST_PORT（默认 8686）、SCREEN_W/SCREEN_H（单屏分辨率，默认 3840x2160）
set -e
cd "$(dirname "$0")"
PORT="${PPTIST_PORT:-8686}"
SW="${SCREEN_W:-3840}"
SH="${SCREEN_H:-2160}"
HALF_H=$((SH / 2))

if [ -z "${DISPLAY:-}" ]; then
  echo "[dual-kiosk] 需要 DISPLAY（Xwayland/X11 会话内运行）" >&2
  exit 1
fi
AUTH=$(ps -eo args | grep -o "\-auth [^ ]*" | grep mutter-Xwayland | head -1 | cut -d" " -f2)
[ -n "$AUTH" ] && export XAUTHORITY="$AUTH"
command -v xdotool >/dev/null || { echo "[dual-kiosk] 缺少 xdotool（sudo apt-get install -y xdotool）" >&2; exit 1; }

# 清掉旧实例（注意：模式加 [] 避免匹配到本脚本自身命令行）
pkill -f "chromium[-]browser" 2>/dev/null || true
sleep 4

FLAGS="--kiosk --noerrdialogs --disable-session-crashed-bubble --check-for-update-interval=31536000 --use-gl=egl"
# 必须走 wrapper（/usr/bin/chromium-browser），否则 /etc/chromium-browser/customizations 不生效
BIN=/usr/bin/chromium-browser
[ -x "$BIN" ] || BIN=$(command -v chromium-browser)

echo "[dual-kiosk] 主屏 /play → 左屏 (0,0) ${SW}x${SH}"
xdotool mousemove $((SW / 4)) $HALF_H
nohup "$BIN" $FLAGS --user-data-dir="$HOME/.config/chromium-play" \
  --window-position=0,0 --window-size="${SW},${SH}" \
  "http://127.0.0.1:${PORT}/play" >/tmp/chromium-play.log 2>&1 &
sleep 8

echo "[dual-kiosk] 副屏 /secondary → 右屏 (${SW},0)"
xdotool mousemove $((SW + SW / 4)) $HALF_H
nohup "$BIN" $FLAGS --user-data-dir="$HOME/.config/chromium-secondary" \
  --window-position="${SW},0" --window-size="${SW},${SH}" \
  "http://127.0.0.1:${PORT}/secondary" >/tmp/chromium-secondary.log 2>&1 &
sleep 6

echo "[dual-kiosk] 窗口布局："
for w in $(xdotool search --class "chromium-browser" 2>/dev/null); do
  xdotool getwindowgeometry --shell "$w" 2>/dev/null | awk -v w="$w" '/^(X|WIDTH)/{printf "%s=%s ",$1,$2}END{print "wid=" w}'
done | grep "WIDTH=${SW}"
echo "[dual-kiosk] 完成。服务地址: http://$(hostname -I | awk '{print $1}'):${PORT}"
