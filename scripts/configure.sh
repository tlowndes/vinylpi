#!/usr/bin/env bash
# Per-device setup: passwords and Icecast config. Runs at install, or on first boot of the image.
set -euo pipefail

ENV_DIR=/etc/vinyl-pi
ENV_FILE="$ENV_DIR/vinyl.env"
ICECAST_XML=/etc/icecast2/icecast.xml

mkdir -p "$ENV_DIR"
gen() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 || true; }

if [[ ! -f "$ENV_FILE" ]]; then
  cat >"$ENV_FILE" <<EOF
# Vinyl Pi settings. After editing: sudo systemctl restart vinyl-stream vinyl-web vinyl-wifi
ICECAST_SOURCE_PASSWORD=$(gen)
ICECAST_ADMIN_PASSWORD=$(gen)
MOUNT=vinyl
BITRATE=320k
SAMPLE_RATE=44100
# Set this if auto-detection picks the wrong device (see: arecord -l), e.g. plughw:1,0
#VINYL_DEVICE=
AUTO_UPDATE=1
UPDATE_BRANCH=main
HOTSPOT_SSID=VinylPi-Setup
HOTSPOT_PASSWORD=vinylpi-setup
EOF
fi
chown root:vinyl "$ENV_FILE"
chmod 640 "$ENV_FILE"
# shellcheck source=/dev/null
source "$ENV_FILE"

[[ -f "$ICECAST_XML.orig" ]] || cp "$ICECAST_XML" "$ICECAST_XML.orig"
sed -i \
  -e "s|<source-password>[^<]*</source-password>|<source-password>${ICECAST_SOURCE_PASSWORD}</source-password>|" \
  -e "s|<relay-password>[^<]*</relay-password>|<relay-password>${ICECAST_SOURCE_PASSWORD}</relay-password>|" \
  -e "s|<admin-password>[^<]*</admin-password>|<admin-password>${ICECAST_ADMIN_PASSWORD}</admin-password>|" \
  -e "s|<hostname>[^<]*</hostname>|<hostname>$(hostname).local</hostname>|" \
  "$ICECAST_XML"
# Icecast already sends "Access-Control-Allow-Origin: *". Older versions added a second copy, which
# browsers reject ("*, *"), so the web player played nothing. Take that copy out.
sed -i '/<!-- vinylpi-cors -->/,/<\/http-headers>/d' "$ICECAST_XML"
[[ -f /etc/default/icecast2 ]] && sed -i 's/^ENABLE=.*/ENABLE=true/' /etc/default/icecast2
exit 0
