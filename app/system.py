"""Read-only Pi status, plus calls into the root helper (vinyl-admin) via sudo."""
import json
import os
import subprocess
import urllib.request

APP_DIR = os.environ.get("VINYL_APP_DIR", "/opt/vinyl-pi")
DATA_DIR = os.environ.get("VINYL_DATA_DIR", "/var/lib/vinyl-pi")
RUN_DIR = os.environ.get("VINYL_RUN_DIR", "/run/vinyl-pi")
ENV_FILE = os.environ.get("VINYL_ENV", "/etc/vinyl-pi/vinyl.env")
ADMIN = os.path.join(APP_DIR, "scripts", "vinyl-admin.sh")
ICECAST = os.environ.get("ICECAST_STATUS", "http://127.0.0.1:8000/status-json.xsl")


def _run(cmd, timeout=5):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception:
        return ""


def _read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def env():
    vals = {}
    try:
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    vals[k] = v
    except Exception:
        pass
    return vals


def temperature():
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return round(int(f.read()) / 1000)
    except Exception:
        return None


def wifi():
    out = _run(["nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL", "dev", "wifi"])
    for line in out.splitlines():
        parts = line.split(":")
        if len(parts) >= 3 and parts[0] == "yes":
            return {"ssid": parts[1], "signal": int(parts[2] or 0)}
    return None


def turntable():
    for line in _run(["arecord", "-l"]).splitlines():
        if line.startswith("card") and ("USB" in line or "CODEC" in line.upper()):
            return line.split("[", 1)[-1].split("]", 1)[0]
    return None


def listeners():
    try:
        with urllib.request.urlopen(ICECAST, timeout=2) as r:
            src = json.load(r).get("icestats", {}).get("source")
        if isinstance(src, list):
            src = src[0] if src else None
        return int(src.get("listeners", 0)) if src else 0, bool(src)
    except Exception:
        return 0, False


def version():
    v = _run(["git", "-C", APP_DIR, "describe", "--tags", "--always", "--dirty"])
    return v or "dev"


def mode():
    return "hotspot" if os.path.exists(os.path.join(RUN_DIR, "hotspot")) else "normal"


def status():
    n, live = listeners()
    e = env()
    return {
        "mode": mode(),
        "version": version(),
        "temperature": temperature(),
        "wifi": wifi(),
        "turntable": turntable(),
        "live": live,
        "listeners": n,
        "bitrate": e.get("BITRATE", "320k"),
        "auto_update": e.get("AUTO_UPDATE", "1") == "1",
        "cover_scan": bool(e.get("ANTHROPIC_API_KEY")),
        "update": _read_json(os.path.join(DATA_DIR, "update.json"), {}),
        "watchdog": _read_json(os.path.join(RUN_DIR, "watchdog.json"), {}),
    }


def networks():
    return _read_json(os.path.join(RUN_DIR, "networks.json"), [])


def admin(*args, timeout=60):
    """Run a whitelisted root action. Returns (ok, output)."""
    try:
        p = subprocess.run(["sudo", "-n", ADMIN, *args], capture_output=True, text=True, timeout=timeout)
        return p.returncode == 0, (p.stdout + p.stderr).strip()
    except Exception as exc:
        return False, str(exc)
