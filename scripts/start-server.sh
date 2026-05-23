#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

export EMAIL_DATA_DIR="${EMAIL_DATA_DIR:-$HOME/Library/Application Support/EmailApp}"
export EMAIL_SERVER_HOST="${EMAIL_SERVER_HOST:-127.0.0.1}"
export EMAIL_SERVER_PORT="${EMAIL_SERVER_PORT:-7331}"

if [[ -z "${NODE_BIN:-}" ]]; then
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /Applications/Codex.app/Contents/Resources/node \
    /usr/bin/node; do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "${NODE_BIN:-}" ]]; then
  echo "node not found. Set NODE_BIN to an absolute Node 24+ binary." >&2
  exit 127
fi

cd "$ROOT_DIR"
exec "$NODE_BIN" --no-warnings server/src/main.js
