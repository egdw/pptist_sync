#!/usr/bin/env bash
# Install, enable and immediately start PPTist as a systemd system service.
# Usage: bash enable-boot-service.sh
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"
SERVICE_NAME="pptist.service"
RUN_USER="${SUDO_USER:-$USER}"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "[pptist] systemd not found on this Linux system."
  exit 1
fi

if [ ! -x runtime/node/bin/node ]; then
  echo "[pptist] Preparing runtime first..."
  bash setup.sh
fi

chmod +x service-run.sh start-pptist.sh stop-pptist.sh
RUN_GROUP="$(id -gn "$RUN_USER")"
UNIT_TMP="$(mktemp)"
trap 'rm -f "$UNIT_TMP"' EXIT

cat > "$UNIT_TMP" <<EOF
[Unit]
Description=PPTist ShowFlow and LCD Render Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$DIR
ExecStart=$DIR/service-run.sh
Restart=always
RestartSec=3
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF

echo "[pptist] Installing /etc/systemd/system/$SERVICE_NAME ..."
sudo install -m 0644 "$UNIT_TMP" "/etc/systemd/system/$SERVICE_NAME"
sudo systemctl daemon-reload
# setup.sh may have started a non-systemd instance; release the port before enabling the service.
bash stop-pptist.sh 2>/dev/null || true
sudo systemctl enable --now "$SERVICE_NAME"

echo ""
echo "PPTist boot service enabled and started."
echo "Status : sudo systemctl status $SERVICE_NAME"
echo "Logs   : journalctl -u $SERVICE_NAME -f"
echo "Disable: bash disable-boot-service.sh"
