#!/usr/bin/env bash
# PPTist 双屏看门狗 v2：主屏 + 副屏 kiosk 自动守护
#
# 目标：任何"卡死 / 白屏"在 ≤15 分钟内自动恢复（正常检测确认 10 分钟 + 恢复动作）。
#
# 检测（每 5 分钟一轮，连续 2 轮命中才动作）：
#   主屏: controller 角色 lastSeen > 90s 或缺失（页面崩溃/白屏/冻结都会断心跳）
#   副屏A: secondary 角色 lastSeen > 90s 或缺失
#   副屏B: runtime.seq 有新步骤但 lastAck 不推进（合成器卡死：JS 活着但画面不出帧）
#
# 恢复阶梯（每屏独立）：
#   第 1 级：xdotool 向该屏 kiosk 窗口发送 F5 + Ctrl+R 重载页面（约 5 秒恢复，不动实例）
#   第 2 级：重载无效（继续命中 2 轮）→ 重启该屏 chromium 实例（约 15 秒恢复）
#   每日 04:30 主动重载两屏，清理长时间运行的积累状态。
# 限速：每屏两次动作之间至少间隔 10 分钟。
set -u
PORT="${PPTIST_PORT:-8686}"
STATUS_URL="http://127.0.0.1:${PORT}/api/studio/system/status"
STATE_FILE="/var/tmp/pptist-watchdog.state"
LOG_TAG="pptist-watchdog"
MAIN_W=3840          # 单屏宽
CONFIRM_ROUNDS=2     # 连续命中轮数（×5min）
ACTION_COOLDOWN=600  # 同屏两次动作最小间隔（秒）

log() { logger -t "$LOG_TAG" "$*"; echo "[$(date '+%F %T')] $*"; }

# ---------- 取状态 ----------
JSON=$(curl -s --max-time 8 "$STATUS_URL") || { log "状态接口不可达，跳过"; exit 0; }
ENVF=$(mktemp)
echo "$JSON" | python3 -c '
import json, sys, time
try:
    d = json.load(sys.stdin)
    now = time.time() * 1000
    ws = d["websocket"]; roles = ws["roles"]
    seq = ws["runtime"].get("seq") or 0
    out = "SEQ=%d" % seq
    for key, tag in (("controller", "MAIN"), ("secondary", "SEC")):
        r = roles.get(key)
        if r:
            seen = int((now - r["lastSeen"]) / 1000)
            ack = r.get("lastAck") or 0
            ackage = int((now - ack) / 1000) if ack else 99999
            out += "\n%s_SEEN=%d\n%s_ACK=%d" % (tag, seen, tag, ackage)
        else:
            out += "\n%s_SEEN=9999\n%s_ACK=99999" % (tag, tag)
    print(out)
except Exception:
    print("PARSE_ERR=1\nMAIN_SEEN=-1\nMAIN_ACK=-1\nSEC_SEEN=-1\nSEC_ACK=-1\nSEQ=-1")
' > "$ENVF" 2>/dev/null
. "$ENVF"; rm -f "$ENVF"
if [ "${PARSE_ERR:-0}" = "1" ]; then log "状态解析失败，跳过"; exit 0; fi

# ---------- 读历史状态 ----------
PREV_SEQ=-1; PREV_SEC_ACK=-1
MAIN_CAND=0; SEC_A=0; SEC_B=0
MAIN_LAST_ACT=0; SEC_LAST_ACT=0
[ -f "$STATE_FILE" ] && . "$STATE_FILE"
NOW=$(date +%s)

write_state() { cat > "$STATE_FILE" <<EOF
PREV_SEQ=$SEQ
PREV_SEC_ACK=$SEC_ACK
MAIN_CAND=$MAIN_CAND
SEC_A=$SEC_A
SEC_B=$SEC_B
MAIN_LAST_ACT=$MAIN_LAST_ACT
SEC_LAST_ACT=$SEC_LAST_ACT
EOF
}

restart_instance() { # $1: secondary|play
  local dir="$1" x=0
  [ "$dir" = "secondary" ] && x=$MAIN_W
  pkill -f "user-data-dir=/home/ztl/.config/chromium-$dir" 2>/dev/null
  sleep 4
  export DISPLAY="${DISPLAY:-:0}"
  XAUTH=$(ps -eo args | grep -o "\-auth [^ ]*" | grep mutter-Xwayland | head -1 | cut -d" " -f2)
  [ -n "$XAUTH" ] && export XAUTHORITY="$XAUTH"
  command -v xdotool >/dev/null && xdotool mousemove $((x + MAIN_W / 4)) $((2160 / 2))
  FLAGS="--kiosk --noerrdialogs --disable-session-crashed-bubble --check-for-update-interval=31536000 --use-gl=egl"
  # setsid 脱离 oneshot 单元 cgroup，避免 systemd 收尾连带杀掉新实例
  if [ "$(id -u)" = "0" ]; then
    runuser -u ztl -- setsid nohup /usr/bin/chromium-browser $FLAGS \
      --user-data-dir="/home/ztl/.config/chromium-$dir" \
      --window-position=$x,0 --window-size=${MAIN_W},2160 \
      "http://127.0.0.1:${PORT}/$([ "$dir" = "secondary" ] && echo secondary || echo play)" >/tmp/chromium-$dir.log 2>&1 &
  else
    setsid nohup /usr/bin/chromium-browser $FLAGS \
      --user-data-dir="$HOME/.config/chromium-$dir" \
      --window-position=$x,0 --window-size=${MAIN_W},2160 \
      "http://127.0.0.1:${PORT}/$([ "$dir" = "secondary" ] && echo secondary || echo play)" >/tmp/chromium-$dir.log 2>&1 &
  fi
}

# ---------- 主屏判定 ----------
if [ "$MAIN_SEEN" -gt 90 ]; then
  MAIN_CAND=$((MAIN_CAND + 1))
  log "主屏检测命中 $MAIN_CAND/$CONFIRM_ROUNDS（lastSeen=${MAIN_SEEN}s）"
else
  MAIN_CAND=0
fi

# ---------- 副屏判定 ----------
SEC_HIT=0
if [ "$SEC_SEEN" -gt 90 ]; then SEC_A=$((SEC_A + 1)); SEC_HIT=1
else SEC_A=0; fi
if [ "$PREV_SEQ" -ge 0 ] && [ "$SEQ" != "$PREV_SEQ" ] && [ "$SEC_ACK" = "$PREV_SEC_ACK" ]; then
  SEC_B=$((SEC_B + 1)); SEC_HIT=1
else
  SEC_B=0
fi
if [ "$SEC_A" -gt 0 ]; then log "副屏检测A命中 $SEC_A/$CONFIRM_ROUNDS（lastSeen=${SEC_SEEN}s）"; fi
if [ "$SEC_B" -gt 0 ]; then log "副屏检测B命中 $SEC_B/$CONFIRM_ROUNDS（seq $PREV_SEQ→$SEQ，lastAck=${SEC_ACK}s）"; fi

# ---------- 恢复动作 ----------
# 恢复动作：直接重启该屏 chromium 实例（约 15 秒恢复）。
# 不采用"先重载"方案：GNOME 焦点策略 + kiosk 模式下注入的重载键不可靠（实测被忽略）。
act() { # $1: 屏
  local screen="$1" x=0
  [ "$screen" = "secondary" ] && x=$MAIN_W
  local last="$MAIN_LAST_ACT"; [ "$screen" = "secondary" ] && last="$SEC_LAST_ACT"
  if [ $((NOW - last)) -lt "$ACTION_COOLDOWN" ]; then log "$screen 处于冷却期，跳过动作"; return; fi
  log "$screen：确认冻结，重启实例"
  restart_instance "$screen"
}

if [ "$MAIN_CAND" -ge "$CONFIRM_ROUNDS" ]; then
  act main
  MAIN_LAST_ACT=$NOW
  MAIN_CAND=0
fi
SEC_CAND=$(( SEC_A > SEC_B ? SEC_A : SEC_B ))
if [ "$SEC_CAND" -ge "$CONFIRM_ROUNDS" ]; then
  act secondary
  SEC_LAST_ACT=$NOW
  SEC_A=0; SEC_B=0
fi

# ---------- 每日 04:30 主动重载两屏（防积累） ----------
H=$(date +%H%M)
if [ "$H" = "0430" ] && [ $((NOW - MAIN_LAST_ACT)) -gt 21600 ] && [ $((NOW - SEC_LAST_ACT)) -gt 21600 ]; then
  log "每日维护：重启两屏实例（防长时运行积累）"
  restart_instance play; sleep 3; restart_instance secondary
  MAIN_LAST_ACT=$NOW; SEC_LAST_ACT=$NOW
fi

# ---------- 窗口落位巡检：主/副屏装反（GNOME 竞态）时自动纠正 ----------
# 依赖 start-dual-kiosk.sh 的双实例布局；单屏降级(--sec=none)时自动跳过
placement_check() {
  command -v xdotool >/dev/null 2>&1 && command -v wmctrl >/dev/null 2>&1 || return 0
  export DISPLAY="${DISPLAY:-:0}"
  local xa
  xa=$(ps -eo args | grep -o "\-auth [^ ]*" | grep mutter-Xwayland | head -1 | cut -d" " -f2)
  [ -n "$xa" ] && export XAUTHORITY="$xa"
  local m1x="" m2x=""
  while read -r line; do
    local name
    name=$(echo "$line" | awk '{print $2}' | sed 's/^[+*!~-]*//')
    [[ "$line" =~ ([0-9]+)/[0-9]+x([0-9]+)/[0-9]+\+([0-9]+)\+([0-9]+) ]] || continue
    if [ -z "$m1x" ]; then m1x="${BASH_REMATCH[3]}"; else m2x="${BASH_REMATCH[3]}"; break; fi
  done < <(xrandr --listmonitors 2>/dev/null | grep -E "^[[:space:]]*[0-9]+:")
  if [ -z "$m1x" ] || [ -z "$m2x" ] || [ "$m1x" = "$m2x" ]; then return 0; fi
  for w in $(xdotool search --class "chromium-browser" 2>/dev/null); do
    local wd pid cmd want cur
    wd=$(xdotool getwindowgeometry --shell "$w" 2>/dev/null | sed -n 's/^WIDTH=//p')
    case "$wd" in 1920|2560|3840) ;; *) continue ;; esac
    pid=$(xdotool getwindowpid "$w" 2>/dev/null)
    [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] || continue
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
    case "$cmd" in
      *user-data-dir=*chromium-play*)      want="$m1x" ;;
      *user-data-dir=*chromium-secondary*) want="$m2x" ;;
      *) continue ;;
    esac
    cur=$(xdotool getwindowgeometry --shell "$w" 2>/dev/null | sed -n 's/^X=//p')
    if [ -n "$cur" ] && [ "$cur" != "$want" ]; then
      wmctrl -i -r "$w" -b remove,fullscreen 2>/dev/null
      sleep 0.3
      xdotool windowmove "$w" "$want" 0 2>/dev/null
      sleep 0.3
      wmctrl -i -r "$w" -b add,fullscreen 2>/dev/null
      log "落位纠正：$([ "$want" = "$m1x" ] && echo 主屏 || echo 副屏) 窗口 X=$cur → X=$want"
    fi
  done
  return 0
}
placement_check

write_state
