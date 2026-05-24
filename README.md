# Email

A private native email app foundation with:

- A local always-on server for account sync, message storage, outbound mail, open tracking, and search.
- SQLite + FTS5 storage for fast full-history search.
- Native SwiftUI macOS and iOS app targets sharing one UI/client layer.
- Multi-account inbox views, folders, labels, compose/send flow, settings, and system/light/dark theming.

## Run the Server

```sh
npm install
npm run server:dev
```

The server listens on `http://127.0.0.1:7331` by default and stores data in:

```text
~/Library/Application Support/EmailApp/mail.sqlite
```

For an always-running local daemon:

```sh
./scripts/install-launch-agent.sh
```

Copy `.env.example` to `.env` for local app-owned provider credentials. The launch agent reads `.env` through `scripts/start-server.sh`.

## Build the Apps

```sh
npm run build:mac
npm run build:ios
```

The Codex run action uses:

```sh
./script/build_and_run.sh --install
```

That script starts the server if needed, builds the macOS app, copies the fresh build to:

```text
~/Applications/Email.app
```

and launches it. Re-run the command after app changes to update the installed local app. To install somewhere else, set `EMAIL_MAC_INSTALL_DIR`:

```sh
EMAIL_MAC_INSTALL_DIR=/Applications ./script/build_and_run.sh --install
```

## Package the macOS App

For a shareable macOS build:

```sh
npm run package:mac
```

This creates:

```text
dist/Email.app
dist/Email-mac.zip
dist/Email-mac.dmg
```

The packaged app bundles the local Node server under `Email.app/Contents/Resources/Server` and starts it automatically on `127.0.0.1:7331` when a dev server is not already running. To include release-only provider config, pass an env file explicitly:

```sh
EMAIL_RELEASE_ENV_FILE=.env.production npm run package:mac
```

Do not copy local personal secrets into public builds. Public direct-download distribution requires Developer ID signing and notarization:

```sh
DEVELOPER_ID_APPLICATION="Developer ID Application: Your Name (TEAMID)" \
NOTARYTOOL_PROFILE=email-notary \
npm run package:mac
```

Create the notary profile once with:

```sh
xcrun notarytool store-credentials email-notary \
  --apple-id "you@example.com" \
  --team-id TEAMID \
  --password "app-specific-password"
```

Without `DEVELOPER_ID_APPLICATION`, the script still creates unsigned artifacts for local inspection, but those are not suitable for public downloads because Gatekeeper will warn or block them on other Macs.

The packaged app includes the Node runtime from the build machine. The current local build is Apple Silicon (`arm64`). For Intel Mac support, build a matching `x86_64` or universal macOS app and bundle a matching Node runtime.

## GitHub Downloads

GitHub Actions builds a downloadable macOS artifact on every push to `main` and when run manually:

1. Open the repository on GitHub.
2. Go to Actions -> macOS App.
3. Open the latest successful run.
4. Download the `Email-macOS-...` artifact.

Artifacts from normal workflow runs expire after 14 days. For durable downloads, push a version tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Tags starting with `v` create or update a GitHub Release and attach:

```text
Email-mac.dmg
Email-mac.zip
appcast.xml
checksums.txt
```

The macOS app uses Sparkle 2 for updates. Its feed URL is:

```text
https://github.com/borjadotai/email/releases/latest/download/appcast.xml
```

Sparkle automatic checks and automatic installs are enabled by default. The app also adds a macOS menu item at Email -> Check for Updates....

Unsigned artifacts are useful for private testing, but public downloads should be signed and notarized. Configure these GitHub repository secrets to enable that in the workflow:

```text
MACOS_DEVELOPER_ID_CERTIFICATE_BASE64
MACOS_DEVELOPER_ID_CERTIFICATE_PASSWORD
DEVELOPER_ID_APPLICATION
APPLE_ID
APPLE_TEAM_ID
APPLE_APP_SPECIFIC_PASSWORD
SPARKLE_PRIVATE_KEY
```

`MACOS_DEVELOPER_ID_CERTIFICATE_BASE64` is a base64-encoded `.p12` export of the Developer ID Application certificate. `DEVELOPER_ID_APPLICATION` should match the identity name, for example:

```text
Developer ID Application: Your Name (TEAMID)
```

Optionally set `EMAIL_RELEASE_ENV_BASE64` to a base64-encoded release env file if a private/internal build needs bundled provider configuration. Avoid putting personal secrets into public release builds.

`SPARKLE_PRIVATE_KEY` is the exported private EdDSA key from Sparkle's `generate_keys` tool. The matching public key is embedded in the app as `SUPublicEDKey`.

## Server API

Core endpoints live under `/api`:

- `GET /api/health`
- `GET /api/accounts`
- `POST /api/accounts`
- `GET /api/auth/settings`
- `POST /api/auth/gmail/start`
- `GET /api/auth/gmail/callback`
- `POST /api/auth/icloud/connect`
- `POST /api/accounts/:id/sync`
- `GET /api/mailboxes`
- `GET /api/labels`
- `POST /api/labels`
- `GET /api/emails?q=&accountId=&mailboxId=&labelId=`
- `GET /api/emails/:id`
- `PATCH /api/emails/:id`
- `POST /api/emails/:id/labels`
- `POST /api/messages/send`
- `GET /api/events`
- `GET /api/track/open/:trackingId.gif`

## Real Account Setup

### Gmail

1. In Google Cloud Console, enable the Gmail API for the project.
2. Create an OAuth client for a web application.
3. Add this authorized redirect URI:

```text
http://127.0.0.1:7331/api/auth/gmail/callback
```

4. Configure the app/server with `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
5. Use Add Account -> Gmail. The app opens the system browser for Google OAuth and receives the callback at:

```text
http://127.0.0.1:7331/api/auth/gmail/callback
```

Users do not enter Google OAuth client credentials. Those credentials belong to the app build or server environment. Per-account refresh tokens are stored in the macOS Keychain under the `EmailApp` service. Gmail sync currently imports recent messages into local SQLite/FTS and maps Gmail user labels into local labels.

After creating the OAuth client, download its JSON file and import it locally:

```sh
node scripts/import-google-oauth.mjs ~/Downloads/client_secret_*.json
launchctl kickstart -k "gui/$(id -u)/com.borjadotai.email.server"
```

### iCloud

1. Generate an app-specific password at `https://account.apple.com`.
2. Use Add Account -> iCloud with your iCloud Mail address and the generated password.

Sign in with Apple identifies a user to an app, but it does not provide iCloud Mail IMAP/SMTP access. The server verifies IMAP and SMTP before saving the account. It stores the app-specific password in the macOS Keychain, imports INBOX messages over IMAP, and sends via iCloud SMTP.

Public Gmail distribution will require Google OAuth consent screen configuration and, because this app requests Gmail mail access scopes, Google verification before broad external use.

## Runtime Notes

- `EMAIL_INITIAL_SYNC_LIMIT` controls how many messages are imported per sync pass. The default is `500`.
- `EMAIL_PUBLIC_BASE_URL` must point at a reachable server URL for outbound open tracking pixels to work outside the local machine.
- The current iCloud importer focuses on INBOX. Gmail imports all non-spam/trash messages returned by the Gmail API and places them into Inbox, Sent, Drafts, Trash, or Archive based on Gmail system labels.
