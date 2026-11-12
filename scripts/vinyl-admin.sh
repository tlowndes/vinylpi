#!/usr/bin/env bash
# Root helper for the web app. The vinyl user may run ONLY this script via sudo
# (see config/sudoers), so every argument is validated here.
set -euo pipefail

APP_DIR=/opt/vinyl-pi
ENV_FILE=/etc/vinyl-pi/vinyl.env
RUN_DIR=/run/vinyl-pi

set_env() { # set_env KEY VALUE
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >>"$ENV_FILE"; fi
}

case "${1:-}" in
  restart-stream)
    systemctl restart vinyl-stream
    ;;
  set-bitrate)
    [[ "${2:-}" =~ ^(128k|192k|256k|320k)$ ]] || { echo "Unsupported bitrate" >&2; exit 2; }
    set_env BITRATE "$2"
    systemctl restart vinyl-stream
    ;;
  set-auto-update)
    [[ "${2:-}" =~ ^[01]$ ]] || { echo "Use 0 or 1" >&2; exit 2; }
    set_env AUTO_UPDATE "$2"
    ;;
  update-check)
    "$APP_DIR/scripts/update.sh" --check
    ;;
  update-apply)
    systemctl start --no-block vinyl-update.service
    echo "Update started. The page will reload in about a minute."
    ;;
  wifi-connect)
    ssid="${2:-}" pass="${3:-}"
    (( ${#ssid} >= 1 && ${#ssid} <= 32 )) || { echo "Network name must be 1 to 32 characters" >&2; exit 2; }
    (( ${#pass} == 0 || (${#pass} >= 8 && ${#pass} <= 63) )) || { echo "Wi-Fi passwords are 8 to 63 characters" >&2; exit 2; }
    mkdir -p "$RUN_DIR"
    umask 077
    # Hand over via a root-only file so the password never shows in the process list.
    printf '%s\n%s\n' "$ssid" "$pass" >"$RUN_DIR/wifi-request"
    systemd-run --quiet --no-block --unit "vinyl-wifi-join-$(date +%s)" "$APP_DIR/scripts/wifi.sh" join
    echo "Joining $ssid"
    ;;
  *)
    echo "Usage: vinyl-admin.sh restart-stream|set-bitrate|set-auto-update|update-check|update-apply|wifi-connect" >&2
    exit 2
    ;;
esac
