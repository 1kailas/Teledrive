#!/usr/bin/env bash
# Run telegram-bot-api in --local mode for TeleDrive.
# Loads the repo-root .env for TELEGRAM_API_ID/HASH + paths.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$ROOT/bin:$PATH"
set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a

: "${TELEGRAM_API_ID:?set TELEGRAM_API_ID in .env (from my.telegram.org)}"
: "${TELEGRAM_API_HASH:?set TELEGRAM_API_HASH in .env}"
BOT_API_URL="${TELEGRAM_BOT_API_URL:-http://127.0.0.1:8081}"
API_DIR="${TELEGRAM_BOT_API_DIR:-/var/lib/telegram-bot-api}"
export TELEGRAM_API_ID TELEGRAM_API_HASH   # read natively by telegram-bot-api — keeps secrets out of argv/`ps`

# derive host/port from the configured URL
HOST="$(echo "$BOT_API_URL" | sed -E 's|^[a-z]+://([^:/]+).*|\1|')"
PORT="$(echo "$BOT_API_URL" | sed -nE 's|.*:([0-9]+).*|\1|p')"
PORT="${PORT:-8081}"

mkdir -p "$API_DIR" "$API_DIR/tmp"

echo "Starting telegram-bot-api --local on $HOST:$PORT (dir $API_DIR)"
exec telegram-bot-api \
  --local \
  --http-ip-address="$HOST" \
  --http-port="$PORT" \
  --dir="$API_DIR" \
  --temp-dir="$API_DIR/tmp" \
  --log="$API_DIR/bot-api.log" \
  --verbosity=1
