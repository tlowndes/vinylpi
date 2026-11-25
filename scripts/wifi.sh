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
    echo; echo "== Wi-Fi file";  cat "$RUN/boot-wifi.status" 2>/dev/null || echo "no vinylpi-wifi.txt with a network name"
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

# Wi-Fi from the SD card: vinylpi-wifi.txt on the boot partition (the drive any computer can open).
# Read at start-up and every check, so it works on every boot, not just the first.
BOOT_WIFI_CON=vinylpi-wifi
BOOT_WIFI_DONE=/var/lib/vinyl-pi/boot-wifi.sha
boot_wifi_file() {
  local f
  for f in /boot/firmware/vinylpi-wifi.txt /boot/firmware/vinylpi-wifi.txt.txt /boot/firmware/VINYLPI-WIFI.TXT; do
    [[ -f "$f" ]] && { echo "$f"; return 0; }
  done
  return 1
}

apply_boot_wifi() { # returns 0 only when it set up a new network
  local f sum parsed ssid pass country out
  f=$(boot_wifi_file) || return 1
  sum=$(sha256sum "$f" | cut -c1-64)
  if [[ -f "$BOOT_WIFI_DONE" && "$(cat "$BOOT_WIFI_DONE")" == "$sum" ]] \
      && nmcli -t -f NAME con show 2>/dev/null | grep -qx "$BOOT_WIFI_CON"; then
    return 1  # already set up from this exact file
  fi
  parsed=$(python3 - "$f" <<'PY'
import re, sys
vals = {}
for line in open(sys.argv[1], encoding="utf-8-sig", errors="replace"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, val = line.split("=", 1)
    key = re.sub(r"[^a-z]", "", key.lower())
    val = val.strip()
    if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
        val = val[1:-1]
    vals[key] = val
ssid = vals.get("wifiname") or vals.get("ssid") or vals.get("name") or ""
pw = vals.get("wifipassword") or vals.get("password") or vals.get("psk") or ""
country = (vals.get("country") or "GB").upper()[:2]
print(ssid); print(pw); print(country)
PY
) || return 1
  { IFS= read -r ssid; IFS= read -r pass; IFS= read -r country; } <<<"$parsed"
  if [[ -z "$ssid" ]]; then
    echo "Wi-Fi file found but WIFI_NAME is empty" >"$RUN/boot-wifi.status"; return 1
  fi
  if [[ -n "$pass" ]] && (( ${#pass} < 8 || ${#pass} > 63 )); then
    log "Wi-Fi file: password for $ssid must be 8 to 63 characters"
    echo "Wi-Fi file: the password for $ssid must be 8 to 63 characters" >"$RUN/boot-wifi.status"
    status_json last_error "The password in vinylpi-wifi.txt must be 8 to 63 characters."
    echo "$sum" >"$BOOT_WIFI_DONE"; return 1
  fi
  log "setting up Wi-Fi \"$ssid\" from the SD card (country $country)"
  [[ "$country" =~ ^[A-Z]{2}$ ]] && iw reg set "$country" 2>/dev/null
  nmcli con delete "$BOOT_WIFI_CON" >/dev/null 2>&1
  local sec=()
  [[ -n "$pass" ]] && sec=(wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$pass")
  if ! out=$(nmcli con add type wifi ifname "$IFACE" con-name "$BOOT_WIFI_CON" ssid "$ssid" \
      connection.autoconnect yes connection.autoconnect-priority 10 802-11-wireless.hidden yes "${sec[@]}" 2>&1); then
    log "Wi-Fi file: couldn't save $ssid: $out"
    echo "Wi-Fi file: couldn't save $ssid: $out" >"$RUN/boot-wifi.status"
    return 1
  fi
  echo "$sum" >"$BOOT_WIFI_DONE"
  echo "Wi-Fi file: saved \"$ssid\" ($(date))" >"$RUN/boot-wifi.status"
  return 0
}

connect_boot_wifi() { # called from the watchdog loop when the file has something new
  stop_hotspot
  nmcli con down "$HOTSPOT_NAME" >/dev/null 2>&1
  local out
  out=$(nmcli con up "$BOOT_WIFI_CON" 2>&1) || log "Wi-Fi file: couldn't connect yet: $out"
  if wait_online 45; then
    log "joined Wi-Fi from the SD card"; status_json last_fix "$(now)" last_error ""
    echo "$(cat "$RUN/boot-wifi.status" 2>/dev/null), connected" >"$RUN/boot-wifi.status"
    return 0
  fi
  echo "$(cat "$RUN/boot-wifi.status" 2>/dev/null), but couldn't connect. Check the name and password." >"$RUN/boot-wifi.status"
  status_json last_error "Couldn't join the Wi-Fi in vinylpi-wifi.txt. Check the name and password."
  return 1
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

hotspot_up() { # hotspot_up secure|open
  nmcli con delete "$HOTSPOT_NAME" >/dev/null 2>&1
  local sec=()
  if [[ "$1" == secure ]]; then
    # WPA2 only (RSN + CCMP) and no PMF. NetworkManager otherwise asks for WPA-PSK-SHA256 (PMF),
    # and the Pi 3's Broadcom chip rejects that in AP mode ("key setting validation failed").
    sec=(wifi-sec.key-mgmt wpa-psk wifi-sec.proto rsn wifi-sec.pairwise ccmp wifi-sec.group ccmp
         wifi-sec.pmf disable wifi-sec.psk "$HOTSPOT_PASS")
  fi
  nmcli con add type wifi ifname "$IFACE" con-name "$HOTSPOT_NAME" autoconnect no ssid "$HOTSPOT_NAME" \
    802-11-wireless.mode ap 802-11-wireless.band bg 802-11-wireless.channel 6 \
    ipv4.method shared ipv6.method disabled "${sec[@]}" >/dev/null 2>&1 || return 1
  nmcli con up "$HOTSPOT_NAME" 2>&1
}

start_hotspot() {
  log "opening hotspot $HOTSPOT_NAME"
  rfkill unblock wifi 2>/dev/null; nmcli radio wifi on 2>/dev/null
  scan
  local out
  if out=$(hotspot_up secure); then
    status_json hotspot_open 0
  else
    log "secure hotspot failed: $out"
    # Last resort: an open setup network, so the Pi can always be reached. It only runs while
    # the Pi is offline, and the web app has no password on the home network either.
    if out=$(hotspot_up open); then
      log "opened $HOTSPOT_NAME without a password"
      status_json hotspot_open 1
    else
      log "couldn't open hotspot: $out"
      nmcli con delete "$HOTSPOT_NAME" >/dev/null 2>&1
      status_json last_error "Couldn't open the setup hotspot: ${out:0:200}"
      return 1
    fi
  fi
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
  apply_boot_wifi && { connect_boot_wifi || true; down_since=0 kicked=0; }
  while true; do
    sleep "$CHECK_EVERY"
    exec 9>"$LOCK"
    flock -n 9 || continue   # a join is in progress
    if apply_boot_wifi; then
      connect_boot_wifi && { down_since=0 kicked=0; flock -u 9; continue; }
    fi
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
