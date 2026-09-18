#!/usr/bin/env bash
# PPTist 备用机故障接管：主力机(.13)宕机时，本机(.11)快速顶上 .13 这个 IP
#
# 用法（在备用机 .11 上执行）：
#   ./pptist-failover.sh takeover           # 接管 .13（要求主力机已失联，--force 强制）
#   ./pptist-failover.sh restore            # 切换回接管前的网络配置（主力修复后用）
#   ./pptist-failover.sh sync-data          # 从主力机同步最新 data/（需主力在线）
#   ./pptist-failover.sh status             # 查看当前状态
#
# 安全机制：
# - 接管前探测主力机是否存活，存活则拒绝（--force 可越过，用于主力机网络卡死但IP未释放的场景）
# - 网络变更通过 systemd-run 瞬态单元执行，脱离 SSH 会话，会话断开不影响接管
# - 生效后主动 GARP 广播，局域网设备(工牌等)立即更新 ARP，无需等待缓存过期
# - 接管前的网络配置保存于 /var/tmp/pptist-failover.state，restore 可精确还原
set -u
VIP="192.168.2.13"
GW="192.168.2.1"
DNS="223.5.5.5 119.29.29.29"
STATE=/var/tmp/pptist-failover.state
APPLY=/tmp/pptist-failover-apply.sh
RESULT=/tmp/pptist-failover.result
LOGTAG=pptist-failover
SUDO_PASS="123456"   # 本机/远端 sudo 密码（板内封闭环境，与 一键更新-服务器.sh 同约定）
log() { logger -t "$LOGTAG" "$*"; echo "[$(date '+%F %T')] $*"; }
find_con() { nmcli -t -f NAME,DEVICE con show --active 2>/dev/null | awk -F: '$2=="eth1"{print $1; exit}'; }
# 存活探测用 TCP 服务端口(板子忽略 ICMP ping, ping 会误判)
primary_alive() {
  local p
  for p in 8686 22 8083; do
    timeout 3 bash -c "echo > /dev/tcp/$VIP/$p" 2>/dev/null && return 0
  done
  return 1
}

action="${1:-status}"
FORCE=0
for a in "$@"; do [ "$a" = "--force" ] && FORCE=1; done

CON=$(find_con)
[ -z "$CON" ] && { log "错误：eth1 上无活动连接"; exit 1; }

case "$action" in
status)
  echo "本机 IP: $(ip -4 addr show eth1 | grep -oE 'inet [0-9./]+' | head -1)"
  echo "连接: $CON  方法: $(nmcli -g ipv4.method con show "$CON" 2>/dev/null)"
  if primary_alive; then echo "主力机($VIP): 在线 —— 不宜接管"; else echo "主力机($VIP): 失联 —— 可以接管"; fi
  echo "pptist: $(systemctl is-active pptist)  看门狗: $(systemctl is-active pptist-watchdog.timer)"
  echo "接管记录: $([ -f /tmp/pptist-failover.result ] && cat /tmp/pptist-failover.result || echo 无)"
  ;;

sync-data)
  if primary_alive; then
    log "同步 pptist data ..."
    rsync -a --delete ztl@$VIP:/home/ztl/ppt/pptist-rk3588-lcd-deploy/data/ /home/ztl/ppt/pptist-rk3588-lcd-deploy/data/ \
      && log "pptist 数据同步完成" || log "pptist 数据同步失败"
    systemctl try-restart pptist 2>/dev/null || true
    log "同步禅道（两台禅道将各暂停约 1 分钟）..."
    systemctl stop zbox 2>/dev/null || true
    ssh ztl@$VIP "echo $SUDO_PASS | sudo -S -p '' systemctl stop zbox" >/dev/null 2>&1
    ssh ztl@$VIP "echo $SUDO_PASS | sudo -S -p '' tar czf - -C / --exclude=opt/zbox/logs --exclude=opt/zbox/tmp opt/zbox" \
      | sudo tar xzf - -C /
    log "禅道数据已同步"
    ssh ztl@$VIP "echo $SUDO_PASS | sudo -S -p '' systemctl start zbox" >/dev/null 2>&1
    systemctl start zbox
    sleep 3
    systemctl is-active zbox >/dev/null && log "禅道已恢复（本机 + 主力机）" || log "警告：本机禅道未恢复，手动执行 sudo systemctl start zbox"
  else
    log "主力机失联，无法同步（使用本机最近一次同步的数据）"
  fi
  ;;

takeover)
  if primary_alive && [ "$FORCE" = "0" ]; then
    log "拒绝接管：主力机 $VIP 仍在线！确认其已宕机后加 --force 执行"
    exit 1
  fi
  # 保存当前配置（供 restore）
  {
    echo "PREV_METHOD='$(nmcli -g ipv4.method con show "$CON" 2>/dev/null)'"
    echo "PREV_ADDR='$(nmcli -g ipv4.addresses con show "$CON" 2>/dev/null)'"
    echo "PREV_GW='$(nmcli -g ipv4.gateway con show "$CON" 2>/dev/null)'"
    echo "PREV_DNS='$(nmcli -g ipv4.dns con show "$CON" 2>/dev/null)'"
    echo "PREV_CON='$CON'"
  } > "$STATE"
  # 生成接管脚本（systemd-run 瞬态单元执行，脱离 SSH 会话）
  cat > "$APPLY" <<EOF
#!/usr/bin/env bash
nmcli con mod "$CON" ipv4.method manual ipv4.addresses $VIP/24 ipv4.gateway $GW ipv4.dns "$DNS"
nmcli con up "$CON"
sleep 3
arping -U -I eth1 -c 4 $VIP 2>/dev/null
sleep 1
ip -4 addr show eth1 | grep -q "$VIP/" && echo "接管成功: \$(date '+%F %T')" > "$RESULT" || echo "接管失败: \$(date '+%F %T')" > "$RESULT"
EOF
  chmod +x "$APPLY"
  rm -f "$RESULT"
  log "开始接管 $VIP（$CON）..."
  systemd-run --unit=pptist-failover-apply --description "PPTist IP takeover" bash "$APPLY" >/dev/null 2>&1 \
    || setsid nohup bash "$APPLY" >/dev/null 2>&1 &
  # 等待生效（最长 30 秒）
  for i in $(seq 1 15); do
    [ -f "$RESULT" ] && break
    sleep 2
  done
  if [ -f "$RESULT" ]; then
    log "$(cat "$RESULT")"
    ip -4 addr show eth1 | grep -q "$VIP/" && log "接管完成：本机已作为 $VIP 对外服务（pptist:8686 / broker:8083）"
    exit 0
  fi
  log "接管超时，请检查: journalctl -u pptist-failover-apply"
  exit 1
  ;;

restore)
  if [ ! -f "$STATE" ]; then log "无接管记录可还原"; exit 1; fi
  . "$STATE"
  if [ "${PREV_METHOD:-}" = "" ]; then log "接管记录不完整，无法还原"; exit 1; fi
  log "还原到接管前配置（$PREV_CON, method=$PREV_METHOD, addr=$PREV_ADDR）"
  cat > "$APPLY" <<EOF
#!/usr/bin/env bash
nmcli con mod "$PREV_CON" ipv4.method "$PREV_METHOD" ipv4.addresses "$PREV_ADDR" ipv4.gateway "$PREV_GW" ipv4.dns "$PREV_DNS"
nmcli con up "$PREV_CON"
sleep 3
echo "还原完成: \$(date '+%F %T')" > "$RESULT"
EOF
  chmod +x "$APPLY"
  rm -f "$RESULT"
  systemd-run --unit=pptist-failover-restore --description "PPTist IP restore" bash "$APPLY" >/dev/null 2>&1 \
    || setsid nohup bash "$APPLY" >/dev/null 2>&1 &
  for i in $(seq 1 15); do [ -f "$RESULT" ] && break; sleep 2; done
  [ -f "$RESULT" ] && log "$(cat "$RESULT")" || { log "还原超时，请检查 journalctl -u pptist-failover-restore"; exit 1; }
  rm -f "$STATE"
  ;;

*)
  echo "用法: $0 {takeover|restore|sync-data|status} [--force]" >&2
  exit 1
  ;;
esac
