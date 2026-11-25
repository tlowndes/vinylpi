"""Vinyl Pi web app: now playing, record lookup, settings and Wi-Fi rescue."""
import json
import os
import queue
import threading
import time
import uuid

from flask import Flask, Response, jsonify, request, send_from_directory

import cover
import musicbrainz as mb
import recognise
import stats
import system

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
DATA_DIR = system.DATA_DIR
COVERS = os.path.join(DATA_DIR, "covers")
STATE_FILE = os.path.join(DATA_DIR, "state.json")
plays = stats.PlayLog(os.path.join(DATA_DIR, "plays.jsonl"))

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
_lock = threading.Lock()
_subscribers = []


def _load():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {"now": None, "history": [], "spins": 0}


state = _load()
plays.seed(state.get("history", []))


def _save_and_broadcast():
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)
    msg = json.dumps(public_state())
    for q in list(_subscribers):
        q.put(msg)


def public_state():
    return {"now": state.get("now"), "history": state.get("history", [])[:20], "spins": state.get("spins", 0)}


def _side_of(number):
    return number[0].upper() if number and number[0].isalpha() else None


def _retire_now():
    """Move the record on the platter to history and the play log. Call with _lock held."""
    old = state.get("now")
    if old:
        old["ended_at"] = time.time()
        state["history"] = ([old] + state.get("history", []))[:100]
        plays.add(old, old["ended_at"])


def _set_now(rec):
    """Make rec the record on the platter, moving the old one to history."""
    with _lock:
        _retire_now()
        sides = sorted({s for s in (_side_of(t["number"]) for t in rec.get("tracks", [])) if s})
        t = time.time()
        rec.update({"id": uuid.uuid4().hex[:12], "started_at": t, "set_at": t, "side": sides[0] if sides else "A", "sides": sides or ["A", "B"]})
        state["now"] = rec
        state["spins"] = state.get("spins", 0) + 1
        _save_and_broadcast()
    return rec


def _with_cover(details):
    os.makedirs(COVERS, exist_ok=True)
    name = f"{details['release']}.jpg"
    path = os.path.join(COVERS, name)
    if os.path.exists(path) or mb.download_cover([details.get("cover_url"), details.get("cover_fallback")], path):
        details["cover"] = f"/covers/{name}"
    else:
        details["cover"] = None
    return details


# ---------- pages ----------

@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/static/<path:name>")
def static_files(name):
    return send_from_directory(STATIC, name)


@app.get("/covers/<path:name>")
def covers(name):
    return send_from_directory(COVERS, name, max_age=86400 * 30)


# ---------- state ----------

@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/state")
def get_state():
    return jsonify(public_state())


@app.get("/api/events")
def events():
    q = queue.Queue()
    _subscribers.append(q)

    def stream():
        try:
            yield f"data: {json.dumps(public_state())}\n\n"
            while True:
                try:
                    yield f"data: {q.get(timeout=25)}\n\n"
                except queue.Empty:
                    yield ": ping\n\n"
        finally:
            _subscribers.remove(q)

    return Response(stream(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/now")
def set_now():
    body = request.get_json(force=True) or {}
    try:
        if body.get("release_group") or body.get("release"):
            d = mb.details(release_group=body.get("release_group"), release_id=body.get("release"))
            if not d:
                return {"error": "Couldn't find that record on MusicBrainz"}, 404
            rec = _with_cover(d)
        elif body.get("title"):
            rec = {"title": body["title"][:200], "artist": body.get("artist", "")[:200], "year": str(body.get("year", ""))[:4],
                   "label": "", "tracks": [], "cover": None, "manual": True}
        else:
            return {"error": "Nothing to set"}, 400
    except Exception as exc:
        return {"error": f"MusicBrainz lookup failed: {exc}"}, 502
    return jsonify(_set_now(rec))


@app.post("/api/flip")
def flip():
    with _lock:
        now = state.get("now")
        if not now:
            return {"error": "Nothing playing"}, 400
        sides = now.get("sides") or ["A", "B"]
        i = sides.index(now["side"]) if now.get("side") in sides else -1
        now["side"] = sides[(i + 1) % len(sides)]
        now["started_at"] = time.time()
        now.pop("heard", None)
        _save_and_broadcast()
    return jsonify(now)


@app.post("/api/clear")
def clear():
    with _lock:
        _retire_now()
        state["now"] = None
        _save_and_broadcast()
    return {"ok": True}


@app.get("/api/stats")
def get_stats():
    try:
        days = int(request.args.get("days", 7))
    except ValueError:
        days = 7
    days = days if days in (0, 7, 30) else 7
    return jsonify(stats.summary(plays.entries(), state.get("now"), days))


# ---------- lookup ----------

@app.get("/api/search")
def search():
    try:
        return jsonify(mb.search(request.args.get("q", "")))
    except Exception as exc:
        return {"error": f"Search failed: {exc}"}, 502


@app.get("/api/barcode/<code>")
def barcode(code):
    try:
        d = mb.by_barcode(code)
    except Exception as exc:
        return {"error": f"Lookup failed: {exc}"}, 502
    if not d:
        return {"error": "No record with that barcode on MusicBrainz"}, 404
    return jsonify({"release": d["release"], "release_group": d["release_group"], "title": d["title"],
                    "artist": d["artist"], "year": d["year"], "label": d["label"], "cover": d["cover_url"]})


@app.post("/api/cover")
def cover_scan():
    photo = request.files.get("photo")
    if not photo:
        return {"error": "No photo"}, 400
    data = photo.read(6 * 1024 * 1024 + 1)
    if len(data) > 6 * 1024 * 1024:
        return {"error": "That photo is too big"}, 413
    try:
        found = cover.identify(data, system.env().get("ANTHROPIC_API_KEY", ""))
    except cover.CoverError as exc:
        return {"error": str(exc)}, 502
    q = found["search"] or " ".join(x for x in (found["artist"], found["title"]) if x)
    if found["confidence"] == "low":
        found["artist"] = found["title"] = ""
        q = ""
    return jsonify({"found": found, "query": q})


# ---------- what's this song? ----------

def _norm(s):
    s = (s or "").lower().split(" (")[0].split(" - ")[0]
    return "".join(ch for ch in s if ch.isalnum())


def _match_track(rec, title):
    want = _norm(title)
    for t in rec.get("tracks", []) if want else []:
        have = _norm(t["title"])
        if have and (have == want or have.startswith(want) or want.startswith(have)):
            return t
    return None


def _album_for(song):
    """Nothing on the platter: find the album on MusicBrainz so the page fills itself in."""
    try:
        hits = mb.search(" ".join(x for x in (song["artist"], song["album"] or song["title"]) if x), limit=3)
        want = _norm(song["album"])
        pick = next((h for h in hits if want and _norm(h["title"]) == want), hits[0] if hits else None)
        d = pick and mb.details(release_group=pick["release_group"])
        return _with_cover(d) if d else None
    except Exception:
        return None


def _save_artwork(url):
    """Keep AudD's artwork on the Pi, so the page can read its colours (no cross-site image)."""
    os.makedirs(COVERS, exist_ok=True)
    name = f"song-{uuid.uuid5(uuid.NAMESPACE_URL, url).hex[:16]}.jpg"
    path = os.path.join(COVERS, name)
    return f"/covers/{name}" if os.path.exists(path) or mb.download_cover([url], path) else None


@app.post("/api/identify")
def identify():
    e = system.env()
    try:
        clip = recognise.capture(f"http://127.0.0.1:8000/{e.get('MOUNT', 'vinyl')}")
        song = recognise.identify(clip, e.get("AUDD_API_TOKEN", ""))
    except recognise.RecogniseError as exc:
        return {"error": str(exc)}, 502
    if not song:
        return {"found": False, "message": "Couldn't name that one. Try again in the middle of a song."}

    if not state.get("now"):
        rec = _album_for(song)
        _set_now(rec or {"title": song["album"] or song["title"], "artist": song["artist"], "year": song["year"],
                         "label": "", "tracks": [], "cover": None, "manual": True})
    now = state.get("now")
    art = _save_artwork(song["artwork"]) if now and not now.get("cover") and song.get("artwork") else None
    with _lock:
        now = state.get("now")
        if now:
            t = _match_track(now, song["title"])
            if t:
                song["number"] = t["number"]
                s = _side_of(t["number"])
                if s and s != now.get("side") and s in (now.get("sides") or []):
                    now["side"] = s  # the record was flipped without telling us
            if art and not now.get("cover"):
                now["cover"] = art
            now["heard"] = song
            _save_and_broadcast()
    return jsonify({"found": True, "song": song})


# ---------- Pi ----------

@app.get("/api/status")
def status():
    return jsonify(system.status())


@app.post("/api/update/check")
def update_check():
    ok, out = system.admin("update-check", timeout=90)
    return jsonify({"ok": ok, "message": out, "update": system.status()["update"]})


@app.post("/api/update/apply")
def update_apply():
    ok, out = system.admin("update-apply", timeout=10)
    return jsonify({"ok": ok, "message": out or "Update started. The page will reload in about a minute."})


@app.post("/api/settings")
def settings():
    body = request.get_json(force=True) or {}
    results = []
    if "bitrate" in body:
        results.append(system.admin("set-bitrate", str(body["bitrate"])))
    if "anthropic_key" in body:
        results.append(system.admin("set-anthropic-key", str(body["anthropic_key"]).strip()))
    if "audd_token" in body:
        results.append(system.admin("set-audd-token", str(body["audd_token"]).strip()))
    if "auto_update" in body:
        results.append(system.admin("set-auto-update", "1" if body["auto_update"] else "0"))
    ok = all(r[0] for r in results)
    return jsonify({"ok": ok, "message": "; ".join(r[1] for r in results if r[1])}), (200 if ok else 500)


@app.post("/api/restart-stream")
def restart_stream():
    ok, out = system.admin("restart-stream")
    return jsonify({"ok": ok, "message": out}), (200 if ok else 500)


@app.post("/api/diagnostics")
def diagnostics():
    ok, out = system.admin("diagnostics", timeout=30)
    return jsonify({"ok": ok, "report": out}), (200 if ok else 500)


@app.get("/api/wifi/networks")
def wifi_networks():
    return jsonify(system.networks())


@app.post("/api/wifi/connect")
def wifi_connect():
    body = request.get_json(force=True) or {}
    ssid, password = str(body.get("ssid", "")), str(body.get("password", ""))
    if not ssid or len(ssid) > 32 or len(password) > 63:
        return {"error": "Check the network name and password"}, 400
    # Runs in the background: the hotspot drops as soon as the Pi tries to join.
    ok, out = system.admin("wifi-connect", ssid, password, timeout=10)
    return jsonify({"ok": ok, "message": out}), (200 if ok else 500)


@app.get("/<path:_any>")
def spa(_any):
    # Phones probe random URLs when they join the rescue hotspot; send them to the app.
    return send_from_directory(STATIC, "index.html")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "80"))
    try:
        from waitress import serve  # production server on the Pi
        # Each open page holds one thread for live updates, so allow plenty.
        serve(app, host="0.0.0.0", port=port, threads=24, channel_timeout=3600)
    except ImportError:
        app.run(host="0.0.0.0", port=port, threaded=True)
