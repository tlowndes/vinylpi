"""Listening stats from an append-only play log (one JSON line per record spun)."""
import json
import os
import time
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

MAX_GUESS = 60 * 60  # a record left on "now playing" all night counts as an hour at most


def _seconds(length):
    try:
        m, s = str(length).split(":")[-2:]
        return int(m) * 60 + int(s)
    except ValueError:
        return 0


def record_length(rec):
    return sum(_seconds(t.get("length")) for t in rec.get("tracks") or [])


def listened(rec, end):
    """Best guess at how long a record was really on: time on the platter, capped at its running time."""
    start = rec.get("set_at") or rec.get("started_at") or end
    cap = record_length(rec) or MAX_GUESS
    return max(0, min(end - start, cap * 1.1, MAX_GUESS * 1.5))


class PlayLog:
    def __init__(self, path):
        self.path = path

    def add(self, rec, end):
        entry = {
            "release_group": rec.get("release_group"), "release": rec.get("release"),
            "title": rec.get("title", ""), "artist": rec.get("artist", ""), "cover": rec.get("cover"),
            "year": rec.get("year", ""), "start": rec.get("set_at") or rec.get("started_at") or end,
            "seconds": round(listened(rec, end)),
        }
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "a") as f:
            f.write(json.dumps(entry) + "\n")

    def seed(self, history):
        """First run after upgrading: build the log from the recent history we already have."""
        if os.path.exists(self.path) or not history:
            return
        for rec in reversed(history):
            self.add(rec, rec.get("ended_at") or rec.get("started_at") or time.time())

    def entries(self):
        try:
            with open(self.path) as f:
                return [json.loads(line) for line in f if line.strip()]
        except FileNotFoundError:
            return []


def summary(entries, now_playing=None, days=7, today=None):
    """days=0 means all time."""
    today = today or date.today()
    if now_playing:
        t = time.time()
        entries = entries + [{**{k: now_playing.get(k) for k in ("release_group", "title", "artist", "cover", "year")},
                              "start": now_playing.get("set_at") or now_playing.get("started_at") or t,
                              "seconds": round(listened(now_playing, t))}]
    since = 0
    if days:
        since = datetime.combine(today - timedelta(days=days - 1), datetime.min.time()).timestamp()
    rows = [e for e in entries if e.get("start", 0) >= since]

    def key(e):
        return e.get("release_group") or f"{e.get('artist', '').lower()}|{e.get('title', '').lower()}"

    spins, info, artist_spins, artist_secs = Counter(), {}, Counter(), Counter()
    for e in rows:
        spins[key(e)] += 1
        info.setdefault(key(e), e)
        if e.get("cover"):
            info[key(e)] = {**info[key(e)], "cover": e["cover"]}
        a = e.get("artist") or "Unknown artist"
        artist_spins[a] += 1
        artist_secs[a] += e.get("seconds", 0)

    # Bars: one per day for a week or month, one per week for all time.
    buckets = defaultdict(int)
    if days:
        labels = [today - timedelta(days=i) for i in range(days - 1, -1, -1)]
        for e in rows:
            buckets[date.fromtimestamp(e["start"])] += e.get("seconds", 0)
        chart = [{"label": d.strftime("%a") if days <= 7 else d.strftime("%-d"), "date": d.isoformat(),
                  "minutes": round(buckets[d] / 60)} for d in labels]
    else:
        monday = today - timedelta(days=today.weekday())
        labels = [monday - timedelta(weeks=i) for i in range(11, -1, -1)]
        for e in rows:
            d = date.fromtimestamp(e["start"])
            buckets[d - timedelta(days=d.weekday())] += e.get("seconds", 0)
        chart = [{"label": d.strftime("%-d %b"), "date": d.isoformat(), "minutes": round(buckets[d] / 60)} for d in labels]

    top_records = [{"title": info[k].get("title"), "artist": info[k].get("artist"), "cover": info[k].get("cover"),
                    "year": info[k].get("year"), "spins": n} for k, n in spins.most_common(5)]
    top_artists = [{"artist": a, "spins": n, "minutes": round(artist_secs[a] / 60)} for a, n in artist_spins.most_common(5)]
    return {
        "days": days,
        "spins": len(rows),
        "minutes": round(sum(e.get("seconds", 0) for e in rows) / 60),
        "records": len(spins),
        "artists": len(artist_spins),
        "chart": chart,
        "top_records": top_records,
        "top_artists": top_artists,
        "first": min((e["start"] for e in entries), default=None),
    }
