"""Tiny Discogs client: find a release, add it to your collection, read your collection."""
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.discogs.com"
UA = "VinylPi/1.0 +https://github.com/tlowndes/vinylpi"

_lock = threading.Lock()
_last = 0.0


class DiscogsError(Exception):
    pass


def _call(token, path, params=None, method="GET"):
    """Discogs allows 60 requests a minute with a token, so keep a second apart."""
    global _last
    if not token:
        raise DiscogsError("Add your Discogs token in Settings first.")
    url = f"{API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    with _lock:
        wait = 1.05 - (time.monotonic() - _last)
        if wait > 0:
            time.sleep(wait)
        _last = time.monotonic()
    req = urllib.request.Request(url, method=method, data=b"" if method == "POST" else None,
                                 headers={"User-Agent": UA, "Authorization": f"Discogs token={token}",
                                          "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise DiscogsError("Discogs didn't accept the token. Check it in Settings.") from exc
        if exc.code == 429:
            raise DiscogsError("Discogs says slow down. Try again in a minute.") from exc
        raise DiscogsError(f"Discogs returned an error ({exc.code}).") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise DiscogsError("Couldn't reach Discogs. Is the Pi online?") from exc


def username(token):
    return _call(token, "/oauth/identity").get("username", "")


def find_release(token, rec):
    """Discogs release id for a record: known link, then barcode, then artist + title on vinyl."""
    if rec.get("discogs_id"):
        return rec["discogs_id"]
    searches = []
    if rec.get("barcode"):
        searches.append({"barcode": rec["barcode"], "type": "release"})
    if rec.get("title"):
        searches.append({"artist": rec.get("artist", ""), "release_title": rec["title"], "format": "Vinyl", "type": "release"})
    for q in searches:
        res = _call(token, "/database/search", {**q, "per_page": 5}).get("results") or []
        if res:
            return res[0]["id"]
    return None


def add_to_collection(token, user, release_id):
    """Folder 1 is Discogs' "Uncategorized"."""
    return _call(token, f"/users/{urllib.parse.quote(user)}/collection/folders/1/releases/{int(release_id)}", method="POST")


def collection(token, user, max_pages=20):
    """Every record in your Discogs collection, as plain dicts."""
    out, page = [], 1
    while page <= max_pages:
        data = _call(token, f"/users/{urllib.parse.quote(user)}/collection/folders/0/releases",
                     {"per_page": 100, "page": page, "sort": "artist"})
        for item in data.get("releases") or []:
            b = item.get("basic_information") or {}
            artists = b.get("artists") or []
            artist = ""
            for a in artists:
                artist += (a.get("anv") or a.get("name", "")).split(" (")[0]  # Discogs adds "(2)" to clashing names
                j = (a.get("join") or "").strip()
                artist += ", " if j == "," else f" {j} " if j else ""
            artist = artist.strip().rstrip(",")
            labels = b.get("labels") or []
            out.append({
                "discogs_id": b.get("id") or item.get("id"),
                "title": b.get("title", ""),
                "artist": artist,
                "year": str(b.get("year") or "") if b.get("year") else "",
                "label": labels[0].get("name", "") if labels else "",
                "genres": (b.get("genres") or [])[:2] + (b.get("styles") or [])[:1],
                "cover_url": b.get("cover_image") or b.get("thumb"),
            })
        pages = (data.get("pagination") or {}).get("pages", 1)
        if page >= pages:
            break
        page += 1
    return out
