# Vinyl Pi

Stream a USB turntable around the house from a Raspberry Pi 3. Drop the needle, open a browser on your phone or PC, press play.

```
Turntable ──USB──▶ Raspberry Pi 3 ──Wi-Fi/LAN──▶ Browser on phone / PC
                   (FFmpeg → Icecast, 320kbps MP3)
```

**Status:** phase 1, streaming. Web UI and "now playing" (search, barcode and cover scan) are coming next.

## What you need

- Raspberry Pi 3 with power supply (2.5A)
- microSD card, 8GB or more
- Turntable with USB out
- A computer to flash the card

## 1. Set up the Pi

1. Install [Raspberry Pi Imager](https://www.raspberrypi.com/software/) on your computer.
2. In Imager choose:
   - **Device:** Raspberry Pi 3
   - **OS:** Raspberry Pi OS (other) → **Raspberry Pi OS Lite (64-bit)**
   - **Storage:** your microSD card
3. When asked to customise settings, choose **Edit settings**:
   - **Hostname:** `vinyl`
   - **Username and password:** pick your own (e.g. `tom`)
   - **Wireless LAN:** your Wi-Fi name and password, country `GB`
   - **Services tab:** tick **Enable SSH** (password authentication)
4. Write the card, put it in the Pi, plug in the turntable over USB, then power up. First boot takes a couple of minutes.

> Wired Ethernet is more reliable than Wi-Fi if the Pi is near your router.

## 2. Install Vinyl Pi

From your computer's terminal (PowerShell on Windows, Terminal on Mac):

```bash
ssh tom@vinyl.local
```

Then on the Pi:

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/tlowndes/vinylpi.git
cd vinylpi
sudo ./scripts/install.sh
```

The installer sets up Icecast and FFmpeg, generates passwords, and starts the stream on every boot.

## 3. Listen

Open this in any browser on the same network:

```
http://vinyl.local:8000/vinyl
```

Expect a few seconds' delay behind the record. That buffer is what keeps playback smooth over Wi-Fi.

> On Android, `.local` names sometimes don't resolve. Use the Pi's IP instead: run `hostname -I` on the Pi.

## Check the input

Not hearing anything, or it's too quiet or distorted?

```bash
/opt/vinyl-pi/scripts/test-input.sh
```

It records 10 seconds and reports the level. Aim for a `max_volume` around -1 to -6 dB. If it's very quiet, check the turntable's gain switch, or run `alsamixer`, press F6, pick the USB device and raise the capture level.

## Useful commands

| What | Command |
| --- | --- |
| Stream status | `systemctl status vinyl-stream` |
| Recent logs | `journalctl -u vinyl-stream -n 50` |
| Restart stream | `sudo systemctl restart vinyl-stream` |
| Change bitrate or device | `sudo nano /etc/vinyl-pi/vinyl.env`, then restart |
| List audio inputs | `arecord -l` |
| Update | `cd ~/vinylpi && git pull && sudo ./scripts/install.sh` |

## How it works

- `scripts/stream.sh` finds the USB audio device, captures it with ALSA, and encodes it to MP3 with FFmpeg.
- **Icecast** serves that stream to any number of listeners on port 8000.
- `vinyl-stream.service` (systemd) starts it on boot and keeps retrying if the turntable is off or unplugged.
- Settings and passwords live in `/etc/vinyl-pi/vinyl.env` and never in the repo.

## Roadmap

- [x] Phase 1: stream to the browser
- [ ] Phase 2: web UI at `http://vinyl.local`, with a player, live level meter, and now playing via search (MusicBrainz) and barcode scan
- [ ] Phase 3: cover photo scan, listening history, and side A/B tracking
