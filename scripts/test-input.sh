#!/usr/bin/env bash
# Record 10 seconds from the turntable and report the level, to check the input works.
set -euo pipefail

ENV_FILE="${VINYL_ENV:-/etc/vinyl-pi/vinyl.env}"
# shellcheck source=/dev/null
if [[ -r "$ENV_FILE" ]]; then source "$ENV_FILE"; fi

echo "Capture devices:"
arecord -l || true
echo

card=$(arecord -l 2>/dev/null | grep -iE 'usb|codec' | head -n1 | sed -E 's/^card ([0-9]+):.*/\1/' || true)
DEVICE="${VINYL_DEVICE:-${card:+plughw:${card},0}}"
[[ -z "$DEVICE" ]] && { echo "No USB capture device found." >&2; exit 1; }

echo "Drop the needle, then wait 10 seconds... (using $DEVICE)"
sudo systemctl stop vinyl-stream 2>/dev/null || true
out=/tmp/vinyl-test.wav
arecord -D "$DEVICE" -f S16_LE -r 44100 -c 2 -d 10 "$out"
ffmpeg -hide_banner -nostats -i "$out" -af volumedetect -f null - 2>&1 | grep -E 'mean_volume|max_volume'
echo
echo "Saved to $out. A max_volume near -1 to -6 dB is ideal; below -30 dB means little or no signal."
sudo systemctl start vinyl-stream 2>/dev/null || true
