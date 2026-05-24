#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/Apps/Email.xcodeproj"
SCHEME="EmailMac"
DERIVED_DATA="$ROOT_DIR/DerivedData"
SERVER_URL="http://127.0.0.1:7331/api/health"
INSTALL_DIR="${EMAIL_MAC_INSTALL_DIR:-$HOME/Applications}"
INSTALL_APP="$INSTALL_DIR/Email.app"
INSTALL=0
VERIFY=0

for arg in "$@"; do
  case "$arg" in
    --install)
      INSTALL=1
      ;;
    --verify)
      VERIFY=1
      ;;
    --help|-h)
      cat <<EOF
Usage: ./script/build_and_run.sh [--install] [--verify]

Builds and launches the macOS app.

Options:
  --install   Copy the fresh build to ~/Applications/Email.app before launch.
              Set EMAIL_MAC_INSTALL_DIR to choose another install directory.
  --verify    After launch, verify the Email process is running.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

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
LAUNCH_APP="$APP"

if [[ "$INSTALL" == "1" ]]; then
  mkdir -p "$INSTALL_DIR"
  rm -rf "$INSTALL_APP"
  /usr/bin/ditto "$APP" "$INSTALL_APP"
  LAUNCH_APP="$INSTALL_APP"
  echo "Installed $INSTALL_APP"
fi

open -n "$LAUNCH_APP"

if [[ "$VERIFY" == "1" ]]; then
  sleep 1
  pgrep -x Email >/dev/null
fi
