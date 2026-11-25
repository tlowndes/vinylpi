#!/usr/bin/env bash
# Vinyl Pi installer.
#   sudo /opt/vinyl-pi/scripts/install.sh            install on a running Pi
#   install.sh --image                                bake into a Pi image (pi-gen chroot)
#   install.sh --update                               re-apply after an update (used by update.sh)
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Please run with sudo" >&2; exit 1; }
MODE="${1:-live}"; MODE="${MODE#--}"
APP_DIR=/opt/vinyl-pi
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGES=(icecast2 ffmpeg alsa-utils avahi-daemon git curl network-manager python3 python3-flask python3-waitress python3-venv rfkill iw dnsmasq-base nginx openssl)

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

# The services expect the app at /opt/vinyl-pi. If cloned elsewhere, move a copy there.
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  step "Copying Vinyl Pi to $APP_DIR"
  rm -rf "$APP_DIR"
  cp -a "$SRC_DIR" "$APP_DIR"
  exec "$APP_DIR/scripts/install.sh" "$@"
fi
missing=()
for p in "${PACKAGES[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if (( ${#missing[@]} )); then
  step "Installing ${missing[*]} (a few minutes on a Pi 3)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # Don't let packages start services mid-install: stock nginx wants port 80, which the web app has.
  had_policy=0; [[ -e /usr/sbin/policy-rc.d ]] && had_policy=1
  (( had_policy )) || printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d
  chmod +x /usr/sbin/policy-rc.d
  apt-get install -y -qq "${missing[@]}" || { (( had_policy )) || rm -f /usr/sbin/policy-rc.d; exit 1; }
  (( had_policy )) || rm -f /usr/sbin/policy-rc.d
fi

# The web app reads the version with git as the vinyl user, so trust the folder whoever owns it.
git config --system --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" || git config --system --add safe.directory "$APP_DIR"

step "Setting up the vinyl user and folders"
id vinyl &>/dev/null || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin --groups audio vinyl
install -d -o vinyl -g vinyl /var/lib/vinyl-pi /var/lib/vinyl-pi/covers
install -d /etc/vinyl-pi
chmod +x "$APP_DIR"/scripts/*.sh

step "Setting up Python extras"
# Cover scan uses the Anthropic SDK, which Raspberry Pi OS doesn't package. Keep it in a venv.
[[ -x "$APP_DIR/.venv/bin/python" ]] || python3 -m venv --system-site-packages "$APP_DIR/.venv"
# Never let a failed download (Pi offline during an update) stop the install: cover scan just says it isn't ready.
"$APP_DIR/.venv/bin/pip" install --quiet --disable-pip-version-check -r "$APP_DIR/app/requirements.txt" \
  || echo "Couldn't install Python extras right now; cover scan will be off until the next update." >&2

step "Installing services"
for unit in icecast2.service vinyl-stream.service vinyl-web.service vinyl-wifi.service vinyl-update.service vinyl-update.timer vinyl-firstboot.service; do
  install -m 644 "$APP_DIR/config/$unit" "/etc/systemd/system/$unit"
done
install -m 644 "$APP_DIR/config/tmpfiles.conf" /usr/lib/tmpfiles.d/vinyl-pi.conf
install -d /etc/systemd/system/nginx.service.d
install -m 644 "$APP_DIR/config/nginx-vinyl.conf" /etc/systemd/system/nginx.service.d/vinyl-pi.conf
rm -f /etc/nginx/sites-enabled/default
install -d /etc/NetworkManager/dnsmasq-shared.d
install -m 644 "$APP_DIR/config/dnsmasq-captive.conf" /etc/NetworkManager/dnsmasq-shared.d/vinyl-pi.conf
# Tell the router this Pi is also called "vinylpi", so vinylpi.home.arpa (or whatever domain the router uses) finds it.
install -d /etc/NetworkManager/conf.d
install -m 644 "$APP_DIR/config/nm-dhcp-hostname.conf" /etc/NetworkManager/conf.d/vinyl-pi-hostname.conf
install -m 440 "$APP_DIR/config/sudoers" /etc/sudoers.d/vinyl-pi
visudo -cf /etc/sudoers.d/vinyl-pi >/dev/null || { rm -f /etc/sudoers.d/vinyl-pi; echo "sudoers file invalid" >&2; exit 1; }

# Wi-Fi template on the boot partition, so Wi-Fi can be set from any computer. Never overwrite a filled-in one.
if [[ -d /boot/firmware && ! -e /boot/firmware/vinylpi-wifi.txt ]]; then
  install -m 644 "$APP_DIR/config/vinylpi-wifi.txt" /boot/firmware/vinylpi-wifi.txt 2>/dev/null || true
fi

systemctl enable icecast2 nginx avahi-daemon NetworkManager vinyl-stream vinyl-web vinyl-wifi vinyl-update.timer vinyl-firstboot >/dev/null 2>&1

if [[ "$MODE" == image ]]; then
  # Passwords are made on first boot, so every Pi gets its own.
  rm -f /etc/vinyl-pi/vinyl.env
  step "Baked into the image. First boot finishes the setup."
  exit 0
fi

[[ -f /etc/vinyl-pi/vinyl.env ]] || "$APP_DIR/scripts/configure.sh"
systemctl daemon-reload
systemd-tmpfiles --create /usr/lib/tmpfiles.d/vinyl-pi.conf

if [[ "$MODE" == update ]]; then
  "$APP_DIR/scripts/configure.sh"
  systemctl restart icecast2 || true
  systemctl restart vinyl-web vinyl-wifi vinyl-stream
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl restart nginx || echo "The secure page (https) didn't start: journalctl -u nginx" >&2
  exit 0
fi

step "Starting everything"
"$APP_DIR/scripts/configure.sh"
systemctl restart icecast2
systemctl restart vinyl-stream vinyl-web vinyl-wifi
systemctl restart nginx || echo "The secure page (https) didn't start: journalctl -u nginx" >&2
systemctl start vinyl-update.timer
sleep 3

# shellcheck source=/dev/null
source /etc/vinyl-pi/vinyl.env
host="$(hostname).local"
step "Done"
echo "Open this on your phone or PC:   http://${host}"
echo "Fixed address with a port:         http://vinylpi.home.arpa:8880  (needs your router to know the name; see README)"
echo "Secure page (live camera scan):   https://${host}  (trust the certificate first: Settings -> Secure page)"
echo "Raw stream (for VLC and friends): http://${host}:8000/${MOUNT}"
systemctl is-active --quiet vinyl-stream || echo "The stream isn't running yet. Is the turntable plugged in and on? Check: journalctl -u vinyl-stream -n 30"
