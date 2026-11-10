#!/bin/bash
set -eu
if [ -f /etc/fenxi-chrome.env ]; then
  set -a
  . /etc/fenxi-chrome.env
  set +a
fi
mkdir -p /tmp/.X11-unix /data
chmod 1777 /tmp/.X11-unix || true
if id chrome >/dev/null 2>&1; then
  chown -R chrome:chrome /data || true
fi

cleanup() {
  if [ -n "${NODE_PID:-}" ]; then kill "$NODE_PID" 2>/dev/null || true; fi
}
trap cleanup TERM INT

cd /app
node server/index.js &
NODE_PID=$!
wait "$NODE_PID"
