"""Name the song that's playing: grab a few seconds of the live stream and ask AudD."""
import json
import time
import urllib.error
import urllib.request
import uuid

AUDD_URL = "https://api.audd.io/"
SECONDS = 9  # AudD needs about 5-10 s; longer just costs upload time
MAX_BYTES = 1024 * 1024


class RecogniseError(Exception):
    pass


def capture(stream_url, seconds=SECONDS):
    """Read `seconds` of MP3 from Icecast. Icecast sends a burst first, so trim to the target size."""
    try:
        r = urllib.request.urlopen(stream_url, timeout=5)
    except Exception as exc:
        raise RecogniseError("The stream is offline, so there's nothing to listen to.") from exc
    # Bitrate from Icecast's header (kbps), else assume 320k.
    try:
        kbps = int((r.headers.get("icy-br") or "320").split(",")[0])
    except ValueError:
        kbps = 320
    want = min(MAX_BYTES, kbps * 125 * seconds)
    buf = bytearray()
    deadline = time.time() + seconds + 6
    with r:
        while len(buf) < want and time.time() < deadline:
            chunk = r.read(16384)
            if not chunk:
                break
            buf += chunk
    if len(buf) < kbps * 125 * 3:
        raise RecogniseError("Couldn't hear enough of the stream. Try again.")
    return bytes(buf)


def _multipart(fields, file_field, filename, data):
    b = uuid.uuid4().hex
    out = bytearray()
    for k, v in fields.items():
        out += f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    out += (f'--{b}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
            "Content-Type: audio/mpeg\r\n\r\n").encode()
    out += data + f"\r\n--{b}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={b}"


def _artwork(res):
    am = res.get("apple_music") or {}
    url = (am.get("artwork") or {}).get("url")
    if url:
        return url.replace("{w}", "600").replace("{h}", "600")
    imgs = ((res.get("spotify") or {}).get("album") or {}).get("images") or []
    return imgs[0]["url"] if imgs else None


def identify(audio, token):
    fields = {"return": "apple_music,spotify"}
    if token:
        fields["api_token"] = token
    body, ctype = _multipart(fields, "file", "clip.mp3", audio)
    req = urllib.request.Request(AUDD_URL, data=body, headers={"Content-Type": ctype, "User-Agent": "VinylPi"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RecogniseError("Couldn't reach AudD. Is the Pi online?") from exc
    except ValueError as exc:
        raise RecogniseError("AudD sent back something odd. Try again.") from exc

    if data.get("status") != "success":
        err = data.get("error") or {}
        code = err.get("error_code")
        if code == 900:
            raise RecogniseError("AudD didn't accept the API token. Check it in Settings.")
        if code in (901, 902):
            raise RecogniseError("Out of free AudD lookups. Add or top up your AudD token in Settings.")
        raise RecogniseError(err.get("error_message") or "AudD couldn't check that. Try again.")

    res = data.get("result")
    if not res:
        return None
    return {
        "title": str(res.get("title", ""))[:200],
        "artist": str(res.get("artist", ""))[:200],
        "album": str(res.get("album", ""))[:200],
        "year": str(res.get("release_date", ""))[:4],
        "artwork": _artwork(res),
        "link": res.get("song_link"),
        "at": time.time(),
    }
