#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/Apps/Email.xcodeproj"
SCHEME="EmailMac"
DERIVED_DATA="$ROOT_DIR/DerivedData"
CONFIGURATION="${EMAIL_MAC_CONFIGURATION:-Debug}"
SERVER_BASE_URL="${EMAIL_RELEASE_SERVER_URL:-}"
INSTALL_DIR="${EMAIL_MAC_INSTALL_DIR:-$HOME/Applications}"
INSTALL_APP="$INSTALL_DIR/Email.app"
INSTALL=0
VERIFY=0
FRESH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --production)
      CONFIGURATION="Release"
      SERVER_BASE_URL="${SERVER_BASE_URL:-https://dearly-email.fly.dev}"
      shift
      ;;
    --server-url)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--server-url requires a value" >&2; exit 2; }
      SERVER_BASE_URL="$2"
      shift 2
      ;;
    --fresh)
      FRESH=1
      shift
      ;;
    --install)
      INSTALL=1
      shift
      ;;
    --verify)
      VERIFY=1
      shift
      ;;
    --help|-h)
      cat <<EOF
Usage: ./script/build_and_run.sh [--production] [--server-url URL] [--fresh] [--install] [--verify]

Builds and launches the macOS app.

Options:
  --production
              Build Release and point at the hosted Fly backend.
  --server-url URL
              Inject a specific Email API base URL into the app build.
  --fresh     Clear the saved server override and Supabase auth session before launch.
  --install   Copy the fresh build to ~/Applications/Email.app before launch.
              Set EMAIL_MAC_INSTALL_DIR to choose another install directory.
  --verify    After launch, verify the Email process is running.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$SERVER_BASE_URL" ]]; then
  if [[ "$CONFIGURATION" == "Release" ]]; then
    SERVER_BASE_URL="https://dearly-email.fly.dev"
  else
    SERVER_BASE_URL="http://127.0.0.1:7331"
  fi
fi

SERVER_HEALTH_URL="${SERVER_BASE_URL%/}/api/health"

if [[ "$SERVER_BASE_URL" == http://127.0.0.1* || "$SERVER_BASE_URL" == http://localhost* ]]; then
  if ! curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1; then
    nohup env EMAIL_SEED_DEMO="${EMAIL_SEED_DEMO:-1}" "$ROOT_DIR/scripts/start-server.sh" >/tmp/email-server.log 2>&1 &
    for _ in {1..40}; do
      if curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done

    if ! curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1; then
      echo "Email server did not become healthy. See /tmp/email-server.log." >&2
      exit 1
    fi
  fi
else
  if ! curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1; then
    echo "Hosted Email API is not healthy at $SERVER_HEALTH_URL." >&2
    exit 1
  fi
fi

if [[ "$FRESH" == "1" ]]; then
  /usr/bin/defaults delete com.borjadotai.email.mac email.serverURL >/dev/null 2>&1 || true
  /usr/bin/security delete-generic-password -s EmailApp.AuthSession -a supabase >/dev/null 2>&1 || true
fi

pkill -x Email >/dev/null 2>&1 || true

xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED_DATA" \
  "EMAIL_DEFAULT_SERVER_URL=$SERVER_BASE_URL" \
  build

APP="$DERIVED_DATA/Build/Products/$CONFIGURATION/Email.app"
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

echo "Launched $LAUNCH_APP"
echo "Server URL: $SERVER_BASE_URL"
