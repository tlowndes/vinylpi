#!/bin/bash -e
# Runs on the build host: copy the Vinyl Pi checkout (with its git history) into the image.
rm -rf "${ROOTFS_DIR}/opt/vinyl-pi"
cp -a files/vinyl-pi "${ROOTFS_DIR}/opt/vinyl-pi"
