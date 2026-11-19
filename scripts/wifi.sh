#!/usr/bin/env bash
# Wi-Fi watchdog and rescue hotspot.
#   wifi.sh watch   keep Wi-Fi alive; after 5 minutes offline open the VinylPi-Setup hotspot
#   wifi.sh join    join the network the web app asked for (reads /run/vinyl-pi/wifi-request)
#   wifi.sh scan    save nearby networks for the web app
set -uo pipefail

ENV_FILE=/etc/vinyl-pi/vinyl.env
# shellcheck source=/dev/null
[[ -r "$ENV_FILE" ]] && source "$ENV_FILE"
IFACE="${WIFI_IFACE:-wlan0}"
HOTSPOT_NAME="${HOTSPOT_SSID:-VinylPi-Setup}"
HOTSPOT_PASS="${HOTSPOT_PASSWORD:-vinylpi-setup}"
CHECK_EVERY="${WATCHDOG_INTERVAL:-20}"       # seconds between checks
KICK_AFTER="${WATCHDOG_KICK_AFTER:-60}"      # restart Wi-Fi after this long offline
HOTSPOT_AFTER="${WATCHDOG_HOTSPOT_AFTER:-300}" # open the hotspot after this long offline
HOTSPOT_FOR="${WATCHDOG_HOTSPOT_FOR:-600}"   # then retry the saved network every 10 min
RUN=/run/vinyl-pi
LOCK="$RUN/wifi.lock"
mkdir -p "$RUN"

log() { echo "wifi: $*"; }
BOOT_LOG=/boot/firmware/vinylpi-wifi-log.txt

# Write a status report to the SD card's boot partition, so it can be read on any computer
# when the Pi can't be reached over the network.
diag() {
  [[ -d /boot/firmware ]] || return 0
  {
    echo "Vinyl Pi Wi-Fi report, $(date)"
    echo; echo "== Board";       tr -d '\0' </proc/device-tree/model 2>/dev/null; echo
    echo; echo "== Devices";     nmcli -t -f DEVICE,TYPE,STATE dev 2>&1
    echo; echo "== Radio";       nmcli radio 2>&1; rfkill list 2>&1
    echo; echo "== Connections"; nmcli -t -f NAME,TYPE,DEVICE con show 2>&1
    echo; echo "== Watchdog";    cat "$RUN/watchdog.json" 2>/dev/null; echo
    echo; echo "== Log";         journalctl -b -u vinyl-wifi -u NetworkManager -u wpa_supplicant -n 120 --no-pager 2>&1
    echo; echo "== Kernel Wi-Fi"; journalctl -b -k --no-pager 2>/dev/null | grep -iE "brcm|wlan|cfg80211" | tail -30
  } >"$BOOT_LOG.tmp" 2>&1
  mv -f "$BOOT_LOG.tmp" "$BOOT_LOG"
}
now() { date +%s; }

status_json() { # status_json key value [key value ...] merges into watchdog.json
  python3 - "$RUN/watchdog.json" "$@" <<'PY'
import json, sys
path, kv = sys.argv[1], sys.argv[2:]
try:
    data = json.load(open(path))
except Exception:
    data = {}
for k, v in zip(kv[::2], kv[1::2]):
    data[k] = int(v) if v.isdigit() else v
json.dump(data, open(path, "w"))
PY
}

ethernet_up() { nmcli -t -f TYPE,STATE dev 2>/dev/null | grep -q '^ethernet:connected'; }
hotspot_on() { [[ -e "$RUN/hotspot" ]]; }

online() {
  ethernet_up && return 0
  nmcli -t -f DEVICE,STATE dev 2>/dev/null | grep -q "^$IFACE:connected$" || return 1
  local gw
  gw=$(ip -4 route show default dev "$IFACE" 2>/dev/null | awk '{print $3; exit}')
  [[ -n "$gw" ]] || return 1
  ping -c1 -W3 "$gw" >/dev/null 2>&1 || ping -c1 -W3 1.1.1.1 >/dev/null 2>&1
}

saved_wifi() { nmcli -t -f TYPE,NAME con show 2>/dev/null | grep '^802-11-wireless:' | grep -v ":$HOTSPOT_NAME$" | grep -q .; }

scan() {
  nmcli dev wifi rescan ifname "$IFACE" >/dev/null 2>&1
  sleep 3
  nmcli -t -f SSID,SIGNAL dev wifi list ifname "$IFACE" 2>/dev/null | python3 -c '
import json, sys
best = {}
for line in sys.stdin:
    ssid, _, sig = line.rstrip("\n").rpartition(":")
    ssid = ssid.replace("\\:", ":")
    if ssid and ssid != "'"$HOTSPOT_NAME"'":
        best[ssid] = max(best.get(ssid, 0), int(sig or 0))
nets = [{"ssid": s, "signal": v} for s, v in sorted(best.items(), key=lambda x: -x[1])][:15]
json.dump(nets, open("'"$RUN/networks.json"'", "w"))
'
}

hotspot_active() { nmcli -t -f NAME con show --active 2>/dev/null | grep -qx "$HOTSPOT_NAME"; }

start_hotspot() {
  log "opening hotspot $HOTSPOT_NAME"
  rfkill unblock wifi 2>/dev/null; nmcli radio wifi on 2>/dev/null
  scan
  # Start clean each time so an old or half-made profile can't get in the way.
  nmcli con delete "$HOTSPOT_NAME" >/dev/null 2>&1
  local out
  # NetworkManager's own hotspot command: WPA2 only (RSN + CCMP), which the Pi's Broadcom chip needs.
  # A generic "mode ap" profile also offers WPA1/TKIP, and the Pi 3 refuses to start an AP like that.
  if ! out=$(nmcli dev wifi hotspot ifname "$IFACE" con-name "$HOTSPOT_NAME" ssid "$HOTSPOT_NAME" \
      band bg password "$HOTSPOT_PASS" 2>&1); then
    log "hotspot command failed: $out"
    nmcli con delete "$HOTSPOT_NAME" >/dev/null 2>&1
    # Fallback: the same settings spelled out, in case this NetworkManager lacks the hotspot command.
    nmcli con add type wifi ifname "$IFACE" con-name "$HOTSPOT_NAME" autoconnect no ssid "$HOTSPOT_NAME" \
      802-11-wireless.mode ap 802-11-wireless.band bg ipv4.method shared ipv6.method disabled \
      wifi-sec.key-mgmt wpa-psk wifi-sec.proto rsn wifi-sec.pairwise ccmp wifi-sec.group ccmp \
      wifi-sec.psk "$HOTSPOT_PASS" >/dev/null 2>&1
    if ! out=$(nmcli con up "$HOTSPOT_NAME" 2>&1); then
      log "couldn't open hotspot: $out"
      status_json last_error "Couldn't open the setup hotspot: ${out:0:200}"
      return 1
    fi
  fi
  nmcli con modify "$HOTSPOT_NAME" connection.autoconnect no >/dev/null 2>&1
  log "hotspot $HOTSPOT_NAME is up"
  now >"$RUN/hotspot"
  status_json hotspot 1 last_error ""
}

stop_hotspot() {
  hotspot_on || return 0
  log "closing hotspot"
  nmcli con down "$HOTSPOT_NAME" >/dev/null 2>&1
  rm -f "$RUN/hotspot"
  status_json hotspot 0
}

kick() {
  log "Wi-Fi looks down, restarting it"
  nmcli radio wifi off; sleep 2; nmcli radio wifi on; sleep 5
  nmcli dev connect "$IFACE" >/dev/null 2>&1
  status_json last_kick "$(now)"
}

wait_online() { # wait_online seconds
  local end=$(( $(now) + $1 ))
  while (( $(now) < end )); do online && return 0; sleep 3; done
  return 1
}

watch() {
  local down_since=0 kicked=0 last_diag=0
  status_json started "$(now)" hotspot 0
  rm -f "$RUN/hotspot"
  rfkill unblock wifi 2>/dev/null; nmcli radio wifi on 2>/dev/null
  log "watching $IFACE (saved Wi-Fi: $(saved_wifi && echo yes || echo none))"
  while true; do
    sleep "$CHECK_EVERY"
    exec 9>"$LOCK"
    flock -n 9 || continue   # a join is in progress
    if hotspot_on && ! hotspot_active; then
      log "hotspot dropped, reopening"; rm -f "$RUN/hotspot"; start_hotspot
    elif hotspot_on; then
      if (( $(now) - $(cat "$RUN/hotspot") > HOTSPOT_FOR )) && saved_wifi; then
        stop_hotspot
        if wait_online 45; then
          log "back online"; status_json last_fix "$(now)"; down_since=0; kicked=0
        else
          start_hotspot
        fi
      fi
    elif online; then
      if (( down_since )); then log "back online"; status_json last_fix "$(now)"; diag; fi
      down_since=0 kicked=0
    else
      (( down_since )) || down_since=$(now)
      local gone=$(( $(now) - down_since ))
      if ! saved_wifi; then
        # Fresh Pi with no Wi-Fi set up: nothing to wait for, so offer the hotspot straight away.
        log "no Wi-Fi set up yet"; start_hotspot
      else
        if (( gone >= KICK_AFTER && ! kicked )); then kick; kicked=1; fi
        if (( gone >= HOTSPOT_AFTER )); then start_hotspot; fi
      fi
    fi
    # While offline (or on the hotspot), refresh the report on the SD card once a minute.
    if (( down_since || $(now) - last_diag > 3600 )) || hotspot_on; then
      if (( $(now) - last_diag >= 60 )); then diag; last_diag=$(now); fi
    fi
    flock -u 9
  done
}

join() {
  [[ -r "$RUN/wifi-request" ]] || { log "no request"; exit 1; }
  local ssid pass
  { IFS= read -r ssid; IFS= read -r pass; } <"$RUN/wifi-request"
  rm -f "$RUN/wifi-request"
  exec 9>"$LOCK"; flock 9
  stop_hotspot
  sleep 2
  nmcli dev wifi rescan ifname "$IFACE" >/dev/null 2>&1; sleep 3
  local ok=1
  if [[ -n "$pass" ]]; then
    nmcli dev wifi connect "$ssid" password "$pass" ifname "$IFACE" >/dev/null 2>&1 || ok=0
  else
    nmcli dev wifi connect "$ssid" ifname "$IFACE" >/dev/null 2>&1 || ok=0
  fi
  if (( ok )) && wait_online 30; then
    log "joined $ssid"; status_json last_fix "$(now)" last_error ""
  else
    log "couldn't join $ssid"
    status_json last_error "Couldn't join $ssid. Check the password."
    start_hotspot
  fi
}

case "${1:-}" in
  watch) watch ;;
  join) join ;;
  scan) scan ;;
  *) echo "Usage: wifi.sh watch|join|scan" >&2; exit 2 ;;
esac
