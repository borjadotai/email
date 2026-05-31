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
  EMAIL_MAC_PROVISIONING_PROFILE  Developer ID provisioning profile with Push Notifications.
  EMAIL_MAC_APNS_ENVIRONMENT      APNs entitlement value for manual signing. Defaults to production.
  EMAIL_RELEASE_SERVER_URL   API endpoint baked into the app's default settings.
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

XCODEBUILD_OVERRIDES=()
if [[ -n "${EMAIL_RELEASE_VERSION:-}" ]]; then
  XCODEBUILD_OVERRIDES+=(MARKETING_VERSION="$EMAIL_RELEASE_VERSION")
fi
if [[ -n "${EMAIL_RELEASE_BUILD:-}" ]]; then
  XCODEBUILD_OVERRIDES+=(CURRENT_PROJECT_VERSION="$EMAIL_RELEASE_BUILD")
fi
if [[ -n "${EMAIL_RELEASE_SERVER_URL:-}" ]]; then
  XCODEBUILD_OVERRIDES+=(EMAIL_DEFAULT_SERVER_URL="$EMAIL_RELEASE_SERVER_URL")
fi

mkdir -p "$DIST_DIR"
rm -rf "$APP_BUNDLE" "$ZIP_PATH" "$DMG_PATH" "$DMG_STAGE"

XCODEBUILD_COMMAND=(
  xcodebuild
  -project "$PROJECT"
  -scheme "$SCHEME"
  -configuration "$CONFIGURATION"
  -destination 'platform=macOS'
  -derivedDataPath "$DERIVED_DATA"
  CODE_SIGNING_ALLOWED=NO
)
if [[ ${#XCODEBUILD_OVERRIDES[@]} -gt 0 ]]; then
  XCODEBUILD_COMMAND+=("${XCODEBUILD_OVERRIDES[@]}")
fi
XCODEBUILD_COMMAND+=(build)

"${XCODEBUILD_COMMAND[@]}"

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

MAC_PROVISIONING_PROFILE="${EMAIL_MAC_PROVISIONING_PROFILE:-${MACOS_PROVISIONING_PROFILE:-}}"
MAC_APNS_ENTITLEMENTS=""
if [[ -n "$MAC_PROVISIONING_PROFILE" ]]; then
  if [[ ! -f "$MAC_PROVISIONING_PROFILE" ]]; then
    echo "Mac provisioning profile not found: $MAC_PROVISIONING_PROFILE" >&2
    exit 1
  fi
  /usr/bin/ditto "$MAC_PROVISIONING_PROFILE" "$APP_BUNDLE/Contents/embedded.provisionprofile"

  MAC_APNS_ENVIRONMENT="${EMAIL_MAC_APNS_ENVIRONMENT:-production}"
  MAC_APNS_ENTITLEMENTS="$DIST_DIR/EmailMac.codesign.entitlements"
  /usr/bin/plutil -create xml1 "$MAC_APNS_ENTITLEMENTS"
  /usr/libexec/PlistBuddy -c "Add :com.apple.developer.aps-environment string $MAC_APNS_ENVIRONMENT" "$MAC_APNS_ENTITLEMENTS"
  /usr/libexec/PlistBuddy -c "Add :com.apple.developer.usernotifications.communication bool true" "$MAC_APNS_ENTITLEMENTS"
fi

SIGN_IDENTITY="${DEVELOPER_ID_APPLICATION:-${EMAIL_CODESIGN_IDENTITY:-}}"
if [[ "$UNSIGNED" == "0" && -n "$SIGN_IDENTITY" ]]; then
  SIGNING_DESCRIPTION="$SIGN_IDENTITY"
  CODESIGN_ARGS=(--force --timestamp --options runtime --sign "$SIGN_IDENTITY")
else
  SIGNING_DESCRIPTION="ad-hoc local signature"
  CODESIGN_ARGS=(--force --timestamp=none --sign -)
fi

echo "Signing final bundle with $SIGNING_DESCRIPTION"
APP_CODESIGN_ARGS=("${CODESIGN_ARGS[@]}")
if [[ -n "$MAC_APNS_ENTITLEMENTS" ]]; then
  APP_CODESIGN_ARGS+=(--entitlements "$MAC_APNS_ENTITLEMENTS")
  echo "Embedding macOS APNs provisioning profile and entitlements."
elif [[ "$UNSIGNED" == "0" && -n "$SIGN_IDENTITY" ]]; then
  echo "No EMAIL_MAC_PROVISIONING_PROFILE provided; macOS APNs will not work in this packaged app."
fi

sign_macho_files() {
  local root="$1"
  if [[ ! -d "$root" ]]; then
    return
  fi

  while IFS= read -r candidate; do
    if /usr/bin/file "$candidate" | /usr/bin/grep -q 'Mach-O'; then
      /usr/bin/codesign "${CODESIGN_ARGS[@]}" "$candidate"
    fi
  done < <(/usr/bin/find "$root" -type f -print)
}

sign_nested_bundles() {
  local root="$1"
  if [[ ! -d "$root" ]]; then
    return
  fi

  while IFS= read -r candidate; do
    /usr/bin/codesign "${CODESIGN_ARGS[@]}" "$candidate"
  done < <(/usr/bin/find "$root" -depth -type d \( -name '*.appex' -o -name '*.xpc' -o -name '*.app' -o -name '*.framework' \) -print)
}

sign_macho_files "$SERVER_BUNDLE"
sign_macho_files "$APP_BUNDLE/Contents/Frameworks"
sign_macho_files "$APP_BUNDLE/Contents/PlugIns"
sign_nested_bundles "$APP_BUNDLE/Contents/Frameworks"
sign_nested_bundles "$APP_BUNDLE/Contents/PlugIns"

/usr/bin/codesign "${APP_CODESIGN_ARGS[@]}" "$APP_BUNDLE"
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
