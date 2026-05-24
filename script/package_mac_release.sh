#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/Apps/Email.xcodeproj"
SCHEME="EmailMac"
CONFIGURATION="${EMAIL_RELEASE_CONFIGURATION:-Release}"
DERIVED_DATA="${EMAIL_RELEASE_DERIVED_DATA:-$ROOT_DIR/DerivedData-Release}"
DIST_DIR="${EMAIL_RELEASE_DIST_DIR:-$ROOT_DIR/dist}"
APP_NAME="Email"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
SERVER_BUNDLE="$APP_BUNDLE/Contents/Resources/Server"
ZIP_PATH="$DIST_DIR/Email-mac.zip"
DMG_PATH="$DIST_DIR/Email-mac.dmg"
DMG_STAGE="$DIST_DIR/dmg-stage"
SKIP_NOTARIZATION=0
UNSIGNED=0

for arg in "$@"; do
  case "$arg" in
    --skip-notarization)
      SKIP_NOTARIZATION=1
      ;;
    --unsigned)
      UNSIGNED=1
      ;;
    --help|-h)
      cat <<EOF
Usage: ./script/package_mac_release.sh [--unsigned] [--skip-notarization]

Builds a distributable macOS app bundle, bundles the local Node server, and
creates dist/Email-mac.zip plus dist/Email-mac.dmg.

Environment:
  DEVELOPER_ID_APPLICATION   Developer ID Application signing identity.
  NOTARYTOOL_PROFILE         notarytool keychain profile for notarization.
  APPLE_ID                   Apple ID fallback for notarytool.
  APPLE_TEAM_ID              Team ID fallback for notarytool.
  APPLE_APP_SPECIFIC_PASSWORD
  EMAIL_RELEASE_ENV_FILE     Optional .env file copied into the bundled server.
  NODE_BIN                   Optional Node 24+ binary to bundle.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

resolve_node() {
  if [[ -n "${NODE_BIN:-}" ]]; then
    if [[ -x "$NODE_BIN" ]]; then
      printf '%s\n' "$NODE_BIN"
      return
    fi
    echo "NODE_BIN is not executable: $NODE_BIN" >&2
    exit 1
  fi

  for candidate in \
    "$(command -v node || true)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /Applications/Codex.app/Contents/Resources/node \
    /usr/bin/node; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  echo "Node 24+ not found. Set NODE_BIN to an absolute Node binary." >&2
  exit 127
}

NODE_SOURCE="$(resolve_node)"
NODE_MAJOR="$("$NODE_SOURCE" -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 24 )); then
  echo "Node 24+ is required for the bundled server. Found $("$NODE_SOURCE" -v) at $NODE_SOURCE." >&2
  exit 1
fi
NODE_SOURCE="$("$NODE_SOURCE" -p 'require("node:fs").realpathSync(process.argv[1])' "$NODE_SOURCE")"
echo "Bundling Node from $NODE_SOURCE"
echo "Node binary: $(/usr/bin/file -b "$NODE_SOURCE")"

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  npm ci --omit=dev
fi

mkdir -p "$DIST_DIR"
rm -rf "$APP_BUNDLE" "$ZIP_PATH" "$DMG_PATH" "$DMG_STAGE"

xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  build

BUILT_APP="$DERIVED_DATA/Build/Products/$CONFIGURATION/$APP_NAME.app"
if [[ ! -d "$BUILT_APP" ]]; then
  echo "Built app not found at $BUILT_APP" >&2
  exit 1
fi

/usr/bin/ditto "$BUILT_APP" "$APP_BUNDLE"
mkdir -p "$SERVER_BUNDLE/server"
/usr/bin/rsync -a --delete "$ROOT_DIR/server/src/" "$SERVER_BUNDLE/server/src/"
/usr/bin/rsync -a --delete "$ROOT_DIR/node_modules/" "$SERVER_BUNDLE/node_modules/"
/usr/bin/ditto "$ROOT_DIR/package.json" "$SERVER_BUNDLE/package.json"
/usr/bin/ditto "$ROOT_DIR/package-lock.json" "$SERVER_BUNDLE/package-lock.json"
/usr/bin/ditto "$NODE_SOURCE" "$SERVER_BUNDLE/node"
chmod 755 "$SERVER_BUNDLE/node"

if [[ -n "${EMAIL_RELEASE_ENV_FILE:-}" ]]; then
  if [[ ! -f "$EMAIL_RELEASE_ENV_FILE" ]]; then
    echo "EMAIL_RELEASE_ENV_FILE does not exist: $EMAIL_RELEASE_ENV_FILE" >&2
    exit 1
  fi
  /usr/bin/install -m 600 "$EMAIL_RELEASE_ENV_FILE" "$SERVER_BUNDLE/.env"
fi

SIGN_IDENTITY="${DEVELOPER_ID_APPLICATION:-${EMAIL_CODESIGN_IDENTITY:-}}"
if [[ "$UNSIGNED" == "0" && -n "$SIGN_IDENTITY" ]]; then
  SIGNING_DESCRIPTION="$SIGN_IDENTITY"
  CODESIGN_ARGS=(--force --timestamp --options runtime --sign "$SIGN_IDENTITY")
else
  SIGNING_DESCRIPTION="ad-hoc local signature"
  CODESIGN_ARGS=(--force --timestamp=none --options runtime --sign -)
fi

echo "Signing final bundle with $SIGNING_DESCRIPTION"
while IFS= read -r candidate; do
  if /usr/bin/file "$candidate" | /usr/bin/grep -q 'Mach-O'; then
    /usr/bin/codesign "${CODESIGN_ARGS[@]}" "$candidate"
  fi
done < <(/usr/bin/find "$SERVER_BUNDLE" -type f -print)

/usr/bin/codesign "${CODESIGN_ARGS[@]}" --deep "$APP_BUNDLE"
/usr/bin/codesign --verify --strict --deep --verbose=2 "$APP_BUNDLE"

if [[ "$UNSIGNED" == "0" && -n "$SIGN_IDENTITY" ]]; then
  echo "Developer ID signing complete."
else
  echo "Creating ad-hoc signed artifacts. Set DEVELOPER_ID_APPLICATION for public distribution."
fi

(cd "$DIST_DIR" && /usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP_NAME.app" "$ZIP_PATH")

mkdir -p "$DMG_STAGE"
/usr/bin/ditto "$APP_BUNDLE" "$DMG_STAGE/$APP_NAME.app"
ln -s /Applications "$DMG_STAGE/Applications"
/usr/bin/hdiutil create -volname "$APP_NAME" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG_PATH"
rm -rf "$DMG_STAGE"

NOTARIZED=0
if [[ "$SKIP_NOTARIZATION" == "0" && "$UNSIGNED" == "0" && -n "$SIGN_IDENTITY" ]]; then
  if [[ -n "${NOTARYTOOL_PROFILE:-${EMAIL_NOTARY_PROFILE:-}}" ]]; then
    PROFILE="${NOTARYTOOL_PROFILE:-${EMAIL_NOTARY_PROFILE:-}}"
    xcrun notarytool submit "$DMG_PATH" --keychain-profile "$PROFILE" --wait
    NOTARIZED=1
  elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
    xcrun notarytool submit "$DMG_PATH" \
      --apple-id "$APPLE_ID" \
      --team-id "$APPLE_TEAM_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --wait
    NOTARIZED=1
  else
    echo "Skipping notarization. Set NOTARYTOOL_PROFILE or APPLE_ID/APPLE_TEAM_ID/APPLE_APP_SPECIFIC_PASSWORD."
  fi
fi

if [[ "$NOTARIZED" == "1" ]]; then
  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH"
fi

echo "Packaged:"
echo "  $APP_BUNDLE"
echo "  $ZIP_PATH"
echo "  $DMG_PATH"
