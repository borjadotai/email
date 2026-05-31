#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/Apps/Email.xcodeproj"
SCHEME="EmailMac"
DERIVED_DATA="$ROOT_DIR/DerivedData"
INSTALL_DIR="${EMAIL_MAC_INSTALL_DIR:-$HOME/Applications}"
INSTALL_APP="$INSTALL_DIR/Email.app"
APP_BUNDLE_ID="com.borjadotai.email.mac"
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

Builds and launches the macOS app against the active Carta CLI server.

Options:
  --install   Copy the fresh build to ~/Applications/Email.app before launch.
              Set EMAIL_MAC_INSTALL_DIR to choose another install directory.
  --verify    After launch, verify the Email process is running.

Environment:
  EMAIL_DEFAULT_SERVER_URL  Override the server URL used by the app.
  EMAIL_USE_LEGACY_SERVER   Set to 1 to fall back to the old bundled dev server.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

SERVER_BASE_URL="${EMAIL_DEFAULT_SERVER_URL:-}"

if [[ -z "$SERVER_BASE_URL" ]] && command -v carta >/dev/null 2>&1; then
  CONNECTION_JSON="$(carta connection --check --json 2>/dev/null || true)"
  SERVER_BASE_URL="$(printf '%s' "$CONNECTION_JSON" | node -e '
    let text = "";
    process.stdin.on("data", chunk => { text += chunk; });
    process.stdin.on("end", () => {
      try {
        const payload = JSON.parse(text);
        if (payload?.health?.ok && payload?.server?.baseURL) {
          process.stdout.write(payload.server.baseURL);
        }
      } catch {}
    });
  ')"
fi

if [[ -z "$SERVER_BASE_URL" ]]; then
  if [[ "${EMAIL_USE_LEGACY_SERVER:-0}" == "1" ]]; then
    SERVER_BASE_URL="http://127.0.0.1:7331"
  else
    echo "No healthy Carta CLI server found. Run 'carta setup' or 'carta server start', then retry." >&2
    exit 1
  fi
fi

SERVER_BASE_URL="${SERVER_BASE_URL%/}"
SERVER_HEALTH_URL="$SERVER_BASE_URL/api/health"

if ! curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1; then
  if [[ "${EMAIL_USE_LEGACY_SERVER:-0}" == "1" && "$SERVER_BASE_URL" == "http://127.0.0.1:7331" ]]; then
    nohup env EMAIL_SEED_DEMO="${EMAIL_SEED_DEMO:-1}" "$ROOT_DIR/scripts/start-server.sh" >/tmp/email-server.log 2>&1 &
    for _ in {1..40}; do
      if curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
  fi

  if ! curl -fsS "$SERVER_HEALTH_URL" >/dev/null 2>&1; then
    echo "Email server is not healthy at $SERVER_HEALTH_URL." >&2
    exit 1
  fi
fi

pkill -x Email >/dev/null 2>&1 || true
defaults write "$APP_BUNDLE_ID" email.serverURL "$SERVER_BASE_URL"

xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED_DATA" \
  EMAIL_DEFAULT_SERVER_URL="$SERVER_BASE_URL" \
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
