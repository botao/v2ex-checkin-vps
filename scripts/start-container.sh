#!/bin/sh
set -eu
export DISPLAY=:99
Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp &
display_pid=$!
attempt=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  kill -0 "$display_pid" 2>/dev/null || exit 1
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || exit 1
  sleep 0.1
done
# Keep Node as the container's main process so graceful shutdown receives signals.
exec node dist/src/server.js
