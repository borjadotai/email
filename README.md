# Email

Self-hosted native email clients for macOS and iOS.

The important idea is simple: the private part runs on a machine you control, and
the apps are just clients. The macOS and iOS apps should not contain Google
secrets, account passwords, refresh tokens, or a private `.env` file. They talk
to your server over HTTP, and your server stores mail, syncs accounts, sends
messages, and keeps provider credentials private.

## Start Here

The easiest personal setup is:

1. Pick one always-on machine as the email server. A Mac mini, desktop Mac, or a
   MacBook that usually stays on works well.
2. Run the guided server setup on that machine.
3. Install the macOS app, and optionally the iOS app.
4. Point each app at your server URL, then add Gmail or iCloud accounts from the
   app.

For access away from home, put all of your devices on the same private network
with something like Tailscale, then use the server's Tailscale or `.local`
address as the app's Server URL.

## What Runs Where

- Server machine: stores SQLite mail data, talks to Gmail/iCloud, sends mail,
  keeps OAuth secrets and account tokens in the server environment and macOS
  Keychain.
- macOS app: native email client, no provider secrets, updates from GitHub
  Releases with Sparkle.
- iOS app: native email client, no provider secrets, currently installed through
  Xcode while public iOS distribution is not set up.
- GitHub repo/releases: safe to be public. Release artifacts can contain public
  configuration like a default server URL, but not private provider secrets.

## Server Setup

On the always-on server Mac, install Node.js 24 or newer from
`https://nodejs.org/`, then run:

```sh
git clone https://github.com/borjadotai/email.git
cd email
npm run setup:server
```

The setup command is the beginner path. It checks Node, installs dependencies,
creates `.env` from `.env.example`, asks for the server URL your apps will use,
configures the server to listen on `0.0.0.0:7331`, and can install the macOS
LaunchAgent so the server keeps running after restarts.

After setup, check that the server answers:

```sh
curl http://127.0.0.1:7331/api/health
```

Server data is stored on the server Mac at:

```text
~/Library/Application Support/EmailApp/mail.sqlite
```

Server logs are written to:

```text
~/Library/Logs/EmailApp/server.out.log
~/Library/Logs/EmailApp/server.error.log
```

## Add Accounts

### Gmail

Gmail needs a Google OAuth client. You only do this on the server machine:

1. In Google Cloud Console, enable the Gmail API for your project.
2. Create an OAuth client for a web application.
3. Add this authorized redirect URI, using your real server URL:

```text
http://your-server:7331/api/auth/gmail/callback
```

4. Download the OAuth JSON file and import it into the server `.env`:

```sh
node scripts/import-google-oauth.mjs ~/Downloads/client_secret_*.json
launchctl kickstart -k "gui/$(id -u)/com.borjadotai.email.server"
```

The apps never need the Google OAuth client secret. They ask the server to start
the Gmail sign-in flow, and Google redirects back to your server.

Broad public Gmail distribution requires Google OAuth consent screen
configuration and, because this app requests Gmail mail access scopes, Google
verification before broad external use.

### iCloud

iCloud does not use Sign in with Apple for mail access. Generate an app-specific
password at `https://account.apple.com`, then add the account from the app with
your iCloud Mail address and that app-specific password. The server verifies
IMAP/SMTP and stores the password in the server Mac's Keychain.

## Install the Clients

### macOS

Download the latest `Email-mac.dmg` from:

```text
https://github.com/borjadotai/email/releases/latest
```

Drag `Email.app` to Applications, open it, then set the Server URL in Settings.
Use the same URL you entered during server setup, for example:

```text
http://your-server:7331
```

The app includes Sparkle updates. It checks automatically, and you can also use
Email -> Check for Updates... or Settings -> General -> Updates.

Current public test builds are not Developer ID notarized yet. For smooth
one-click public distribution, the release workflow still needs Apple Developer
ID signing and notarization configured.

### iOS

Until TestFlight or App Store distribution exists, install the iOS app from
Xcode:

1. Open `Apps/Email.xcodeproj`.
2. Select the `EmailiOS` scheme.
3. Select your iPhone.
4. Set your signing team if Xcode asks.
5. Press Run.

Open the app on the phone and set the same Server URL as the macOS app.

## Keep It Updated

To update the server on the always-on Mac:

```sh
cd email
git pull
npm install
launchctl kickstart -k "gui/$(id -u)/com.borjadotai.email.server"
```

To update the macOS app, use Sparkle's automatic updates or Email -> Check for
Updates.... The app update does not need provider secrets because it only talks
to your server.

To update iOS for now, pull the latest repo in Xcode and run the app again on
the device.

## Troubleshooting

- If the app cannot connect, open `http://your-server:7331/api/health` from the
  same device or network.
- If that works locally but not from another device, confirm the server URL,
  firewall settings, and that `EMAIL_SERVER_HOST=0.0.0.0` is present in `.env`.
- If Gmail setup fails, confirm the Google redirect URI exactly matches
  `EMAIL_PUBLIC_BASE_URL` plus `/api/auth/gmail/callback`.
- If the server does not start, check
  `~/Library/Logs/EmailApp/server.error.log`.

## Developer Commands

Run the server manually:

```sh
npm install
npm run server:dev
```

Install or refresh the always-on LaunchAgent manually:

```sh
./scripts/install-launch-agent.sh
```

Build the apps:

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

The packaged app bundles the local Node server under `Email.app/Contents/Resources/Server` for local/internal runs. If its configured server URL is loopback, it starts that bundled server automatically on `127.0.0.1:7331` when a dev server is not already running.

Provider secrets should not be bundled into the app. For builds that should use a shared backend, bake only the backend URL into the app:

```sh
EMAIL_RELEASE_SERVER_URL=http://your-server:7331 npm run package:mac
```

Run the backend separately with the provider secrets in its server environment. Public direct-download distribution requires Developer ID signing and notarization:

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

Sparkle automatic checks and automatic installs are enabled by default. The app also adds update controls at Email -> Check for Updates... and Settings -> General -> Updates. The feed and update zip must be publicly reachable by the installed app; private GitHub release assets cannot be fetched by Sparkle.

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

Optionally set the GitHub repository variable `EMAIL_RELEASE_SERVER_URL` to the backend endpoint that release builds should use by default. Do not store provider secrets in release build variables or bundle them into the app. This URL is embedded in public app artifacts, so treat it as public configuration.

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

## Runtime Notes

- `EMAIL_INITIAL_SYNC_LIMIT` controls how many messages are imported per sync pass. The default is `500`.
- `EMAIL_PUBLIC_BASE_URL` must point at a reachable server URL for outbound open tracking pixels to work outside the local machine.
- The current iCloud importer focuses on INBOX. Gmail imports all non-spam/trash messages returned by the Gmail API and places them into Inbox, Sent, Drafts, Trash, or Archive based on Gmail system labels.
