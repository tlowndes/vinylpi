# Vinyl Pi image

`.github/workflows/build-image.yml` builds a ready-to-flash Raspberry Pi OS Lite (64-bit) image with Vinyl Pi baked in, using [pi-gen](https://github.com/RPi-Distro/pi-gen) via [pi-gen-action](https://github.com/usimd/pi-gen-action).

- `stage-vinylpi/` is a custom pi-gen stage that runs after the standard Lite stages (`stage0 stage1 stage2`).
- `00-run.sh` copies this repo into `/opt/vinyl-pi`, then `01-run-chroot.sh` runs `scripts/install.sh --image` inside the image.
- Passwords are generated on first boot (`vinyl-firstboot.service`), so every Pi gets its own.

SSH is off in the image, so there is no login with a default password. Use the manual install in the main README if you want SSH.

To publish a release with the image attached, either push a tag like `v1.0.0`, or open **Actions → Build Pi image → Run workflow** and type the tag (e.g. `v1.0.0`) in the release box. Leave the box empty to get the image as a download on the run page instead.
