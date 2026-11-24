#!/bin/bash -e
# Runs on the build host: copy the Vinyl Pi checkout (with its git history) into the image.
rm -rf "${ROOTFS_DIR}/opt/vinyl-pi"
cp -a files/vinyl-pi "${ROOTFS_DIR}/opt/vinyl-pi"
# Wi-Fi template on the boot partition, the part of the card any computer can open.
install -m 644 files/vinyl-pi/config/vinylpi-wifi.txt "${ROOTFS_DIR}/boot/firmware/vinylpi-wifi.txt"
