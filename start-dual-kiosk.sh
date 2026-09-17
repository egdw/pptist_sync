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
    restart|stop|status|check) ACTION="$arg" ;;
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

# ---------- check: 现场赛前自检（任何陌生屏幕环境先跑这个） ----------
if [ "$ACTION" = "check" ]; then
  FAIL=0
  say() { echo "  $*"; }
  echo "== 现场赛前自检 =="
  # 1. 显示器
  export DISPLAY="${DISPLAY:-:0}"
  XAUTH=$(ps -eo args | grep -o "\-auth [^ ]*" | grep mutter-Xwayland | head -1 | cut -d" " -f2)
  [ -n "$XAUTH" ] && export XAUTHORITY="$XAUTH"
  MON_OUT=$(xrandr --listmonitors 2>&1)
  MON_N=$(echo "$MON_OUT" | grep -cE "^[[:space:]]*[0-9]+:")
  if [ "$MON_N" -ge 2 ]; then say "✓ 显示器: $MON_N 块 ($(echo "$MON_OUT" | grep -oE 'HDMI[-0-9]*|DP[-0-9]*|eDP[-0-9]*' | sort -u | paste -sd' ' -))"; 
  elif [ "$MON_N" = 1 ]; then say "⚠ 只检测到 1 块显示器——将以主屏全屏 + 副屏半屏同屏降级运行: "; echo "$MON_OUT" | tail -n +2;
  else say "✗ 未检测到显示器（xrandr 失败或桌面未登录）"; FAIL=1; fi
  # 2. 服务
  if curl -s --max-time 4 "http://127.0.0.1:${PORT}/default-ppt-api/config" >/dev/null 2>&1; then say "✓ pptist 服务在线（端口 ${PORT}）"; else say "✗ pptist 服务不可达——先 sudo systemctl restart pptist"; FAIL=1; fi
  # 3. 文稿
  CUR=$(curl -s --max-time 4 "http://127.0.0.1:${PORT}/default-ppt-api/current" 2>/dev/null)
  echo "$CUR" | grep -q '"exists":true' && say "✓ 主屏文稿: $(echo "$CUR" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("filename",""), d.get("pageCount",""), "页")' 2>/dev/null)" || { say "✗ 主屏无文稿"; FAIL=1; }
  # 4. 禁硬解
  if grep -qs "disable-accelerated-video-decode" /etc/chromium-browser/customizations/* 2>/dev/null; then say "✓ Chromium 禁硬解已配置"; else say "✗ 禁硬解未配置（整机冻结风险）——见部署说明第 1 条"; FAIL=1; fi
  # 5. 看门狗
  systemctl is-active --quiet pptist-watchdog.timer 2>/dev/null && say "✓ 看门狗 timer 运行中" || say "⚠ 看门狗未启用（卡死无法自愈）——见部署说明第 4 条"
  # 6. swap
  [ "$(awk '/SwapTotal/{print $2}' /proc/meminfo)" -gt 0 ] && say "✓ swap 已启用" || say "⚠ 无 swap（内存耗尽会拖死整机）——见部署说明第 2 条"
  # 7. 联动运行时
  curl -s --max-time 4 "http://127.0.0.1:${PORT}/showflow-api/runtime" | grep -q '"exists":true' && say "✓ 联动运行时有记录（重启可恢复画面）" || say "ℹ 联动运行时暂无记录（首次放映后会自动写入）"
  echo "== 结论: $([ "$FAIL" = 0 ] && echo 全部通过 || echo 有失败项，请先处理) =="
  [ "$FAIL" = 0 ] || exit 1
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
  ps -eo args | grep "chromium[-]browser" | grep -vE "type=|crashpad" | grep -oE "user-data-dir=[^ ]+|http[^ ]+" || echo "  (无运行中的实例)"
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
# SSH 终端里没有 DISPLAY：板子桌面会话固定为 :0，自动补默认值
if [ -z "${DISPLAY:-}" ]; then
  export DISPLAY=:0
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

# 主/副屏分配: CLI > 环境变量 > 自动(第一/第二块活动屏)
if [ "${#MON_LIST[@]}" = 0 ]; then
  echo "[dual-kiosk] 错误：未检测到任何显示器（桌面会话未登录或 xrandr 失败）——先运行 ./start-dual-kiosk.sh check 诊断" >&2
  exit 1
fi
MAIN_REQ="${MAIN_REQ:-${PPTIST_MAIN_DISPLAY:-}}"
SEC_REQ="${SEC_REQ:-${PPTIST_SEC_DISPLAY:-}}"
if [ -n "$MAIN_REQ" ]; then MAIN_DISP="$MAIN_REQ"; else MAIN_DISP="${MON_LIST[0]:-}"; fi
SEC_SAME=0
if [ -n "$SEC_REQ" ] && [ "$SEC_REQ" != "none" ]; then SEC_DISP="$SEC_REQ";
elif [ "$SEC_REQ" = "none" ]; then SEC_DISP="";
elif [ "${#MON_LIST[@]}" -ge 2 ]; then SEC_DISP="${MON_LIST[1]}";
else
  # 现场只有一块屏: 主屏全屏, 副屏以右半屏降级同显（不阻断启动）
  SEC_DISP="$MAIN_DISP"; SEC_SAME=1
  echo "[dual-kiosk] ⚠ 只检测到一块显示器：主屏将全屏显示，副屏以右半屏窗口降级同显" >&2
fi

for d in "$MAIN_DISP" "$SEC_DISP"; do
  if [ -n "$d" ] && [ -z "${MON_X[$d]:-}" ]; then
    echo "[dual-kiosk] 错误：显示器 $d 未连接或不存在。活动显示器: ${MON_LIST[*]:-未知}" >&2
    echo "             可用 --main=<名> --sec=<名> 重新指定（--sec=none 表示只跑主屏）" >&2
    exit 1
  fi
done
MX="${MON_X[$MAIN_DISP]:-0}"; MW="${MON_W[$MAIN_DISP]:-3840}"; MH="${MON_H[$MAIN_DISP]:-2160}"
if [ "$SEC_SAME" = "1" ]; then
  SX=$((MX + MW / 2)); SW=$((MW / 2)); SH="$MH"
else
  SX="${MON_X[$SEC_DISP]:-0}"; SW="${MON_W[$SEC_DISP]:-3840}"; SH="${MON_H[$SEC_DISP]:-2160}"
fi
echo "[dual-kiosk] 分配: 主屏=$MAIN_DISP(+${MX}, ${MW}x${MH}) 副屏=$SEC_DISP(+${SX}, ${SW}x${SH})"
if [ "$SEC_DISP" = "$MAIN_DISP" ] && [ "$SEC_SAME" = "0" ]; then
  echo "[dual-kiosk] 错误：主副屏不能是同一块显示器（单屏环境请 --sec=none 或省略让脚本自动降级）" >&2
  exit 1
fi

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

if [ -n "$SEC_DISP" ]; then
  echo "[dual-kiosk] 副屏 /secondary → $SEC_DISP"
  xdotool mousemove $((SX + SW / 4)) $((SH / 2))
  # 单屏降级时副屏不能用 --kiosk（kiosk 强制全屏会盖住主屏），用普通窗口
  if [ "$SEC_SAME" = "1" ]; then
    SEC_FLAGS="--noerrdialogs --disable-session-crashed-bubble --check-for-update-interval=31536000 --use-gl=egl"
  else
    SEC_FLAGS="$FLAGS"
  fi
  nohup "$BIN" $SEC_FLAGS --user-data-dir="$HOME/.config/chromium-secondary" \
    --window-position=${SX},0 --window-size=${SW},${SH} \
    "http://127.0.0.1:${PORT}/secondary" >/tmp/chromium-secondary.log 2>&1 &
  sleep 6
else
  echo "[dual-kiosk] --sec=none：跳过副屏，仅启动主屏"
fi

echo "[dual-kiosk] 窗口落位校正（按实例 PID 识别，防 GNOME 竞态放错屏）"
sleep 3
for round in 1 2; do
  for w in $(xdotool search --class "chromium-browser" 2>/dev/null); do
    WD=$(xdotool getwindowgeometry --shell "$w" 2>/dev/null | sed -n 's/^WIDTH=//p')
    [ "$WD" = "$MW" ] || [ "$WD" = "$SW" ] || continue
    PID=$(xdotool getwindowpid "$w" 2>/dev/null)
    CMD=$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)
    case "$CMD" in
      *chromium-play*)      WANT="$MX"; WANTW="$MW" ;;
      *chromium-secondary*) WANT="$SX"; WANTW="$SW" ;;
      *) continue ;;
    esac
    CUR=$(xdotool getwindowgeometry --shell "$w" 2>/dev/null | sed -n 's/^X=//p')
    if [ "$CUR" != "$WANT" ]; then
      echo "  校正: $([ "$WANTW" = "$MW" ] && echo 主屏 || echo 副屏) 窗口 $w 从 X=$CUR → X=$WANT"
      wmctrl -i -r "$w" -b remove,fullscreen 2>/dev/null
      sleep 0.3
      xdotool windowmove "$w" "$WANT" 0 2>/dev/null
      sleep 0.3
      wmctrl -i -r "$w" -b add,fullscreen 2>/dev/null
      sleep 1
    fi
  done
done
echo "[dual-kiosk] 最终布局："
for w in $(xdotool search --class "chromium-browser" 2>/dev/null); do
  WD=$(xdotool getwindowgeometry --shell "$w" 2>/dev/null | sed -n 's/^WIDTH=//p')
  [ "$WD" != "$MW" ] && [ "$WD" != "$SW" ] && continue
  PID=$(xdotool getwindowpid "$w" 2>/dev/null)
  CMD=$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)
  case "$CMD" in
    *chromium-play*)      TAG="主屏/play" ;;
    *chromium-secondary*) TAG="副屏/secondary" ;;
    *) continue ;;
  esac
  CUR=$(xdotool getwindowgeometry --shell "$w" 2>/dev/null | sed -n 's/^X=//p')
  echo "  $TAG → X=$CUR"
done
echo "[dual-kiosk] 完成。页面将自动恢复到上次的联动画面。服务地址: http://$(hostname -I | awk '{print $1}'):${PORT}"
