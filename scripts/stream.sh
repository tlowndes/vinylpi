#!/usr/bin/env bash
# Capture the USB turntable and push an MP3 stream to the local Icecast server.
set -euo pipefail

ENV_FILE="${VINYL_ENV:-/etc/vinyl-pi/vinyl.env}"
# shellcheck source=/dev/null
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"

: "${ICECAST_SOURCE_PASSWORD:?ICECAST_SOURCE_PASSWORD not set in $ENV_FILE}"
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
if [[ -z "$DEVICE" ]]; then
  echo "No USB capture device found. Is the turntable plugged in and switched on?" >&2
  echo "Run 'arecord -l' to list devices, then set VINYL_DEVICE in $ENV_FILE." >&2
  exit 1
fi

echo "Streaming $DEVICE -> http://${ICECAST_HOST}:${ICECAST_PORT}/${MOUNT} at ${BITRATE}"

exec ffmpeg -hide_banner -loglevel warning -nostdin \
  -f alsa -channels 2 -sample_rate "$SAMPLE_RATE" -thread_queue_size 1024 -i "$DEVICE" \
  -c:a libmp3lame -b:a "$BITRATE" -ar "$SAMPLE_RATE" \
  -content_type audio/mpeg -ice_name "Vinyl" -ice_description "Live from the turntable" \
  -f mp3 "icecast://source:${ICECAST_SOURCE_PASSWORD}@${ICECAST_HOST}:${ICECAST_PORT}/${MOUNT}"
