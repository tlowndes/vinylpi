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
  set-anthropic-key)
    key="${2:-}"
    if [[ -z "$key" ]]; then
      sed -i '/^ANTHROPIC_API_KEY=/d' "$ENV_FILE"; echo "Cover scan key removed"
    else
      [[ "$key" =~ ^sk-ant-[A-Za-z0-9_-]{20,200}$ ]] || { echo "That doesn't look like an Anthropic API key (it starts sk-ant-)" >&2; exit 2; }
      set_env ANTHROPIC_API_KEY "$key"; echo "Cover scan key saved"
    fi
    ;;
  set-audd-token)
    token="${2:-}"
    if [[ -z "$token" ]]; then
      sed -i '/^AUDD_API_TOKEN=/d' "$ENV_FILE"; echo "AudD token removed"
    else
      [[ "$token" =~ ^[A-Za-z0-9]{16,64}$ ]] || { echo "That doesn't look like an AudD API token" >&2; exit 2; }
      set_env AUDD_API_TOKEN "$token"; echo "AudD token saved"
    fi
    ;;
  set-discogs-token)
    token="${2:-}"
    if [[ -z "$token" ]]; then
      sed -i '/^DISCOGS_TOKEN=/d' "$ENV_FILE"; echo "Discogs token removed"
    else
      [[ "$token" =~ ^[A-Za-z0-9]{20,64}$ ]] || { echo "That doesn't look like a Discogs token" >&2; exit 2; }
      set_env DISCOGS_TOKEN "$token"; echo "Discogs token saved"
    fi
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
  diagnostics)
    # A plain-text health report for troubleshooting, also saved to the SD card's boot partition.
    report() {
      echo "Vinyl Pi report, $(date '+%Y-%m-%d %H:%M %Z')"
      echo "Version: $(git -C "$APP_DIR" -c safe.directory="$APP_DIR" describe --tags --always 2>/dev/null)"
      echo "System: $(sed -n "s/^PRETTY_NAME=//p" /etc/os-release | tr -d "\""), kernel $(uname -r), $(tr -d '\0' 2>/dev/null </proc/device-tree/model)"
      echo
      echo "== Services"
      for u in icecast2 nginx vinyl-stream vinyl-web vinyl-wifi vinyl-firstboot; do
        printf '%-16s %s\n' "$u" "$(systemctl is-active "$u" 2>&1)"
      done
      echo "icecast2 unit: $(systemctl show -p FragmentPath,SourcePath --value icecast2 2>/dev/null | tr '\n' ' ')"
      echo
      echo "== Turntable (arecord -l)"
      arecord -l 2>&1
      echo
      echo "== Stream state"
      cat /var/lib/vinyl-pi/stream.json 2>&1; echo
      echo
      echo "== Icecast status"
      curl -sS -m 3 http://127.0.0.1:8000/status-json.xsl 2>&1; echo
      echo
      echo "== Stream log (journal)"
      journalctl -u vinyl-stream -n 40 --no-pager 2>&1
      echo
      echo "== Icecast log (journal)"
      journalctl -u icecast2 -n 20 --no-pager 2>&1
      echo
      echo "== Icecast error.log"
      tail -n 20 /var/log/icecast2/error.log 2>&1
    }
    # Never show passwords or keys, even if an old version logged them.
    pw=$(sed -n 's/^ICECAST_SOURCE_PASSWORD=//p' "$ENV_FILE" 2>/dev/null)
    out=$(report | sed -E 's#(icecast://[^:/@]+:)[^@]*@#\1****@#g; s#sk-ant-[A-Za-z0-9_-]+#sk-ant-****#g')
    [[ -n "$pw" ]] && out=${out//"$pw"/****}
    for k in AUDD_API_TOKEN DISCOGS_TOKEN; do
      tok=$(sed -n "s/^$k=//p" "$ENV_FILE" 2>/dev/null)
      [[ -n "$tok" ]] && out=${out//"$tok"/****}
    done
    [[ -d /boot/firmware ]] && printf '%s\n' "$out" >/boot/firmware/vinylpi-report.txt 2>/dev/null
    printf '%s\n' "$out"
    ;;
  *)
    echo "Usage: vinyl-admin.sh restart-stream|set-bitrate|set-auto-update|set-anthropic-key|set-audd-token|set-discogs-token|update-check|update-apply|wifi-connect|diagnostics" >&2
    exit 2
    ;;
esac
