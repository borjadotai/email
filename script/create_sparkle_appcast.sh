#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE_PATH="${SPARKLE_ARCHIVE_PATH:-$ROOT_DIR/dist/Email-mac.zip}"
APP_PATH="${SPARKLE_APP_PATH:-$ROOT_DIR/dist/Email.app}"
OUTPUT_PATH="${SPARKLE_APPCAST_PATH:-$ROOT_DIR/dist/appcast.xml}"
RELEASE_TAG="${GITHUB_REF_NAME:-${SPARKLE_RELEASE_TAG:-}}"
SIGN_UPDATE="${SPARKLE_SIGN_UPDATE:-}"

if [[ -z "$RELEASE_TAG" ]]; then
  echo "GITHUB_REF_NAME or SPARKLE_RELEASE_TAG is required." >&2
  exit 1
fi

if [[ ! -f "$ARCHIVE_PATH" ]]; then
  echo "Update archive not found: $ARCHIVE_PATH" >&2
  exit 1
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "App bundle not found: $APP_PATH" >&2
  exit 1
fi

if [[ -z "$SIGN_UPDATE" ]]; then
  RUNNER_TEMP_DIR="${RUNNER_TEMP:-/tmp}"
  for candidate in \
    "$ROOT_DIR/.build/checkouts/Sparkle/bin/sign_update" \
    "$RUNNER_TEMP_DIR/sparkle/bin/sign_update" \
    /tmp/sparkle-tools/bin/sign_update; do
    if [[ -x "$candidate" ]]; then
      SIGN_UPDATE="$candidate"
      break
    fi
  done
fi

if [[ -z "$SIGN_UPDATE" || ! -x "$SIGN_UPDATE" ]]; then
  echo "Sparkle sign_update tool not found. Set SPARKLE_SIGN_UPDATE." >&2
  exit 1
fi

if [[ -z "${SPARKLE_PRIVATE_KEY:-}" ]]; then
  echo "SPARKLE_PRIVATE_KEY is required to sign the update archive." >&2
  exit 1
fi

SHORT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
BUNDLE_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_PATH/Contents/Info.plist")"
PUB_DATE="$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')"
UPDATE_URL="https://github.com/borjadotai/email/releases/download/$RELEASE_TAG/Email-mac.zip"
RELEASE_URL="https://github.com/borjadotai/email/releases/tag/$RELEASE_TAG"
SIGNATURE_ATTRIBUTES="$(printf '%s' "$SPARKLE_PRIVATE_KEY" | "$SIGN_UPDATE" --ed-key-file - "$ARCHIVE_PATH")"

cat > "$OUTPUT_PATH" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Email Updates</title>
    <link>https://github.com/borjadotai/email/releases</link>
    <description>Updates for Email.</description>
    <item>
      <title>Email $SHORT_VERSION</title>
      <link>$RELEASE_URL</link>
      <sparkle:version>$BUNDLE_VERSION</sparkle:version>
      <sparkle:shortVersionString>$SHORT_VERSION</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>
      <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
      <pubDate>$PUB_DATE</pubDate>
      <enclosure url="$UPDATE_URL"
        $SIGNATURE_ATTRIBUTES
        type="application/zip" />
    </item>
  </channel>
</rss>
EOF

echo "Created $OUTPUT_PATH"
