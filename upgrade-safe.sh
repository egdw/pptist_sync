#!/usr/bin/env bash
# 安全升级：只同步程序文件，绝不覆盖安装目录中的 data/ 与 config.env。
# 用法：在新部署包解压目录执行：bash upgrade-safe.sh /home/user/pptist
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="${1:-$(cd "$SOURCE_DIR/.." && pwd)/pptist}"
NO_RESTART=false

if [ "${2:-}" = "--no-restart" ] || [ "${1:-}" = "--no-restart" ]; then
  NO_RESTART=true
  [ "${1:-}" = "--no-restart" ] && TARGET_DIR="$(cd "$SOURCE_DIR/.." && pwd)/pptist"
fi

if [ ! -d "$TARGET_DIR" ]; then
  echo "[upgrade] 找不到旧安装目录：$TARGET_DIR"
  echo "用法：bash upgrade-safe.sh /home/user/pptist"
  exit 1
fi
if [ "$SOURCE_DIR" = "$(cd "$TARGET_DIR" && pwd)" ]; then
  echo "[upgrade] 请在新部署包解压后的目录运行本脚本，不能在旧安装目录内运行。"
  exit 1
fi

echo "[upgrade] 源目录：$SOURCE_DIR"
echo "[upgrade] 目标目录：$TARGET_DIR"
echo "[upgrade] 数据保护：不会读取、删除、复制或覆盖 $TARGET_DIR/data/ 与 config.env"

BACKUP_DIR="$TARGET_DIR/backups/upgrade-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
if [ -f "$TARGET_DIR/config.env" ]; then
  cp -p "$TARGET_DIR/config.env" "$BACKUP_DIR/config.env.before-upgrade"
fi
printf 'Upgraded at %s\nSource: %s\n' "$(date -Is)" "$SOURCE_DIR" > "$BACKUP_DIR/UPGRADE-INFO.txt"

WAS_SYSTEMD=false
if systemctl is-active --quiet pptist 2>/dev/null; then
  WAS_SYSTEMD=true
  echo "[upgrade] 停止 systemd 服务..."
  sudo systemctl stop pptist
elif [ -x "$TARGET_DIR/stop-pptist.sh" ]; then
  echo "[upgrade] 停止旧服务..."
  (cd "$TARGET_DIR" && bash ./stop-pptist.sh) || true
fi

sync_dir() {
  local name="$1"
  [ -d "$SOURCE_DIR/$name" ] || return 0
  mkdir -p "$TARGET_DIR/$name"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$SOURCE_DIR/$name/" "$TARGET_DIR/$name/"
  else
    # 仅删除下方白名单中的程序目录；data/ 和 config.env 从不会成为目标。
    rm -rf "$TARGET_DIR/$name"
    mkdir -p "$TARGET_DIR/$name"
    cp -a "$SOURCE_DIR/$name/." "$TARGET_DIR/$name/"
  fi
}

# 仅同步程序目录，绝不把包内的空 data/ 覆盖到旧机的数据目录。
for dir in dist server reveal-example runtime doc src; do
  sync_dir "$dir"
done
for file in LICENSE logo.png setup.sh start-pptist.sh stop-pptist.sh service-run.sh \
  enable-boot-service.sh disable-boot-service.sh upgrade-safe.sh BUILD-INFO.txt; do
  [ -f "$SOURCE_DIR/$file" ] && cp -p "$SOURCE_DIR/$file" "$TARGET_DIR/$file"
done
chmod +x "$TARGET_DIR"/*.sh 2>/dev/null || true

if [ "$NO_RESTART" = false ]; then
  if [ "$WAS_SYSTEMD" = true ]; then
    echo "[upgrade] 重启 systemd 服务..."
    sudo systemctl restart pptist
  else
    echo "[upgrade] 启动新版服务..."
    (cd "$TARGET_DIR" && bash ./start-pptist.sh play)
  fi
fi

echo "[upgrade] 完成。data/ 与 config.env 保持原样；升级前 config.env 副本：$BACKUP_DIR"
