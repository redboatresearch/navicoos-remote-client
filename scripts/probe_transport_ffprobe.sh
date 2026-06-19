#!/usr/bin/env bash
# probe_transport_ffprobe.sh — independent cross-check of the spec §0 precondition
# using ffprobe. Compares forced TCP-interleaved vs UDP transport so we can see
# which the device actually honors, independent of our own TypeScript probe.
#
# Requires ffprobe (brew install ffmpeg / apt install ffmpeg).
#
# Usage:
#   scripts/probe_transport_ffprobe.sh [IP] [PATH]
#   scripts/probe_transport_ffprobe.sh 192.168.0.1 /screenmirror

set -u
IP="${1:-192.168.0.1}"
RTSP_PATH="${2:-/screenmirror}"
URL="rtsp://${IP}:554${RTSP_PATH}"

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffprobe not found. Install ffmpeg (brew install ffmpeg / apt install ffmpeg)." >&2
  exit 1
fi

run() {
  local transport="$1"
  echo "──────────────────────────────────────────────────────────────"
  echo ">> ffprobe with -rtsp_transport ${transport}"
  echo "──────────────────────────────────────────────────────────────"
  # -rw_timeout (microseconds) keeps a UDP-only/unreachable case from hanging.
  ffprobe -hide_banner \
    -rtsp_transport "${transport}" \
    -rw_timeout 8000000 \
    -show_streams -show_format \
    "${URL}" 2>&1
  echo "   (exit: $?)"
  echo
}

echo "Probing ${URL}"
echo
run tcp
run udp

cat <<'EOF'
Interpretation:
  • TCP succeeds, UDP fails   -> device prefers/forces interleaved TCP. Build the
                                 pure-TS path (spec §1-§5).
  • Both succeed              -> device supports both; TCP is the right choice for
                                 marine wifi (spec §0).
  • TCP fails, UDP succeeds   -> device is UDP-only; take the §0 UDP fallback
                                 (Deno.listenDatagram).
  • Both fail                 -> wrong IP/path, auth required, or device offline.
EOF
