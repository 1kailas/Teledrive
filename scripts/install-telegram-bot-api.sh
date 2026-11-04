#!/usr/bin/env bash
# Build and install telegram-bot-api (the self-hosted Bot API server with
# --local support) on Debian/Ubuntu. Idempotent: re-run to update.
#
#   sudo ./scripts/install-telegram-bot-api.sh
#
# Config:
#   BUILD_DIR  build source dir   (default /opt/telegram-bot-api-src)
#   BUILD_JOBS cmake --parallel N (default $(nproc); use 1 on small VPSes —
#              the build needs several GB of RAM)
set -euo pipefail

BUILD_DIR="${BUILD_DIR:-/opt/telegram-bot-api-src}"
JOBS="${BUILD_JOBS:-$(nproc)}"
REPO="https://github.com/tdlib/telegram-bot-api"

echo "==> Installing build dependencies"
apt-get update -y
apt-get install -y make git zlib1g-dev libssl-dev gperf cmake g++ php-cli openssl \
  libreadline-dev 2>/dev/null || apt-get install -y make git zlib1g-dev libssl-dev gperf cmake g++

if [ -d "$BUILD_DIR/.git" ]; then
  echo "==> Updating existing clone in $BUILD_DIR"
  git -C "$BUILD_DIR" pull --ff-only
  git -C "$BUILD_DIR" submodule update --init --recursive
else
  echo "==> Cloning $REPO (recursive) into $BUILD_DIR"
  git clone --recursive "$REPO" "$BUILD_DIR"
fi

echo "==> Building (Release, -j$JOBS) — this takes a while and needs a few GB of RAM"
cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR/build" --target install --parallel "$JOBS"
# `cmake --install` puts it in /usr/local/bin
echo "==> Installed:"
/usr/local/bin/telegram-bot-api --version || true
echo "Done. Next: sudo ./scripts/run-telegram-bot-api.sh (or enable the systemd unit)."
