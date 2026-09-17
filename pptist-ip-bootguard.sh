#!/usr/bin/env bash
# PPTist 主力机开机 IP 守卫：
# 开机时若 192.168.2.13 已被备用机接管(failover)占用，本机自动退回 DHCP，
# 避免 IP 冲突。待备用机执行 restore / 关机后，重启本机即恢复 .13。
set -u
VIP="192.168.2.13"
CON=$(nmcli -t -f NAME,DEVICE con show --active 2>/dev/null | awk -F: '$2=="eth1"{print $1; exit}')
[ -z "$CON" ] && exit 0
sleep 15   # 等本机网络与交换机/ARP 稳定
OWN=$(cat /sys/class/net/eth1/address)
OTHER=$(arping -c 3 -w 3 "$VIP" 2>/dev/null | grep -i "reply from" | grep -iv "$OWN" | head -1)
if [ -n "$OTHER" ]; then
  logger -t pptist-ip-bootguard "检测到 $VIP 已被其他设备占用($OTHER)，本机自动切换为 DHCP"
  nmcli con mod "$CON" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""
  nmcli con up "$CON" >/dev/null 2>&1
  logger -t pptist-ip-bootguard "已切换为 DHCP: $(ip -4 addr show eth1 | grep -oE 'inet [0-9./]+')"
else
  logger -t pptist-ip-bootguard "$VIP 空闲，本机保持静态 .13"
fi
