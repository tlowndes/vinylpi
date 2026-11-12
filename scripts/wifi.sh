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

start_hotspot() {
  log "opening hotspot $HOTSPOT_NAME"
  scan
  nmcli con show "$HOTSPOT_NAME" >/dev/null 2>&1 || nmcli con add type wifi ifname "$IFACE" con-name "$HOTSPOT_NAME" \
    autoconnect no ssid "$HOTSPOT_NAME" mode ap ipv4.method shared ipv6.method disabled \
    wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$HOTSPOT_PASS" >/dev/null
  nmcli con modify "$HOTSPOT_NAME" wifi-sec.psk "$HOTSPOT_PASS" >/dev/null 2>&1
  if nmcli con up "$HOTSPOT_NAME" >/dev/null 2>&1; then
    now >"$RUN/hotspot"
    status_json hotspot 1
  fi
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
  local down_since=0 kicked=0
  status_json started "$(now)" hotspot 0
  rm -f "$RUN/hotspot"
  while true; do
    sleep "$CHECK_EVERY"
    exec 9>"$LOCK"
    flock -n 9 || continue   # a join is in progress
    if hotspot_on; then
      if (( $(now) - $(cat "$RUN/hotspot") > HOTSPOT_FOR )) && saved_wifi; then
        stop_hotspot
        if wait_online 45; then
          log "back online"; status_json last_fix "$(now)"; down_since=0; kicked=0
        else
          start_hotspot
        fi
      fi
    elif online; then
      if (( down_since )); then log "back online"; status_json last_fix "$(now)"; fi
      down_since=0 kicked=0
    else
      (( down_since )) || down_since=$(now)
      local gone=$(( $(now) - down_since ))
      if (( gone >= KICK_AFTER && ! kicked )); then kick; kicked=1; fi
      # No Wi-Fi set up at all (fresh image): offer the hotspot after the first kick.
      if (( gone >= HOTSPOT_AFTER )) || { (( kicked )) && ! saved_wifi; }; then start_hotspot; fi
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
