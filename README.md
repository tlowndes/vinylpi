# Vinyl Pi

Stream a USB turntable around the house from a Raspberry Pi 3. Drop the needle, open `http://vinyl.local` on your phone or PC, press play.

```
Turntable ──USB──▶ Raspberry Pi 3 ──Wi-Fi/LAN──▶ Browser on phone / PC
                   (FFmpeg → Icecast, 320kbps MP3)
```

- **Player** with a live level meter, in the browser. No app needed.
- **Now playing:** search MusicBrainz, scan the barcode or the front cover with your phone, or type it in. Cover, tracklist and the current side show up for everyone listening.
- **Listening stats:** hours with the needle down, most-spun records and top artists, by week, month or all time.
- **Looks after itself:** Wi-Fi watchdog with a rescue hotspot, and nightly updates from GitHub that roll back if anything breaks.

## What you need

- Raspberry Pi 3 with power supply (2.5A). The Pi 3 has Wi-Fi built in.
- microSD card, 8GB or more
- Turntable with USB out

## Option A: flash the ready-made image (easiest)

1. Download `vinylpi-*.img.xz` from the [latest release](https://github.com/tlowndes/vinylpi/releases/latest).
2. In [Raspberry Pi Imager](https://www.raspberrypi.com/software/) choose **Device:** Raspberry Pi 3, **OS:** Use custom → that file, then your SD card. Skip any customisation.
3. When it's done, take the card out and put it back in. Open the drive called **bootfs**, open `vinylpi-wifi.txt`, type your Wi-Fi name and password after the `=` signs, and save.
4. Put the card in the Pi, plug in the turntable over USB, and power up. First boot takes a few minutes, then open **http://vinyl.local**.

To change Wi-Fi later, edit the same file again. The Pi reads it on every start.

> Or skip the hotspot: plug the Pi into your router with a network cable.

**No Wi-Fi set up?** The Pi opens its own network after a minute or so (`VinylPi-Setup`, password `vinylpi-setup`; if your phone doesn't ask for a password, that's fine too). Join it on your phone; the setup page should pop up (if not, open `http://10.42.0.1`). Pick your home Wi-Fi.

**Can't reach it at all?** Power off, put the SD card in your computer, and open `vinylpi-wifi-log.txt` on the card. It's a Wi-Fi report the Pi refreshes every minute while it's offline.

## Option B: install on Raspberry Pi OS yourself

Use this if you want SSH access to the Pi.

1. Flash **Raspberry Pi OS Lite (64-bit)** with Imager. In **Edit settings** set hostname `vinyl`, your username and password, your Wi-Fi (country `GB`), and tick **Enable SSH**.
2. Boot it, then from your computer:

```bash
ssh tom@vinyl.local
sudo apt update && sudo apt install -y git
sudo git clone https://github.com/tlowndes/vinylpi.git /opt/vinyl-pi
sudo /opt/vinyl-pi/scripts/install.sh
```

The installer sets up Icecast, FFmpeg, the web app and the background services, then prints the address to open.

## Using it

- **Listen:** open `http://vinyl.local` and press play. Expect a few seconds' delay behind the record. That buffer keeps playback smooth over Wi-Fi.
- **Set what's playing:** tap **New record**, then search, scan the barcode or cover, or type it in.
- **Stats:** the chart icon at the top of the player.
- **Flip side:** moves the tracklist to the next side.
- **Settings** (top-right icon): bitrate, restart stream, updates, Wi-Fi, and the Pi's temperature.
- **VLC or other players:** the raw stream is `http://vinyl.local:8000/vinyl`.

> On Android, `.local` names sometimes don't resolve. Use the Pi's IP address instead (your router's device list shows it).

## Cover scan

Two modes, set in **Settings → Cover scan**:

- **Text only (free, default):** your phone reads the artist and title printed on the sleeve, then searches MusicBrainz. You can fix the words before searching.
- **Claude:** paste an [Anthropic API key](https://console.anthropic.com/settings/keys) and Claude recognises the cover from the artwork, even with no text on it. About 1p a scan, billed to your Anthropic account. The key stays on the Pi.

## What's this song?

Tap **What's this?** on the Now playing screen. The Pi grabs about 9 seconds of the stream and asks [AudD](https://audd.io) to name it. The song shows under the album, and its track is marked in the tracklist (the side switches if you flipped without telling it). With nothing on the platter, it fills in the album too.

It works a few times a day with no setup. For more, paste a free [AudD token](https://dashboard.audd.io/) into **Settings → Song recognition** (about 300 lookups, then roughly $2 per 1,000). Lookups only happen when you tap.

## Your shelf

Tap the shelf icon on Now playing. Every record you play lands on the shelf, and **+** adds records you own without playing them (search or barcode).

- **Order:** Artist (filed by surname, "Beatles, The"), Genre, Colour (a rainbow of sleeves) or Year. Switch any time and the shelf rearranges.
- **Order list:** a numbered list to follow when you reshelve.
- **Shelves:** the sliders icon sets how many shelves you have and how many records fit on each. Records fill them in order; anything that doesn't fit shows under "No room yet".
- **Tap a spine** to see where it lives (shelf, slot, and what it sits between) or to spin it.
- **Discogs:** paste a [personal token](https://www.discogs.com/settings/developers) in **Settings → Discogs** and records you add go into your Discogs collection too. You can also import your Discogs collection onto the shelf.

## Secure page (https)

Phones only allow a live camera feed on secure pages, so Vinyl Pi also serves **https://vinyl.local** (nginx in front of the web app and the stream). The Pi makes its own certificate, so each phone trusts it once: **Settings → Secure page** has the download and the steps for iPhone and Android. After that, opening http://vinyl.local hops to the secure page by itself, and the barcode scanner shows a live camera.

## Wi-Fi rescue

A watchdog checks the connection every 20 seconds:

1. After 1 minute offline it restarts Wi-Fi.
2. After 5 minutes it opens the `VinylPi-Setup` hotspot so you can fix it from your phone.
3. While the hotspot is open, it retries your saved network every 10 minutes and closes the hotspot once it's back.

## Updates

- Every night around 4am the Pi checks GitHub and installs anything new on `main`.
- If the new version doesn't come up healthy, it rolls back on its own and says so in Settings.
- Turn off auto-updates or update now from **Settings → Updates**.

To ship an update: merge to `main`. To build a new image: push a tag such as `v1.1.0` (see [image/README.md](image/README.md)).

## Check the input

Not hearing anything, or it's too quiet or distorted? Over SSH:

```bash
/opt/vinyl-pi/scripts/test-input.sh
```

It records 10 seconds and reports the level. Aim for a `max_volume` around -1 to -6 dB. If it's very quiet, check the turntable's gain switch, or run `alsamixer`, press F6, pick the USB device and raise the capture level.

## Useful commands

| What | Command |
| --- | --- |
| Status | `systemctl status vinyl-stream vinyl-web vinyl-wifi` |
| Logs | `journalctl -u vinyl-stream -u vinyl-web -u vinyl-wifi -n 50` |
| Settings | `sudo nano /etc/vinyl-pi/vinyl.env`, then `sudo systemctl restart vinyl-stream vinyl-web vinyl-wifi` |
| Update now | `sudo /opt/vinyl-pi/scripts/update.sh --apply` |
| List audio inputs | `arecord -l` |

## How it works

| Part | What it does |
| --- | --- |
| `scripts/stream.sh` | Finds the USB audio device and encodes it to MP3 with FFmpeg |
| Icecast | Serves the stream on port 8000 |
| `app/` | Flask web app on port 80: player, now playing, stats, settings, live updates |
| `app/cover.py` | Cover recognition with Claude (optional, needs an API key) |
| `scripts/https.sh` | Makes the Pi's certificate and the nginx site for https |
| `app/collection.py` | Your shelf: records you own, how they're filed |
| `app/discogs.py` | Discogs sync (optional, needs a token) |
| `app/recognise.py` | "What's this?" song recognition with AudD |
| `scripts/wifi.sh` | Wi-Fi watchdog and rescue hotspot |
| `scripts/update.sh` | Pulls from GitHub, health-checks, rolls back on failure |
| `scripts/vinyl-admin.sh` | The only thing the web app may run as root; checks every input |
| `image/` | Builds the ready-to-flash image with GitHub Actions |

Settings and passwords live in `/etc/vinyl-pi/vinyl.env`, never in the repo. Free cover text reading uses [Tesseract.js](https://tesseract.projectnaptha.com) in your browser. Album info comes from [MusicBrainz](https://musicbrainz.org) and the [Cover Art Archive](https://coverartarchive.org).

## Roadmap

- [x] Phase 1: stream to the browser
- [x] Phase 2: web UI, now playing (search and barcode), Wi-Fi rescue, updates, Pi image
- [x] Phase 3: cover scan (free text reading or Claude) and listening stats
