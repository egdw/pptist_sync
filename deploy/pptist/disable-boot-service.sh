#!/usr/bin/env bash
# Stop and remove the PPTist systemd service. Application data is not deleted.
set -e
SERVICE_NAME="pptist.service"
sudo systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
sudo rm -f "/etc/systemd/system/$SERVICE_NAME"
sudo systemctl daemon-reload
echo "PPTist boot service disabled. Application data was kept."
