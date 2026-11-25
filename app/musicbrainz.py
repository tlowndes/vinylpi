"""Tiny MusicBrainz + Cover Art Archive client (stdlib only)."""
import json
import threading
import urllib.error
import time
import urllib.parse
import urllib.request

API = "https://musicbrainz.org/ws/2"
CAA = "https://coverartarchive.org"
UA = "VinylPi/1.0 ( https://github.com/tlowndes/vinylpi )"

_lock = threading.Lock()
_last = 0.0


def _get(path, params):
    """GET a MusicBrainz JSON endpoint, keeping to their 1 request/second rule."""
    global _last
    params = {**params, "fmt": "json"}
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    with _lock:
        wait = 1.05 - (time.monotonic() - _last)
        if wait > 0:
            time.sleep(wait)
        _last = time.monotonic()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    # MusicBrainz answers 503 when it's busy or we're going too fast. Back off and try again.
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.load(r)
        except urllib.error.HTTPError as exc:
            if exc.code not in (502, 503, 504) or attempt == 3:
                if exc.code in (502, 503, 504):
                    raise Busy("MusicBrainz is busy right now. Try again in a minute.") from exc
                raise
            time.sleep(1.5 * (attempt + 1))
            with _lock:
                _last = time.monotonic()


class Busy(Exception):
    pass


def _artist(credit):
    return "".join(c.get("name", "") + c.get("joinphrase", "") for c in credit or []).strip()


def search(query, limit=8):
    """Search albums. Returns release groups (one per album, not per pressing)."""
    q = query.strip()
    if not q:
        return []
    data = _get("release-group", {"query": f"{q} AND primarytype:album", "limit": limit})
    out = []
    for rg in data.get("release-groups", []):
        out.append({
            "release_group": rg["id"],
            "title": rg.get("title", ""),
            "artist": _artist(rg.get("artist-credit")),
            "year": (rg.get("first-release-date") or "")[:4],
            "cover": f"{CAA}/release-group/{rg['id']}/front-250",
        })
    return out


def by_barcode(code):
    code = "".join(ch for ch in code if ch.isdigit())
    if not code:
        return None
    data = _get("release", {"query": f"barcode:{code}", "limit": 1})
    rels = data.get("releases", [])
    return details(release_id=rels[0]["id"]) if rels else None


def _sort_name(credit):
    """How a record shop files the artist: "Bowie, David", "Beatles, The"."""
    if credit and len(credit) == 1:
        return (credit[0].get("artist") or {}).get("sort-name") or ""
    return ""


def _discogs_id(relations):
    for rel in relations or []:
        url = (rel.get("url") or {}).get("resource", "")
        if rel.get("type") == "discogs" and "/release/" in url:
            tail = url.rstrip("/").rsplit("/", 1)[-1].split("-")[0]
            if tail.isdigit():
                return int(tail)
    return None


def genres(release_group):
    """Album-level genres (fuller than a single pressing's)."""
    rg = _get(f"release-group/{release_group}", {"inc": "genres"})
    return [g["name"] for g in sorted(rg.get("genres") or [], key=lambda g: -g.get("count", 0))][:3]


def _pick_release(rg_id):
    """Prefer a vinyl pressing so track numbers come out as A1, B2..."""
    data = _get("release", {"release-group": rg_id, "inc": "media", "limit": 25})
    rels = data.get("releases", [])
    if not rels:
        return None
    for r in rels:
        if any("Vinyl" in (m.get("format") or "") for m in r.get("media", [])):
            return r["id"]
    return rels[0]["id"]


def details(release_group=None, release_id=None):
    if not release_id:
        release_id = _pick_release(release_group)
        if not release_id:
            return None
    r = _get(f"release/{release_id}", {"inc": "recordings labels release-groups artist-credits genres url-rels"})
    rg = r.get("release-group", {})
    tracks = []
    media = r.get("media", [])
    # A vinyl release bundled with a CD or download lists every track twice; keep the vinyl.
    vinyl = [m for m in media if "Vinyl" in (m.get("format") or "")]
    for m in vinyl or media:
        for t in m.get("tracks", []):
            ms = t.get("length") or 0
            tracks.append({
                "number": t.get("number") or str(t.get("position", "")),
                "title": t.get("title", ""),
                "length": f"{ms // 60000}:{ms // 1000 % 60:02d}" if ms else "",
            })
    labels = [li.get("label", {}).get("name") for li in r.get("label-info", []) if li.get("label")]
    return {
        "release": release_id,
        "release_group": rg.get("id"),
        "title": r.get("title", ""),
        "artist": _artist(r.get("artist-credit")),
        "year": (rg.get("first-release-date") or r.get("date") or "")[:4],
        "label": labels[0] if labels else "",
        "tracks": tracks,
        "sort_artist": _sort_name(r.get("artist-credit")),
        "genres": [g["name"] for g in sorted(r.get("genres") or [], key=lambda g: -g.get("count", 0))][:3],
        "barcode": r.get("barcode") or "",
        "discogs_id": _discogs_id(r.get("relations")),
        "cover_url": f"{CAA}/release/{release_id}/front-500",
        "cover_fallback": f"{CAA}/release-group/{rg.get('id')}/front-500" if rg.get("id") else None,
    }


def download_cover(urls, dest):
    for url in urls:
        if not url:
            continue
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=15) as r, open(dest, "wb") as f:
                f.write(r.read())
            return True
        except Exception:
            continue
    return False
