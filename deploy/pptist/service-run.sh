#!/usr/bin/env bash
# systemd service entry: load local configuration and keep the server in foreground.
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"

if [ -f config.env ]; then
  set -a
  . ./config.env
  set +a
fi

export PPTIST_DATA_DIR="${PPTIST_DATA_DIR:-$DIR/data/default-ppt}"
export PPTIST_SECONDARY_DATA_DIR="${PPTIST_SECONDARY_DATA_DIR:-$DIR/data/secondary-ppt}"
export PPTIST_LED_CACHE_DIR="${PPTIST_LED_CACHE_DIR:-$DIR/data/led-cache}"
export PPTIST_LED_PORTRAIT_DIR="${PPTIST_LED_PORTRAIT_DIR:-$DIR/data/led-assets/portraits}"

if [ -x "$DIR/runtime/node/bin/node" ]; then
  NODE_CMD="$DIR/runtime/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_CMD="$(command -v node)"
else
  echo "[pptist] Node.js not found. Run: bash setup.sh"
  exit 1
fi

exec "$NODE_CMD" server/pptist-server.mjs
