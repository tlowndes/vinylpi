"""The records you own: a small JSON file, plus how a record shop would file them."""
import json
import os
import threading
import time
import uuid

_lock = threading.Lock()


def sort_key(artist, sort_artist=""):
    """File under surname when MusicBrainz knows it, and never under "The"."""
    s = (sort_artist or artist or "").strip()
    low = s.lower()
    for lead in ("the ", "a "):
        if low.startswith(lead) and "," not in s:
            s = s[len(lead):] + ", " + s[: len(lead) - 1]
            break
    return s


# Broad shelf sections, checked in order: the first that matches any of a record's genres wins.
SECTIONS = [
    ("Soundtracks", ("soundtrack", "score", "stage & screen")),
    ("Classical", ("classical", "opera", "baroque", "orchestral")),
    ("Jazz", ("jazz", "bebop", "swing", "bossa")),
    ("Hip Hop", ("hip hop", "hip-hop", "rap", "trip hop")),
    ("Electronic", ("electronic", "house", "techno", "ambient", "synth", "disco", "drum and bass", "dance", "idm", "trance")),
    ("Soul & Funk", ("soul", "funk", "r&b", "rhythm & blues", "motown", "gospel")),
    ("Reggae", ("reggae", "dub", "ska", "dancehall")),
    ("Blues", ("blues",)),
    ("Metal", ("metal",)),
    ("Punk", ("punk", "hardcore")),
    ("Folk & Country", ("folk", "country", "americana", "bluegrass", "singer-songwriter")),
    ("World", ("latin", "afro", "world", "brazil", "african")),
    ("Rock", ("rock", "indie", "alternative", "grunge", "psychedelic", "shoegaze", "britpop")),
    ("Pop", ("pop", "new wave")),
]


def section(genres):
    """Broad shelf section for a record ("Rock", "Jazz"…), from MusicBrainz or Discogs genres."""
    low = [g.lower() for g in genres or []]
    for g in low:  # the record's main genre first
        for name, keys in SECTIONS:
            if any(k in g for k in keys):
                return name
    return "Other"


class Collection:
    def __init__(self, path):
        self.path = path
        self._items = self._load()

    def _load(self):
        try:
            with open(self.path) as f:
                return json.load(f)
        except Exception:
            return []

    def _save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self._items, f)
        os.replace(tmp, self.path)

    def all(self):
        with _lock:
            return [{**r, "section": section(r.get("genres"))} for r in self._items]

    def find(self, rec):
        """Same album already on the shelf? Match by MusicBrainz album, pressing, Discogs id, then name."""
        name = ((rec.get("artist") or "").lower(), (rec.get("title") or "").lower())
        for r in self._items:
            for k in ("release_group", "release", "discogs_id"):
                if rec.get(k) and r.get(k) == rec.get(k):
                    return r
            if name[1] and ((r.get("artist") or "").lower(), (r.get("title") or "").lower()) == name:
                return r
        return None

    def add(self, rec, played=False):
        """Add a record (or note a play of one already here). Returns (entry, is_new)."""
        with _lock:
            have = self.find(rec)
            if have:
                for k in ("release_group", "release", "discogs_id", "cover", "label", "year", "barcode", "sort_artist"):
                    if rec.get(k) and not have.get(k):
                        have[k] = rec[k]
                if rec.get("genres") and not have.get("genres"):
                    have["genres"] = rec["genres"]
                if played:
                    have["plays"] = have.get("plays", 0) + 1
                    have["last_played"] = time.time()
                self._save()
                return dict(have), False
            entry = {
                "id": uuid.uuid4().hex[:12],
                "title": (rec.get("title") or "")[:200],
                "artist": (rec.get("artist") or "")[:200],
                "sort_artist": sort_key(rec.get("artist"), rec.get("sort_artist")),
                "year": str(rec.get("year") or "")[:4],
                "label": rec.get("label") or "",
                "genres": rec.get("genres") or [],
                "cover": rec.get("cover"),
                "release_group": rec.get("release_group"),
                "release": rec.get("release"),
                "discogs_id": rec.get("discogs_id"),
                "barcode": rec.get("barcode") or "",
                "added_at": time.time(),
                "plays": 1 if played else 0,
                "last_played": time.time() if played else None,
            }
            self._items.append(entry)
            self._save()
            return dict(entry), True

    def update(self, item_id, **fields):
        with _lock:
            for r in self._items:
                if r["id"] == item_id:
                    r.update(fields)
                    self._save()
                    return dict(r)
        return None

    def remove(self, item_id):
        with _lock:
            before = len(self._items)
            self._items = [r for r in self._items if r["id"] != item_id]
            if len(self._items) != before:
                self._save()
                return True
        return False
