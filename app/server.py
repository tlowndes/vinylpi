"""Vinyl Pi web app: now playing, record lookup, settings and Wi-Fi rescue."""
import json
import os
import queue
import threading
import time
import uuid

from flask import Flask, Response, jsonify, request, send_from_directory

import collection
import cover
import discogs
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
shelf = collection.Collection(os.path.join(DATA_DIR, "collection.json"))

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
    threading.Thread(target=_shelve, args=(dict(rec), True), daemon=True).start()
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


@app.get("/manifest.webmanifest")
def manifest():
    return send_from_directory(STATIC, "manifest.webmanifest", mimetype="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    # Served from the top level so it can look after the whole site (needed for "Add to home screen").
    res = send_from_directory(STATIC, "sw.js", mimetype="text/javascript", max_age=0)
    res.headers["Cache-Control"] = "no-cache"
    return res


@app.get("/vinylpi-ca.crt")
def ca_cert():
    # The Pi's own certificate authority. Trust it once on a phone and https://vinyl.local works with no warning.
    path = os.path.join(system.TLS_DIR, "ca.crt")
    if not os.path.exists(path):
        return {"error": "The secure page isn't set up yet. Run an update from Settings."}, 404
    return send_from_directory(system.TLS_DIR, "ca.crt", mimetype="application/x-x509-ca-cert",
                               as_attachment=True, download_name="vinylpi-ca.crt", max_age=0)


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
    if body.get("collection_id"):
        item = next((r for r in shelf.all() if r["id"] == body["collection_id"]), None)
        if not item:
            return {"error": "That record isn't on your shelf any more"}, 404
        if item.get("release") or item.get("release_group"):
            body = {"release": item.get("release"), "release_group": item.get("release_group")}
        elif item.get("discogs_id") and system.env().get("DISCOGS_TOKEN"):
            body = {"discogs": item["discogs_id"]}
        else:
            return jsonify(_set_now({k: item.get(k) for k in ("title", "artist", "year", "label", "cover", "discogs_id")}
                                    | {"tracks": [], "manual": True}))
    try:
        rec = _record_from(body)
    except LookupError as exc:
        return {"error": str(exc)}, 404
    except (mb.Busy, discogs.DiscogsError) as exc:
        return {"error": str(exc)}, 503
    except Exception as exc:
        return {"error": f"Lookup failed: {exc}"}, 502
    if not rec:
        return {"error": "Nothing to set"}, 400
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


@app.post("/api/stats/remove")
def stats_remove():
    """Take plays out of the stats: given ids, or everything that only played a little (tidy=true)."""
    body = request.get_json(silent=True) or {}
    ids = list(body.get("ids") or [])
    if body.get("tidy"):
        ids += [e["id"] for e in plays.entries() if stats.is_partial(e)]
    return jsonify({"removed": plays.remove(ids) if ids else 0})


# ---------- lookup ----------

@app.get("/api/search")
def search():
    try:
        return jsonify(mb.search(request.args.get("q", "")))
    except Exception as exc:
        return {"error": f"Search failed: {exc}"}, 502


def _record_from(body):
    """A full record from MusicBrainz ids, a Discogs id, or a typed-in title. None if the body names nothing."""
    if body.get("release_group") or body.get("release"):
        d = mb.details(release_group=body.get("release_group"), release_id=body.get("release"))
        if not d:
            raise LookupError("Couldn't find that record on MusicBrainz")
        return _with_cover(d)
    if body.get("discogs"):
        d = discogs.release(system.env().get("DISCOGS_TOKEN", ""), body["discogs"])
        os.makedirs(COVERS, exist_ok=True)
        name = f"discogs-{d['discogs_id']}.jpg"
        path = os.path.join(COVERS, name)
        d["cover"] = f"/covers/{name}" if os.path.exists(path) or mb.download_cover([d.get("cover_url")], path) else None
        return d
    if body.get("title"):
        return {"title": body["title"][:200], "artist": body.get("artist", "")[:200], "year": str(body.get("year", ""))[:4],
                "label": "", "tracks": [], "cover": None, "manual": True}
    return None


@app.get("/api/barcode/<code>")
def barcode(code):
    code = "".join(ch for ch in code if ch.isdigit())
    d, busy = None, None
    try:
        d = mb.by_barcode(code)
    except mb.Busy as exc:
        busy = str(exc)
    except Exception as exc:
        busy = f"MusicBrainz lookup failed: {exc}"
    # Not on MusicBrainz (or it's busy)? Try Discogs, which knows most vinyl barcodes.
    token = system.env().get("DISCOGS_TOKEN", "")
    if not d and token:
        try:
            rid = discogs.by_barcode(token, code)
            if rid:
                d = discogs.release(token, rid)
        except discogs.DiscogsError as exc:
            busy = busy or str(exc)
    if not d:
        if busy:
            return {"error": busy}, 503
        tip = "" if token else " Link Discogs in Settings to search there too."
        return {"error": f"No record with that barcode on MusicBrainz.{tip}"}, 404
    return jsonify({"release": d["release"], "release_group": d["release_group"], "discogs": d.get("discogs_id"),
                    "title": d["title"], "artist": d["artist"], "year": d["year"], "label": d["label"],
                    "cover": d["cover_url"], "tracks": d["tracks"]})


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


# ---------- collection (the shelf) ----------

_import = {"state": "idle"}


def _discogs_user(token):
    try:
        return discogs.username(token) if token else ""
    except discogs.DiscogsError:
        return ""


def _shelve(rec, played=False):
    """Put a record on the shelf, fill in its genres, and copy it to Discogs. Runs in the background."""
    if not rec.get("title"):
        return None
    entry, new = shelf.add(rec, played=played)
    if not entry.get("genres") and entry.get("release_group"):
        try:
            g = mb.genres(entry["release_group"])
            if g:
                shelf.update(entry["id"], genres=g)
        except Exception:
            pass
    token = system.env().get("DISCOGS_TOKEN", "")
    if token and not entry.get("discogs_synced"):
        try:
            rid = discogs.find_release(token, entry)
            user = rid and _discogs_user(token)
            if rid and user:
                discogs.add_to_collection(token, user, rid)
                shelf.update(entry["id"], discogs_id=rid, discogs_synced=True)
        except Exception:
            pass  # Discogs is a nice-to-have: the shelf on the Pi is the one that counts
    return entry


@app.get("/api/collection")
def get_collection():
    return jsonify(shelf.all())


@app.post("/api/collection")
def add_to_collection():
    body = request.get_json(force=True) or {}
    try:
        rec = _record_from(body)
        if not rec:
            return {"error": "Nothing to add"}, 400
    except LookupError as exc:
        return {"error": str(exc)}, 404
    except (mb.Busy, discogs.DiscogsError) as exc:
        return {"error": str(exc)}, 503
    except Exception as exc:
        return {"error": f"MusicBrainz lookup failed: {exc}"}, 502
    if shelf.find(rec):
        return {"error": f"{rec['title']} is already on your shelf"}, 409
    entry, _ = shelf.add(rec)
    threading.Thread(target=_shelve, args=(rec,), daemon=True).start()
    return jsonify(entry)


@app.delete("/api/collection/<item_id>")
def remove_from_collection(item_id):
    return ({"ok": True} if shelf.remove(item_id) else ({"error": "Not on the shelf"}, 404))


SHELVES_FILE = os.path.join(DATA_DIR, "shelves.json")


@app.get("/api/shelves")
def get_shelves():
    try:
        with open(SHELVES_FILE) as f:
            return jsonify(json.load(f))
    except Exception:
        return jsonify([{"name": "Shelf 1", "capacity": 80}])


@app.post("/api/shelves")
def set_shelves():
    body = request.get_json(force=True)
    if not isinstance(body, list) or not 1 <= len(body) <= 50:
        return {"error": "Between 1 and 50 shelves"}, 400
    clean = []
    for i, s in enumerate(body):
        try:
            cap = max(1, min(2000, int(s.get("capacity", 80))))
        except (TypeError, ValueError, AttributeError):
            return {"error": "Each shelf needs a number of records"}, 400
        clean.append({"name": str(s.get("name") or f"Shelf {i + 1}")[:40], "capacity": cap})
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SHELVES_FILE + ".tmp", "w") as f:
        json.dump(clean, f)
    os.replace(SHELVES_FILE + ".tmp", SHELVES_FILE)
    return jsonify(clean)


@app.get("/api/discogs")
def discogs_status():
    token = system.env().get("DISCOGS_TOKEN", "")
    return jsonify({"connected": bool(token), "username": _discogs_user(token) if request.args.get("check") else None,
                    "import": _import})


def _run_import(token):
    global _import
    try:
        user = discogs.username(token)
        _import = {"state": "reading", "user": user}
        items = discogs.collection(token, user)
        _import = {"state": "adding", "user": user, "total": len(items), "done": 0, "added": 0}
        os.makedirs(COVERS, exist_ok=True)
        for it in items:
            name = f"discogs-{it['discogs_id']}.jpg"
            path = os.path.join(COVERS, name)
            if not shelf.find(it):
                if it.get("cover_url") and (os.path.exists(path) or mb.download_cover([it["cover_url"]], path)):
                    it["cover"] = f"/covers/{name}"
                it["discogs_synced"] = True
                entry, new = shelf.add(it)
                shelf.update(entry["id"], discogs_synced=True)
                _import["added"] += int(new)
            _import["done"] += 1
        _import = {"state": "done", "user": user, "total": len(items), "added": _import["added"], "at": time.time()}
    except discogs.DiscogsError as exc:
        _import = {"state": "failed", "error": str(exc)}
    except Exception as exc:
        _import = {"state": "failed", "error": f"Import stopped: {exc}"}


@app.post("/api/discogs/import")
def discogs_import():
    token = system.env().get("DISCOGS_TOKEN", "")
    if not token:
        return {"error": "Add your Discogs token in Settings first."}, 400
    if _import.get("state") in ("reading", "adding"):
        return jsonify(_import)
    threading.Thread(target=_run_import, args=(token,), daemon=True).start()
    return jsonify({"state": "reading"})


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
    # ?switch=1 (from the scan page's Listen tab): put the album it hears on the platter, even if another one is.
    switch = request.args.get("switch") == "1"
    try:
        url = f"http://127.0.0.1:8000/{e.get('MOUNT', 'vinyl')}"
        song = None
        for _ in range(2):  # a quiet intro or a gap between songs often fails, so take a second listen
            song = recognise.identify(recognise.capture(url), e.get("AUDD_API_TOKEN", ""))
            if song:
                break
    except recognise.RecogniseError as exc:
        return {"error": str(exc)}, 502
    if not song:
        return {"found": False, "message": "Couldn't name that one. Try again in the middle of a song."}

    if switch or not state.get("now"):
        rec = _album_for(song)
        _set_now(rec or {"title": song["album"] or song["title"], "artist": song["artist"], "year": song["year"],
                         "label": "", "tracks": [], "cover": None, "manual": True})
    now = state.get("now")
    art = _save_artwork(song["artwork"]) if now and not now.get("cover") and song.get("artwork") else None
    with _lock:
        now = state.get("now")
        if now:
            t = _match_track(now, song["title"])
            song["on_record"] = bool(t) or not now.get("tracks")
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
    if "discogs_token" in body:
        results.append(system.admin("set-discogs-token", str(body["discogs_token"]).strip()))
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
