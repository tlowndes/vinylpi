# Vinyl Pi

Stream a USB turntable around the house from a Raspberry Pi 3. Drop the needle, open `http://vinyl.local` on your phone or PC, press play.

```
Turntable ──USB──▶ Raspberry Pi 3 ──Wi-Fi/LAN──▶ Browser on phone / PC
                   (FFmpeg → Icecast, 320kbps MP3)
```

- **Player** with a live level meter, in the browser. No app needed.
- **Now playing:** search MusicBrainz, scan the barcode with your phone, or type it in. Cover, tracklist and the current side show up for everyone listening.
- **Looks after itself:** Wi-Fi watchdog with a rescue hotspot, and nightly updates from GitHub that roll back if anything breaks.

## What you need

- Raspberry Pi 3 with power supply (2.5A). The Pi 3 has Wi-Fi built in.
- microSD card, 8GB or more
- Turntable with USB out

## Option A: flash the ready-made image (easiest)

1. Download `vinylpi-*.img.xz` from the [latest release](https://github.com/tlowndes/vinylpi/releases/latest).
2. In [Raspberry Pi Imager](https://www.raspberrypi.com/software/) choose **Device:** Raspberry Pi 3, **OS:** Use custom → that file, then your SD card. Skip the customisation settings.
3. Put the card in the Pi, plug in the turntable over USB, and power up. First boot takes a few minutes.
4. With no Wi-Fi set up, the Pi opens its own network after a minute or so:
   - **Network:** `VinylPi-Setup`
   - **Password:** `vinylpi-setup`
5. Join it on your phone. The setup page should pop up (if not, open `http://10.42.0.1`). Pick your home Wi-Fi and enter its password.
6. Rejoin your home Wi-Fi and open **http://vinyl.local**.

> Or skip the hotspot: plug the Pi into your router with a network cable.

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
- **Set what's playing:** tap **New record**, then search, scan the barcode on the sleeve, or type it in.
- **Flip side:** moves the tracklist to the next side.
- **Settings** (top-right icon): bitrate, restart stream, updates, Wi-Fi, and the Pi's temperature.
- **VLC or other players:** the raw stream is `http://vinyl.local:8000/vinyl`.

> On Android, `.local` names sometimes don't resolve. Use the Pi's IP address instead (your router's device list shows it).

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
| `app/` | Flask web app on port 80: player, now playing, settings, live updates |
| `scripts/wifi.sh` | Wi-Fi watchdog and rescue hotspot |
| `scripts/update.sh` | Pulls from GitHub, health-checks, rolls back on failure |
| `scripts/vinyl-admin.sh` | The only thing the web app may run as root; checks every input |
| `image/` | Builds the ready-to-flash image with GitHub Actions |

Settings and passwords live in `/etc/vinyl-pi/vinyl.env`, never in the repo. Album info comes from [MusicBrainz](https://musicbrainz.org) and the [Cover Art Archive](https://coverartarchive.org).

## Roadmap

- [x] Phase 1: stream to the browser
- [x] Phase 2: web UI, now playing (search and barcode), Wi-Fi rescue, updates, Pi image
- [ ] Phase 3: cover photo scan, listening stats
