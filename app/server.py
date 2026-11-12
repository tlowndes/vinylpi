"""Vinyl Pi web app: now playing, record lookup, settings and Wi-Fi rescue."""
import json
import os
import queue
import threading
import time
import uuid

from flask import Flask, Response, jsonify, request, send_from_directory

import musicbrainz as mb
import system

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
DATA_DIR = system.DATA_DIR
COVERS = os.path.join(DATA_DIR, "covers")
STATE_FILE = os.path.join(DATA_DIR, "state.json")

app = Flask(__name__, static_folder=None)
_lock = threading.Lock()
_subscribers = []


def _load():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {"now": None, "history": [], "spins": 0}


state = _load()


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


def _set_now(rec):
    """Make rec the record on the platter, moving the old one to history."""
    with _lock:
        old = state.get("now")
        if old:
            old["ended_at"] = time.time()
            state["history"] = ([old] + state.get("history", []))[:100]
        sides = sorted({s for s in (_side_of(t["number"]) for t in rec.get("tracks", [])) if s})
        rec.update({"id": uuid.uuid4().hex[:12], "started_at": time.time(), "side": sides[0] if sides else "A", "sides": sides or ["A", "B"]})
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
        _save_and_broadcast()
    return jsonify(now)


@app.post("/api/clear")
def clear():
    with _lock:
        old = state.get("now")
        if old:
            old["ended_at"] = time.time()
            state["history"] = ([old] + state.get("history", []))[:100]
        state["now"] = None
        _save_and_broadcast()
    return {"ok": True}


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
    if "auto_update" in body:
        results.append(system.admin("set-auto-update", "1" if body["auto_update"] else "0"))
    ok = all(r[0] for r in results)
    return jsonify({"ok": ok, "message": "; ".join(r[1] for r in results if r[1])}), (200 if ok else 500)


@app.post("/api/restart-stream")
def restart_stream():
    ok, out = system.admin("restart-stream")
    return jsonify({"ok": ok, "message": out}), (200 if ok else 500)


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
