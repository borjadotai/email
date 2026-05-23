#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/Apps/Email.xcodeproj"
SCHEME="EmailMac"
DERIVED_DATA="$ROOT_DIR/DerivedData"
SERVER_URL="http://127.0.0.1:7331/api/health"

if ! curl -fsS "$SERVER_URL" >/dev/null 2>&1; then
  nohup env EMAIL_SEED_DEMO="${EMAIL_SEED_DEMO:-1}" "$ROOT_DIR/scripts/start-server.sh" >/tmp/email-server.log 2>&1 &
  for _ in {1..40}; do
    if curl -fsS "$SERVER_URL" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done

  if ! curl -fsS "$SERVER_URL" >/dev/null 2>&1; then
    echo "Email server did not become healthy. See /tmp/email-server.log." >&2
    exit 1
  fi
fi

pkill -x Email >/dev/null 2>&1 || true

xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED_DATA" \
  build

APP="$DERIVED_DATA/Build/Products/Debug/Email.app"
open -n "$APP"

if [[ "${1:-}" == "--verify" ]]; then
  sleep 1
  pgrep -x Email >/dev/null
fi
