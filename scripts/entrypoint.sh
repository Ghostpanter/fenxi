#!/bin/bash
set -eu
export DISPLAY="${DISPLAY:-:99}"
if [ -f /etc/fenxi-chrome.env ]; then
  set -a
  . /etc/fenxi-chrome.env
  set +a
fi
mkdir -p /tmp/.X11-unix /data/profile /data/state
chmod 1777 /tmp/.X11-unix || true
rm -f /tmp/.X99-lock
if id chrome >/dev/null 2>&1; then
  chown -R chrome:chrome /data/profile || true
fi

Xvfb "$DISPLAY" -screen 0 1440x900x24 -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
sleep 0.5

VNC_PID=""
WS_PID=""
if [ -n "${NOVNC_PASSWORD:-}" ]; then
  umask 077
  x11vnc -storepasswd "$NOVNC_PASSWORD" /tmp/vnc.pass >/tmp/vncpass.log 2>&1
  x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 \
    -rfbauth /tmp/vnc.pass -localhost -noxdamage >/tmp/x11vnc.log 2>&1 &
  VNC_PID=$!
  if [ -d /usr/share/novnc ] && command -v websockify >/dev/null 2>&1; then
    websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
    WS_PID=$!
  elif command -v novnc_proxy >/dev/null 2>&1; then
    novnc_proxy --vnc 127.0.0.1:5900 --listen 6080 >/tmp/websockify.log 2>&1 &
    WS_PID=$!
  else
    echo "没有 noVNC，桌面打不开。" >&2
  fi
else
  echo "NOVNC_PASSWORD 为空，不打开桌面。外面的页面仍可用，但没法在容器里登录。" >&2
fi

cleanup() {
  if [ -n "${NODE_PID:-}" ]; then kill "$NODE_PID" 2>/dev/null || true; fi
  kill "$XVFB_PID" 2>/dev/null || true
  if [ -n "$VNC_PID" ]; then kill "$VNC_PID" 2>/dev/null || true; fi
  if [ -n "$WS_PID" ]; then kill "$WS_PID" 2>/dev/null || true; fi
}
trap cleanup TERM INT

cd /app
node server/index.js &
NODE_PID=$!
wait "$NODE_PID"
