#!/usr/bin/env bash
# Update Vinyl Pi from GitHub, rolling back if the new version doesn't come up healthy.
#   update.sh --check   fetch and record whether an update is waiting
#   update.sh --apply   install the latest version now
#   update.sh --auto    nightly timer: apply if AUTO_UPDATE=1, otherwise just check
set -uo pipefail

APP_DIR=/opt/vinyl-pi
DATA_DIR=/var/lib/vinyl-pi
STATUS="$DATA_DIR/update.json"
ENV_FILE=/etc/vinyl-pi/vinyl.env
# shellcheck source=/dev/null
[[ -r "$ENV_FILE" ]] && source "$ENV_FILE"
BRANCH="${UPDATE_BRANCH:-main}"

# git reset rewrites this very file, and bash reads scripts as it goes, so run from a copy.
if [[ "${VINYL_UPDATE_COPY:-}" != 1 ]]; then
  mkdir -p /run/vinyl-pi
  cp "$0" /run/vinyl-pi/update-run.sh
  VINYL_UPDATE_COPY=1 exec bash /run/vinyl-pi/update-run.sh "$@"
fi

git_() { git -C "$APP_DIR" -c safe.directory="$APP_DIR" "$@"; }

write_status() { # write_status state [error]
  local cur latest behind notes
  cur=$(git_ describe --tags --always 2>/dev/null)
  latest=$(git_ describe --tags --always "origin/$BRANCH" 2>/dev/null)
  behind=$(git_ rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)
  notes=$(git_ log --format=%s "HEAD..origin/$BRANCH" 2>/dev/null | head -n 5)
  mkdir -p "$DATA_DIR"
  python3 - "$STATUS" "$1" "${2:-}" "$cur" "$latest" "$behind" "$notes" <<'PY'
import json, sys, time
path, state, error, cur, latest, behind, notes = sys.argv[1:8]
json.dump({
    "state": state, "error": error, "current": cur, "latest": latest,
    "available": int(behind or 0) > 0, "behind": int(behind or 0),
    "notes": [n for n in notes.splitlines() if n], "checked_at": int(time.time()),
}, open(path, "w"))
PY
}

check() {
  if ! git_ fetch --quiet --tags origin "$BRANCH"; then
    write_status idle "Couldn't reach GitHub."
    echo "Couldn't reach GitHub" >&2
    return 1
  fi
  write_status idle
  echo "$(git_ rev-list --count "HEAD..origin/$BRANCH") update(s) waiting"
}

healthy() {
  for _ in $(seq 1 20); do
    sleep 3
    systemctl is-active --quiet vinyl-web && curl -fsS -m 3 http://127.0.0.1/api/health >/dev/null 2>&1 && return 0
  done
  return 1
}

apply() {
  check || return 1
  if [[ $(git_ rev-list --count "HEAD..origin/$BRANCH") == 0 ]]; then echo "Already up to date"; return 0; fi
  local prev
  prev=$(git_ rev-parse HEAD)
  write_status updating
  echo "Updating $(git_ describe --tags --always) -> $(git_ describe --tags --always "origin/$BRANCH")"
  git_ reset --hard --quiet "origin/$BRANCH"
  if "$APP_DIR/scripts/install.sh" --update && healthy; then
    write_status idle
    echo "Updated to $(git_ describe --tags --always)"
  else
    echo "New version failed its health check, rolling back" >&2
    git_ reset --hard --quiet "$prev"
    "$APP_DIR/scripts/install.sh" --update
    write_status idle "The last update failed, so Vinyl Pi rolled back to the previous version."
    return 1
  fi
}

case "${1:---check}" in
  --check) check ;;
  --apply) apply ;;
  --auto) if [[ "${AUTO_UPDATE:-1}" == 1 ]]; then apply; else check; fi ;;
  *) echo "Usage: update.sh --check|--apply|--auto" >&2; exit 2 ;;
esac
