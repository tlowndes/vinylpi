#!/usr/bin/env bash
# Capture the USB turntable and push an MP3 stream to the local Icecast server.
# Every start writes what happened to $DATA_DIR/stream.json, so the web app can say why the stream is offline.
set -uo pipefail

ENV_FILE="${VINYL_ENV:-/etc/vinyl-pi/vinyl.env}"
DATA_DIR="${VINYL_DATA_DIR:-/var/lib/vinyl-pi}"
STATE="$DATA_DIR/stream.json"
LOG="$DATA_DIR/stream.log"

note() { # note state message [device]: record the stream's state for the web app, and say it in the journal
  python3 - "$STATE" "$1" "$2" "${3:-}" <<'PY' 2>/dev/null || true
import json, sys, time
path, state, message, device = sys.argv[1:5]
json.dump({"state": state, "message": message, "device": device, "at": int(time.time())}, open(path, "w"))
PY
  echo "$2" >&2
}
fail() { note failed "$1" "${2:-}"; exit 1; }

# shellcheck source=/dev/null
if [[ -f "$ENV_FILE" ]]; then
  source "$ENV_FILE" 2>/dev/null || fail "Can't read the settings file $ENV_FILE"
fi
[[ -n "${ICECAST_SOURCE_PASSWORD:-}" ]] || fail "Settings not ready yet (first boot still running?)"
ICECAST_HOST="${ICECAST_HOST:-127.0.0.1}"
ICECAST_PORT="${ICECAST_PORT:-8000}"
MOUNT="${MOUNT:-vinyl}"
BITRATE="${BITRATE:-320k}"
SAMPLE_RATE="${SAMPLE_RATE:-44100}"

find_usb_device() {
  # First capture card whose name mentions USB/CODEC (typical turntable chips).
  local card
  card=$(arecord -l 2>/dev/null | grep -iE 'usb|codec' | head -n1 | sed -E 's/^card ([0-9]+):.*/\1/')
  [[ -n "$card" ]] && echo "plughw:${card},0"
}

DEVICE="${VINYL_DEVICE:-$(find_usb_device || true)}"
[[ -n "$DEVICE" ]] || fail "No turntable found. Is it plugged in and switched on?"

# Open the turntable for a moment first: a busy or blocked device gives a clear error here.
if ! probe=$(timeout 10 arecord -q -D "$DEVICE" -f S16_LE -r "$SAMPLE_RATE" -c 2 -d 1 /dev/null 2>&1); then
  fail "Can't record from the turntable ($DEVICE): $(echo "$probe" | tail -n1)" "$DEVICE"
fi

# Icecast is the server the phone listens to. Wait up to 30 seconds for it after a boot.
for _ in $(seq 1 15); do
  curl -fsS -m 2 -o /dev/null "http://${ICECAST_HOST}:${ICECAST_PORT}/status-json.xsl" && break
  sleep 2
done
curl -fsS -m 2 -o /dev/null "http://${ICECAST_HOST}:${ICECAST_PORT}/status-json.xsl" \
  || fail "The streaming server (Icecast) isn't running" "$DEVICE"

note running "Streaming" "$DEVICE"
echo "Streaming $DEVICE -> http://${ICECAST_HOST}:${ICECAST_PORT}/${MOUNT} at ${BITRATE}"

# The password goes in an option, not the URL, so it never shows up in logs or the process list.
: >"$LOG"
ffmpeg -hide_banner -loglevel warning -nostdin \
  -f alsa -channels 2 -sample_rate "$SAMPLE_RATE" -thread_queue_size 1024 -i "$DEVICE" \
  -c:a libmp3lame -b:a "$BITRATE" -ar "$SAMPLE_RATE" \
  -content_type audio/mpeg -ice_name "Vinyl" -ice_description "Live from the turntable" \
  -password "$ICECAST_SOURCE_PASSWORD" \
  -f mp3 "icecast://source@${ICECAST_HOST}:${ICECAST_PORT}/${MOUNT}" \
  2> >(tee -a "$LOG" >&2)
code=$?
last=$(grep -v '^\s*$' "$LOG" 2>/dev/null | tail -n1 | cut -c1-200)
fail "Stream stopped (code $code)${last:+: $last}" "$DEVICE"
