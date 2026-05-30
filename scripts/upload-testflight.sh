#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT_DIR/.env.testflight" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.testflight"
  set +a
fi

PROJECT_PATH="$ROOT_DIR/Apps/Email.xcodeproj"
SCHEME="${EMAIL_IOS_SCHEME:-EmailiOS}"
CONFIGURATION="${EMAIL_IOS_CONFIGURATION:-Release}"
TEAM_ID="${DEVELOPMENT_TEAM:-32HQUBGF5H}"
BUILD_NUMBER="${EMAIL_IOS_BUILD_NUMBER:-$(date +%Y%m%d%H%M)}"
ARCHIVE_DIR="${EMAIL_IOS_ARCHIVE_DIR:-$HOME/Library/Developer/Xcode/Archives/$(date +%Y-%m-%d)}"
ARCHIVE_PATH="${EMAIL_IOS_ARCHIVE_PATH:-$ARCHIVE_DIR/Email-$BUILD_NUMBER.xcarchive}"
EXPORT_PATH="${EMAIL_IOS_EXPORT_PATH:-$ROOT_DIR/build/TestFlight/upload-$BUILD_NUMBER}"
IPA_PATH="$EXPORT_PATH/Email.ipa"

ASC_KEY_ID="${ASC_KEY_ID:-992N98Z9WD}"
ASC_KEY_PATH="${ASC_KEY_PATH:-$HOME/Downloads/AuthKey_${ASC_KEY_ID}.p8}"
ASC_ISSUER_ID="${ASC_ISSUER_ID:-}"
IOS_BUNDLE_ID="${EMAIL_IOS_BUNDLE_ID:-com.borjadotai.email.ios}"
NOTIFICATION_BUNDLE_ID="${EMAIL_IOS_NOTIFICATION_BUNDLE_ID:-com.borjadotai.email.ios.notificationservice}"
IOS_PROFILE_NAME="${EMAIL_IOS_PROFILE_NAME:-Email iOS App Store 1780164031962}"
NOTIFICATION_PROFILE_NAME="${EMAIL_IOS_NOTIFICATION_PROFILE_NAME:-Email Notification Service App Store 1780164031962}"

if [[ -z "$ASC_ISSUER_ID" ]]; then
  cat >&2 <<EOF
ASC_ISSUER_ID is required.

Find it in App Store Connect:
  Users and Access -> Integrations -> App Store Connect API -> Issuer ID

Then run:
  ASC_ISSUER_ID=<issuer-id> scripts/upload-testflight.sh
EOF
  exit 2
fi

if [[ ! -f "$ASC_KEY_PATH" ]]; then
  echo "App Store Connect API key not found: $ASC_KEY_PATH" >&2
  exit 2
fi

mkdir -p "$ARCHIVE_DIR" "$EXPORT_PATH"
EXPORT_OPTIONS="$(mktemp "${TMPDIR:-/tmp}/email-export-options.XXXXXX.plist")"
trap 'rm -f "$EXPORT_OPTIONS"' EXIT

cat > "$EXPORT_OPTIONS" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>destination</key>
	<string>export</string>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
	<key>method</key>
	<string>app-store-connect</string>
	<key>signingCertificate</key>
	<string>Apple Distribution</string>
	<key>signingStyle</key>
	<string>manual</string>
	<key>teamID</key>
	<string>$TEAM_ID</string>
	<key>uploadSymbols</key>
	<true/>
	<key>provisioningProfiles</key>
	<dict>
		<key>$IOS_BUNDLE_ID</key>
		<string>$IOS_PROFILE_NAME</string>
		<key>$NOTIFICATION_BUNDLE_ID</key>
		<string>$NOTIFICATION_PROFILE_NAME</string>
	</dict>
</dict>
</plist>
EOF

XCODEBUILD_OVERRIDES=(
  DEVELOPMENT_TEAM="$TEAM_ID"
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER"
)
if [[ -n "${EMAIL_IOS_MARKETING_VERSION:-}" ]]; then
  XCODEBUILD_OVERRIDES+=(MARKETING_VERSION="$EMAIL_IOS_MARKETING_VERSION")
fi

AUTH_ARGS=(
  -authenticationKeyPath "$ASC_KEY_PATH"
  -authenticationKeyID "$ASC_KEY_ID"
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
)

echo "Archiving $SCHEME build $BUILD_NUMBER..."
xcodebuild \
  -project "$PROJECT_PATH" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  "${XCODEBUILD_OVERRIDES[@]}" \
  archive \
  -allowProvisioningUpdates \
  "${AUTH_ARGS[@]}"

echo
echo "Exporting App Store IPA..."
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -allowProvisioningUpdates

if [[ ! -f "$IPA_PATH" ]]; then
  echo "Expected exported IPA not found: $IPA_PATH" >&2
  exit 1
fi

echo
echo "Uploading IPA to App Store Connect..."
xcrun altool \
  --upload-app \
  --type ios \
  --file "$IPA_PATH" \
  --api-key "$ASC_KEY_ID" \
  --api-issuer "$ASC_ISSUER_ID" \
  --p8-file-path "$ASC_KEY_PATH" \
  --show-progress

echo
echo "Uploaded build $BUILD_NUMBER to App Store Connect/TestFlight."
echo "Archive: $ARCHIVE_PATH"
echo "IPA: $IPA_PATH"
