#!/usr/bin/env bash
# Vinyl Pi installer. Run on the Pi from the repo folder:  sudo ./scripts/install.sh
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Please run with sudo: sudo ./scripts/install.sh" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/vinyl-pi
ENV_DIR=/etc/vinyl-pi
ENV_FILE="$ENV_DIR/vinyl.env"
ICECAST_XML=/etc/icecast2/icecast.xml

step() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }

step "Installing packages (this takes a few minutes on a Pi 3)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq icecast2 ffmpeg alsa-utils avahi-daemon rsync

step "Creating the vinyl service user"
id vinyl &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin --groups audio vinyl

step "Writing settings to $ENV_FILE"
mkdir -p "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  gen() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20; }
  cat >"$ENV_FILE" <<EOF
# Vinyl Pi settings. Restart after editing: sudo systemctl restart vinyl-stream
ICECAST_SOURCE_PASSWORD=$(gen)
ICECAST_ADMIN_PASSWORD=$(gen)
MOUNT=vinyl
BITRATE=320k
SAMPLE_RATE=44100
# Set this if auto-detection picks the wrong device (see: arecord -l), e.g. plughw:1,0
#VINYL_DEVICE=
EOF
fi
chown root:vinyl "$ENV_FILE"
chmod 640 "$ENV_FILE"
# shellcheck source=/dev/null
source "$ENV_FILE"

step "Configuring Icecast"
[[ -f "$ICECAST_XML.orig" ]] || cp "$ICECAST_XML" "$ICECAST_XML.orig"
sed -i \
  -e "s|<source-password>[^<]*</source-password>|<source-password>${ICECAST_SOURCE_PASSWORD}</source-password>|" \
  -e "s|<relay-password>[^<]*</relay-password>|<relay-password>${ICECAST_SOURCE_PASSWORD}</relay-password>|" \
  -e "s|<admin-password>[^<]*</admin-password>|<admin-password>${ICECAST_ADMIN_PASSWORD}</admin-password>|" \
  -e "s|<hostname>[^<]*</hostname>|<hostname>$(hostname).local</hostname>|" \
  "$ICECAST_XML"
# Debian ships Icecast disabled until configured
[[ -f /etc/default/icecast2 ]] && sed -i 's/^ENABLE=.*/ENABLE=true/' /etc/default/icecast2

step "Copying app to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete --exclude .git "$REPO_DIR/" "$APP_DIR/"
chmod +x "$APP_DIR"/scripts/*.sh

step "Setting up services"
install -m 644 "$APP_DIR/config/vinyl-stream.service" /etc/systemd/system/vinyl-stream.service
systemctl daemon-reload
systemctl enable --now avahi-daemon icecast2
systemctl restart icecast2
systemctl enable vinyl-stream
systemctl restart vinyl-stream

sleep 3
step "Done"
host="$(hostname).local"
if systemctl is-active --quiet vinyl-stream; then
  echo "Stream is running. Open this on your PC or phone:"
else
  echo "Stream isn't running yet (is the turntable plugged in and on?). Check: journalctl -u vinyl-stream -n 30"
  echo "Once it is, listen at:"
fi
echo "  http://${host}:8000/${MOUNT}"
echo
echo "Icecast admin: http://${host}:8000/admin/  (user: admin, password in $ENV_FILE)"
