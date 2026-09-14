#!/usr/bin/env bash
# PPTist 双屏 kiosk 启动器 v2
#
# 用法:
#   ./start-dual-kiosk.sh                 # 启动主屏(/play) + 副屏(/secondary)
#   ./start-dual-kiosk.sh restart         # 完全重启: 重启 pptist 服务 + 双屏浏览器,
#                                         # 两屏自动恢复到重启前的画面(联动运行时持久化)
#   ./start-dual-kiosk.sh --main=HDMI-2 --sec=HDMI-1
#                                         # 指定哪块 HDMI 显示主屏/副屏(默认 HDMI-1=主, HDMI-2=副)
#
# HDMI 分配: 自动探测已连接的显示器(xrandr);也可用环境变量
#   PPTIST_MAIN_DISPLAY / PPTIST_SEC_DISPLAY 或 config.env 配置。
#
# 背景(2026-09 双屏协同卡死排查结论, 详见 部署说明.md):
# 1. 必须两个独立实例——单实例第二次调用只会把页面塞进隐藏标签页;
# 2. 必须先安装 /etc/chromium-browser/customizations/10-disable-hw-video-decode
#    (禁硬解, 规避 vendor MPP 多会话冻结)——经 wrapper 启动才生效;
# 3. 浏览器启动后, 播放页自动按服务端持久化的联动运行时恢复到重启前的虚拟步骤。
set -e
cd "$(dirname "$0")"
PORT="${PPTIST_PORT:-8686}"

ACTION="start"
ARGS=()
for arg in "$@"; do
  case "$arg" in
    restart|stop|status) ACTION="$arg" ;;
    --main=*) MAIN_REQ="${arg#--main=}" ;;
    --sec=*) SEC_REQ="${arg#--sec=}" ;;
    *) ARGS+=("$arg") ;;
  esac
done

# ---------- stop: 只关浏览器 ----------
if [ "$ACTION" = "stop" ]; then
  pkill -f "chromium[-]browser" 2>/dev/null || true
  echo "[dual-kiosk] 浏览器已停止（服务未动，页面服务仍在线）"
  exit 0
fi

# ---------- status ----------
if [ "$ACTION" = "status" ]; then
  echo "== 显示器 =="
  export DISPLAY="${DISPLAY:-:0}"
  XAUTH=$(ps -eo args | grep -o "\-auth [^ ]*" | grep mutter-Xwayland | head -1 | cut -d" " -f2)
  [ -n "$XAUTH" ] && export XAUTHORITY="$XAUTH"
  xrandr --listmonitors 2>/dev/null || echo "(xrandr 不可用)"
  echo "== kiosk 实例 =="
  ps -eo pid,args | grep "chromium[-]browser" | grep -vE "type=|crashpad" | grep -oE "user-data-dir=[^ ]+|http[^ ]+" | paste -sd' ' -n - 2>/dev/null || true
  echo "== 联动运行时 =="
  curl -s --max-time 4 "http://127.0.0.1:${PORT}/api/studio/system/status" | python3 -c "
import json,sys,time
try:
    d=json.load(sys.stdin); now=time.time()*1000
    ws=d['websocket']; r=ws['runtime']
    print(f\"runtime: step={r.get('stepId')} seq={r.get('seq')}\")
    for role,i in ws['roles'].items():
        print(f\"{role}: lastSeen={(now-i['lastSeen'])/1000:.0f}s ago conn={i['connections']}\")
except Exception as e: print('服务不可达:', e)"
  exit 0
fi

# ---------- restart: 服务 + 双屏浏览器, 页面自动恢复到重启前画面 ----------
if [ "$ACTION" = "restart" ]; then
  echo "[dual-kiosk] 完全重启：pptist 服务 + 双屏浏览器"
  if sudo -n systemctl restart pptist 2>/dev/null || sudo systemctl restart pptist; then
    echo "[dual-kiosk] pptist 服务已重启"
  else
    echo "[dual-kiosk] 警告：服务重启失败（无 sudo 权限?），仅重启浏览器" >&2
  fi
  sleep 3
  ACTION="start"
fi

# ---------- 显示器探测与分配 ----------
if [ -z "${DISPLAY:-}" ]; then
  echo "[dual-kiosk] 需要 DISPLAY（Xwayland/X11 会话内运行）" >&2
  exit 1
fi
XAUTH=$(ps -eo args | grep -o "\-auth [^ ]*" | grep mutter-Xwayland | head -1 | cut -d" " -f2)
[ -n "$XAUTH" ] && export XAUTHORITY="$XAUTH"
command -v xdotool >/dev/null || { echo "[dual-kiosk] 缺少 xdotool（sudo apt-get install -y xdotool）" >&2; exit 1; }

# 解析活动显示器: " 0: +*HDMI-1 3840/1200x2160/680+0+0" → NAME X W H
declare -A MON_X MON_W MON_H
declare -a MON_LIST=()
if command -v xrandr >/dev/null 2>&1; then
  while read -r line; do
    NAME=$(echo "$line" | awk '{print $2}' | sed 's/^[+*!~-]*//')
    # 行样例: " 0: +*HDMI-1 3840/1200x2160/680+0+0  HDMI-1" → W=3840 H=2160 X=0 Y=0
    if [[ "$line" =~ ([0-9]+)/[0-9]+x([0-9]+)/[0-9]+\+([0-9]+)\+([0-9]+) ]]; then
      MON_X[$NAME]=${BASH_REMATCH[3]}
      MON_W[$NAME]=${BASH_REMATCH[1]}
      MON_H[$NAME]=${BASH_REMATCH[2]}
      MON_LIST+=("$NAME")
    fi
  done < <(xrandr --listmonitors 2>/dev/null | grep -E "^\s*[0-9]+:")
fi

# 主/副屏分配: CLI > 环境变量 > 自动(第一/第二块活动屏, 缺省名 HDMI-1/HDMI-2)
MAIN_REQ="${MAIN_REQ:-${PPTIST_MAIN_DISPLAY:-}}"
SEC_REQ="${SEC_REQ:-${PPTIST_SEC_DISPLAY:-}}"
if [ -n "$MAIN_REQ" ]; then MAIN_DISP="$MAIN_REQ"; else MAIN_DISP="${MON_LIST[0]:-HDMI-1}"; fi
if [ -n "$SEC_REQ" ]; then SEC_DISP="$SEC_REQ"; else SEC_DISP="${MON_LIST[1]:-${MON_LIST[0]:-HDMI-2}}"; fi

for d in "$MAIN_DISP" "$SEC_DISP"; do
  if [ -z "${MON_X[$d]:-}" ]; then
    echo "[dual-kiosk] 错误：显示器 $d 未连接或不存在。活动显示器: ${MON_LIST[*]:-未知}" >&2
    echo "             可用 --main=<名> --sec=<名> 重新指定" >&2
    exit 1
  fi
done
MX="${MON_X[$MAIN_DISP]}"; MW="${MON_W[$MAIN_DISP]}"; MH="${MON_H[$MAIN_DISP]}"
SX="${MON_X[$SEC_DISP]}"; SW="${MON_W[$SEC_DISP]}"; SH="${MON_H[$SEC_DISP]}"
echo "[dual-kiosk] 分配: 主屏=$MAIN_DISP(+${MX}, ${MW}x${MH}) 副屏=$SEC_DISP(+${SX}, ${SW}x${SH})"
[ "$MAIN_DISP" = "$SEC_DISP" ] && { echo "[dual-kiosk] 错误：主副屏不能是同一块显示器" >&2; exit 1; }

# ---------- 清理并启动 ----------
pkill -f "chromium[-]browser" 2>/dev/null || true
sleep 4
FLAGS="--kiosk --noerrdialogs --disable-session-crashed-bubble --check-for-update-interval=31536000 --use-gl=egl"
# 必须走 wrapper（/usr/bin/chromium-browser），否则 /etc/chromium-browser/customizations 不生效
BIN=/usr/bin/chromium-browser
[ -x "$BIN" ] || BIN=$(command -v chromium-browser)

echo "[dual-kiosk] 主屏 /play → $MAIN_DISP"
xdotool mousemove $((MX + MW / 4)) $((MH / 2))
nohup "$BIN" $FLAGS --user-data-dir="$HOME/.config/chromium-play" \
  --window-position=${MX},0 --window-size=${MW},${MH} \
  "http://127.0.0.1:${PORT}/play" >/tmp/chromium-play.log 2>&1 &
sleep 8

echo "[dual-kiosk] 副屏 /secondary → $SEC_DISP"
xdotool mousemove $((SX + SW / 4)) $((SH / 2))
nohup "$BIN" $FLAGS --user-data-dir="$HOME/.config/chromium-secondary" \
  --window-position=${SX},0 --window-size=${SW},${SH} \
  "http://127.0.0.1:${PORT}/secondary" >/tmp/chromium-secondary.log 2>&1 &
sleep 6

echo "[dual-kiosk] 窗口布局："
for w in $(xdotool search --class "chromium-browser" 2>/dev/null); do
  xdotool getwindowgeometry --shell "$w" 2>/dev/null | awk '/^(X|WIDTH)/{printf "%s=%s ",$1,$2}END{print ""}'
done | grep "WIDTH=${MW}" | sed 's/^/  /'
echo "[dual-kiosk] 完成。页面将自动恢复到上次的联动画面。服务地址: http://$(hostname -I | awk '{print $1}'):${PORT}"
