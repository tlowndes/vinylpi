"""Follow which track is playing: count through the tracklist by track lengths, and use the
quiet gaps between tracks (the stream is level-checked a few times a second) to stay in step.

Follower is pure logic (easy to test). Tracker listens to the Icecast stream with ffmpeg and
drives a Follower for whatever side is on the platter."""
import array
import math
import subprocess
import threading
import time

RATE = 8000           # Hz: plenty to hear a gap, light on the Pi
WINDOW = 800          # samples per level reading, so 10 readings a second
LEAD_IN = 6.0         # seconds from needle drop to the first note, if we never see the music start
QUIET_RATIO = 0.18    # "quiet" = under this share of the recent loudness
MIN_GAP = 0.9         # seconds of quiet that count as a gap between tracks
SETTLE = 12.0         # after a sync (tap or What's this?), don't take gaps this soon


def _seconds(length):
    try:
        m, s = str(length).split(":")[-2:]
        return int(m) * 60 + int(s)
    except ValueError:
        return 0


class Follower:
    """tracks: [{"number", "length"}] for the side on the platter. Feed it level readings with feed()."""

    def __init__(self, tracks, started_at):
        self.tracks = [{"number": t["number"], "len": _seconds(t.get("length"))} for t in tracks]
        self.pos = 0
        self.track_start = started_at + LEAD_IN
        self.loud = 0.0          # running loudness of the music
        self.quiet_since = None
        self.heard_music = False  # have we seen the first notes yet?
        self.synced_at = None     # set by sync(): until the next gap we accept one at any point
        self.ended = False

    # ---- what the page wants to know ----
    @property
    def number(self):
        return self.tracks[self.pos]["number"] if self.tracks else None

    def _len(self, i):
        return self.tracks[i]["len"] if 0 <= i < len(self.tracks) else 0

    # ---- corrections ----
    def sync(self, number, t, elapsed=0.0):
        """Someone (a tap, What's this?) told us which track is on. elapsed = how far into it, if known."""
        for i, tr in enumerate(self.tracks):
            if tr["number"] == number:
                self.pos, self.ended = i, False
                self.track_start = t - elapsed
                self.heard_music = True
                self.synced_at = t if not elapsed else None
                return True
        return False

    # ---- the clock and the gaps ----
    def tick(self, t):
        """Call every so often. Moves on by timing alone if a track has overrun with no gap heard."""
        changed = False
        while (not self.ended and self._len(self.pos)
               and t - self.track_start > self._len(self.pos) + max(25.0, 0.12 * self._len(self.pos))):
            changed |= self._advance(self.track_start + self._len(self.pos))
        return changed

    def _advance(self, at):
        if self.pos + 1 >= len(self.tracks):
            self.ended = True
            return False
        self.pos += 1
        self.track_start = at
        self.synced_at = None
        return True

    def feed(self, level, t):
        """One level reading (RMS) at time t. Returns True when the track changed."""
        # How loud the music is: rise fast, fall slowly, so a gap stands out against it.
        if level > self.loud:
            self.loud = self.loud * 0.8 + level * 0.2
        elif level >= self.loud * QUIET_RATIO:
            self.loud *= 0.9995
        quiet = self.loud > 0 and level < self.loud * QUIET_RATIO
        if quiet:
            if self.quiet_since is None:
                self.quiet_since = t
            return False
        gap = None
        if self.quiet_since is not None and t - self.quiet_since >= MIN_GAP:
            gap = (self.quiet_since + t) / 2
        self.quiet_since = None
        if not self.heard_music and self.loud:
            # the first notes after the needle drops: that's when track one starts
            self.heard_music = True
            if t - self.track_start < 60:
                self.track_start = t
            return False
        return self._on_gap(gap, t) if gap else False

    def _on_gap(self, mid, t):
        """A gap in the music ended. Is it the end of a track? Only believe it near where one should end."""
        if self.ended:
            return False
        if self.synced_at is not None:  # just told which track: the next real gap is the end of it
            return t - self.synced_at >= SETTLE and self._advance(mid)
        elapsed = mid - self.track_start
        end = 0.0
        for j in range(self.pos, len(self.tracks)):
            length = self._len(j)
            if not length:  # no running time on file: any gap after half a minute will do
                if j == self.pos and elapsed >= 30:
                    self.pos = j
                    return self._advance(mid)
                return False
            end += length
            if abs(elapsed - end) <= max(20.0, 0.12 * end) and (j > self.pos or elapsed >= 0.7 * end):
                self.pos = j
                return self._advance(mid)
            if elapsed < end - max(20.0, 0.12 * end):
                return False  # too early for any track to end: a quiet passage, not a gap
        return False


def rms(samples):
    if not samples:
        return 0.0
    return math.sqrt(sum(x * x for x in samples) / len(samples))


class Tracker(threading.Thread):
    """Listens to the stream and keeps the page told which track is on.

    get_now() -> the record on the platter (dict) or None
    set_playing(record_id, number, since) -> store it and tell the pages"""

    def __init__(self, stream_url, get_now, set_playing):
        super().__init__(daemon=True)
        self.url, self.get_now, self.set_playing = stream_url, get_now, set_playing
        self.follower = None
        self.key = None
        self.lock = threading.Lock()

    # ---- setup per side ----
    def _side_tracks(self, now):
        tracks = now.get("tracks") or []
        lettered = [t for t in tracks if t["number"][:1].isalpha()]
        pool = lettered or tracks
        side = now.get("side")
        return [t for t in pool if not lettered or t["number"][:1].upper() == side]

    def _ensure(self, now):
        key = (now.get("id"), now.get("side"), now.get("started_at"))
        with self.lock:
            if key != self.key:
                self.key = key
                tracks = self._side_tracks(now)
                self.follower = Follower(tracks, now.get("started_at") or time.time()) if tracks else None
                if self.follower:
                    self._publish(now.get("id"), time.time())
            return self.follower

    def _publish(self, record_id, t):
        f = self.follower
        if f and f.number:
            self.set_playing(record_id, f.number, f.track_start)

    # ---- called by the web app ----
    def sync(self, record_id, number, elapsed=0.0):
        """A tap or a recognised song says which track is on."""
        now = self.get_now()
        if not (now and now.get("id") == record_id and self._ensure(now)):
            return False
        with self.lock:
            ok = self.follower.sync(number, time.time(), elapsed)
        if ok:
            self._publish(record_id, time.time())
        return ok

    # ---- the listening loop ----
    def run(self):
        while True:
            try:
                self._listen()
            except Exception:
                pass
            time.sleep(5)

    def _listen(self):
        now = self.get_now()
        while not (now and now.get("tracks")):
            time.sleep(2)
            now = self.get_now()
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "quiet", "-nostdin", "-i", self.url,
               "-vn", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            buf = b""
            last_tick = 0.0
            while True:
                data = proc.stdout.read(WINDOW * 2)
                if not data:
                    return
                buf += data
                while len(buf) >= WINDOW * 2:
                    chunk, buf = buf[:WINDOW * 2], buf[WINDOW * 2:]
                    now = self.get_now()
                    if not (now and now.get("tracks")):
                        continue
                    f = self._ensure(now)
                    if not f:
                        continue
                    a = array.array("h")
                    a.frombytes(chunk)
                    t = time.time()
                    with self.lock:
                        changed = f.feed(rms(a), t)
                        if t - last_tick > 1:
                            last_tick = t
                            changed |= f.tick(t)
                    if changed:
                        self._publish(now.get("id"), t)
        finally:
            proc.kill()
